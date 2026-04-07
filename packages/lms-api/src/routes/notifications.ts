/**
 * Notifications Routes
 * Source: SRS-CH03 §3.6 Notification System
 * Base: /api/v1/notifications
 *
 * Types: ai_alert, quiz_graded, badge_earned, level_up,
 *        teacher_message, flashcard_due, peer_review_request,
 *        threshold_breakthrough, announcement
 *
 * Delivery: REST polling + Server-Sent Events (SSE) push
 */
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'

const CreateNotificationSchema = z.object({
  user_id: z.string().uuid().optional(),     // target user; if omitted + broadcast=true → all
  type: z.enum([
    'ai_alert', 'quiz_graded', 'badge_earned', 'level_up',
    'teacher_message', 'flashcard_due', 'peer_review_request',
    'threshold_breakthrough', 'announcement'
  ]),
  title: z.string().min(1).max(200),
  body: z.string().min(1),
  data: z.record(z.unknown()).default({}),
  broadcast: z.boolean().default(false),     // send to all students in class
  class_id: z.string().optional(),           // used with broadcast
})

const MarkReadSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
})

export async function notificationsRoutes(fastify: FastifyInstance) {

  // ── GET /api/v1/notifications — list my notifications ──────────────────────
  fastify.get<{ Querystring: { unread?: string; limit?: string; offset?: string } }>(
    '/',
    { preHandler: [fastify.authenticate] },
    async (req, _reply) => {
      const userId = req.user.sub
      const onlyUnread = req.query.unread === 'true'
      const limit = Math.min(parseInt(req.query.limit || '20'), 50)
      const offset = parseInt(req.query.offset || '0')

      const whereClause = onlyUnread
        ? 'WHERE n.user_id = $1 AND n.is_read = FALSE'
        : 'WHERE n.user_id = $1'

      const [countRes, rowsRes] = await Promise.all([
        fastify.db.query(
          `SELECT COUNT(*) FROM notifications n ${whereClause}`,
          [userId]
        ),
        fastify.db.query(
          `SELECT n.*,
                  u.full_name AS created_by_name
           FROM notifications n
           LEFT JOIN users u ON u.id = n.created_by
           ${whereClause}
           ORDER BY n.created_at DESC
           LIMIT $2 OFFSET $3`,
          [userId, limit, offset]
        ),
      ])

      const unreadCount = await fastify.db.query(
        'SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = FALSE',
        [userId]
      )

      return {
        data: rowsRes.rows,
        meta: {
          total: parseInt(countRes.rows[0].count),
          unread: parseInt(unreadCount.rows[0].count),
          limit,
          offset,
        },
      }
    }
  )

  // ── POST /api/v1/notifications/read — mark notifications as read ────────────
  fastify.post(
    '/read',
    { preHandler: [fastify.authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { ids } = MarkReadSchema.parse(req.body)
      const userId = req.user.sub

      const result = await fastify.db.query(
        `UPDATE notifications
         SET is_read = TRUE, read_at = NOW()
         WHERE id = ANY($1::uuid[]) AND user_id = $2
         RETURNING id`,
        [ids, userId]
      )

      return { data: { marked_read: result.rowCount } }
    }
  )

  // ── POST /api/v1/notifications/read-all — mark all as read ─────────────────
  fastify.post(
    '/read-all',
    { preHandler: [fastify.authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const result = await fastify.db.query(
        `UPDATE notifications
         SET is_read = TRUE, read_at = NOW()
         WHERE user_id = $1 AND is_read = FALSE
         RETURNING id`,
        [req.user.sub]
      )

      return { data: { marked_read: result.rowCount } }
    }
  )

  // ── POST /api/v1/notifications — create notification (teacher/admin) ────────
  fastify.post(
    '/',
    { preHandler: [fastify.authenticate, fastify.authorizeRole('teacher', 'admin')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = CreateNotificationSchema.parse(req.body)

      if (body.broadcast) {
        // Broadcast to all students in a class
        const targetClass = body.class_id
        if (!targetClass) {
          return reply.status(400).send({
            error: { code: 'MISSING_CLASS_ID', message: 'class_id required for broadcast' }
          })
        }

        const students = await fastify.db.query(
          `SELECT id FROM users WHERE class_id = $1 AND role = 'student' AND deleted_at IS NULL`,
          [targetClass]
        )

        if (students.rows.length === 0) {
          return reply.status(404).send({
            error: { code: 'NO_STUDENTS', message: `No students found in class ${targetClass}` }
          })
        }

        // Bulk insert
        const values = students.rows.map((s: { id: string }) => [
          s.id, body.type, body.title, body.body,
          JSON.stringify(body.data), req.user.sub
        ])

        const placeholders = values.map((_, i) =>
          `($${i * 6 + 1}, $${i * 6 + 2}, $${i * 6 + 3}, $${i * 6 + 4}, $${i * 6 + 5}::jsonb, $${i * 6 + 6})`
        ).join(', ')

        await fastify.db.query(
          `INSERT INTO notifications (user_id, type, title, body, data, created_by)
           VALUES ${placeholders}`,
          values.flat()
        )

        // Publish to Redis for SSE push
        await fastify.redis.publish(
          `notifications:class:${targetClass}`,
          JSON.stringify({ type: body.type, title: body.title, body: body.body, data: body.data })
        )

        return reply.status(201).send({
          data: { sent_to: students.rows.length, type: 'broadcast' }
        })
      } else {
        // Single user
        if (!body.user_id) {
          return reply.status(400).send({
            error: { code: 'MISSING_USER_ID', message: 'user_id required for single notification' }
          })
        }

        const result = await fastify.db.query(
          `INSERT INTO notifications (user_id, type, title, body, data, created_by)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6)
           RETURNING *`,
          [body.user_id, body.type, body.title, body.body, JSON.stringify(body.data), req.user.sub]
        )

        // Publish to Redis for SSE push
        await fastify.redis.publish(
          `notifications:user:${body.user_id}`,
          JSON.stringify(result.rows[0])
        )

        return reply.status(201).send({ data: result.rows[0] })
      }
    }
  )

  // ── GET /api/v1/notifications/stream — SSE push stream ─────────────────────
  // Streams real-time notifications to authenticated client.
  // Uses Redis pub/sub and keeps the connection open.
  fastify.get(
    '/stream',
    { preHandler: [fastify.authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = req.user.sub

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-store',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',  // Disable Nginx buffering
        'Access-Control-Allow-Origin': '*',
      })

      // Send initial "connected" event
      reply.raw.write(`event: connected\ndata: ${JSON.stringify({ userId, ts: new Date().toISOString() })}\n\n`)

      // Subscribe to user channel
      const subscriber = fastify.redis.duplicate()
      const channel = `notifications:user:${userId}`

      const onMessage = (chan: string, message: string) => {
        if (chan === channel) {
          try {
            reply.raw.write(`event: notification\ndata: ${message}\n\n`)
          } catch {
            // Client disconnected
          }
        }
      }

      await subscriber.subscribe(channel)
      subscriber.on('message', onMessage)

      // Keepalive ping every 25s to prevent proxy timeout
      const pingInterval = setInterval(() => {
        try {
          reply.raw.write(`: ping\n\n`)
        } catch {
          clearInterval(pingInterval)
        }
      }, 25000)

      // Cleanup on close
      req.raw.on('close', () => {
        clearInterval(pingInterval)
        subscriber.unsubscribe(channel)
        subscriber.quit()
      })

      // Keep connection open — do not call reply.send()
    }
  )

  // ── DELETE /api/v1/notifications/:id — delete a notification ────────────────
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: [fastify.authenticate] },
    async (req, reply) => {
      const result = await fastify.db.query(
        `DELETE FROM notifications WHERE id = $1 AND user_id = $2 RETURNING id`,
        [req.params.id, req.user.sub]
      )

      if (result.rowCount === 0) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Notification not found' }
        })
      }

      return { data: { deleted: true } }
    }
  )
}

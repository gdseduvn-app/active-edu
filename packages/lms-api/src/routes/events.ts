/**
 * Event Ingestion API (Internal)
 * Source: SRS-CH05 §5.6.4, SRS-CH04 §4.5
 * INTERNAL ONLY — not exposed to internet
 * Auth: X-Internal-Key header
 */
import { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'

const EventSchema = z.object({
  user_id: z.string().uuid(),
  lesson_id: z.string().uuid().optional(),
  session_id: z.string().uuid().optional(),
  event_type: z.enum([
    'quiz_submitted','assignment_submitted','video_progress',
    'session_started','session_ended','discussion_posted',
    'peer_review_given','lesson_completed','teacher_override',
    'ai_literacy_assessed','solo_assessed','page_viewed',
    'hint_requested','code_executed','flashcard_reviewed',
  ]),
  payload: z.record(z.any()).default({}),
})

export async function eventRoutes(fastify: FastifyInstance) {

  // POST /internal/events — ingest event from LMS
  fastify.post(
    '/internal/events',
    {
      preHandler: async (req, reply) => {
        const key = req.headers['x-internal-key']
        if (key !== process.env.INTERNAL_KEY) {
          return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Internal key required' } })
        }
      }
    },
    async (req: FastifyRequest, reply) => {
      const event = EventSchema.parse(req.body)
      // Insert to partitioned events table
      const result = await fastify.db.query(
        `INSERT INTO events (user_id, lesson_id, session_id, event_type, payload)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
        [event.user_id, event.lesson_id, event.session_id, event.event_type, JSON.stringify(event.payload)]
      )
      // Publish to Redis Stream for Event Processor
      await fastify.redis.xadd(
        'stream:events',
        '*',
        'event_id', result.rows[0].id.toString(),
        'user_id', event.user_id,
        'event_type', event.event_type,
        'payload', JSON.stringify(event.payload),
      )
      return reply.status(201).send({ data: { id: result.rows[0].id } })
    }
  )

  // GET /api/v1/events/stream/:userId — SSE for real-time updates
  fastify.get<{ Params: { userId: string } }>(
    '/api/v1/events/stream/:userId',
    { preHandler: [fastify.authenticate] },
    async (req, reply) => {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      })
      // Subscribe to Redis pub/sub for this user
      const sub = fastify.redis.duplicate()
      await sub.subscribe(`user:${req.params.userId}:events`)
      sub.on('message', (channel: string, message: string) => {
        reply.raw.write(`data: ${message}\n\n`)
      })
      req.raw.on('close', () => { sub.unsubscribe(); sub.disconnect() })
    }
  )
}

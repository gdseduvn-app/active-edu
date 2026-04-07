/**
 * AURA AdaptLearn — User Management Routes
 * Source: SRS-CH05 §5.4 User APIs
 * Base prefix: /api/v1/users
 *
 * GET    /              — Admin: paginated user list (search, filters)
 * GET    /:userId       — Teacher or self: profile + learner_model snapshot
 * PATCH  /:userId       — Admin or self: update profile fields
 * DELETE /:userId       — Admin: soft-delete (deleted_at = NOW())
 * GET    /:userId/progress — Teacher or self: learner_model + last 5 agent decisions + quiz stats
 */

import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'

// ── Zod schemas ───────────────────────────────────────────────────────────────

const ListUsersQuery = z.object({
  page:     z.coerce.number().int().min(1).default(1),
  limit:    z.coerce.number().int().min(1).max(100).default(20),
  role:     z.enum(['student', 'teacher', 'admin', 'observer']).optional(),
  class_id: z.string().optional(),
  search:   z.string().optional(),
})

const UpdateUserBody = z.object({
  full_name:  z.string().min(1).max(255).optional(),
  avatar_url: z.string().url().optional(),
  class_id:   z.string().max(20).optional(),
  // Admin-only fields (silently ignored for non-admins — enforced in handler)
  role:       z.enum(['student', 'teacher', 'admin', 'observer']).optional(),
  is_active:  z.boolean().optional(),
})

// ── Plugin ────────────────────────────────────────────────────────────────────

export async function userRoutes (
  app: FastifyInstance,
  _opts: FastifyPluginOptions,
): Promise<void> {

  // ── GET / ──────────────────────────────────────────────────────────────────
  // Admin only. Paginated list with optional filters and pg_trgm search.
  app.get(
    '/',
    { preHandler: [app.authenticate, app.authorizeRole('admin')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const q = ListUsersQuery.parse(request.query)
      const offset = (q.page - 1) * q.limit

      const conditions: string[] = ['deleted_at IS NULL']
      const params: unknown[] = []
      let p = 1

      if (q.role) {
        conditions.push(`role = $${p++}`)
        params.push(q.role)
      }
      if (q.class_id) {
        conditions.push(`class_id = $${p++}`)
        params.push(q.class_id)
      }
      if (q.search) {
        // Use pg_trgm similarity search on full_name and email
        conditions.push(
          `(full_name ILIKE $${p} OR email ILIKE $${p} OR username ILIKE $${p})`,
        )
        params.push(`%${q.search}%`)
        p++
      }

      const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

      // Count query
      const countResult = await app.db.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM users ${whereClause}`,
        params,
      )
      const total = parseInt(countResult.rows[0]?.count ?? '0', 10)

      // Data query
      const dataResult = await app.db.query(
        `SELECT id, username, email, full_name, role, class_id, grade,
                is_active, avatar_url, last_login_at, created_at
         FROM users
         ${whereClause}
         ORDER BY created_at DESC
         LIMIT $${p++} OFFSET $${p++}`,
        [...params, q.limit, offset],
      )

      return reply.send({
        data: dataResult.rows,
        meta: {
          total,
          page:  q.page,
          limit: q.limit,
        },
      })
    },
  )

  // ── GET /:userId ───────────────────────────────────────────────────────────
  // Teacher/admin or the user themselves. Returns profile + learner_model snapshot.
  app.get<{ Params: { userId: string } }>(
    '/:userId',
    { preHandler: [app.authenticate, app.authorizeTeacherOrSelf] },
    async (request, reply) => {
      const { userId } = request.params

      const userResult = await app.db.query(
        `SELECT id, username, email, full_name, role, class_id, grade,
                is_active, avatar_url, last_login_at, created_at
         FROM users
         WHERE id = $1 AND deleted_at IS NULL`,
        [userId],
      )
      const user = userResult.rows[0]
      if (!user) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Không tìm thấy người dùng',
        })
      }

      // Attach learner_model if it exists (students only, but harmless for others)
      const lmResult = await app.db.query(
        `SELECT mastery_map, bloom_profile, error_patterns, solo_profile,
                current_level, engagement_score, consecutive_pass, consecutive_fail,
                streak_days, total_study_minutes, last_session_at, tags
         FROM learner_models
         WHERE user_id = $1`,
        [userId],
      )

      return reply.send({
        data: {
          ...user,
          learner_model: lmResult.rows[0] ?? null,
        },
      })
    },
  )

  // ── PATCH /:userId ─────────────────────────────────────────────────────────
  // Admin can update any field including role and is_active.
  // A user can update their own full_name, avatar_url, class_id only.
  app.patch<{ Params: { userId: string } }>(
    '/:userId',
    { preHandler: [app.authenticate, app.authorizeTeacherOrSelf] },
    async (request: FastifyRequest<{ Params: { userId: string } }>, reply) => {
      const { userId } = request.params
      const callerRole = request.user.role
      const callerId   = request.user.sub

      // Ensure target user exists
      const exists = await app.db.query<{ id: string }>(
        `SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL`,
        [userId],
      )
      if (!exists.rows[0]) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Không tìm thấy người dùng',
        })
      }

      const body = UpdateUserBody.parse(request.body)

      // Non-admins cannot change role or is_active; also non-admins can only
      // update their own account (authorizeTeacherOrSelf already enforces this
      // for teachers, but teachers are not self, so we guard the admin-only fields).
      const isAdmin = callerRole === 'admin'
      const isSelf  = callerId === userId

      if (!isAdmin && !isSelf) {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Không có quyền chỉnh sửa tài khoản này',
        })
      }

      const setClauses: string[] = []
      const params: unknown[] = []
      let p = 1

      if (body.full_name !== undefined) {
        setClauses.push(`full_name = $${p++}`)
        params.push(body.full_name)
      }
      if (body.avatar_url !== undefined) {
        setClauses.push(`avatar_url = $${p++}`)
        params.push(body.avatar_url)
      }
      if (body.class_id !== undefined) {
        setClauses.push(`class_id = $${p++}`)
        params.push(body.class_id)
      }
      // Admin-only fields
      if (isAdmin) {
        if (body.role !== undefined) {
          setClauses.push(`role = $${p++}`)
          params.push(body.role)
        }
        if (body.is_active !== undefined) {
          setClauses.push(`is_active = $${p++}`)
          params.push(body.is_active)
        }
      }

      if (setClauses.length === 0) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Không có trường nào để cập nhật',
        })
      }

      setClauses.push(`updated_at = NOW()`)
      params.push(userId)

      const updateResult = await app.db.query(
        `UPDATE users
         SET ${setClauses.join(', ')}
         WHERE id = $${p} AND deleted_at IS NULL
         RETURNING id, username, email, full_name, role, class_id, grade,
                   is_active, avatar_url, updated_at`,
        params,
      )

      return reply.send({ data: updateResult.rows[0] })
    },
  )

  // ── DELETE /:userId ────────────────────────────────────────────────────────
  // Admin only. Soft delete via deleted_at timestamp.
  app.delete<{ Params: { userId: string } }>(
    '/:userId',
    { preHandler: [app.authenticate, app.authorizeRole('admin')] },
    async (request, reply) => {
      const { userId } = request.params

      // Prevent admins from deleting themselves to avoid lockout
      if (userId === request.user.sub) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Không thể xoá chính tài khoản của mình',
        })
      }

      const result = await app.db.query<{ id: string }>(
        `UPDATE users
         SET deleted_at = NOW(), is_active = FALSE, updated_at = NOW()
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING id`,
        [userId],
      )

      if (!result.rows[0]) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Không tìm thấy người dùng',
        })
      }

      // Invalidate any cached learner model data
      await app.redis.del(`learner_model:${userId}`)

      return reply.status(204).send()
    },
  )

  // ── GET /:userId/progress ──────────────────────────────────────────────────
  // Teacher/admin or self.
  // Returns: full learner_model + last 5 agent decisions + quiz attempt stats.
  app.get<{ Params: { userId: string } }>(
    '/:userId/progress',
    { preHandler: [app.authenticate, app.authorizeTeacherOrSelf] },
    async (request, reply) => {
      const { userId } = request.params

      // Verify user exists
      const userExists = await app.db.query<{ id: string; full_name: string; role: string }>(
        `SELECT id, full_name, role FROM users WHERE id = $1 AND deleted_at IS NULL`,
        [userId],
      )
      if (!userExists.rows[0]) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Không tìm thấy người dùng',
        })
      }

      // 1. Full learner model
      const lmResult = await app.db.query(
        `SELECT * FROM learner_models WHERE user_id = $1`,
        [userId],
      )

      // 2. Last 5 agent decisions with lesson context
      const decisionsResult = await app.db.query(
        `SELECT ad.id, ad.rule_fired, ad.reason, ad.confidence,
                ad.created_at, ad.overridden_by, ad.override_reason,
                l.id        AS lesson_id,
                l.title     AS lesson_title,
                l.lesson_code,
                l.difficulty_level
         FROM agent_decisions ad
         LEFT JOIN lessons l ON l.id = ad.next_lesson_id
         WHERE ad.user_id = $1
         ORDER BY ad.created_at DESC
         LIMIT 5`,
        [userId],
      )

      // 3. Quiz attempt summary stats
      const statsResult = await app.db.query<{
        total_attempts: string
        passed_count:   string
        avg_score:      string | null
        last_attempt:   string | null
      }>(
        `SELECT
           COUNT(*)                               AS total_attempts,
           COUNT(*) FILTER (WHERE passed = TRUE)  AS passed_count,
           AVG(score_percent)                     AS avg_score,
           MAX(submitted_at)                      AS last_attempt
         FROM quiz_attempts
         WHERE user_id = $1 AND submitted_at IS NOT NULL`,
        [userId],
      )

      const stats = statsResult.rows[0]

      return reply.send({
        data: {
          user: userExists.rows[0],
          learner_model:    lmResult.rows[0] ?? null,
          agent_decisions:  decisionsResult.rows,
          quiz_stats: {
            total_attempts: parseInt(stats?.total_attempts ?? '0', 10),
            passed_count:   parseInt(stats?.passed_count   ?? '0', 10),
            avg_score:      stats?.avg_score != null ? parseFloat(stats.avg_score) : null,
            last_attempt:   stats?.last_attempt ?? null,
          },
        },
      })
    },
  )
}

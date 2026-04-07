/**
 * AI Agent API Routes
 * Source: SRS-CH05 §5.6 AI Agent APIs
 * Base: /api/v1/agent
 */
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'

const LearnerModelSchema = z.object({
  user_id: z.string().uuid(),
})

const OverrideSchema = z.object({
  user_id: z.string().uuid(),
  next_lesson_id: z.string().uuid(),
  reason: z.string().min(10).max(500),
})

const FeedbackRequestSchema = z.object({
  user_id: z.string().uuid(),
  lesson_id: z.string().uuid(),
  score: z.number().min(0),
  max_score: z.number().min(0),
  error_tags: z.array(z.string()).default([]),
  time_taken_sec: z.number().optional(),
})

export async function agentRoutes(fastify: FastifyInstance) {

  // GET /api/v1/agent/learner-model/:userId
  fastify.get<{ Params: { userId: string } }>(
    '/learner-model/:userId',
    { preHandler: [fastify.authenticate, fastify.authorizeTeacherOrSelf] },
    async (req, reply) => {
      const { userId } = req.params
      const lm = await fastify.db.query(
        `SELECT * FROM learner_models WHERE user_id = $1`,
        [userId]
      )
      if (!lm.rows[0]) return reply.status(404).send({ error: { code: 'LM_NOT_FOUND', message: 'Chưa có dữ liệu học tập' } })
      return { data: lm.rows[0] }
    }
  )

  // GET /api/v1/agent/recommendations/:userId
  fastify.get<{ Params: { userId: string } }>(
    '/recommendations/:userId',
    { preHandler: [fastify.authenticate, fastify.authorizeTeacherOrSelf] },
    async (req, reply) => {
      const { userId } = req.params
      // Fetch last 3 agent decisions
      const decisions = await fastify.db.query(
        `SELECT ad.*, l.title, l.lesson_code, l.difficulty_level
         FROM agent_decisions ad
         LEFT JOIN lessons l ON l.id = ad.next_lesson_id
         WHERE ad.user_id = $1
         ORDER BY ad.created_at DESC LIMIT 3`,
        [userId]
      )
      return { data: decisions.rows }
    }
  )

  // POST /api/v1/agent/override
  fastify.post(
    '/override',
    { preHandler: [fastify.authenticate, fastify.authorizeRole('teacher', 'admin')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = OverrideSchema.parse(req.body)
      // Update learner model + create override decision record
      await fastify.db.query(
        `UPDATE learner_models SET current_lesson_id = $1, updated_at = NOW() WHERE user_id = $2`,
        [body.next_lesson_id, body.user_id]
      )
      await fastify.db.query(
        `INSERT INTO agent_decisions
         (user_id, rule_fired, next_lesson_id, reason, overridden_by, override_reason, override_at, confidence)
         VALUES ($1, 'TEACHER_OVERRIDE', $2, $3, $4, $3, NOW(), 1.0)`,
        [body.user_id, body.next_lesson_id, body.reason, req.user.sub]
      )
      // Invalidate Redis cache
      await fastify.redis.del(`learner_model:${body.user_id}`)
      return { data: { success: true, message: 'Đã ghi đè lộ trình thành công' } }
    }
  )

  // GET /api/v1/agent/explain/:userId/:decisionId
  // Explainability API — teachers can see why Agent chose a lesson
  fastify.get<{ Params: { userId: string; decisionId: string } }>(
    '/explain/:userId/:decisionId',
    { preHandler: [fastify.authenticate, fastify.authorizeRole('teacher', 'admin')] },
    async (req, reply) => {
      const { userId, decisionId } = req.params
      const result = await fastify.db.query(
        `SELECT ad.*, l.title, l.lesson_code, l.bloom_level, l.difficulty_level,
                u.full_name as student_name
         FROM agent_decisions ad
         LEFT JOIN lessons l ON l.id = ad.next_lesson_id
         LEFT JOIN users u ON u.id = ad.user_id
         WHERE ad.id = $1 AND ad.user_id = $2`,
        [decisionId, userId]
      )
      if (!result.rows[0]) return reply.status(404).send({ error: { code: 'DECISION_NOT_FOUND', message: 'Không tìm thấy quyết định này' } })
      return { data: result.rows[0] }
    }
  )

  // POST /api/v1/agent/feedback (internal: generate feedback after grading)
  fastify.post(
    '/feedback',
    { preHandler: [fastify.authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = FeedbackRequestSchema.parse(req.body)
      // Forward to Python Agent Service
      const agentRes = await fetch(`${process.env.AGENT_SERVICE_URL}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Key': process.env.INTERNAL_KEY! },
        body: JSON.stringify(body),
      })
      const feedback = await agentRes.json()
      return { data: feedback }
    }
  )
}

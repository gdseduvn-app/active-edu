/**
 * Lesson & Content API Routes
 * Source: SRS-CH05 §5.4 Lesson & Content APIs
 * Base: /api/v1/lessons
 */
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'

const LessonCreateSchema = z.object({
  lesson_code: z.string().regex(/^\d{6}\.\d{4}[a-z]\d$/),
  title: z.string().min(1).max(500),
  subject: z.string().default('toan'),
  grade: z.number().int().min(1).max(12),
  bloom_level: z.number().int().min(1).max(6),
  solo_target: z.number().int().min(1).max(5).default(4),
  knowledge_type: z.enum(['declarative','functioning','both']).default('declarative'),
  threshold_concept: z.boolean().default(false),
  lesson_model: z.enum(['scaffold','practice','case','teach','explore','repair','project','reflect']),
  difficulty_level: z.enum(['nen_tang','mo_rong','chuyen_sau']),
  al_format: z.string().optional(),
  kolb_phase: z.string().default('all'),
  html_content: z.string().optional(),
  ilos: z.array(z.any()).default([]),
  estimated_minutes: z.number().int().default(20),
  total_points: z.number().int().default(0),
})

export async function lessonRoutes(fastify: FastifyInstance) {

  // GET /api/v1/lessons — list with filters
  fastify.get('/', { preHandler: [fastify.authenticate] }, async (req: FastifyRequest, reply) => {
    const { grade, subject, bloom_level, status, search, limit = 50, offset = 0 } = req.query as any
    let sql = `SELECT id, lesson_code, title, grade, subject, bloom_level, solo_target,
                      lesson_model, difficulty_level, al_format, status, estimated_minutes
               FROM lessons WHERE deleted_at IS NULL`
    const params: any[] = []
    let p = 1
    if (grade)       { sql += ` AND grade = $${p++}`;       params.push(grade) }
    if (subject)     { sql += ` AND subject = $${p++}`;     params.push(subject) }
    if (bloom_level) { sql += ` AND bloom_level = $${p++}`; params.push(bloom_level) }
    if (status)      { sql += ` AND status = $${p++}`;      params.push(status) }
    if (search) {
      sql += ` AND to_tsvector('simple', title || ' ' || COALESCE(yccđ_requirement,'')) @@ plainto_tsquery('simple', $${p++})`
      params.push(search)
    }
    sql += ` ORDER BY grade, lesson_code LIMIT $${p++} OFFSET $${p++}`
    params.push(limit, offset)
    const result = await fastify.db.query(sql, params)
    return { data: result.rows, pagination: { total: result.rowCount, limit, offset } }
  })

  // GET /api/v1/lessons/:id — detail
  fastify.get<{ Params: { id: string } }>(
    '/:id', { preHandler: [fastify.authenticate] },
    async (req, reply) => {
      const result = await fastify.db.query(
        `SELECT l.*, u.full_name as author_name
         FROM lessons l LEFT JOIN users u ON u.id = l.author_id
         WHERE l.id = $1 AND l.deleted_at IS NULL`,
        [req.params.id]
      )
      if (!result.rows[0]) return reply.status(404).send({ error: { code: 'LESSON_NOT_FOUND', message: 'Không tìm thấy bài học' } })
      return { data: result.rows[0] }
    }
  )

  // POST /api/v1/lessons — create (teacher/admin)
  fastify.post(
    '/',
    { preHandler: [fastify.authenticate, fastify.authorizeRole('teacher', 'admin')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = LessonCreateSchema.parse(req.body)
      const result = await fastify.db.query(
        `INSERT INTO lessons (
          lesson_code, title, subject, grade, bloom_level, solo_target, knowledge_type,
          threshold_concept, lesson_model, difficulty_level, al_format, kolb_phase,
          html_content, ilos, estimated_minutes, total_points, author_id, status
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'draft')
        RETURNING *`,
        [body.lesson_code, body.title, body.subject, body.grade, body.bloom_level,
         body.solo_target, body.knowledge_type, body.threshold_concept, body.lesson_model,
         body.difficulty_level, body.al_format, body.kolb_phase, body.html_content,
         JSON.stringify(body.ilos), body.estimated_minutes, body.total_points, req.user.id]
      )
      // Trigger AURA pipeline for html_content
      if (body.html_content) {
        await fastify.redis.publish('aura:pipeline', JSON.stringify({
          lesson_id: result.rows[0].id,
          material_type: 'html',
          content: body.html_content,
        }))
      }
      return reply.status(201).send({ data: result.rows[0] })
    }
  )

  // PATCH /api/v1/lessons/:id — update
  fastify.patch<{ Params: { id: string } }>(
    '/:id',
    { preHandler: [fastify.authenticate, fastify.authorizeRole('teacher', 'admin')] },
    async (req, reply) => {
      const result = await fastify.db.query(
        `UPDATE lessons SET html_content = COALESCE($1, html_content),
         title = COALESCE($2, title), status = COALESCE($3, status), updated_at = NOW()
         WHERE id = $4 AND deleted_at IS NULL RETURNING *`,
        [(req.body as any).html_content, (req.body as any).title, (req.body as any).status, req.params.id]
      )
      return { data: result.rows[0] }
    }
  )

  // POST /api/v1/lessons/:id/publish
  fastify.post<{ Params: { id: string } }>(
    '/:id/publish',
    { preHandler: [fastify.authenticate, fastify.authorizeRole('teacher', 'admin')] },
    async (req, reply) => {
      const result = await fastify.db.query(
        `UPDATE lessons SET status = 'published', published_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND deleted_at IS NULL RETURNING id, title, status`,
        [req.params.id]
      )
      return { data: result.rows[0] }
    }
  )

  // GET /api/v1/lessons/std791 — browse YCCĐ catalog (from JSON file)
  fastify.get('/std791', { preHandler: [fastify.authenticate] }, async (req: FastifyRequest, reply) => {
    const { grade, bloom_level, search, limit = 50 } = req.query as any
    const result = await fastify.db.query(
      `SELECT id, lesson_code, title, grade, bloom_level, yccđ_requirement,
              lesson_model, difficulty_level, status
       FROM lessons WHERE deleted_at IS NULL
       ${grade ? 'AND grade = ' + parseInt(grade) : ''}
       ${bloom_level ? 'AND bloom_level = ' + parseInt(bloom_level) : ''}
       ORDER BY grade, lesson_code LIMIT $1`,
      [limit]
    )
    return { data: result.rows }
  })
}

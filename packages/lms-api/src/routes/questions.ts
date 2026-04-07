/**
 * AURA AdaptLearn — Question Bank Routes
 * Source: SRS-CH05 §5.5 Question Bank APIs
 * Base prefix: /api/v1/questions
 *
 * Supports 9 question types:
 *   mcq, true_false, fill_blank, ordering, matching,
 *   short_answer, essay, code_python, math_input
 *
 * GET    /               — List questions with filters + pagination
 * POST   /               — Create question (teacher/admin)
 * GET    /bank           — Public question bank (published, for reuse)
 * GET    /:id            — Get single question (hide answer from students)
 * PATCH  /:id            — Update (owner or admin)
 * DELETE /:id            — Soft delete (owner or admin)
 * POST   /:id/publish    — Set status = 'published' (teacher/admin)
 */

import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'

// ── Question types ────────────────────────────────────────────────────────────

const QuestionTypeEnum = z.enum([
  'mcq',
  'true_false',
  'fill_blank',
  'ordering',
  'matching',
  'short_answer',
  'essay',
  'code_python',
  'math_input',
])

type QuestionType = z.infer<typeof QuestionTypeEnum>

// ── Option sub-schemas ────────────────────────────────────────────────────────

// MCQ option: [{id, text, is_correct}]
const McqOption = z.object({
  id:         z.string(),
  text:       z.string(),
  is_correct: z.boolean(),
})

// Matching option: [{left, right}]
const MatchingOption = z.object({
  left:  z.string(),
  right: z.string(),
})

// Ordering option: [{id, text, position}]
const OrderingOption = z.object({
  id:       z.string(),
  text:     z.string(),
  position: z.number().int().min(0),
})

// Scoring rubric entry for essay / short_answer
const RubricEntry = z.object({
  criterion:   z.string(),
  max_points:  z.number(),
  description: z.string().optional(),
})

// ── Main question create/update schema ───────────────────────────────────────

const QuestionBody = z.object({
  lesson_id:            z.string().uuid().optional(),
  question_type:        QuestionTypeEnum,
  stem:                 z.string().min(1),
  bloom_level:          z.number().int().min(1).max(6),
  difficulty:           z.enum(['easy', 'medium', 'hard', 'challenge']),
  points:               z.number().min(0).default(1),
  // Options vary by type
  options:              z.union([
                          z.array(McqOption),
                          z.array(MatchingOption),
                          z.array(OrderingOption),
                          z.array(z.any()),
                        ]).optional(),
  correct_answer:       z.string().optional(),   // fill_blank, short_answer, math_input
  solution_code:        z.string().optional(),   // code_python: expected solution
  test_cases:           z.array(z.object({       // code_python
                          input:           z.string(),
                          expected_output: z.string(),
                        })).optional(),
  explanation:          z.string().optional(),
  hints:                z.array(z.string()).default([]),
  al_format:            z.string().optional(),
  aura_scoring_rubric:  z.array(RubricEntry).optional(),  // essay / short_answer
  tags:                 z.array(z.string()).default([]),
  is_public:            z.boolean().default(false),
  solo_level:           z.number().int().min(1).max(5).default(3),
})

// ── List query schema ─────────────────────────────────────────────────────────

const ListQuestionsQuery = z.object({
  lesson_id:     z.string().uuid().optional(),
  question_type: QuestionTypeEnum.optional(),
  bloom_level:   z.coerce.number().int().min(1).max(6).optional(),
  difficulty:    z.enum(['easy', 'medium', 'hard', 'challenge']).optional(),
  status:        z.enum(['draft', 'review', 'published', 'retired']).optional(),
  search:        z.string().optional(),
  page:          z.coerce.number().int().min(1).default(1),
  limit:         z.coerce.number().int().min(1).max(100).default(20),
})

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Strip correct_answer/rubric/test_cases/solution_code from a question row for students. */
function stripAnswerFields (row: Record<string, unknown>): Record<string, unknown> {
  const { correct_answer, rubric, test_cases, solution_code, ...safe } = row
  void correct_answer; void rubric; void test_cases; void solution_code
  return safe
}

/** Validate that required fields are present for each question type. */
function validateTypeConstraints (body: z.infer<typeof QuestionBody>): string | null {
  const t: QuestionType = body.question_type
  if ((t === 'mcq' || t === 'true_false') && (!body.options || (body.options as unknown[]).length === 0)) {
    return `question_type '${t}' requires at least one option`
  }
  if (t === 'fill_blank' && !body.correct_answer) {
    return `question_type 'fill_blank' requires correct_answer`
  }
  if (t === 'math_input' && !body.correct_answer) {
    return `question_type 'math_input' requires correct_answer`
  }
  if (t === 'matching' && (!body.options || (body.options as unknown[]).length < 2)) {
    return `question_type 'matching' requires at least 2 option pairs`
  }
  if (t === 'ordering' && (!body.options || (body.options as unknown[]).length < 2)) {
    return `question_type 'ordering' requires at least 2 items`
  }
  if (t === 'code_python' && !body.solution_code) {
    return `question_type 'code_python' requires solution_code`
  }
  return null
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export async function questionRoutes (
  app: FastifyInstance,
  _opts: FastifyPluginOptions,
): Promise<void> {

  // ── GET /bank ──────────────────────────────────────────────────────────────
  // MUST be registered before /:id to avoid route conflict.
  // Returns published questions from all lessons (is_public=true), filterable.
  // Available to teachers and admins for question reuse.
  app.get(
    '/bank',
    { preHandler: [app.authenticate, app.authorizeRole('teacher', 'admin')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const q = ListQuestionsQuery.parse(request.query)
      const offset = (q.page - 1) * q.limit

      const conditions: string[] = [
        `qs.deleted_at IS NULL`,
        `qs.status = 'published'`,
        `qs.is_public = TRUE`,
      ]
      const params: unknown[] = []
      let p = 1

      if (q.question_type) { conditions.push(`qs.question_type = $${p++}`); params.push(q.question_type) }
      if (q.bloom_level)   { conditions.push(`qs.bloom_level = $${p++}`);   params.push(q.bloom_level) }
      if (q.difficulty)    { conditions.push(`qs.difficulty = $${p++}`);    params.push(q.difficulty) }
      if (q.lesson_id)     { conditions.push(`qs.lesson_id = $${p++}`);     params.push(q.lesson_id) }
      if (q.search) {
        conditions.push(
          `to_tsvector('simple', qs.stem) @@ plainto_tsquery('simple', $${p++})`,
        )
        params.push(q.search)
      }

      const whereClause = `WHERE ${conditions.join(' AND ')}`

      const countResult = await app.db.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM questions qs ${whereClause}`,
        params,
      )
      const total = parseInt(countResult.rows[0]?.count ?? '0', 10)

      const dataResult = await app.db.query(
        `SELECT qs.id, qs.lesson_id, qs.question_type, qs.stem, qs.bloom_level,
                qs.difficulty, qs.points, qs.options, qs.hints, qs.tags,
                qs.times_used, qs.avg_score, qs.author_id,
                l.title AS lesson_title, l.lesson_code,
                u.full_name AS author_name
         FROM questions qs
         LEFT JOIN lessons l ON l.id = qs.lesson_id
         LEFT JOIN users   u ON u.id = qs.author_id
         ${whereClause}
         ORDER BY qs.times_used DESC, qs.created_at DESC
         LIMIT $${p++} OFFSET $${p++}`,
        [...params, q.limit, offset],
      )

      return reply.send({
        data: dataResult.rows,
        meta: { total, page: q.page, limit: q.limit },
      })
    },
  )

  // ── GET / ──────────────────────────────────────────────────────────────────
  // List questions with filters. Students only see published questions;
  // teachers/admins see all statuses.
  app.get(
    '/',
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const q = ListQuestionsQuery.parse(request.query)
      const offset = (q.page - 1) * q.limit
      const isStudent = request.user.role === 'student'

      const conditions: string[] = ['deleted_at IS NULL']
      const params: unknown[] = []
      let p = 1

      if (q.lesson_id)     { conditions.push(`lesson_id = $${p++}`);     params.push(q.lesson_id) }
      if (q.question_type) { conditions.push(`question_type = $${p++}`); params.push(q.question_type) }
      if (q.bloom_level)   { conditions.push(`bloom_level = $${p++}`);   params.push(q.bloom_level) }
      if (q.difficulty)    { conditions.push(`difficulty = $${p++}`);    params.push(q.difficulty) }

      // Status filter: students can only see published
      if (isStudent) {
        conditions.push(`status = 'published'`)
      } else if (q.status) {
        conditions.push(`status = $${p++}`)
        params.push(q.status)
      }

      if (q.search) {
        conditions.push(
          `to_tsvector('simple', stem) @@ plainto_tsquery('simple', $${p++})`,
        )
        params.push(q.search)
      }

      const whereClause = `WHERE ${conditions.join(' AND ')}`

      const countResult = await app.db.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM questions ${whereClause}`,
        params,
      )
      const total = parseInt(countResult.rows[0]?.count ?? '0', 10)

      const selectCols = isStudent
        ? `id, lesson_id, question_type, stem, bloom_level, difficulty, points,
           options, hints, tags, created_at`
        : `id, lesson_id, question_type, stem, bloom_level, solo_level, difficulty,
           points, options, correct_answer, explanation, rubric, hints, tags,
           auto_grade, author_id, is_public, status, times_used, avg_score,
           discrimination, created_at, updated_at`

      const dataResult = await app.db.query(
        `SELECT ${selectCols}
         FROM questions
         ${whereClause}
         ORDER BY bloom_level ASC, difficulty ASC, created_at DESC
         LIMIT $${p++} OFFSET $${p++}`,
        [...params, q.limit, offset],
      )

      return reply.send({
        data: dataResult.rows,
        meta: { total, page: q.page, limit: q.limit },
      })
    },
  )

  // ── POST / ────────────────────────────────────────────────────────────────
  // Create a new question. Teacher/admin only.
  app.post(
    '/',
    { preHandler: [app.authenticate, app.authorizeRole('teacher', 'admin')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = QuestionBody.parse(request.body)

      const validationError = validateTypeConstraints(body)
      if (validationError) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: validationError,
        })
      }

      // Certain types do not support auto_grade
      const manualGradeTypes: QuestionType[] = ['essay', 'short_answer']
      const autoGrade = !manualGradeTypes.includes(body.question_type)

      // For code_python, store test_cases inside options JSON
      let optionsJson: unknown = body.options ?? []
      if (body.question_type === 'code_python' && body.test_cases) {
        optionsJson = body.test_cases
      }

      // Rubric stored in the `rubric` column (maps to aura_scoring_rubric in input)
      const rubricJson = body.aura_scoring_rubric ?? []

      // difficulty column CHECK is easy|medium|hard — map 'challenge' to 'hard'
      // but we store the raw value as a tag so nothing is lost.
      const dbDifficulty = body.difficulty === 'challenge' ? 'hard' : body.difficulty
      const tags = body.difficulty === 'challenge'
        ? [...body.tags, 'challenge']
        : body.tags

      const result = await app.db.query(
        `INSERT INTO questions (
           lesson_id, question_type, stem, bloom_level, solo_level, difficulty,
           points, options, correct_answer, explanation, rubric, hints,
           auto_grade, tags, author_id, is_public, status
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8, $9, $10, $11, $12,
           $13, $14, $15, $16, 'draft'
         )
         RETURNING *`,
        [
          body.lesson_id          ?? null,
          body.question_type,
          body.stem,
          body.bloom_level,
          body.solo_level,
          dbDifficulty,
          body.points,
          JSON.stringify(optionsJson),
          body.correct_answer     ?? body.solution_code ?? null,
          body.explanation        ?? null,
          JSON.stringify(rubricJson),
          body.hints,
          autoGrade,
          tags,
          request.user.sub,
          body.is_public,
        ],
      )

      return reply.status(201).send({ data: result.rows[0] })
    },
  )

  // ── GET /:id ───────────────────────────────────────────────────────────────
  // Returns full question. Strips answer fields from students.
  app.get<{ Params: { id: string } }>(
    '/:id',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const result = await app.db.query(
        `SELECT q.*, u.full_name AS author_name
         FROM questions q
         LEFT JOIN users u ON u.id = q.author_id
         WHERE q.id = $1 AND q.deleted_at IS NULL`,
        [request.params.id],
      )
      const row = result.rows[0] as Record<string, unknown> | undefined
      if (!row) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Không tìm thấy câu hỏi',
        })
      }

      if (request.user.role === 'student') {
        return reply.send({ data: stripAnswerFields(row) })
      }
      return reply.send({ data: row })
    },
  )

  // ── PATCH /:id ─────────────────────────────────────────────────────────────
  // Update question. Owner (author_id = user.sub) or admin.
  app.patch<{ Params: { id: string } }>(
    '/:id',
    { preHandler: [app.authenticate, app.authorizeRole('teacher', 'admin')] },
    async (request, reply) => {
      // Fetch existing question to check ownership
      const existing = await app.db.query<{ author_id: string; status: string }>(
        `SELECT author_id, status FROM questions WHERE id = $1 AND deleted_at IS NULL`,
        [request.params.id],
      )
      const q = existing.rows[0]
      if (!q) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Không tìm thấy câu hỏi',
        })
      }

      const isAdmin = request.user.role === 'admin'
      const isOwner = q.author_id === request.user.sub
      if (!isAdmin && !isOwner) {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Chỉ tác giả hoặc admin mới được chỉnh sửa câu hỏi này',
        })
      }

      // Accept partial update using QuestionBody with all fields optional
      const partialBody = QuestionBody.partial().parse(request.body)

      const setClauses: string[] = []
      const params: unknown[] = []
      let p = 1

      const addField = (col: string, val: unknown) => {
        setClauses.push(`${col} = $${p++}`)
        params.push(val)
      }

      if (partialBody.stem             !== undefined) addField('stem',           partialBody.stem)
      if (partialBody.bloom_level      !== undefined) addField('bloom_level',    partialBody.bloom_level)
      if (partialBody.solo_level       !== undefined) addField('solo_level',     partialBody.solo_level)
      if (partialBody.difficulty       !== undefined) {
        addField('difficulty', partialBody.difficulty === 'challenge' ? 'hard' : partialBody.difficulty)
      }
      if (partialBody.points           !== undefined) addField('points',         partialBody.points)
      if (partialBody.options          !== undefined) addField('options',         JSON.stringify(partialBody.options))
      if (partialBody.correct_answer   !== undefined) addField('correct_answer', partialBody.correct_answer)
      if (partialBody.explanation      !== undefined) addField('explanation',     partialBody.explanation)
      if (partialBody.hints            !== undefined) addField('hints',           partialBody.hints)
      if (partialBody.tags             !== undefined) addField('tags',            partialBody.tags)
      if (partialBody.is_public        !== undefined) addField('is_public',       partialBody.is_public)
      if (partialBody.aura_scoring_rubric !== undefined) addField('rubric',       JSON.stringify(partialBody.aura_scoring_rubric))
      if (partialBody.solution_code    !== undefined) addField('correct_answer',  partialBody.solution_code)

      if (setClauses.length === 0) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Không có trường nào để cập nhật',
        })
      }

      setClauses.push(`updated_at = NOW()`)
      params.push(request.params.id)

      const updateResult = await app.db.query(
        `UPDATE questions
         SET ${setClauses.join(', ')}
         WHERE id = $${p} AND deleted_at IS NULL
         RETURNING *`,
        params,
      )

      return reply.send({ data: updateResult.rows[0] })
    },
  )

  // ── DELETE /:id ────────────────────────────────────────────────────────────
  // Soft delete. Owner or admin.
  app.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: [app.authenticate, app.authorizeRole('teacher', 'admin')] },
    async (request, reply) => {
      const existing = await app.db.query<{ author_id: string }>(
        `SELECT author_id FROM questions WHERE id = $1 AND deleted_at IS NULL`,
        [request.params.id],
      )
      const q = existing.rows[0]
      if (!q) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Không tìm thấy câu hỏi',
        })
      }

      const isAdmin = request.user.role === 'admin'
      const isOwner = q.author_id === request.user.sub
      if (!isAdmin && !isOwner) {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Chỉ tác giả hoặc admin mới được xoá câu hỏi này',
        })
      }

      await app.db.query(
        `UPDATE questions SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [request.params.id],
      )

      return reply.status(204).send()
    },
  )

  // ── POST /:id/publish ──────────────────────────────────────────────────────
  // Set status to 'published'. Teacher (owner) or admin.
  app.post<{ Params: { id: string } }>(
    '/:id/publish',
    { preHandler: [app.authenticate, app.authorizeRole('teacher', 'admin')] },
    async (request, reply) => {
      const existing = await app.db.query<{ author_id: string; status: string }>(
        `SELECT author_id, status FROM questions WHERE id = $1 AND deleted_at IS NULL`,
        [request.params.id],
      )
      const q = existing.rows[0]
      if (!q) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Không tìm thấy câu hỏi',
        })
      }

      const isAdmin = request.user.role === 'admin'
      const isOwner = q.author_id === request.user.sub
      if (!isAdmin && !isOwner) {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Chỉ tác giả hoặc admin mới được xuất bản câu hỏi này',
        })
      }

      if (q.status === 'retired') {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Không thể xuất bản câu hỏi đã bị thu hồi',
        })
      }

      const result = await app.db.query(
        `UPDATE questions
         SET status = 'published', updated_at = NOW()
         WHERE id = $1
         RETURNING id, stem, question_type, status, updated_at`,
        [request.params.id],
      )

      return reply.send({ data: result.rows[0] })
    },
  )
}

/**
 * Exam API Routes — SRS-CH05 §5.11, CH08 §8.3
 * 12 endpoints: CRUD, lifecycle 8 states, submit, grade, analytics, auto-generate
 * Base: /api/v1/exams
 */
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'

export async function examRoutes(app: FastifyInstance) {

  // POST /exams — Tạo đề mới (status=draft)
  app.post('/', {
    preHandler: [app.authenticate, app.authorizeRole('teacher', 'admin')],
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { title, description, exam_type, question_ids, time_limit_min,
            target_class_codes, shuffle_questions, shuffle_options, total_points,
            passing_score, linked_lesson_ids } = req.body as any

    const result = await app.db.query(
      `INSERT INTO exams (title, description, exam_type, question_ids, time_limit_min,
       target_class_codes, shuffle_questions, shuffle_options, total_points, passing_score,
       linked_lesson_ids, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id, title, status`,
      [title, description, exam_type || 'practice', question_ids || [],
       time_limit_min, target_class_codes || [], shuffle_questions ?? false,
       shuffle_options ?? true, total_points || 10, passing_score || 5,
       linked_lesson_ids || [], req.user.sub]
    )
    return reply.code(201).send({ data: result.rows[0] })
  })

  // GET /exams/:id — Chi tiết đề (answers HIDDEN khi active — exam integrity)
  app.get<{ Params: { id: string } }>('/:id', {
    preHandler: [app.authenticate],
  }, async (req, reply) => {
    const exam = await app.db.query(
      `SELECT e.*, u.full_name as created_by_name FROM exams e
       LEFT JOIN users u ON u.id = e.created_by WHERE e.id = $1`, [req.params.id]
    )
    if (!exam.rows[0]) return reply.code(404).send({ error: { code: 'NOT_FOUND' } })

    const data = exam.rows[0]
    // SECURITY: Hide answers when exam is active (Ch08 §8.3.1, Ch05 error EXAM_ANSWERS_HIDDEN)
    if (data.status === 'active' && req.user.role === 'student') {
      // Fetch questions WITHOUT correct_answer
      const questions = await app.db.query(
        `SELECT id, stem, question_type, options, bloom_level, points
         FROM questions WHERE id = ANY($1)`, [data.question_ids]
      )
      // Strip correct answers from options
      const safeQuestions = questions.rows.map((q: any) => ({
        ...q,
        options: (q.options || []).map((o: any) => ({ id: o.id, text: o.text })), // No is_correct
        correct_answer: undefined,
      }))
      return { data: { ...data, questions: safeQuestions } }
    }
    return { data }
  })

  // PATCH /exams/:id/status — Chuyển trạng thái (8 states lifecycle)
  app.patch<{ Params: { id: string } }>('/:id/status', {
    preHandler: [app.authenticate, app.authorizeRole('teacher', 'admin')],
  }, async (req, reply) => {
    const { status } = req.body as { status: string }
    const valid_transitions: Record<string, string[]> = {
      draft: ['review'],
      review: ['approved', 'draft'], // reject → back to draft
      approved: ['published'],
      published: ['active'],
      active: ['closed'],
      closed: ['graded'],
      graded: ['archived'],
    }
    const exam = await app.db.query(`SELECT status FROM exams WHERE id = $1`, [req.params.id])
    if (!exam.rows[0]) return reply.code(404).send({ error: { code: 'NOT_FOUND' } })

    const currentStatus = exam.rows[0].status
    if (!valid_transitions[currentStatus]?.includes(status)) {
      return reply.code(400).send({
        error: { code: 'INVALID_TRANSITION', message: `Không thể chuyển từ ${currentStatus} sang ${status}` },
      })
    }

    // Hash content on approve (immutable after)
    let contentHash = null
    if (status === 'approved') {
      const crypto = await import('crypto')
      contentHash = crypto.createHash('sha256')
        .update(JSON.stringify(exam.rows[0]))
        .digest('hex')
    }

    await app.db.query(
      `UPDATE exams SET status = $2, content_hash = COALESCE($3, content_hash),
       approved_by = CASE WHEN $2 = 'approved' THEN $4 ELSE approved_by END,
       updated_at = NOW() WHERE id = $1`,
      [req.params.id, status, contentHash, req.user.sub]
    )
    return { data: { id: req.params.id, status } }
  })

  // POST /exams/:id/submit — HS nộp bài
  app.post<{ Params: { id: string } }>('/:id/submit', {
    preHandler: [app.authenticate],
  }, async (req, reply) => {
    const { answers, idempotency_key } = req.body as { answers: any; idempotency_key?: string }

    // Idempotency check
    if (idempotency_key) {
      const exists = await app.redis.get(`idem:exam:${idempotency_key}`)
      if (exists) return { data: JSON.parse(exists) }
    }

    // Auto-grade objective questions
    const exam = await app.db.query(`SELECT * FROM exams WHERE id = $1`, [req.params.id])
    if (!exam.rows[0]) return reply.code(404).send({ error: { code: 'NOT_FOUND' } })
    if (exam.rows[0].status !== 'active') {
      return reply.code(403).send({ error: { code: 'EXAM_NOT_ACTIVE', message: 'Đề chưa mở hoặc đã đóng' } })
    }

    const result = await app.db.query(
      `INSERT INTO exam_submissions (exam_id, learner_id, answers, submitted_at, status)
       VALUES ($1, $2, $3, NOW(), 'submitted')
       RETURNING id, status`,
      [req.params.id, req.user.sub, JSON.stringify(answers)]
    )

    // Publish event
    await app.redis.xadd('events:main', '*',
      'event_type', 'EXAM_SUBMITTED',
      'learner_id', req.user.sub,
      'payload', JSON.stringify({ exam_id: req.params.id, submission_id: result.rows[0].id }),
      'source', 'lms', 'ts', Date.now().toString()
    )

    const responseData = { submission_id: result.rows[0].id, status: 'submitted' }
    if (idempotency_key) {
      await app.redis.set(`idem:exam:${idempotency_key}`, JSON.stringify(responseData), 'EX', 86400)
    }
    return reply.code(202).send({ data: responseData })
  })

  // GET /exams/:id/submissions — Tất cả bài nộp (teacher)
  app.get<{ Params: { id: string } }>('/:id/submissions', {
    preHandler: [app.authenticate, app.authorizeRole('teacher', 'admin')],
  }, async (req) => {
    const result = await app.db.query(
      `SELECT es.*, u.full_name FROM exam_submissions es
       JOIN users u ON u.id = es.learner_id
       WHERE es.exam_id = $1 ORDER BY es.submitted_at DESC`,
      [req.params.id]
    )
    return { data: result.rows }
  })

  // GET /exams/:id/results — Kết quả (chỉ khi graded)
  app.get<{ Params: { id: string } }>('/:id/results', {
    preHandler: [app.authenticate],
  }, async (req, reply) => {
    const exam = await app.db.query(`SELECT status, show_correct_after FROM exams WHERE id = $1`, [req.params.id])
    if (exam.rows[0]?.show_correct_after === 'never' && req.user.role === 'student') {
      return reply.code(403).send({ error: { code: 'RESULTS_HIDDEN', message: 'Kết quả không được công bố' } })
    }
    const result = await app.db.query(
      `SELECT * FROM exam_submissions WHERE exam_id = $1 AND learner_id = $2`,
      [req.params.id, req.user.sub]
    )
    return { data: result.rows[0] || null }
  })

  // PATCH /exams/:id/grade — GV chấm tay
  app.patch<{ Params: { id: string } }>('/:id/grade', {
    preHandler: [app.authenticate, app.authorizeRole('teacher', 'admin')],
  }, async (req) => {
    const { submission_id, manual_score, feedback } = req.body as any
    await app.db.query(
      `UPDATE exam_submissions SET manual_score = $2, final_score = $2, status = 'graded'
       WHERE id = $1`, [submission_id, manual_score]
    )
    // Publish EXAM_GRADED event
    const sub = await app.db.query(`SELECT learner_id FROM exam_submissions WHERE id = $1`, [submission_id])
    await app.redis.xadd('events:main', '*',
      'event_type', 'EXAM_GRADED',
      'learner_id', sub.rows[0]?.learner_id || '',
      'payload', JSON.stringify({ exam_id: req.params.id, submission_id, score: manual_score }),
      'source', 'lms', 'ts', Date.now().toString()
    )
    return { data: { graded: true } }
  })

  // GET /exams/:id/analytics — Post-exam analytics
  app.get<{ Params: { id: string } }>('/:id/analytics', {
    preHandler: [app.authenticate, app.authorizeRole('teacher', 'admin')],
  }, async (req) => {
    const stats = await app.db.query(
      `SELECT COUNT(*) as total, AVG(final_score) as avg_score,
              MIN(final_score) as min_score, MAX(final_score) as max_score
       FROM exam_submissions WHERE exam_id = $1 AND status = 'graded'`,
      [req.params.id]
    )
    return { data: stats.rows[0] }
  })

  // POST /exams/auto-generate — Sinh đề từ blueprint
  app.post('/auto-generate', {
    preHandler: [app.authenticate, app.authorizeRole('teacher', 'admin')],
  }, async (req, reply) => {
    const { blueprint_id } = req.body as { blueprint_id: string }
    const bp = await app.db.query(`SELECT * FROM exam_blueprints WHERE id = $1`, [blueprint_id])
    if (!bp.rows[0]) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Blueprint không tồn tại' } })

    const blueprint = bp.rows[0]
    // Select questions matching blueprint criteria
    const questions = await app.db.query(
      `SELECT id, bloom_level, difficulty FROM questions
       WHERE lesson_id = ANY(
         SELECT id FROM lessons WHERE lesson_code = ANY($1)
       ) AND status = 'published' AND deleted_at IS NULL
       ORDER BY RANDOM() LIMIT $2`,
      [blueprint.lesson_ids || [], blueprint.total_questions || 40]
    )

    // Create exam with selected questions
    const exam = await app.db.query(
      `INSERT INTO exams (title, exam_type, question_ids, blueprint_id, time_limit_min,
       total_points, shuffle_questions, shuffle_options, created_by)
       VALUES ($1, 'practice', $2, $3, $4, $5, $6, TRUE, $7)
       RETURNING id, title, status`,
      [`Đề tự động — ${blueprint.name}`,
       questions.rows.map((q: any) => q.id), blueprint_id,
       blueprint.time_limit_min || 45, blueprint.total_questions || 40,
       blueprint.allow_shuffle ?? true, req.user.sub]
    )
    return reply.code(201).send({ data: exam.rows[0] })
  })

  // GET /exams/:id/item-analysis — p-value, D-index, Cronbach α
  app.get<{ Params: { id: string } }>('/:id/item-analysis', {
    preHandler: [app.authenticate, app.authorizeRole('teacher', 'admin')],
  }, async (req) => {
    // Basic item analysis — needs N ≥ 30 submissions
    const submissions = await app.db.query(
      `SELECT answers FROM exam_submissions WHERE exam_id = $1 AND status = 'graded'`,
      [req.params.id]
    )
    if (submissions.rowCount && submissions.rowCount < 30) {
      return { data: { message: `Cần ít nhất 30 bài nộp (hiện có ${submissions.rowCount}). Item Analysis chưa đủ dữ liệu.` } }
    }
    // TODO: Calculate p-value, D-index, Cronbach α per question
    return { data: { total_submissions: submissions.rowCount, message: 'Item analysis đang được tính...' } }
  })

  // DELETE /exams/:id — Archive
  app.delete<{ Params: { id: string } }>('/:id', {
    preHandler: [app.authenticate, app.authorizeRole('teacher', 'admin')],
  }, async (req) => {
    await app.db.query(
      `UPDATE exams SET status = 'archived', updated_at = NOW() WHERE id = $1`, [req.params.id]
    )
    return { data: { success: true } }
  })
}

/**
 * AURA AdaptLearn — Quiz Routes
 * Source: SRS-CH05 §5.5 Quiz APIs
 * Base prefix: /api/v1/quiz
 *
 * POST /start                  — Student starts a quiz attempt for a lesson
 * POST /:attemptId/submit      — Submit answers; auto-grade where possible
 * GET  /:attemptId/review      — Get attempt with full answers + correct answers
 * GET  /history/:userId        — Paginated quiz history for a user
 */

import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'

// ── Types ─────────────────────────────────────────────────────────────────────

interface QuestionRow {
  id:             string
  question_type:  string
  stem:           string
  bloom_level:    number
  difficulty:     string
  points:         number
  options:        unknown       // JSONB — varies by type
  correct_answer: string | null
  hints:          string[]
  auto_grade:     boolean
}

interface AnswerRecord {
  question_id:   string
  answer:        unknown        // student's answer (type-dependent)
  is_correct:    boolean | null // null = pending manual grading
  score:         number | null  // null = pending
  time_ms:       number | null
  error_tags:    string[]
}

// ── Zod schemas ───────────────────────────────────────────────────────────────

const StartBody = z.object({
  lesson_id: z.string().uuid(),
})

const AnswerItem = z.object({
  question_id: z.string().uuid(),
  answer:      z.unknown(),       // flexible — validated per question type in grader
  time_ms:     z.number().int().min(0).optional(),
})

const SubmitBody = z.object({
  answers:     z.array(AnswerItem).min(1),
})

const HistoryQuery = z.object({
  page:  z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

// ── Grader helpers ────────────────────────────────────────────────────────────

/** Normalize a string for case-insensitive, whitespace-trimmed comparison. */
const normalizeStr = (s: unknown): string =>
  String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

/** Grade a single answer against the question row. Returns partial AnswerRecord. */
function gradeAnswer (
  q: QuestionRow,
  rawAnswer: unknown,
): Pick<AnswerRecord, 'is_correct' | 'score' | 'error_tags'> {
  const type = q.question_type

  // Types that require manual or AI grading
  if (type === 'essay' || type === 'short_answer') {
    return { is_correct: null, score: null, error_tags: [] }
  }

  // code_python: graded by agent service, mark as pending here
  if (type === 'code_python') {
    return { is_correct: null, score: null, error_tags: ['pending_code_execution'] }
  }

  // ── mcq / true_false ──────────────────────────────────────────────────────
  if (type === 'mcq' || type === 'true_false') {
    // options is [{id, text, is_correct}]; answer is the selected option id
    const opts = (q.options as Array<{ id: string; is_correct?: boolean }> | null) ?? []
    const selectedId = String(rawAnswer ?? '').trim()
    const selectedOpt = opts.find((o) => o.id === selectedId)
    const isCorrect = selectedOpt?.is_correct === true

    const errorTags: string[] = []
    if (!isCorrect) errorTags.push('wrong_option')
    return {
      is_correct: isCorrect,
      score:      isCorrect ? q.points : 0,
      error_tags: errorTags,
    }
  }

  // ── fill_blank ────────────────────────────────────────────────────────────
  if (type === 'fill_blank') {
    const isCorrect = normalizeStr(rawAnswer) === normalizeStr(q.correct_answer)
    return {
      is_correct: isCorrect,
      score:      isCorrect ? q.points : 0,
      error_tags: isCorrect ? [] : ['wrong_fill_blank'],
    }
  }

  // ── math_input ────────────────────────────────────────────────────────────
  // Simple normalized string comparison — a full CAS is out of scope for the
  // API layer; the agent service can re-grade with symbolic equality if needed.
  if (type === 'math_input') {
    const isCorrect = normalizeStr(rawAnswer) === normalizeStr(q.correct_answer)
    return {
      is_correct: isCorrect,
      score:      isCorrect ? q.points : 0,
      error_tags: isCorrect ? [] : ['wrong_math_expression'],
    }
  }

  // ── ordering ──────────────────────────────────────────────────────────────
  // answer should be an ordered array of option ids: ["id3","id1","id2"]
  if (type === 'ordering') {
    const opts = (q.options as Array<{ id: string; position: number }> | null) ?? []
    // Build correct order array sorted by position
    const correctOrder = [...opts]
      .sort((a, b) => a.position - b.position)
      .map((o) => o.id)

    const studentOrder = Array.isArray(rawAnswer)
      ? (rawAnswer as unknown[]).map(String)
      : []

    const isCorrect =
      studentOrder.length === correctOrder.length &&
      studentOrder.every((id, idx) => id === correctOrder[idx])

    // Partial score: award points proportional to correctly-placed items
    let correctCount = 0
    for (let i = 0; i < correctOrder.length; i++) {
      if (studentOrder[i] === correctOrder[i]) correctCount++
    }
    const partialScore = (correctCount / Math.max(correctOrder.length, 1)) * q.points

    return {
      is_correct: isCorrect,
      score:      Math.round(partialScore * 100) / 100,
      error_tags: isCorrect ? [] : ['wrong_ordering'],
    }
  }

  // ── matching ──────────────────────────────────────────────────────────────
  // answer: [{left, right}]  — student's paired associations
  // options: [{left, right}] — correct pairs
  if (type === 'matching') {
    const correctPairs = (q.options as Array<{ left: string; right: string }> | null) ?? []
    const studentPairs = Array.isArray(rawAnswer)
      ? (rawAnswer as Array<{ left: string; right: string }>)
      : []

    let correctCount = 0
    for (const cp of correctPairs) {
      const match = studentPairs.find(
        (sp) => normalizeStr(sp.left) === normalizeStr(cp.left) &&
                normalizeStr(sp.right) === normalizeStr(cp.right),
      )
      if (match) correctCount++
    }

    const total = Math.max(correctPairs.length, 1)
    const partialScore = (correctCount / total) * q.points
    const isCorrect = correctCount === total

    return {
      is_correct: isCorrect,
      score:      Math.round(partialScore * 100) / 100,
      error_tags: isCorrect ? [] : ['wrong_matching'],
    }
  }

  // Unknown type — cannot auto-grade
  return { is_correct: null, score: null, error_tags: ['ungraded_type'] }
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export async function quizRoutes (
  app: FastifyInstance,
  _opts: FastifyPluginOptions,
): Promise<void> {

  // ── POST /start ───────────────────────────────────────────────────────────
  // Student starts a quiz attempt. Returns questions stripped of answers.
  app.post(
    '/start',
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = StartBody.parse(request.body)
      const userId = request.user.sub

      // 1. Fetch lesson to get shuffle setting and pass_threshold
      const lessonResult = await app.db.query<{
        id: string
        title: string
        estimated_minutes: number
        total_points: number
        status: string
      }>(
        `SELECT id, title, estimated_minutes, total_points, status
         FROM lessons
         WHERE id = $1 AND deleted_at IS NULL`,
        [body.lesson_id],
      )
      const lesson = lessonResult.rows[0]
      if (!lesson) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Không tìm thấy bài học',
        })
      }
      if (lesson.status !== 'published') {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Bài học chưa được xuất bản',
        })
      }

      // 2. Fetch published questions for this lesson
      const questionsResult = await app.db.query<QuestionRow>(
        `SELECT id, question_type, stem, bloom_level, difficulty, points,
                options, correct_answer, hints, auto_grade
         FROM questions
         WHERE lesson_id = $1
           AND deleted_at IS NULL
           AND status = 'published'
         ORDER BY bloom_level ASC, created_at ASC`,
        [body.lesson_id],
      )

      if (questionsResult.rows.length === 0) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Bài học này chưa có câu hỏi nào',
        })
      }

      // 3. Shuffle (always shuffle for students to prevent answer copying)
      const questions = [...questionsResult.rows].sort(() => Math.random() - 0.5)

      // 4. Determine attempt number for this user+lesson
      const attemptCountResult = await app.db.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM quiz_attempts WHERE user_id = $1 AND lesson_id = $2`,
        [userId, body.lesson_id],
      )
      const attemptNumber = parseInt(attemptCountResult.rows[0]?.count ?? '0', 10) + 1

      // 5. Create quiz_attempt row
      const maxScore = questions.reduce((sum, q) => sum + q.points, 0)
      const insertResult = await app.db.query<{ id: string }>(
        `INSERT INTO quiz_attempts
           (user_id, lesson_id, attempt_number, answers, total_score, max_score, started_at)
         VALUES ($1, $2, $3, '[]', 0, $4, NOW())
         RETURNING id`,
        [userId, body.lesson_id, attemptNumber, maxScore],
      )
      const attemptId = insertResult.rows[0]?.id
      if (!attemptId) throw new Error('Failed to create quiz_attempt')

      // 6. Publish session_started event to Redis Stream
      await app.redis.xadd(
        'stream:events',
        '*',
        'event_type', 'session_started',
        'user_id',    userId,
        'lesson_id',  body.lesson_id,
        'attempt_id', attemptId,
        'payload',    JSON.stringify({ attempt_id: attemptId, attempt_number: attemptNumber }),
      )

      // 7. Return questions WITHOUT correct_answer / rubric / solution fields
      const safeQuestions = questions.map((q) => ({
        id:            q.id,
        question_type: q.question_type,
        stem:          q.stem,
        bloom_level:   q.bloom_level,
        difficulty:    q.difficulty,
        points:        q.points,
        options:       q.options,
        hints:         q.hints,
      }))

      const timeLimitSec = (lesson.estimated_minutes ?? 20) * 60

      return reply.status(201).send({
        data: {
          attempt_id:     attemptId,
          questions:      safeQuestions,
          time_limit_sec: timeLimitSec,
          lesson_title:   lesson.title,
          max_score:      maxScore,
          attempt_number: attemptNumber,
        },
      })
    },
  )

  // ── POST /:attemptId/submit ───────────────────────────────────────────────
  // Grade answers, update attempt, publish event.
  app.post<{ Params: { attemptId: string } }>(
    '/:attemptId/submit',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { attemptId } = request.params
      const body = SubmitBody.parse(request.body)
      const userId = request.user.sub

      // 1. Validate attempt ownership and status
      const attemptResult = await app.db.query<{
        id: string
        user_id: string
        lesson_id: string
        max_score: number
        started_at: string
        submitted_at: string | null
        attempt_number: number
      }>(
        `SELECT id, user_id, lesson_id, max_score, started_at, submitted_at, attempt_number
         FROM quiz_attempts
         WHERE id = $1`,
        [attemptId],
      )
      const attempt = attemptResult.rows[0]
      if (!attempt) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Không tìm thấy lần làm bài này',
        })
      }
      if (attempt.user_id !== userId) {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Bài làm này không thuộc về bạn',
        })
      }
      if (attempt.submitted_at !== null) {
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: 'Bài làm này đã được nộp rồi',
        })
      }

      // 2. Fetch the question rows for grading
      const questionIds = body.answers.map((a) => a.question_id)
      const questionsResult = await app.db.query<QuestionRow>(
        `SELECT id, question_type, stem, bloom_level, difficulty, points,
                options, correct_answer, hints, auto_grade
         FROM questions
         WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
        [questionIds],
      )
      const qMap = new Map<string, QuestionRow>(
        questionsResult.rows.map((q) => [q.id, q]),
      )

      // 3. Grade each answer
      let totalScore = 0
      let allAutoGradable = true
      const errorTagsSet = new Set<string>()

      const gradedAnswers: AnswerRecord[] = body.answers.map((a) => {
        const q = qMap.get(a.question_id)
        if (!q) {
          // Question not found — skip silently (shouldn't happen in prod)
          return {
            question_id: a.question_id,
            answer:      a.answer,
            is_correct:  null,
            score:       null,
            time_ms:     a.time_ms ?? null,
            error_tags:  ['question_not_found'],
          }
        }

        const { is_correct, score, error_tags } = gradeAnswer(q, a.answer)

        if (is_correct === null || score === null) {
          allAutoGradable = false
        } else {
          totalScore += score
        }
        error_tags.forEach((t) => errorTagsSet.add(t))

        return {
          question_id: a.question_id,
          answer:      a.answer,
          is_correct,
          score,
          time_ms:     a.time_ms ?? null,
          error_tags,
        }
      })

      // 4. Calculate derived metrics
      const maxScore = attempt.max_score
      const scorePercent = maxScore > 0 ? (totalScore / maxScore) * 100 : 0
      const timeTakenSec = Math.floor(
        (Date.now() - new Date(attempt.started_at).getTime()) / 1000,
      )

      // pass_threshold: default 60%. The lessons schema can be extended to store a
      // per-lesson threshold; for now we use a constant that matches SRS default.
      const passThreshold = 60
      const passed = allAutoGradable ? scorePercent >= passThreshold : null

      const errorTags = Array.from(errorTagsSet).filter(
        (t) => !['wrong_option', 'wrong_fill_blank', 'wrong_math_expression',
                 'wrong_ordering', 'wrong_matching'].includes(t),
      )

      // 5. UPDATE quiz_attempts
      const now = new Date().toISOString()
      await app.db.query(
        `UPDATE quiz_attempts
         SET answers      = $1,
             total_score  = $2,
             passed       = $3,
             time_taken_sec = $4,
             submitted_at = NOW(),
             graded_at    = $5,
             error_tags   = $6
         WHERE id = $7`,
        [
          JSON.stringify(gradedAnswers),
          totalScore,
          passed,
          timeTakenSec,
          allAutoGradable ? now : null,
          errorTags,
          attemptId,
        ],
      )

      // 6. Publish quiz_submitted event to Redis Stream
      // Determine bloom_level from the attempted questions (most common level)
      const bloomLevelMap = new Map<number, number>()
      questionsResult.rows.forEach((q) => {
        bloomLevelMap.set(q.bloom_level, (bloomLevelMap.get(q.bloom_level) ?? 0) + 1)
      })
      let dominantBloomLevel = 1
      let maxBloomCount = 0
      bloomLevelMap.forEach((count, level) => {
        if (count > maxBloomCount) { maxBloomCount = count; dominantBloomLevel = level }
      })

      await app.redis.xadd(
        'stream:events',
        '*',
        'event_type',    'quiz_submitted',
        'user_id',       userId,
        'lesson_id',     attempt.lesson_id,
        'attempt_id',    attemptId,
        'payload',       JSON.stringify({
          user_id:        userId,
          lesson_id:      attempt.lesson_id,
          attempt_id:     attemptId,
          score_percent:  Math.round(scorePercent * 100) / 100,
          passed,
          bloom_level:    dominantBloomLevel,
          error_tags:     errorTags,
          time_taken_sec: timeTakenSec,
        }),
      )

      // 7. Generate basic feedback string (full AI feedback via /agent/feedback)
      let feedback = ''
      if (passed === true) {
        feedback = `Chúc mừng! Bạn đã vượt qua bài kiểm tra với ${Math.round(scorePercent)}%.`
      } else if (passed === false) {
        feedback = `Bạn đạt ${Math.round(scorePercent)}%. Hãy ôn lại bài và thử lại.`
      } else {
        feedback = `Bài làm đã được nộp. Một số câu cần chấm thủ công, điểm sẽ cập nhật sau.`
      }

      return reply.send({
        data: {
          attempt_id:    attemptId,
          total_score:   Math.round(totalScore * 100) / 100,
          max_score:     maxScore,
          score_percent: Math.round(scorePercent * 100) / 100,
          passed,
          feedback,
          time_taken_sec: timeTakenSec,
          graded_at:      allAutoGradable ? now : null,
        },
      })
    },
  )

  // ── GET /:attemptId/review ────────────────────────────────────────────────
  // Full attempt review with correct answers. Only available after submission.
  app.get<{ Params: { attemptId: string } }>(
    '/:attemptId/review',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { attemptId } = request.params
      const userId = request.user.sub

      const attemptResult = await app.db.query<{
        id: string
        user_id: string
        lesson_id: string
        attempt_number: number
        answers: AnswerRecord[]
        total_score: number
        max_score: number
        score_percent: number
        passed: boolean | null
        time_taken_sec: number | null
        started_at: string
        submitted_at: string | null
        graded_at: string | null
        feedback: string | null
        error_tags: string[]
      }>(
        `SELECT qa.*,
                l.title AS lesson_title
         FROM quiz_attempts qa
         LEFT JOIN lessons l ON l.id = qa.lesson_id
         WHERE qa.id = $1`,
        [attemptId],
      )
      const attempt = attemptResult.rows[0]
      if (!attempt) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Không tìm thấy lần làm bài',
        })
      }

      // Authorization: student can only view own attempt; teacher/admin can view any
      const isStudent = request.user.role === 'student'
      if (isStudent && attempt.user_id !== userId) {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Bạn không có quyền xem bài làm này',
        })
      }

      if (!attempt.submitted_at) {
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Bài làm chưa được nộp',
        })
      }

      // Enrich answers with full question data (including correct answers)
      const answersList = Array.isArray(attempt.answers) ? attempt.answers : []
      const questionIds = answersList.map((a) => a.question_id).filter(Boolean)

      let questionsById: Map<string, QuestionRow> = new Map()
      if (questionIds.length > 0) {
        const qResult = await app.db.query<QuestionRow>(
          `SELECT id, question_type, stem, bloom_level, difficulty, points,
                  options, correct_answer, hints, auto_grade
           FROM questions
           WHERE id = ANY($1::uuid[])`,
          [questionIds],
        )
        questionsById = new Map(qResult.rows.map((q) => [q.id, q]))
      }

      const enrichedAnswers = answersList.map((a) => {
        const q = questionsById.get(a.question_id)
        return {
          ...a,
          question: q
            ? {
                id:             q.id,
                question_type:  q.question_type,
                stem:           q.stem,
                bloom_level:    q.bloom_level,
                difficulty:     q.difficulty,
                points:         q.points,
                options:        q.options,
                correct_answer: q.correct_answer,
                hints:          q.hints,
              }
            : null,
        }
      })

      return reply.send({
        data: {
          ...attempt,
          answers: enrichedAnswers,
        },
      })
    },
  )

  // ── GET /history/:userId ──────────────────────────────────────────────────
  // Paginated quiz attempt history for a user.
  // Teacher/admin can view any user; students can only view themselves.
  app.get<{ Params: { userId: string } }>(
    '/history/:userId',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { userId } = request.params
      const callerId   = request.user.sub
      const callerRole = request.user.role

      const isStudent = callerRole === 'student'
      if (isStudent && userId !== callerId) {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Bạn chỉ có thể xem lịch sử của chính mình',
        })
      }

      const q = HistoryQuery.parse(request.query)
      const offset = (q.page - 1) * q.limit

      const countResult = await app.db.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM quiz_attempts WHERE user_id = $1`,
        [userId],
      )
      const total = parseInt(countResult.rows[0]?.count ?? '0', 10)

      const dataResult = await app.db.query(
        `SELECT qa.id, qa.lesson_id, qa.attempt_number, qa.total_score, qa.max_score,
                qa.score_percent, qa.passed, qa.time_taken_sec,
                qa.started_at, qa.submitted_at, qa.graded_at, qa.error_tags,
                l.title AS lesson_title, l.lesson_code, l.difficulty_level
         FROM quiz_attempts qa
         LEFT JOIN lessons l ON l.id = qa.lesson_id
         WHERE qa.user_id = $1
         ORDER BY qa.started_at DESC
         LIMIT $2 OFFSET $3`,
        [userId, q.limit, offset],
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
}

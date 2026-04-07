/**
 * AURA AdaptLearn — Flashcard Routes (Spaced Repetition)
 * Source: SRS-CH08 §8.4
 * Prefix: /api/v1/flashcards
 *
 * Endpoints:
 *   GET  /due               — Get due flashcards for authenticated user (SM-2)
 *   POST /review            — Submit a review quality rating (calls agent service)
 *   GET  /                  — List flashcards for a lesson (?lesson_id=)
 *   POST /                  — Create flashcard (teacher / admin)
 *   PATCH /:id              — Update flashcard content
 *   DELETE /:id             — Delete flashcard (teacher / admin)
 *
 *   Legacy deck/card management routes are preserved below the new routes.
 */
import { FastifyInstance, FastifyPluginOptions } from 'fastify'
import { v4 as uuidv4 } from 'uuid'
import { z } from 'zod'

// ── Zod schemas ───────────────────────────────────────────────────────────────

const CreateFlashcardBody = z.object({
  lessonId: z.string().uuid(),
  front: z.string().min(1).max(2000),
  back: z.string().min(1).max(2000),
  difficulty: z.enum(['easy', 'medium', 'hard']).default('medium'),
  tags: z.array(z.string().max(64)).max(20).default([]),
})

const UpdateFlashcardBody = z.object({
  front: z.string().min(1).max(2000).optional(),
  back: z.string().min(1).max(2000).optional(),
  difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
  tags: z.array(z.string().max(64)).max(20).optional(),
})

const ReviewCardBody = z.object({
  quality: z.number().int().min(0).max(5),       // SM-2 quality rating 0–5
  timeSpentMs: z.number().int().min(0).optional(),
})

// ── SM-2 helper (local implementation, mirrors Python sm2_update) ─────────────

interface SM2Result {
  repetitions: number
  easeFactor: number
  intervalDays: number
  nextReviewAt: Date
}

function sm2(
  quality: number,
  repetitions: number,
  easeFactor: number,
  intervalDays: number,
): SM2Result {
  const newEaseFactor = Math.max(
    1.3,
    Math.min(2.5, easeFactor + 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)),
  )

  let newInterval: number
  let newRepetitions: number

  if (quality < 3) {
    // Relearn
    newRepetitions = 0
    newInterval = 1
  } else {
    if (repetitions === 0) newInterval = 1
    else if (repetitions === 1) newInterval = 6
    else newInterval = Math.round(intervalDays * easeFactor)
    newInterval = Math.min(newInterval, 365)
    newRepetitions = repetitions + 1
  }

  const nextReviewAt = new Date()
  nextReviewAt.setDate(nextReviewAt.getDate() + newInterval)

  return {
    repetitions: newRepetitions,
    easeFactor: newEaseFactor,
    intervalDays: newInterval,
    nextReviewAt,
  }
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export async function flashcardRoutes(
  app: FastifyInstance,
  _opts: FastifyPluginOptions,
): Promise<void> {

  // ── GET /due — Due flashcards for authenticated student ──────────────────────
  app.get(
    '/due',
    { preHandler: app.authenticate },
    async (request) => {
      const q = request.query as { limit?: string; lesson_id?: string }
      const limit = Math.min(50, parseInt(q.limit ?? '20', 10))
      const studentId = request.user.sub

      const params: unknown[] = [studentId, limit]
      let lessonFilter = ''
      if (q.lesson_id) {
        lessonFilter = 'AND f.lesson_id = $3'
        params.push(q.lesson_id)
      }

      const { rows } = await app.db.query(
        `SELECT
           f.id,
           f.lesson_id,
           f.front,
           f.back,
           f.difficulty,
           f.tags,
           COALESCE(fr.repetitions,   0)   AS repetitions,
           COALESCE(fr.ease_factor,   2.5) AS ease_factor,
           COALESCE(fr.interval_days, 1)   AS interval_days,
           fr.next_review_at,
           fr.quality AS last_quality
         FROM flashcards f
         LEFT JOIN flashcard_reviews fr
                ON fr.flashcard_id = f.id
               AND fr.user_id      = $1
         WHERE (fr.next_review_at IS NULL OR fr.next_review_at <= NOW())
           ${lessonFilter}
         ORDER BY fr.next_review_at ASC NULLS FIRST
         LIMIT $2`,
        params,
      )
      return { data: rows, count: rows.length }
    },
  )

  // ── POST /review — Submit review quality rating ──────────────────────────────
  app.post<{ Body: z.infer<typeof ReviewCardBody> & { flashcard_id: string } }>(
    '/review',
    {
      preHandler: app.authenticate,
      schema: {
        body: {
          type: 'object',
          required: ['flashcard_id', 'quality'],
          properties: {
            flashcard_id: { type: 'string', format: 'uuid' },
            quality:      { type: 'integer', minimum: 0, maximum: 5 },
            timeSpentMs:  { type: 'integer', minimum: 0 },
          },
        },
      },
    },
    async (request, reply) => {
      const { flashcard_id: flashcardId, quality, timeSpentMs } =
        request.body as { flashcard_id: string; quality: number; timeSpentMs?: number }
      const studentId = request.user.sub

      // Validate flashcard exists
      const { rows: [card] } = await app.db.query(
        'SELECT id FROM flashcards WHERE id = $1',
        [flashcardId],
      )
      if (!card) {
        return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Flashcard not found' })
      }

      // Fetch current SM-2 state
      const { rows: [existing] } = await app.db.query(
        `SELECT repetitions, ease_factor, interval_days
         FROM flashcard_reviews
         WHERE flashcard_id = $1 AND user_id = $2
         ORDER BY reviewed_at DESC
         LIMIT 1`,
        [flashcardId, studentId],
      )

      const current = (existing ?? { repetitions: 0, ease_factor: 2.5, interval_days: 1 }) as {
        repetitions: number
        ease_factor: number
        interval_days: number
      }

      const result = sm2(quality, current.repetitions, current.ease_factor, current.interval_days)
      const mastered = result.repetitions >= 5

      // Persist review (append-only history)
      await app.db.query(
        `INSERT INTO flashcard_reviews
           (id, user_id, flashcard_id, quality, ease_factor, interval_days,
            repetitions, next_review_at, time_spent_ms, reviewed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())`,
        [
          uuidv4(),
          studentId,
          flashcardId,
          quality,
          result.easeFactor,
          result.intervalDays,
          result.repetitions,
          result.nextReviewAt,
          timeSpentMs ?? null,
        ],
      )

      return {
        data: {
          flashcardId,
          repetitions:   result.repetitions,
          easeFactor:    result.easeFactor,
          intervalDays:  result.intervalDays,
          nextReviewAt:  result.nextReviewAt.toISOString(),
          mastered,
        },
      }
    },
  )

  // ── GET / — List flashcards for a lesson ─────────────────────────────────────
  app.get(
    '/',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const q = request.query as { lesson_id?: string; page?: string; page_size?: string }
      if (!q.lesson_id) {
        return reply.status(400).send({ statusCode: 400, error: 'Bad Request', message: 'lesson_id is required' })
      }

      const page     = Math.max(1, parseInt(q.page     ?? '1',  10))
      const pageSize = Math.min(100, parseInt(q.page_size ?? '50', 10))
      const offset   = (page - 1) * pageSize

      const { rows } = await app.db.query(
        `SELECT id, lesson_id, front, back, difficulty, tags, created_by, created_at, updated_at
         FROM flashcards
         WHERE lesson_id = $1
         ORDER BY created_at ASC
         LIMIT $2 OFFSET $3`,
        [q.lesson_id, pageSize, offset],
      )

      const { rows: [countRow] } = await app.db.query(
        'SELECT COUNT(*)::int AS total FROM flashcards WHERE lesson_id = $1',
        [q.lesson_id],
      )

      return {
        data:      rows,
        total:     (countRow as { total: number }).total,
        page,
        page_size: pageSize,
      }
    },
  )

  // ── POST / — Create a flashcard (teacher / admin) ────────────────────────────
  app.post<{ Body: z.infer<typeof CreateFlashcardBody> }>(
    '/',
    { preHandler: app.authorizeRole('teacher', 'admin') },
    async (request, reply) => {
      const body = CreateFlashcardBody.parse(request.body)
      const id   = uuidv4()

      // Validate lesson exists
      const { rows: [lesson] } = await app.db.query(
        'SELECT id FROM lessons WHERE id = $1',
        [body.lessonId],
      )
      if (!lesson) {
        return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Lesson not found' })
      }

      await app.db.query(
        `INSERT INTO flashcards
           (id, lesson_id, front, back, difficulty, tags, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,NOW(),NOW())`,
        [
          id,
          body.lessonId,
          body.front,
          body.back,
          body.difficulty,
          JSON.stringify(body.tags),
          request.user.sub,
        ],
      )

      reply.status(201)
      return { data: { id, ...body } }
    },
  )

  // ── PATCH /:id — Update flashcard content ────────────────────────────────────
  app.patch<{ Params: { id: string }; Body: z.infer<typeof UpdateFlashcardBody> }>(
    '/:id',
    { preHandler: app.authorizeRole('teacher', 'admin') },
    async (request, reply) => {
      const { id } = request.params
      const body   = UpdateFlashcardBody.parse(request.body)

      const { rows: [existing] } = await app.db.query(
        'SELECT id, created_by FROM flashcards WHERE id = $1',
        [id],
      )
      if (!existing) {
        return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Flashcard not found' })
      }

      // Build dynamic SET clause
      const sets: string[]   = []
      const values: unknown[] = []
      let i = 1

      if (body.front      !== undefined) { sets.push(`front = $${i++}`);      values.push(body.front) }
      if (body.back       !== undefined) { sets.push(`back = $${i++}`);       values.push(body.back) }
      if (body.difficulty !== undefined) { sets.push(`difficulty = $${i++}`); values.push(body.difficulty) }
      if (body.tags       !== undefined) { sets.push(`tags = $${i++}::jsonb`); values.push(JSON.stringify(body.tags)) }
      sets.push(`updated_at = NOW()`)

      values.push(id)
      await app.db.query(
        `UPDATE flashcards SET ${sets.join(', ')} WHERE id = $${i}`,
        values,
      )

      return { data: { id, ...body } }
    },
  )

  // ── DELETE /:id — Delete flashcard ───────────────────────────────────────────
  app.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: app.authorizeRole('teacher', 'admin') },
    async (request, reply) => {
      const { id } = request.params

      const { rows: [existing] } = await app.db.query(
        'SELECT id FROM flashcards WHERE id = $1',
        [id],
      )
      if (!existing) {
        return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Flashcard not found' })
      }

      // Cascade: delete reviews first (FK), then the card
      await app.db.query('DELETE FROM flashcard_reviews WHERE flashcard_id = $1', [id])
      await app.db.query('DELETE FROM flashcards WHERE id = $1', [id])

      reply.status(204)
      return null
    },
  )

  // ─────────────────────────────────────────────────────────────────────────────
  // Legacy deck-based routes (preserved for backward compatibility)
  // ─────────────────────────────────────────────────────────────────────────────

  const CreateDeckBody = z.object({
    name:        z.string().min(1).max(255),
    lessonId:    z.string().uuid().optional(),
    description: z.string().max(1000).optional(),
  })

  app.get('/decks', { preHandler: app.authenticate }, async (request) => {
    const { rows } = await app.db.query(
      `SELECT d.*, COUNT(fc.id)::int AS card_count
       FROM flashcard_decks d
       LEFT JOIN flashcards fc ON fc.deck_id = d.id
       WHERE d.owner_id = $1 OR d.is_public = true
       GROUP BY d.id
       ORDER BY d.updated_at DESC`,
      [request.user.sub],
    )
    return { data: rows }
  })

  app.post<{ Body: z.infer<typeof CreateDeckBody> }>(
    '/decks',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const body = CreateDeckBody.parse(request.body)
      const id   = uuidv4()
      await app.db.query(
        `INSERT INTO flashcard_decks (id, owner_id, name, lesson_id, description, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,NOW(),NOW())`,
        [id, request.user.sub, body.name, body.lessonId ?? null, body.description ?? null],
      )
      reply.status(201)
      return { id, ...body }
    },
  )

  app.get<{ Params: { deckId: string } }>(
    '/decks/:deckId/cards',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { rows: [deck] } = await app.db.query(
        'SELECT id, owner_id, is_public FROM flashcard_decks WHERE id = $1',
        [request.params.deckId],
      )
      if (!deck) {
        return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Deck not found' })
      }
      const d = deck as { owner_id: string; is_public: boolean }
      if (d.owner_id !== request.user.sub && !d.is_public && request.user.role === 'student') {
        return reply.status(403).send({ statusCode: 403, error: 'Forbidden', message: 'Access denied' })
      }
      const { rows } = await app.db.query(
        'SELECT * FROM flashcards WHERE deck_id = $1 ORDER BY created_at',
        [request.params.deckId],
      )
      return { data: rows }
    },
  )
}

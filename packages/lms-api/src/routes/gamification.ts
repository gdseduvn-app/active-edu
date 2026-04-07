/**
 * AURA AdaptLearn — Gamification Routes
 * Source: SRS-CH08 §8.7
 * Prefix: /api/v1/gamification
 *
 * Endpoints:
 *   GET  /leaderboard              — Top 20 students by XP (optional ?class_id=)
 *   GET  /profile/:userId          — XP, level, badges, streak for a user
 *   GET  /xp-history/:userId       — Recent XP transactions (paginated)
 *   POST /xp                       — Award XP (teacher / admin)
 *   GET  /badges/:userId           — Badges earned by a user
 *   POST /streak/:userId/checkin   — Daily streak check-in
 */
import { FastifyInstance, FastifyPluginOptions } from 'fastify'
import { v4 as uuidv4 } from 'uuid'
import { z } from 'zod'

// ── Level table (mirrors Python gamification.py LEVELS) ──────────────────────

interface LevelEntry {
  minXp:     number
  level:     number
  nameVi:    string
}

const LEVELS: LevelEntry[] = [
  { minXp: 0,    level: 1,  nameVi: 'Người mới bắt đầu' },
  { minXp: 100,  level: 2,  nameVi: 'Học viên'           },
  { minXp: 300,  level: 3,  nameVi: 'Người khám phá'     },
  { minXp: 600,  level: 4,  nameVi: 'Người học tích cực' },
  { minXp: 1000, level: 5,  nameVi: 'Nhà tư duy'         },
  { minXp: 1500, level: 6,  nameVi: 'Học giả'            },
  { minXp: 2200, level: 7,  nameVi: 'Chuyên gia trẻ'     },
  { minXp: 3000, level: 8,  nameVi: 'Nhà nghiên cứu'     },
  { minXp: 4000, level: 9,  nameVi: 'Bậc thầy'           },
  { minXp: 5500, level: 10, nameVi: 'Thiên tài'          },
]

function getLevelInfo(totalXp: number): { level: number; levelName: string; xpToNext: number } {
  let result = LEVELS[0]
  for (const entry of LEVELS) {
    if (totalXp >= entry.minXp) result = entry
  }
  const idx = LEVELS.indexOf(result)
  const nextMinXp = idx + 1 < LEVELS.length ? LEVELS[idx + 1].minXp : 999_999
  return {
    level:     result.level,
    levelName: result.nameVi,
    xpToNext:  Math.max(0, nextMinXp - totalXp),
  }
}

// ── Zod schemas ───────────────────────────────────────────────────────────────

const AwardXpBody = z.object({
  studentId: z.string().uuid(),
  amount:    z.number().int().min(1).max(10_000),
  reason:    z.string().min(1).max(255),
  refId:     z.string().uuid().optional(),
  metadata:  z.record(z.unknown()).optional(),
})

// ── Plugin ────────────────────────────────────────────────────────────────────

export async function gamificationRoutes(
  app: FastifyInstance,
  _opts: FastifyPluginOptions,
): Promise<void> {

  // ── GET /leaderboard — Top students by XP ─────────────────────────────────
  app.get(
    '/leaderboard',
    { preHandler: app.authenticate },
    async (request) => {
      const q = request.query as { limit?: string; class_id?: string }
      const limit   = Math.min(100, Math.max(1, parseInt(q.limit ?? '20', 10)))
      const classId = q.class_id ?? null

      let query: string
      let params: unknown[]

      if (classId) {
        query = `
          SELECT
            sx.user_id,
            u.name,
            u.avatar_url,
            sx.total_xp,
            sx.level,
            sx.level_name,
            sx.current_streak,
            RANK() OVER (ORDER BY sx.total_xp DESC)::int AS rank
          FROM student_xp sx
          JOIN users u ON u.id = sx.user_id
          JOIN class_memberships cm ON cm.student_id = sx.user_id
          WHERE cm.class_id = $1
            AND u.is_active = true
            AND u.role      = 'student'
          ORDER BY sx.total_xp DESC
          LIMIT $2`
        params = [classId, limit]
      } else {
        query = `
          SELECT
            sx.user_id,
            u.name,
            u.avatar_url,
            sx.total_xp,
            sx.level,
            sx.level_name,
            sx.current_streak,
            RANK() OVER (ORDER BY sx.total_xp DESC)::int AS rank
          FROM student_xp sx
          JOIN users u ON u.id = sx.user_id
          WHERE u.is_active = true
            AND u.role      = 'student'
          ORDER BY sx.total_xp DESC
          LIMIT $1`
        params = [limit]
      }

      const { rows } = await app.db.query(query, params)
      return { data: rows, count: rows.length }
    },
  )

  // ── GET /profile/:userId — XP, level, badges, streak ─────────────────────
  app.get<{ Params: { userId: string } }>(
    '/profile/:userId',
    { preHandler: app.authorizeTeacherOrSelf },
    async (request, reply) => {
      const { userId } = request.params

      const { rows: [profile] } = await app.db.query(
        `SELECT
           sx.user_id,
           u.name,
           u.avatar_url,
           sx.total_xp,
           sx.level,
           sx.level_name,
           sx.badges,
           sx.current_streak,
           sx.longest_streak,
           sx.last_activity_date
         FROM student_xp sx
         JOIN users u ON u.id = sx.user_id
         WHERE sx.user_id = $1`,
        [userId],
      )

      if (!profile) {
        // Auto-create on first access
        const id = uuidv4()
        await app.db.query(
          `INSERT INTO student_xp
             (id, user_id, total_xp, level, level_name, badges,
              current_streak, longest_streak, updated_at)
           VALUES ($1,$2,0,1,'Người mới bắt đầu','[]'::jsonb,0,0,NOW())
           ON CONFLICT (user_id) DO NOTHING`,
          [id, userId],
        )
        return {
          data: {
            userId,
            totalXp:       0,
            level:         1,
            levelName:     'Người mới bắt đầu',
            xpToNext:      100,
            badges:        [] as unknown[],
            currentStreak: 0,
            longestStreak: 0,
          },
        }
      }

      const p = profile as {
        user_id: string
        name: string
        avatar_url: string | null
        total_xp: number
        level: number
        level_name: string
        badges: unknown
        current_streak: number
        longest_streak: number
        last_activity_date: Date | null
      }

      const { xpToNext } = getLevelInfo(p.total_xp)

      // Badges may be a JSONB array or stringified
      let badges: unknown[] = []
      if (Array.isArray(p.badges)) {
        badges = p.badges
      } else if (typeof p.badges === 'string') {
        try { badges = JSON.parse(p.badges) } catch { badges = [] }
      }

      return {
        data: {
          userId:           p.user_id,
          name:             p.name,
          avatarUrl:        p.avatar_url,
          totalXp:          p.total_xp,
          level:            p.level,
          levelName:        p.level_name,
          xpToNext,
          badges,
          currentStreak:    p.current_streak,
          longestStreak:    p.longest_streak,
          lastActivityDate: p.last_activity_date?.toISOString() ?? null,
        },
      }
    },
  )

  // ── GET /xp-history/:userId — Paginated XP transactions ──────────────────
  app.get<{ Params: { userId: string } }>(
    '/xp-history/:userId',
    { preHandler: app.authorizeTeacherOrSelf },
    async (request) => {
      const { userId } = request.params
      const q        = request.query as { page?: string; page_size?: string }
      const page     = Math.max(1, parseInt(q.page      ?? '1',  10))
      const pageSize = Math.min(100, parseInt(q.page_size ?? '20', 10))
      const offset   = (page - 1) * pageSize

      const { rows } = await app.db.query(
        `SELECT id, amount, reason, ref_id, created_at
         FROM xp_transactions
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [userId, pageSize, offset],
      )

      const { rows: [countRow] } = await app.db.query(
        'SELECT COUNT(*)::int AS total FROM xp_transactions WHERE user_id = $1',
        [userId],
      )

      return {
        data: {
          items:    rows,
          total:    (countRow as { total: number }).total,
          page,
          pageSize,
        },
      }
    },
  )

  // ── POST /xp — Award XP (teacher / admin) ────────────────────────────────
  app.post<{ Body: z.infer<typeof AwardXpBody> }>(
    '/xp',
    { preHandler: app.authorizeRole('teacher', 'admin') },
    async (request) => {
      const body  = AwardXpBody.parse(request.body)
      const txId  = uuidv4()

      await app.db.query(
        `INSERT INTO xp_transactions (id, user_id, amount, reason, ref_id, metadata, created_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,NOW())`,
        [txId, body.studentId, body.amount, body.reason, body.refId ?? null,
         JSON.stringify(body.metadata ?? {})],
      )

      // Upsert student_xp total
      const { rows: [updated] } = await app.db.query(
        `INSERT INTO student_xp
           (id, user_id, total_xp, level, level_name, badges, current_streak, longest_streak, updated_at)
         VALUES ($1,$2,$3,1,'Người mới bắt đầu','[]'::jsonb,0,0,NOW())
         ON CONFLICT (user_id) DO UPDATE
           SET total_xp   = student_xp.total_xp + $3,
               updated_at = NOW()
         RETURNING total_xp, level`,
        [uuidv4(), body.studentId, body.amount],
      )

      const newXp = (updated as { total_xp: number; level: number }).total_xp
      const { level, levelName, xpToNext } = getLevelInfo(newXp)

      // Update level in the same row if it changed
      await app.db.query(
        `UPDATE student_xp SET level = $1, level_name = $2, updated_at = NOW()
         WHERE user_id = $3`,
        [level, levelName, body.studentId],
      )

      return {
        data: {
          transactionId: txId,
          newTotalXp:    newXp,
          level,
          levelName,
          xpToNext,
        },
      }
    },
  )

  // ── GET /badges/:userId — Badges earned by a user ────────────────────────
  app.get<{ Params: { userId: string } }>(
    '/badges/:userId',
    { preHandler: app.authorizeTeacherOrSelf },
    async (request) => {
      // Badges are embedded in student_xp.badges JSONB for fast reads.
      const { rows: [xpRow] } = await app.db.query(
        'SELECT badges FROM student_xp WHERE user_id = $1',
        [request.params.userId],
      )

      if (!xpRow) return { data: [] }

      let badges: unknown[] = []
      const raw = (xpRow as { badges: unknown }).badges
      if (Array.isArray(raw)) {
        badges = raw
      } else if (typeof raw === 'string') {
        try { badges = JSON.parse(raw) } catch { badges = [] }
      }

      return { data: badges }
    },
  )

  // ── POST /streak/:userId/checkin — Daily streak check-in ─────────────────
  app.post<{ Params: { userId: string } }>(
    '/streak/:userId/checkin',
    { preHandler: app.authorizeRole('teacher', 'admin') },
    async (request, reply) => {
      const { userId } = request.params

      const { rows: [profile] } = await app.db.query(
        `SELECT current_streak, longest_streak, last_activity_date
         FROM student_xp WHERE user_id = $1`,
        [userId],
      )

      if (!profile) {
        return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Profile not found' })
      }

      const p = profile as {
        current_streak: number
        longest_streak: number
        last_activity_date: Date | null
      }

      const today = new Date()
      today.setHours(0, 0, 0, 0)

      const lastActivity = p.last_activity_date ? new Date(p.last_activity_date) : null
      if (lastActivity) lastActivity.setHours(0, 0, 0, 0)

      const dayDiff = lastActivity
        ? Math.round((today.getTime() - lastActivity.getTime()) / 86_400_000)
        : null

      let newStreak = p.current_streak
      if (dayDiff === null || dayDiff > 1) {
        newStreak = 1   // streak broken or first time
      } else if (dayDiff === 1) {
        newStreak = p.current_streak + 1
      }
      // dayDiff === 0: already checked in today — no change

      const longestStreak = Math.max(newStreak, p.longest_streak)

      await app.db.query(
        `UPDATE student_xp
         SET current_streak    = $1,
             longest_streak    = $2,
             last_activity_date = $3,
             updated_at        = NOW()
         WHERE user_id = $4`,
        [newStreak, longestStreak, today, userId],
      )

      // Milestone XP rewards (streak_3, streak_7, streak_30)
      const milestones: Record<number, string> = { 3: 'streak_3_days', 7: 'streak_7_days', 30: 'streak_30_days' }
      const milestoneReason = milestones[newStreak]
      if (milestoneReason) {
        const txId = uuidv4()
        const xpAmounts: Record<string, number> = { streak_3_days: 20, streak_7_days: 50, streak_30_days: 200 }
        const amount = xpAmounts[milestoneReason]
        await app.db.query(
          `INSERT INTO xp_transactions (id, user_id, amount, reason, created_at) VALUES ($1,$2,$3,$4,NOW())`,
          [txId, userId, amount, milestoneReason],
        )
        await app.db.query(
          `UPDATE student_xp SET total_xp = total_xp + $1, updated_at = NOW() WHERE user_id = $2`,
          [amount, userId],
        )
      }

      return {
        data: {
          currentStreak: newStreak,
          longestStreak,
          checkedInAt:   today.toISOString(),
          milestoneReached: milestoneReason ?? null,
        },
      }
    },
  )
}

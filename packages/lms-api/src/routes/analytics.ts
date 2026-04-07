/**
 * AURA AdaptLearn — Analytics Routes
 * Learning analytics dashboards for teachers and admins.
 * Prefix: /api/v1/analytics
 */
import { FastifyInstance, FastifyPluginOptions } from 'fastify'

export async function analyticsRoutes(
  app: FastifyInstance,
  _opts: FastifyPluginOptions,
): Promise<void> {
  // ── Student progress summary ───────────────────────────────────────────────

  app.get<{ Params: { studentId: string } }>(
    '/students/:studentId/progress',
    { preHandler: app.authorizeTeacherOrSelf },
    async (request) => {
      const { studentId } = request.params
      const q = request.query as { from?: string; to?: string }
      const from = q.from ? new Date(q.from) : new Date(Date.now() - 30 * 86_400_000)
      const to   = q.to   ? new Date(q.to)   : new Date()

      const [lessonProgress, quizStats, xpHistory] = await Promise.all([
        app.db.query(
          `SELECT l.id, l.title, lp.status, lp.completed_at, lp.score
           FROM lesson_progress lp
           JOIN lessons l ON l.id = lp.lesson_id
           WHERE lp.student_id = $1 AND lp.updated_at BETWEEN $2 AND $3
           ORDER BY lp.updated_at DESC`,
          [studentId, from, to],
        ),
        app.db.query(
          `SELECT
             COUNT(*)::int AS total_quizzes,
             AVG(score)::numeric(5,2) AS avg_score,
             MAX(score)::int AS best_score,
             SUM(CASE WHEN score >= 60 THEN 1 ELSE 0 END)::int AS passed
           FROM quiz_sessions
           WHERE student_id = $1 AND completed_at BETWEEN $2 AND $3`,
          [studentId, from, to],
        ),
        app.db.query(
          `SELECT DATE(created_at) AS date, SUM(amount)::int AS xp_earned
           FROM xp_transactions
           WHERE student_id = $1 AND created_at BETWEEN $2 AND $3
           GROUP BY DATE(created_at)
           ORDER BY date`,
          [studentId, from, to],
        ),
      ])

      return {
        studentId,
        period: { from: from.toISOString(), to: to.toISOString() },
        lessonProgress: lessonProgress.rows,
        quizStats: quizStats.rows[0] ?? {},
        xpHistory: xpHistory.rows,
      }
    },
  )

  // ── Class overview (teacher / admin) ──────────────────────────────────────

  app.get(
    '/class/overview',
    { preHandler: app.authorizeRole('teacher', 'admin') },
    async (request) => {
      const q = request.query as { from?: string; to?: string }
      const from = q.from ? new Date(q.from) : new Date(Date.now() - 7 * 86_400_000)
      const to   = q.to   ? new Date(q.to)   : new Date()

      const { rows: activeStudents } = await app.db.query(
        `SELECT COUNT(DISTINCT student_id)::int AS count
         FROM lesson_progress
         WHERE updated_at BETWEEN $1 AND $2`,
        [from, to],
      )

      const { rows: quizAvg } = await app.db.query(
        `SELECT AVG(score)::numeric(5,2) AS class_avg_score
         FROM quiz_sessions
         WHERE completed_at BETWEEN $1 AND $2`,
        [from, to],
      )

      const { rows: topStudents } = await app.db.query(
        `SELECT u.id, u.name, gp.total_xp, gp.current_streak
         FROM gamification_profiles gp
         JOIN users u ON u.id = gp.student_id
         WHERE u.is_active = true AND u.role = 'student'
         ORDER BY gp.total_xp DESC
         LIMIT 10`,
      )

      const { rows: lessonCompletion } = await app.db.query(
        `SELECT l.id, l.title,
                COUNT(CASE WHEN lp.status = 'completed' THEN 1 END)::int AS completions,
                AVG(lp.score)::numeric(5,2) AS avg_score
         FROM lessons l
         LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.updated_at BETWEEN $1 AND $2
         GROUP BY l.id, l.title
         ORDER BY completions DESC
         LIMIT 20`,
        [from, to],
      )

      return {
        period: { from: from.toISOString(), to: to.toISOString() },
        activeStudents: (activeStudents[0] as { count: number } | undefined)?.count ?? 0,
        classAvgScore: (quizAvg[0] as { class_avg_score: string } | undefined)?.class_avg_score ?? '0',
        topStudents,
        lessonCompletion,
      }
    },
  )

  // ── Question difficulty analytics (teacher) ───────────────────────────────

  app.get(
    '/questions/difficulty',
    { preHandler: app.authorizeRole('teacher', 'admin') },
    async (request) => {
      const q = request.query as { lessonId?: string }
      const values: unknown[] = []
      let where = ''
      if (q.lessonId) {
        where = 'WHERE q.lesson_id = $1'
        values.push(q.lessonId)
      }

      const { rows } = await app.db.query(
        `SELECT
           q.id, q.prompt, q.difficulty_level, q.type,
           COUNT(ga.question_id)::int AS attempt_count,
           AVG(CASE WHEN ga.correct THEN 1.0 ELSE 0.0 END)::numeric(4,3) AS success_rate
         FROM questions q
         LEFT JOIN (
           SELECT question_id, correct FROM quiz_sessions qs,
                  jsonb_array_elements(qs.answers::jsonb) AS ga(question_id, correct)
         ) ga ON ga.question_id = q.id::text
         ${where}
         GROUP BY q.id, q.prompt, q.difficulty_level, q.type
         ORDER BY success_rate ASC NULLS LAST`,
        values,
      )

      return { data: rows }
    },
  )
}

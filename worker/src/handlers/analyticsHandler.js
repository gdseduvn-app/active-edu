/**
 * Enhanced Analytics Handler — Teacher & Admin insights
 *
 * GET /api/analytics/course/:id/overview        — course-level metrics
 * GET /api/analytics/course/:id/engagement      — engagement over time (weekly)
 * GET /api/analytics/course/:id/time-on-task    — time spent per student (from xAPI)
 * GET /api/analytics/course/:id/at-risk         — at-risk students (low activity + low mastery)
 * GET /api/analytics/student/:id/summary        — single student learning summary
 * GET /api/analytics/export?course_id=X&fmt=csv — export report
 *
 * Data sources:
 *   - xAPI statements (D1: xapi_statements) → activity, time-on-task
 *   - student_mastery (D1) → BKT mastery levels
 *   - NocoDB Progress → completion data
 *   - NocoDB Submissions → grades
 *   - NocoDB Analytics → view counts, feedback
 */
import { getTokenSecret, verifyToken, verifyAdminAuth } from '../auth.js';
import { nocoFetch } from '../db.js';

async function getSession(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '');
  if (!token) return null;
  return verifyToken(token, getTokenSecret(env));
}

function isTeacherOrAdmin(role) {
  return role === 'admin' || role === 'teacher';
}

// ── GET /api/analytics/course/:id/overview ───────────────────
export async function handleCourseOverview(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!isTeacherOrAdmin(session.role)) return json({ error: 'Không có quyền' }, 403);

  const courseId = path.split('/')[4];
  if (!courseId) return json({ error: 'Thiếu course_id' }, 400);

  // Parallel fetch all data
  const [enrollR, subR, progR, masteryR] = await Promise.all([
    // Enrollments
    env.NOCO_ENROLLMENTS ? nocoFetch(env,
      `/api/v2/tables/${env.NOCO_ENROLLMENTS}/records?where=${encodeURIComponent(`(CourseId,eq,${courseId})~and(Status,eq,active)`)}&fields=Id,UserId&limit=1`
    ) : null,
    // Submissions (graded)
    env.NOCO_SUBMISSIONS ? nocoFetch(env,
      `/api/v2/tables/${env.NOCO_SUBMISSIONS}/records?where=${encodeURIComponent(`(CourseId,eq,${courseId})~and(Status,eq,submitted)`)}&fields=Id,Score,MaxScore,UserId&limit=500`
    ) : null,
    // Progress (completed items)
    env.NOCO_PROGRESS ? nocoFetch(env,
      `/api/v2/tables/${env.NOCO_PROGRESS}/records?where=${encodeURIComponent(`(CourseId,eq,${courseId})`)}&fields=Id,UserId,Completed&limit=1`
    ) : null,
    // Mastery from D1
    env.D1 ? (async () => {
      try {
        return await env.D1.prepare(
          `SELECT AVG(bkt_state) as avg_mastery, COUNT(DISTINCT student_id) as student_count
           FROM student_mastery WHERE student_id IN (
             SELECT DISTINCT actor_id FROM xapi_statements WHERE context_course_id=?
           )`
        ).bind(String(courseId)).first();
      } catch { return null; }
    })() : null,
  ]);

  const enrollCount = enrollR?.ok ? ((await enrollR.json()).pageInfo?.totalRows ?? 0) : 0;
  const submissions = subR?.ok ? ((await subR.json()).list || []) : [];
  const progCount = progR?.ok ? ((await progR.json()).pageInfo?.totalRows ?? 0) : 0;

  // Grade distribution
  const graded = submissions.filter(s => s.Score !== null && s.MaxScore);
  const avgScore = graded.length > 0
    ? Math.round(graded.reduce((s, sub) => s + (sub.Score / sub.MaxScore * 100), 0) / graded.length)
    : null;

  const mastery = await masteryR;
  const avgMastery = mastery?.avg_mastery ? Math.round(mastery.avg_mastery * 100) : null;

  // xAPI activity in last 7 days
  let recentActivity = 0;
  if (env.D1) {
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const actR = await env.D1.prepare(
        `SELECT COUNT(*) as cnt FROM xapi_statements WHERE context_course_id=? AND timestamp >= ?`
      ).bind(String(courseId), sevenDaysAgo).first();
      recentActivity = actR?.cnt || 0;
    } catch { }
  }

  return json({
    course_id: courseId,
    enrolled_students: enrollCount,
    total_submissions: submissions.length,
    graded_submissions: graded.length,
    avg_score_pct: avgScore,
    avg_mastery_pct: avgMastery,
    recent_activity_7d: recentActivity,
    progress_records: progCount,
  });
}

// ── GET /api/analytics/course/:id/engagement ─────────────────
export async function handleCourseEngagement(request, env, { json, path, url }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!isTeacherOrAdmin(session.role)) return json({ error: 'Không có quyền' }, 403);

  const courseId = path.split('/')[4];
  if (!courseId || !env.D1) return json({ weeks: [] });

  const weeks = parseInt(url.searchParams.get('weeks') || '8');

  try {
    // Group xAPI statements by week
    const rows = await env.D1.prepare(`
      SELECT
        strftime('%Y-W%W', timestamp) as week,
        COUNT(*) as events,
        COUNT(DISTINCT actor_id) as active_students,
        SUM(CASE WHEN verb='completed' THEN 1 ELSE 0 END) as completions,
        SUM(CASE WHEN verb='answered' OR verb='attempted' THEN 1 ELSE 0 END) as quiz_attempts
      FROM xapi_statements
      WHERE context_course_id=?
        AND timestamp >= datetime('now', '-${weeks} weeks')
      GROUP BY week
      ORDER BY week ASC
    `).bind(String(courseId)).all();

    return json({ course_id: courseId, weeks: rows.results || [] });
  } catch {
    return json({ weeks: [] });
  }
}

// ── GET /api/analytics/course/:id/time-on-task ───────────────
export async function handleTimeOnTask(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!isTeacherOrAdmin(session.role)) return json({ error: 'Không có quyền' }, 403);

  const courseId = path.split('/')[4];
  if (!courseId || !env.D1) return json({ students: [] });

  try {
    // Sum duration_s per student from xAPI
    const rows = await env.D1.prepare(`
      SELECT
        actor_id,
        actor_email,
        SUM(result_duration_s) as total_seconds,
        COUNT(*) as total_events,
        MAX(timestamp) as last_active,
        SUM(CASE WHEN verb='completed' THEN 1 ELSE 0 END) as completions
      FROM xapi_statements
      WHERE context_course_id=? AND result_duration_s IS NOT NULL
      GROUP BY actor_id
      ORDER BY total_seconds DESC
      LIMIT 100
    `).bind(String(courseId)).all();

    const students = (rows.results || []).map(s => ({
      student_id: s.actor_id,
      email: s.actor_email,
      total_minutes: Math.round((s.total_seconds || 0) / 60),
      total_events: s.total_events,
      completions: s.completions,
      last_active: s.last_active,
    }));

    const avgMinutes = students.length > 0
      ? Math.round(students.reduce((s, r) => s + r.total_minutes, 0) / students.length)
      : 0;

    return json({ course_id: courseId, students, avg_minutes: avgMinutes });
  } catch {
    return json({ students: [] });
  }
}

// ── GET /api/analytics/course/:id/at-risk ────────────────────
export async function handleAtRiskStudents(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!isTeacherOrAdmin(session.role)) return json({ error: 'Không có quyền' }, 403);

  const courseId = path.split('/')[4];
  if (!courseId) return json({ at_risk: [] });

  // Get enrolled students
  if (!env.NOCO_ENROLLMENTS) return json({ at_risk: [] });
  const enrR = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_ENROLLMENTS}/records?where=${encodeURIComponent(`(CourseId,eq,${courseId})~and(Status,eq,active)`)}&fields=UserId,UserEmail,UserName&limit=300`
  );
  if (!enrR.ok) return json({ at_risk: [] });
  const enrolled = (await enrR.json()).list || [];
  if (enrolled.length === 0) return json({ at_risk: [] });

  const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const atRisk = [];

  // Check each student's activity and mastery
  for (const student of enrolled) {
    const studentId = String(student.UserId);
    let riskScore = 0;
    const riskFactors = [];

    // Check recent xAPI activity
    if (env.D1) {
      try {
        const actR = await env.D1.prepare(
          `SELECT COUNT(*) as cnt, MAX(timestamp) as last_seen
           FROM xapi_statements WHERE actor_id=? AND context_course_id=? AND timestamp >= ?`
        ).bind(studentId, String(courseId), twoWeeksAgo).first();

        if (!actR?.cnt || actR.cnt === 0) {
          riskScore += 40;
          riskFactors.push('Không hoạt động 2 tuần');
        } else if (actR.cnt < 3) {
          riskScore += 20;
          riskFactors.push('Ít hoạt động');
        }

        // Check mastery
        const mastR = await env.D1.prepare(
          `SELECT AVG(bkt_state) as avg_mastery FROM student_mastery WHERE student_id=?`
        ).bind(studentId).first();

        if (mastR?.avg_mastery !== null && mastR?.avg_mastery < 0.4) {
          riskScore += 35;
          riskFactors.push(`Mastery thấp (${Math.round((mastR.avg_mastery || 0) * 100)}%)`);
        }
      } catch { }
    }

    // Check submission count
    if (env.NOCO_SUBMISSIONS) {
      const subR = await nocoFetch(env,
        `/api/v2/tables/${env.NOCO_SUBMISSIONS}/records?where=${encodeURIComponent(`(UserId,eq,${studentId})~and(CourseId,eq,${courseId})`)}&fields=Id&limit=1`
      );
      const subCount = subR.ok ? ((await subR.json()).pageInfo?.totalRows ?? 0) : 0;
      if (subCount === 0) {
        riskScore += 25;
        riskFactors.push('Chưa nộp bài nào');
      }
    }

    if (riskScore >= 30) {
      atRisk.push({
        student_id: studentId,
        name: student.UserName || student.UserEmail,
        email: student.UserEmail,
        risk_score: Math.min(riskScore, 100),
        risk_level: riskScore >= 70 ? 'high' : riskScore >= 45 ? 'medium' : 'low',
        risk_factors: riskFactors,
      });
    }
  }

  atRisk.sort((a, b) => b.risk_score - a.risk_score);
  return json({ course_id: courseId, at_risk: atRisk, total: atRisk.length });
}

// ── GET /api/analytics/student/:id/summary ───────────────────
export async function handleStudentSummary(request, env, { json, path, url }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const studentId = path.split('/')[4];
  const courseId = url.searchParams.get('course_id');

  // Students can view their own summary
  const isSelf = String(session.userId) === String(studentId);
  if (!isSelf && !isTeacherOrAdmin(session.role))
    return json({ error: 'Không có quyền' }, 403);

  // Mastery from D1
  let mastery = [];
  let streakData = null;
  if (env.D1) {
    try {
      const mQ = courseId
        ? `SELECT outcome_code, bkt_state, score, attempts, updated_at FROM student_mastery WHERE student_id=? ORDER BY bkt_state DESC`
        : `SELECT outcome_code, bkt_state, score, attempts, updated_at FROM student_mastery WHERE student_id=? ORDER BY bkt_state DESC LIMIT 20`;
      mastery = (await env.D1.prepare(mQ).bind(String(studentId)).all()).results || [];

      streakData = await env.D1.prepare(
        `SELECT current_days, longest_days, last_study FROM study_streaks WHERE student_id=?`
      ).bind(String(studentId)).first();
    } catch { }
  }

  // Recent submissions
  let recentGrades = [];
  if (env.NOCO_SUBMISSIONS) {
    let subWhere = `(UserId,eq,${studentId})~and(Status,eq,submitted)`;
    if (courseId) subWhere += `~and(CourseId,eq,${courseId})`;
    const subR = await nocoFetch(env,
      `/api/v2/tables/${env.NOCO_SUBMISSIONS}/records?where=${encodeURIComponent(subWhere)}&fields=Id,Score,MaxScore,SubmittedAt,AssessmentId&limit=10&sort=-SubmittedAt`
    );
    if (subR.ok) recentGrades = (await subR.json()).list || [];
  }

  // xAPI summary
  let xapiSummary = null;
  if (env.D1) {
    try {
      const q = courseId
        ? `SELECT COUNT(*) as total, SUM(result_duration_s) as total_s, MAX(timestamp) as last_seen FROM xapi_statements WHERE actor_id=? AND context_course_id=?`
        : `SELECT COUNT(*) as total, SUM(result_duration_s) as total_s, MAX(timestamp) as last_seen FROM xapi_statements WHERE actor_id=?`;
      const args = courseId ? [String(studentId), String(courseId)] : [String(studentId)];
      xapiSummary = await env.D1.prepare(q).bind(...args).first();
    } catch { }
  }

  const avgMastery = mastery.length > 0
    ? Math.round(mastery.reduce((s, m) => s + m.bkt_state, 0) / mastery.length * 100)
    : null;

  return json({
    student_id: studentId,
    course_id: courseId || null,
    mastery: { outcomes: mastery, avg_pct: avgMastery },
    streak: streakData || { current_days: 0, longest_days: 0 },
    recent_grades: recentGrades,
    activity: {
      total_events: xapiSummary?.total || 0,
      total_minutes: Math.round((xapiSummary?.total_s || 0) / 60),
      last_seen: xapiSummary?.last_seen || null,
    },
  });
}

// ── GET /api/analytics/export?course_id=X&fmt=csv ────────────
export async function handleAnalyticsExport(request, env, { json, url }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!isTeacherOrAdmin(session.role)) return json({ error: 'Không có quyền' }, 403);

  const courseId = url.searchParams.get('course_id');
  const fmt = url.searchParams.get('fmt') || 'json';
  if (!courseId) return json({ error: 'Thiếu course_id' }, 400);

  // Get enrolled students with their mastery and submission data
  if (!env.NOCO_ENROLLMENTS) return json({ error: 'Không tìm thấy danh sách học sinh' }, 503);

  const enrR = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_ENROLLMENTS}/records?where=${encodeURIComponent(`(CourseId,eq,${courseId})~and(Status,eq,active)`)}&fields=UserId,UserEmail,UserName&limit=300`
  );
  if (!enrR.ok) return json({ error: 'Lỗi lấy dữ liệu' }, 502);
  const students = (await enrR.json()).list || [];

  const rows = await Promise.all(students.map(async s => {
    const sid = String(s.UserId);
    let avgMastery = null, submissionCount = 0, avgScore = null, totalMinutes = 0;

    if (env.D1) {
      try {
        const m = await env.D1.prepare(
          `SELECT AVG(bkt_state) as avg FROM student_mastery WHERE student_id=?`
        ).bind(sid).first();
        avgMastery = m?.avg != null ? Math.round(m.avg * 100) : null;

        const t = await env.D1.prepare(
          `SELECT SUM(result_duration_s) as s FROM xapi_statements WHERE actor_id=? AND context_course_id=?`
        ).bind(sid, String(courseId)).first();
        totalMinutes = Math.round((t?.s || 0) / 60);
      } catch { }
    }

    if (env.NOCO_SUBMISSIONS) {
      const subR = await nocoFetch(env,
        `/api/v2/tables/${env.NOCO_SUBMISSIONS}/records?where=${encodeURIComponent(`(UserId,eq,${sid})~and(CourseId,eq,${courseId})~and(Status,eq,submitted)`)}&fields=Score,MaxScore&limit=100`
      );
      if (subR.ok) {
        const subs = (await subR.json()).list || [];
        submissionCount = subs.length;
        const graded = subs.filter(s => s.MaxScore > 0);
        if (graded.length > 0) {
          avgScore = Math.round(graded.reduce((acc, s) => acc + (s.Score / s.MaxScore * 100), 0) / graded.length);
        }
      }
    }

    return {
      name: s.UserName || '',
      email: s.UserEmail || '',
      avg_mastery_pct: avgMastery,
      submissions: submissionCount,
      avg_score_pct: avgScore,
      total_minutes: totalMinutes,
    };
  }));

  if (fmt === 'csv') {
    const headers = ['Họ tên', 'Email', 'Mastery TB (%)', 'Số bài nộp', 'Điểm TB (%)', 'Thời gian học (phút)'];
    const csvRows = rows.map(r => [
      `"${r.name}"`, r.email, r.avg_mastery_pct ?? '', r.submissions, r.avg_score_pct ?? '', r.total_minutes
    ].join(','));
    const csv = [headers.join(','), ...csvRows].join('\n');

    const cors = { 'Access-Control-Allow-Origin': '*' };
    return new Response(csv, {
      headers: {
        ...cors,
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="analytics_course_${courseId}.csv"`,
      }
    });
  }

  return json({ course_id: courseId, students: rows, exported_at: new Date().toISOString() });
}

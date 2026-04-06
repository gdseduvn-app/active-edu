/**
 * Teacher-specific API handlers
 * Routes:
 *   GET /api/teacher/courses          — courses where TeacherId = session.userId
 *   GET /api/teacher/students?course_id=  — students enrolled in teacher's course
 *   GET /api/teacher/gradebook?course_id= — student × submission matrix for gradebook
 */

import { verifyToken, getTokenSecret } from '../auth.js';
import { nocoFetch } from '../db.js';

// ── Helper: extract & verify teacher session ──────────────────
async function getTeacherSession(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return null;
  const secret = getTokenSecret(env);
  const session = await verifyToken(token, secret);
  if (!session) return null;
  if (session.role !== 'teacher' && session.role !== 'admin') return null;
  return session;
}

// ── GET /api/teacher/courses ──────────────────────────────────
// Returns courses where TeacherId = session.userId (NocoDB filter)
export async function handleTeacherCourses(request, env, { url, json }) {
  const session = await getTeacherSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  if (!env.NOCO_COURSES) return json({ error: 'NOCO_COURSES not configured' }, 503);

  // Build query: filter by TeacherId = userId, respect soft-delete
  const sp = new URLSearchParams(url.search);
  const limit = sp.get('limit') || '50';
  const page = sp.get('page') || '1';

  const baseWhere = `(TeacherId,eq,${session.userId})~and(DeletedAt,is,null)`;

  const r = await nocoFetch(
    env,
    `/api/v2/tables/${env.NOCO_COURSES}/records?where=${encodeURIComponent(baseWhere)}&limit=${limit}&page=${page}&sort=-UpdatedAt`
  );

  const text = await r.text();
  return new Response(text, {
    status: r.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── GET /api/teacher/students?course_id= ─────────────────────
// Returns users enrolled in the given course (enrollment join)
export async function handleTeacherStudents(request, env, { url, json }) {
  const session = await getTeacherSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const courseId = url.searchParams.get('course_id');
  if (!courseId) return json({ error: 'course_id is required' }, 400);

  if (!env.NOCO_ENROLLMENTS) return json({ error: 'NOCO_ENROLLMENTS not configured' }, 503);

  // First verify teacher owns (or is admin) this course
  if (session.role !== 'admin' && env.NOCO_COURSES) {
    const courseCheck = await nocoFetch(
      env,
      `/api/v2/tables/${env.NOCO_COURSES}/records?where=(Id,eq,${courseId})~and(TeacherId,eq,${session.userId})&limit=1&fields=Id`
    );
    if (courseCheck.ok) {
      const cd = await courseCheck.json();
      if (!(cd.list || []).length) {
        return json({ error: 'Not authorized for this course' }, 403);
      }
    }
  }

  // Fetch enrollments for this course
  const enrollWhere = `(CourseId,eq,${courseId})~and(Role,eq,student)`;
  const r = await nocoFetch(
    env,
    `/api/v2/tables/${env.NOCO_ENROLLMENTS}/records?where=${encodeURIComponent(enrollWhere)}&limit=200&fields=Id,UserId,Status,EnrolledAt`
  );

  if (!r.ok) {
    const text = await r.text();
    return new Response(text, { status: r.status, headers: { 'Content-Type': 'application/json' } });
  }

  const enrollData = await r.json();
  const enrollments = enrollData.list || [];

  // Fetch user details for each enrolled student
  let students = [];
  if (env.NOCO_USERS && enrollments.length > 0) {
    const userIds = [...new Set(enrollments.map(e => e.UserId).filter(Boolean))];
    if (userIds.length > 0) {
      const userWhere = `(Id,in,${userIds.join(',')})`;
      const ur = await nocoFetch(
        env,
        `/api/v2/tables/${env.NOCO_USERS}/records?where=${encodeURIComponent(userWhere)}&limit=200&fields=Id,Name,Email,Username,Role`
      );
      if (ur.ok) {
        const ud = await ur.json();
        const userMap = Object.fromEntries((ud.list || []).map(u => [u.Id, u]));
        students = enrollments.map(e => ({
          enrollment_id: e.Id,
          user_id: e.UserId,
          status: e.Status,
          enrolled_at: e.EnrolledAt,
          name: userMap[e.UserId]?.Name || '',
          email: userMap[e.UserId]?.Email || '',
          username: userMap[e.UserId]?.Username || '',
        }));
      }
    }
  } else {
    students = enrollments.map(e => ({
      enrollment_id: e.Id,
      user_id: e.UserId,
      status: e.Status,
      enrolled_at: e.EnrolledAt,
    }));
  }

  return new Response(JSON.stringify({ list: students, total: students.length }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── GET /api/teacher/gradebook?course_id= ────────────────────
// Returns student × submission matrix for gradebook view
export async function handleTeacherGradebook(request, env, { url, json }) {
  const session = await getTeacherSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const courseId = url.searchParams.get('course_id');
  if (!courseId) return json({ error: 'course_id is required' }, 400);

  // Verify teacher owns this course (unless admin)
  if (session.role !== 'admin' && env.NOCO_COURSES) {
    const courseCheck = await nocoFetch(
      env,
      `/api/v2/tables/${env.NOCO_COURSES}/records?where=(Id,eq,${courseId})~and(TeacherId,eq,${session.userId})&limit=1&fields=Id`
    );
    if (courseCheck.ok) {
      const cd = await courseCheck.json();
      if (!(cd.list || []).length) {
        return json({ error: 'Not authorized for this course' }, 403);
      }
    }
  }

  // Fetch assessments for this course
  let assessments = [];
  if (env.NOCO_ASSESSMENTS) {
    const ar = await nocoFetch(
      env,
      `/api/v2/tables/${env.NOCO_ASSESSMENTS}/records?where=(CourseId,eq,${courseId})&limit=50&fields=Id,Title,MaxScore,DueDate`
    );
    if (ar.ok) {
      const ad = await ar.json();
      assessments = ad.list || [];
    }
  }

  // Fetch student enrollments
  let students = [];
  if (env.NOCO_ENROLLMENTS) {
    const enrollWhere = `(CourseId,eq,${courseId})~and(Role,eq,student)`;
    const er = await nocoFetch(
      env,
      `/api/v2/tables/${env.NOCO_ENROLLMENTS}/records?where=${encodeURIComponent(enrollWhere)}&limit=200&fields=Id,UserId`
    );
    if (er.ok) {
      const ed = await er.json();
      const enrollments = ed.list || [];
      const userIds = [...new Set(enrollments.map(e => e.UserId).filter(Boolean))];
      if (userIds.length > 0 && env.NOCO_USERS) {
        const userWhere = `(Id,in,${userIds.join(',')})`;
        const ur = await nocoFetch(
          env,
          `/api/v2/tables/${env.NOCO_USERS}/records?where=${encodeURIComponent(userWhere)}&limit=200&fields=Id,Name,Email`
        );
        if (ur.ok) {
          const ud = await ur.json();
          students = ud.list || [];
        }
      }
    }
  }

  // Fetch submissions from D1 (if available)
  let submissionsMap = {}; // { userId: { assessmentId: { score, status } } }
  try {
    if (env.D1 && assessments.length > 0) {
      const assessmentIds = assessments.map(a => a.Id);
      const placeholders = assessmentIds.map(() => '?').join(',');
      const rows = await env.D1.prepare(
        `SELECT user_id, assessment_id, score, status FROM submissions WHERE assessment_id IN (${placeholders})`
      ).bind(...assessmentIds).all();
      for (const row of (rows.results || [])) {
        if (!submissionsMap[row.user_id]) submissionsMap[row.user_id] = {};
        submissionsMap[row.user_id][row.assessment_id] = { score: row.score, status: row.status };
      }
    }
  } catch {}

  // Build gradebook grid
  const grades = students.map(s => ({
    student_id: s.Id,
    name: s.Name,
    email: s.Email,
    scores: assessments.map(a => {
      const sub = (submissionsMap[s.Id] || {})[a.Id];
      return {
        assessment_id: a.Id,
        score: sub?.score ?? null,
        status: sub?.status ?? 'not_submitted',
      };
    }),
  }));

  return new Response(JSON.stringify({ assessments, students: grades }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── GET /api/teacher/outcomes?course_id= ─────────────────────
// Returns outcome mastery heatmap: per-outcome aggregate + per-student BKT scores
export async function handleTeacherOutcomes(request, env, { url, json }) {
  const session = await getTeacherSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const courseId = url.searchParams.get('course_id');
  if (!courseId) return json({ error: 'course_id is required' }, 400);

  if (!env.NOCO_ALIGNMENTS) return json({ outcomes: [], students: [], outcome_codes: [] });

  // 1. Lấy alignments cho course → danh sách outcome codes
  const alr = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_ALIGNMENTS}/records?where=${encodeURIComponent(`(CourseId,eq,${courseId})`)}&limit=100&fields=OutcomeCode,OutcomeId,AlignmentStrength`
  );
  const alignments = alr.ok ? ((await alr.json()).list || []) : [];
  const outcomeCodes = [...new Set(alignments.map(a => a.OutcomeCode).filter(Boolean))];

  if (!outcomeCodes.length) return json({ outcomes: [], students: [], outcome_codes: [] });

  // 2. Lấy danh sách học sinh enrolled
  let enrollments = [];
  if (env.NOCO_ENROLLMENTS) {
    const enrWhere = `(CourseId,eq,${courseId})~and(Status,eq,active)`;
    const enrR = await nocoFetch(env,
      `/api/v2/tables/${env.NOCO_ENROLLMENTS}/records?where=${encodeURIComponent(enrWhere)}&limit=200&fields=UserId,UserName,UserEmail`
    );
    enrollments = enrR.ok ? ((await enrR.json()).list || []) : [];
  }

  // Nếu không có trường UserName trong Enrollments, join với Users
  const studentIds = [...new Set(enrollments.map(e => e.UserId).filter(Boolean))];
  let userMap = {};
  if (studentIds.length && env.NOCO_USERS) {
    const userR = await nocoFetch(env,
      `/api/v2/tables/${env.NOCO_USERS}/records?where=${encodeURIComponent(`(Id,in,${studentIds.join(',')})`)}&limit=200&fields=Id,Name,Email`
    );
    if (userR.ok) {
      for (const u of ((await userR.json()).list || [])) userMap[u.Id] = u;
    }
  }

  // 3. Lấy student_mastery từ D1
  let masteryRows = [];
  if (env.D1 && outcomeCodes.length) {
    try {
      const placeholders = outcomeCodes.map(() => '?').join(',');
      const result = await env.D1.prepare(
        `SELECT student_id, outcome_code, bkt_state, score, attempts FROM student_mastery WHERE outcome_code IN (${placeholders})`
      ).bind(...outcomeCodes).all();
      masteryRows = result.results || [];
    } catch (e) { console.error('[D1 mastery read]', e.message); }
  }

  // 4. Build lookup: studentId → outcomeCode → data
  const masteryMap = {};
  for (const row of masteryRows) {
    if (!masteryMap[row.student_id]) masteryMap[row.student_id] = {};
    masteryMap[row.student_id][row.outcome_code] = row;
  }

  // 5. Lấy outcome titles từ NocoDB
  const outcomeDetails = {};
  if (env.NOCO_OUTCOMES) {
    try {
      const encoded = outcomeCodes.map(c => `(Code,eq,${c})`).join('~or');
      const oR = await nocoFetch(env,
        `/api/v2/tables/${env.NOCO_OUTCOMES}/records?where=${encodeURIComponent(encoded)}&fields=Code,TitleVi,Subject,Grade&limit=100`
      );
      if (oR.ok) {
        for (const o of ((await oR.json()).list || [])) outcomeDetails[o.Code] = o;
      }
    } catch {}
  }

  // 6. Aggregate per outcome (trung bình BKT của cả lớp)
  const outcomes = outcomeCodes.map(code => {
    const scores = enrollments.map(e => masteryMap[String(e.UserId)]?.[code]?.bkt_state ?? 0);
    const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    const mastered = scores.filter(s => s >= 0.7).length;
    return {
      code,
      title: outcomeDetails[code]?.TitleVi || code,
      subject: outcomeDetails[code]?.Subject || '',
      grade: outcomeDetails[code]?.Grade || '',
      avg_mastery: Math.round(avg * 100) / 100,
      students_mastered: mastered,
      total_students: enrollments.length,
    };
  });

  // 7. Per-student row: { id, name, mastery: { code: bktState } }
  const students = enrollments.map(e => {
    const uid = String(e.UserId);
    const user = userMap[e.UserId] || {};
    return {
      id: e.UserId,
      name: e.UserName || user.Name || e.UserEmail || user.Email || uid,
      mastery: outcomeCodes.reduce((acc, code) => {
        acc[code] = masteryMap[uid]?.[code]?.bkt_state ?? null;
        return acc;
      }, {}),
    };
  });

  return json({ outcomes, students, outcome_codes: outcomeCodes });
}

// ── POST /api/teacher/courses ──────────────────────────────────
// Teacher tạo khoá học mới (TeacherId tự động = userId)
export async function handleTeacherCreateCourse(request, env, { json }) {
  const session = await getTeacherSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!env.NOCO_COURSES) return json({ error: 'NOCO_COURSES not configured' }, 503);

  const body = await request.json().catch(() => ({}));
  if (!body.Title) return json({ error: 'Title is required' }, 400);

  // Force TeacherId = calling teacher, prevent privilege escalation
  body.TeacherId = session.userId;
  body.WorkflowState = body.WorkflowState || 'unpublished';
  body.CreatedAt = new Date().toISOString();

  const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_COURSES}/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  return new Response(JSON.stringify(data), {
    status: r.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── GET /api/teacher/assessments?course_id= ───────────────────
// Danh sách bài tập/quiz của giáo viên (cho SpeedGrader dropdown)
export async function handleTeacherAssessments(request, env, { json, url }) {
  const session = await getTeacherSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!env.NOCO_ASSESSMENTS) return json({ list: [] });

  const courseId = url.searchParams.get('course_id');
  const limit = url.searchParams.get('limit') || '100';

  // Build where: only published/draft assessments for teacher's courses
  let where = '';
  if (courseId) {
    where = `(CourseId,eq,${courseId})`;
  } else {
    // All assessments across all teacher's courses
    if (env.NOCO_COURSES) {
      const cr = await nocoFetch(env,
        `/api/v2/tables/${env.NOCO_COURSES}/records?where=${encodeURIComponent(`(TeacherId,eq,${session.userId})`)}&fields=Id&limit=50`
      );
      if (cr.ok) {
        const cd = await cr.json();
        const ids = (cd.list || []).map(c => c.Id).filter(Boolean);
        if (!ids.length) return json({ list: [] });
        where = ids.map(id => `(CourseId,eq,${id})`).join('~or');
      }
    }
  }

  const r = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_ASSESSMENTS}/records?where=${encodeURIComponent(where)}&fields=Id,Title,AssessmentType,CourseId,DueDate,MaxScore,Status&limit=${limit}&sort=-CreatedAt`
  );
  if (!r.ok) return json({ list: [] });
  const data = await r.json();
  return json(data);
}

// ── GET /api/teacher/submissions?assessment_id=X ──────────────
// Danh sách bài nộp cho bài tập (dùng cho SpeedGrader)
export async function handleTeacherSubmissions(request, env, { json, url }) {
  const session = await getTeacherSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!env.NOCO_SUBMISSIONS) return json({ list: [], submissions: [] });

  const assessmentId = url.searchParams.get('assessment_id');
  const courseId = url.searchParams.get('course_id');

  let where = '';
  if (assessmentId) {
    where = `(AssessmentId,eq,${assessmentId})`;
  } else if (courseId) {
    where = `(CourseId,eq,${courseId})`;
  } else {
    return json({ error: 'assessment_id or course_id required' }, 400);
  }

  const r = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_SUBMISSIONS}/records?where=${encodeURIComponent(where)}&limit=200&sort=-SubmittedAt`
  );
  if (!r.ok) return json({ list: [] });
  const data = await r.json();

  // Enrich with student names if NOCO_USERS is available
  const subs = data.list || [];
  if (subs.length && env.NOCO_USERS) {
    const userIds = [...new Set(subs.map(s => s.UserId).filter(Boolean))];
    if (userIds.length) {
      const ur = await nocoFetch(env,
        `/api/v2/tables/${env.NOCO_USERS}/records?where=${encodeURIComponent(`(Id,in,${userIds.join(',')})`)}&fields=Id,Name,Email&limit=200`
      );
      if (ur.ok) {
        const ud = await ur.json();
        const userMap = Object.fromEntries((ud.list || []).map(u => [String(u.Id), u]));
        data.list = subs.map(s => ({
          ...s,
          StudentName: userMap[String(s.UserId)]?.Name || s.StudentName || '',
          StudentEmail: userMap[String(s.UserId)]?.Email || '',
        }));
      }
    }
  }

  return json(data);
}

// ── PATCH /api/teacher/submissions/:id/grade ──────────────────
// Giáo viên chấm điểm bài nộp
export async function handleTeacherGrade(request, env, { json, path }) {
  const session = await getTeacherSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const subId = path.match(/\/api\/teacher\/submissions\/(\d+)\/grade/)?.[1];
  if (!subId) return json({ error: 'Invalid submission ID' }, 400);
  if (!env.NOCO_SUBMISSIONS) return json({ error: 'NOCO_SUBMISSIONS not configured' }, 503);

  const body = await request.json().catch(() => ({}));
  // { Score, Comment, Status }
  const score = body.Score ?? body.score;
  const comment = body.Comment ?? body.comment ?? '';
  const status = body.Status ?? 'graded';

  if (score === undefined || score === null) return json({ error: 'Score is required' }, 400);

  // Verify this submission belongs to a course taught by this teacher
  if (session.role !== 'admin' && env.NOCO_COURSES) {
    const subR = await nocoFetch(env,
      `/api/v2/tables/${env.NOCO_SUBMISSIONS}/records?where=(Id,eq,${subId})&fields=Id,CourseId&limit=1`
    );
    if (subR.ok) {
      const subData = await subR.json();
      const sub = (subData.list || [])[0];
      if (sub?.CourseId) {
        const courseCheck = await nocoFetch(env,
          `/api/v2/tables/${env.NOCO_COURSES}/records?where=(Id,eq,${sub.CourseId})~and(TeacherId,eq,${session.userId})&fields=Id&limit=1`
        );
        if (courseCheck.ok) {
          const cd = await courseCheck.json();
          if (!(cd.list || []).length) return json({ error: 'Not authorized for this course' }, 403);
        }
      }
    }
  }

  // Update submission
  const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_SUBMISSIONS}/records`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([{
      Id: parseInt(subId),
      Score: parseFloat(score),
      Comment: comment,
      Status: status,
      GradedAt: new Date().toISOString(),
      GradedBy: session.userId,
    }]),
  });

  if (!r.ok) return json({ error: 'Lỗi cập nhật điểm' }, 500);
  return json({ ok: true, score: parseFloat(score), status });
}

// ── POST /api/teacher/announcements ───────────────────────────
// Giáo viên tạo thông báo cho khoá học
export async function handleTeacherCreateAnnouncement(request, env, { json }) {
  const session = await getTeacherSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!env.NOCO_ANNOUNCEMENTS) return json({ error: 'NOCO_ANNOUNCEMENTS not configured' }, 503);

  const body = await request.json().catch(() => ({}));
  if (!body.Title) return json({ error: 'Title is required' }, 400);

  // Verify teacher owns the course if CourseId is provided
  if (body.CourseId && session.role !== 'admin' && env.NOCO_COURSES) {
    const cc = await nocoFetch(env,
      `/api/v2/tables/${env.NOCO_COURSES}/records?where=(Id,eq,${body.CourseId})~and(TeacherId,eq,${session.userId})&fields=Id&limit=1`
    );
    if (cc.ok) {
      const cd = await cc.json();
      if (!(cd.list || []).length) return json({ error: 'Not authorized for this course' }, 403);
    }
  }

  const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_ANNOUNCEMENTS}/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...body,
      AuthorId: session.userId,
      AuthorName: session.name || '',
      CreatedAt: new Date().toISOString(),
    }),
  });
  const data = await r.json();
  return new Response(JSON.stringify(data), {
    status: r.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── POST /api/teacher/assessments ─────────────────────────────
// Teacher creates assessment/quiz with ownership verification
export async function handleTeacherCreateAssessment(request, env, { json }) {
  const session = await getTeacherSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!env.NOCO_ASSESSMENTS) return json({ error: 'NOCO_ASSESSMENTS not configured' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  if (!body.Title) return json({ error: 'Title is required' }, 400);
  if (!body.AssessmentType) return json({ error: 'AssessmentType is required' }, 400);

  const validTypes = ['graded_quiz', 'practice_quiz', 'graded_survey', 'ungraded_survey', 'assignment'];
  if (!validTypes.includes(body.AssessmentType))
    return json({ error: `AssessmentType phải là: ${validTypes.join(', ')}` }, 422);

  // Verify teacher owns the course (non-admin only)
  if (body.CourseId && session.role !== 'admin' && env.NOCO_COURSES) {
    const cc = await nocoFetch(env,
      `/api/v2/tables/${env.NOCO_COURSES}/records?where=(Id,eq,${body.CourseId})~and(TeacherId,eq,${session.userId})&fields=Id&limit=1`
    );
    if (cc.ok) {
      const cd = await cc.json();
      if (!(cd.list || []).length) return json({ error: 'Not authorized for this course' }, 403);
    }
  }

  const now = new Date().toISOString();
  const payload = {
    Title: body.Title,
    Description: body.Description || '',
    AssessmentType: body.AssessmentType,
    CourseId: body.CourseId ? parseInt(body.CourseId) : null,
    ModuleId: body.ModuleId ? parseInt(body.ModuleId) : null,
    MaxScore: body.MaxScore != null ? parseFloat(body.MaxScore) : 10,
    TimeLimit: body.TimeLimit ? parseInt(body.TimeLimit) : null,
    MaxAttempts: body.MaxAttempts ? parseInt(body.MaxAttempts) : 1,
    DueDate: body.DueDate || null,
    AvailableFrom: body.AvailableFrom || null,
    UntilDate: body.UntilDate || null,
    Instructions: body.Instructions || '',
    Status: body.Status || 'unpublished',
    ShuffleQuestions: body.ShuffleQuestions || false,
    ShuffleAnswers: body.ShuffleAnswers || false,
    PassingScore: body.PassingScore || 60,
    TeacherId: session.userId, // Force ownership
    CreatedAt: now,
    UpdatedAt: now,
  };

  const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_ASSESSMENTS}/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!r.ok) {
    const errText = await r.text();
    return json({ error: `Tạo assessment thất bại: ${errText}` }, r.status);
  }

  const created = await r.json();

  // If quiz questions are provided, create them too
  if (body.questions?.length && env.NOCO_ASSESS_QUESTIONS && created.Id) {
    const qRecords = body.questions.map((q, idx) => ({
      AssessmentId: created.Id,
      QuestionType: q.type || 'multiple_choice',
      Content: typeof q.content === 'string' ? q.content : JSON.stringify(q.content),
      Options: JSON.stringify(q.options || []),
      CorrectAnswer: JSON.stringify(q.correctAnswer ?? q.correct_answer),
      Explanation: q.explanation || '',
      Points: q.points || 1,
      Position: idx + 1,
      IsRequired: true,
    }));
    // Create questions in sequence (NocoDB may not support bulk POST)
    for (const qr of qRecords) {
      await nocoFetch(env, `/api/v2/tables/${env.NOCO_ASSESS_QUESTIONS}/records`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(qr),
      }).catch(() => {});
    }
  }

  return json({ ok: true, id: created.Id, assessment: created });
}

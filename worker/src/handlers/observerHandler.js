/**
 * Observer Handler — Read-only access for parents/guardians
 *
 * Observer role: parent/guardian who can view a student's progress
 * without being able to modify anything or access other students.
 *
 * POST   /api/observer/link              — create observer link (admin only)
 * GET    /api/observer/students          — list students this observer can watch
 * GET    /api/observer/progress          — student progress summary (read-only)
 * GET    /api/observer/grades            — student grades (read-only)
 * GET    /api/observer/activity          — recent student activity
 * DELETE /admin/observer-links/:id       — remove observer link (admin)
 *
 * NocoDB table required:
 *   env.NOCO_OBSERVER_LINKS — ObserverLinks
 *     Fields: Id, ObserverId, ObserverEmail, ObserveeId, ObserveeEmail,
 *             CourseId (optional — null = all courses), CreatedAt, IsActive
 *
 * Auth: Observer uses same JWT token with role='observer'.
 *   - Observers can ONLY call GET endpoints
 *   - Observers can ONLY access their linked students
 *   - All write operations return 403
 */
import { getTokenSecret, verifyToken, verifyAdminAuth } from '../auth.js';
import { nocoFetch } from '../db.js';

async function getSession(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '');
  if (!token) return null;
  return verifyToken(token, getTokenSecret(env));
}

// ── POST /api/observer/link ───────────────────────────────────
// Admin creates an observer link between a parent and a student
export async function handleCreateObserverLink(request, env, { json }) {
  if (!await verifyAdminAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
  if (!env.NOCO_OBSERVER_LINKS) return json({ error: 'Observer links chưa được cấu hình' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { observer_id, observee_id, course_id } = body;
  if (!observer_id || !observee_id) return json({ error: 'Thiếu observer_id hoặc observee_id' }, 400);
  if (String(observer_id) === String(observee_id)) return json({ error: 'Observer không thể là chính học sinh' }, 400);

  // Check not duplicate
  let dupWhere = `(ObserverId,eq,${observer_id})~and(ObserveeId,eq,${observee_id})`;
  if (course_id) dupWhere += `~and(CourseId,eq,${course_id})`;
  const dupR = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_OBSERVER_LINKS}/records?where=${encodeURIComponent(dupWhere)}&limit=1`
  );
  if (dupR.ok && (await dupR.json()).list?.length > 0)
    return json({ error: 'Liên kết này đã tồn tại' }, 409);

  const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_OBSERVER_LINKS}/records`, 'POST', {
    ObserverId: String(observer_id),
    ObserveeId: String(observee_id),
    CourseId: course_id ? String(course_id) : null,
    IsActive: true,
    CreatedAt: new Date().toISOString(),
  });

  if (!r.ok) return json({ error: 'Không thể tạo liên kết' }, 502);
  return json({ ok: true, link: await r.json() }, 201);
}

// ── GET /api/observer/students ────────────────────────────────
export async function handleObserverStudents(request, env, { json }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  // Admins/teachers can also use this to see who is observing
  const observerId = session.userId;
  if (!env.NOCO_OBSERVER_LINKS) return json({ students: [] });

  const r = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_OBSERVER_LINKS}/records?where=${encodeURIComponent(`(ObserverId,eq,${observerId})~and(IsActive,eq,true)`)}&limit=50`
  );
  if (!r.ok) return json({ students: [] });
  const links = (await r.json()).list || [];
  if (links.length === 0) return json({ students: [] });

  // Fetch student info
  const studentIds = [...new Set(links.map(l => l.ObserveeId))];
  const students = await Promise.all(studentIds.map(async id => {
    if (!env.NOCO_USERS) return { id };
    const uR = await nocoFetch(env, `/api/v2/tables/${env.NOCO_USERS}/records/${id}?fields=Id,Name,HoTen,Email`);
    if (!uR.ok) return { id };
    const u = await uR.json();
    return {
      id: u.Id,
      name: u.Name || u.HoTen || u.Email,
      email: u.Email,
      course_ids: links.filter(l => l.ObserveeId === String(id)).map(l => l.CourseId).filter(Boolean),
    };
  }));

  return json({ students });
}

// Helper: verify observer can access a specific student
async function verifyObserverAccess(env, observerId, observeeId, courseId = null) {
  if (!env.NOCO_OBSERVER_LINKS) return false;
  let where = `(ObserverId,eq,${observerId})~and(ObserveeId,eq,${observeeId})~and(IsActive,eq,true)`;
  const r = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_OBSERVER_LINKS}/records?where=${encodeURIComponent(where)}&limit=1`
  );
  if (!r.ok) return false;
  const links = (await r.json()).list || [];
  if (links.length === 0) return false;
  // If courseId specified, check link scope
  if (courseId) {
    return links.some(l => !l.CourseId || String(l.CourseId) === String(courseId));
  }
  return true;
}

// ── GET /api/observer/progress?student_id=X&course_id=Y ──────
export async function handleObserverProgress(request, env, { json, url }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const studentId = url.searchParams.get('student_id');
  const courseId = url.searchParams.get('course_id');
  if (!studentId) return json({ error: 'Thiếu student_id' }, 400);

  // Admin/teacher can view anyone; student can view own; observer checks link
  const isPrivileged = session.role === 'admin' || session.role === 'teacher';
  const isSelf = String(session.userId) === String(studentId);
  if (!isPrivileged && !isSelf) {
    const hasAccess = await verifyObserverAccess(env, session.userId, studentId, courseId);
    if (!hasAccess) return json({ error: 'Không có quyền xem tiến độ học sinh này' }, 403);
  }

  // Fetch progress from NocoDB
  if (!env.NOCO_PROGRESS) return json({ progress: [], total_completed: 0 });

  let where = `(UserId,eq,${studentId})`;
  if (courseId) where += `~and(CourseId,eq,${courseId})`;

  const r = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_PROGRESS}/records?where=${encodeURIComponent(where)}&limit=500&sort=-UpdatedAt`
  );
  const progressData = r.ok ? ((await r.json()).list || []) : [];
  const completed = progressData.filter(p => p.Completed || p.Status === 'completed');

  // Fetch mastery from D1
  let masteryData = [];
  if (env.D1 && courseId) {
    try {
      const m = await env.D1.prepare(
        `SELECT outcome_code, bkt_state, score, attempts FROM student_mastery WHERE student_id=?`
      ).bind(String(studentId)).all();
      masteryData = m.results || [];
    } catch { /* table may not exist */ }
  }

  return json({
    student_id: studentId,
    course_id: courseId || null,
    total_items: progressData.length,
    completed_items: completed.length,
    completion_rate: progressData.length > 0 ? Math.round(completed.length / progressData.length * 100) : 0,
    recent_progress: progressData.slice(0, 20),
    mastery: masteryData,
  });
}

// ── GET /api/observer/grades?student_id=X ────────────────────
export async function handleObserverGrades(request, env, { json, url }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const studentId = url.searchParams.get('student_id');
  const courseId = url.searchParams.get('course_id');
  if (!studentId) return json({ error: 'Thiếu student_id' }, 400);

  const isPrivileged = session.role === 'admin' || session.role === 'teacher';
  const isSelfGrades = String(session.userId) === String(studentId);
  if (!isPrivileged && !isSelfGrades) {
    const hasAccess = await verifyObserverAccess(env, session.userId, studentId, courseId);
    if (!hasAccess) return json({ error: 'Không có quyền xem điểm học sinh này' }, 403);
  }

  if (!env.NOCO_SUBMISSIONS) return json({ grades: [] });

  let where = `(UserId,eq,${studentId})~and(Status,eq,submitted)`;
  if (courseId) where += `~and(CourseId,eq,${courseId})`;

  const r = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_SUBMISSIONS}/records?where=${encodeURIComponent(where)}&fields=Id,AssessmentId,Score,MaxScore,Status,SubmittedAt&limit=200&sort=-SubmittedAt`
  );
  const grades = r.ok ? ((await r.json()).list || []) : [];

  const totalScore = grades.reduce((s, g) => s + (g.Score || 0), 0);
  const totalMax = grades.reduce((s, g) => s + (g.MaxScore || 0), 0);

  return json({
    student_id: studentId,
    grades,
    summary: {
      total_submissions: grades.length,
      average_score: grades.length > 0 ? Math.round(totalScore / grades.length * 10) / 10 : null,
      total_score: totalScore,
      total_max: totalMax,
    },
  });
}

// ── GET /api/observer/activity?student_id=X ──────────────────
export async function handleObserverActivity(request, env, { json, url }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const studentId = url.searchParams.get('student_id');
  if (!studentId) return json({ error: 'Thiếu student_id' }, 400);

  const isPrivileged = session.role === 'admin' || session.role === 'teacher';
  if (!isPrivileged && String(session.userId) !== String(studentId)) {
    const hasAccess = await verifyObserverAccess(env, session.userId, studentId);
    if (!hasAccess) return json({ error: 'Không có quyền' }, 403);
  }

  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 50);

  // Get recent xAPI activity from D1
  let activity = [];
  if (env.D1) {
    try {
      const r = await env.D1.prepare(
        `SELECT verb, object_name, context_course_id, timestamp
         FROM xapi_statements WHERE actor_id=?
         ORDER BY timestamp DESC LIMIT ?`
      ).bind(String(studentId), limit).all();
      activity = r.results || [];
    } catch { /* table may not exist */ }
  }

  return json({ student_id: studentId, activity, total: activity.length });
}

// ── DELETE /admin/observer-links/:id ─────────────────────────
export async function handleDeleteObserverLink(request, env, { json, path }) {
  if (!await verifyAdminAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
  if (!env.NOCO_OBSERVER_LINKS) return json({ ok: true });

  const id = path.split('/')[3];
  if (!id) return json({ error: 'Not found' }, 404);

  await nocoFetch(env, `/api/v2/tables/${env.NOCO_OBSERVER_LINKS}/records/${id}`, 'PATCH', { IsActive: false });
  return json({ ok: true });
}

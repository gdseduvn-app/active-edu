/**
 * Calendar Handler — Course events, deadlines & scheduling
 *
 * GET    /api/calendar/events?course_id=X&start=ISO&end=ISO  — events in date range
 * GET    /api/calendar/events/upcoming?course_id=X&limit=5   — next N events
 * POST   /api/calendar/events                                — create event (teacher/admin)
 * PUT    /api/calendar/events/:id                            — edit event
 * DELETE /api/calendar/events/:id                            — delete event
 *
 * Events are auto-generated from:
 *   - Assessment due dates (via NocoDB NOCO_ASSESSMENTS)
 *   - Exam dates (via NocoDB NOCO_EXAMS)
 *
 * NocoDB table required:
 *   env.NOCO_CALENDAR — CalendarEvents
 *     Fields: Id, CourseId, Title, Description, StartAt (ISO), EndAt (ISO),
 *             Type (event|assignment|exam|holiday), RefId (optional),
 *             CreatedBy, IsDeleted
 *
 * Types:
 *   event       — generic event created by teacher
 *   assignment  — linked to assessment (auto-synced)
 *   exam        — linked to exam (auto-synced)
 *   holiday     — school holiday / day off
 */
import { getTokenSecret, verifyToken } from '../auth.js';
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

// ── GET /api/calendar/events ──────────────────────────────────
export async function handleListCalendarEvents(request, env, { json, url }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const courseId = url.searchParams.get('course_id');
  const startParam = url.searchParams.get('start');
  const endParam = url.searchParams.get('end');

  let events = [];

  // ── 1. Manual calendar events (from NocoDB) ─────────────────
  if (env.NOCO_CALENDAR) {
    let where = `(IsDeleted,eq,false)`;
    if (courseId) where += `~and(CourseId,eq,${courseId})`;
    if (startParam) where += `~and(StartAt,gte,${startParam})`;
    if (endParam) where += `~and(StartAt,lte,${endParam})`;

    const r = await nocoFetch(env,
      `/api/v2/tables/${env.NOCO_CALENDAR}/records?where=${encodeURIComponent(where)}&limit=200&sort=StartAt`
    );
    if (r.ok) {
      const data = await r.json();
      events.push(...(data.list || []).map(e => ({ ...e, _source: 'calendar' })));
    }
  }

  // ── 2. Auto-include assessments with due dates ───────────────
  if (env.NOCO_ASSESSMENTS && courseId) {
    let aWhere = `(Status,eq,published)~and(CourseId,eq,${courseId})`;
    if (startParam) aWhere += `~and(DueAt,gte,${startParam})`;
    if (endParam) aWhere += `~and(DueAt,lte,${endParam})`;

    const aR = await nocoFetch(env,
      `/api/v2/tables/${env.NOCO_ASSESSMENTS}/records?where=${encodeURIComponent(aWhere)}&fields=Id,Title,DueAt,TotalPoints&limit=100`
    );
    if (aR.ok) {
      const aData = await aR.json();
      for (const a of (aData.list || [])) {
        if (!a.DueAt) continue;
        events.push({
          Id: `asgn_${a.Id}`,
          CourseId: courseId,
          Title: a.Title,
          Description: `Bài kiểm tra — ${a.TotalPoints || 0} điểm`,
          StartAt: a.DueAt,
          EndAt: a.DueAt,
          Type: 'assignment',
          RefId: String(a.Id),
          _source: 'assessment',
        });
      }
    }
  }

  // ── 3. Auto-include exams ────────────────────────────────────
  if (env.NOCO_EXAMS && courseId) {
    let eWhere = `(Status,eq,published)~and(CourseId,eq,${courseId})`;
    if (startParam) eWhere += `~and(StartAt,gte,${startParam})`;
    if (endParam) eWhere += `~and(StartAt,lte,${endParam})`;

    const eR = await nocoFetch(env,
      `/api/v2/tables/${env.NOCO_EXAMS}/records?where=${encodeURIComponent(eWhere)}&fields=Id,Title,StartAt,EndAt,Duration&limit=100`
    );
    if (eR.ok) {
      const eData = await eR.json();
      for (const e of (eData.list || [])) {
        if (!e.StartAt) continue;
        events.push({
          Id: `exam_${e.Id}`,
          CourseId: courseId,
          Title: e.Title,
          Description: `Bài thi — ${e.Duration || 0} phút`,
          StartAt: e.StartAt,
          EndAt: e.EndAt || e.StartAt,
          Type: 'exam',
          RefId: String(e.Id),
          _source: 'exam',
        });
      }
    }
  }

  // Sort all events by StartAt
  events.sort((a, b) => (a.StartAt || '').localeCompare(b.StartAt || ''));

  return json({ events, total: events.length });
}

// ── GET /api/calendar/events/upcoming ────────────────────────
export async function handleUpcomingEvents(request, env, { json, url }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const courseId = url.searchParams.get('course_id');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '5'), 20);
  const now = new Date().toISOString();
  const endOfMonth = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  // Reuse list handler logic with current time as start
  const fakeUrl = new URL(request.url);
  fakeUrl.searchParams.set('start', now);
  fakeUrl.searchParams.set('end', endOfMonth);

  const fakeRequest = new Request(fakeUrl.toString(), {
    headers: request.headers,
  });
  const result = await handleListCalendarEvents(fakeRequest, env, { json: (d) => d, url: fakeUrl });

  // If json() was called, we need to extract
  // Instead, query directly
  const allUrl = new URL(request.url);
  allUrl.searchParams.set('start', now);
  allUrl.searchParams.set('end', endOfMonth);
  if (courseId) allUrl.searchParams.set('course_id', courseId);

  // Re-invoke with modified URL
  const upcoming = await _getUpcomingDirect(env, courseId, now, endOfMonth, limit);
  return json({ events: upcoming, total: upcoming.length });
}

async function _getUpcomingDirect(env, courseId, start, end, limit) {
  const events = [];

  if (env.NOCO_CALENDAR) {
    let where = `(IsDeleted,eq,false)~and(StartAt,gte,${start})~and(StartAt,lte,${end})`;
    if (courseId) where += `~and(CourseId,eq,${courseId})`;
    const r = await nocoFetch(env,
      `/api/v2/tables/${env.NOCO_CALENDAR}/records?where=${encodeURIComponent(where)}&limit=${limit}&sort=StartAt`
    );
    if (r.ok) {
      const d = await r.json();
      events.push(...(d.list || []).map(e => ({ ...e, type: e.Type || 'event' })));
    }
  }

  if (env.NOCO_ASSESSMENTS && courseId && events.length < limit) {
    let aWhere = `(Status,eq,published)~and(CourseId,eq,${courseId})~and(DueAt,gte,${start})~and(DueAt,lte,${end})`;
    const aR = await nocoFetch(env,
      `/api/v2/tables/${env.NOCO_ASSESSMENTS}/records?where=${encodeURIComponent(aWhere)}&fields=Id,Title,DueAt&limit=${limit}&sort=DueAt`
    );
    if (aR.ok) {
      const aD = await aR.json();
      for (const a of (aD.list || [])) {
        if (!a.DueAt) continue;
        events.push({ Id: `asgn_${a.Id}`, Title: a.Title, StartAt: a.DueAt, type: 'assignment' });
      }
    }
  }

  events.sort((a, b) => (a.StartAt || '').localeCompare(b.StartAt || ''));
  return events.slice(0, limit);
}

// ── POST /api/calendar/events ─────────────────────────────────
export async function handleCreateCalendarEvent(request, env, { json }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!isTeacherOrAdmin(session.role)) return json({ error: 'Chỉ giáo viên/admin có thể tạo sự kiện' }, 403);

  if (!env.NOCO_CALENDAR) return json({ error: 'Tính năng lịch chưa được cấu hình' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { course_id, title, description, start_at, end_at, type = 'event' } = body;
  if (!course_id) return json({ error: 'Thiếu course_id' }, 400);
  if (!title || title.trim().length < 2) return json({ error: 'Tiêu đề ít nhất 2 ký tự' }, 400);
  if (!start_at) return json({ error: 'Thiếu thời gian bắt đầu (start_at)' }, 400);

  const validTypes = ['event', 'holiday', 'assignment', 'exam'];
  const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_CALENDAR}/records`, 'POST', {
    CourseId: String(course_id),
    Title: title.trim().slice(0, 255),
    Description: (description || '').trim().slice(0, 2000),
    StartAt: start_at,
    EndAt: end_at || start_at,
    Type: validTypes.includes(type) ? type : 'event',
    CreatedBy: String(session.userId),
    IsDeleted: false,
  });

  if (!r.ok) return json({ error: 'Không thể tạo sự kiện' }, 502);
  const created = await r.json();
  return json({ ok: true, event: created }, 201);
}

// ── PUT /api/calendar/events/:id ──────────────────────────────
export async function handleUpdateCalendarEvent(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!isTeacherOrAdmin(session.role)) return json({ error: 'Không có quyền chỉnh sửa' }, 403);

  const id = path.split('/')[4];
  if (!id || !env.NOCO_CALENDAR) return json({ error: 'Not found' }, 404);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const patch = {};
  if (body.title) patch.Title = body.title.trim().slice(0, 255);
  if (body.description !== undefined) patch.Description = (body.description || '').trim().slice(0, 2000);
  if (body.start_at) patch.StartAt = body.start_at;
  if (body.end_at) patch.EndAt = body.end_at;
  if (body.type) patch.Type = body.type;

  if (Object.keys(patch).length === 0) return json({ error: 'Không có gì để cập nhật' }, 400);

  await nocoFetch(env, `/api/v2/tables/${env.NOCO_CALENDAR}/records/${id}`, 'PATCH', patch);
  return json({ ok: true });
}

// ── DELETE /api/calendar/events/:id ──────────────────────────
export async function handleDeleteCalendarEvent(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!isTeacherOrAdmin(session.role)) return json({ error: 'Không có quyền xoá' }, 403);

  const id = path.split('/')[4];
  if (!id || !env.NOCO_CALENDAR) return json({ error: 'Not found' }, 404);

  // Only allow deleting manually created events (not auto-generated from assessments/exams)
  if (id.startsWith('asgn_') || id.startsWith('exam_'))
    return json({ error: 'Không thể xoá sự kiện tự động — xoá bài thi/kiểm tra trực tiếp' }, 400);

  await nocoFetch(env, `/api/v2/tables/${env.NOCO_CALENDAR}/records/${id}`, 'PATCH', {
    IsDeleted: true,
  });
  return json({ ok: true });
}

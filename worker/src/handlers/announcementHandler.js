/**
 * Announcement Handler — Course announcements from teacher/admin
 *
 * GET    /api/announcements?course_id=X   — list (students: published only)
 * POST   /api/announcements               — create (teacher/admin only)
 * PUT    /api/announcements/:id           — edit (teacher/admin only)
 * DELETE /api/announcements/:id           — soft delete
 * POST   /api/announcements/:id/read      — mark as read (per-user in D1)
 * GET    /api/announcements/unread-count  — unread count for nav badge
 *
 * NocoDB tables required:
 *   env.NOCO_ANNOUNCEMENTS — Announcements
 *     Fields: Id, CourseId, AuthorId, AuthorName, Title, Body,
 *             PublishedAt (ISO string or null), ExpiredAt (ISO string or null),
 *             IsDeleted (bool)
 *
 * D1 table (via /admin/setup/d1-schema):
 *   announcement_reads (announcement_id TEXT, user_id TEXT, read_at TEXT)
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

// ── GET /api/announcements?course_id=X ───────────────────────
export async function handleListAnnouncements(request, env, { json, url }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const courseId = url.searchParams.get('course_id');
  if (!courseId) return json({ error: 'Thiếu course_id' }, 400);

  if (!env.NOCO_ANNOUNCEMENTS) return json({ announcements: [], total: 0 });

  const now = new Date().toISOString();
  const page = parseInt(url.searchParams.get('page') || '1');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 50);
  const offset = (page - 1) * limit;

  let where = `(CourseId,eq,${courseId})~and(IsDeleted,eq,false)`;

  // Students only see published + non-expired announcements
  if (!isTeacherOrAdmin(session.role)) {
    where += `~and(PublishedAt,lte,${now})`;
  }

  const r = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_ANNOUNCEMENTS}/records?where=${encodeURIComponent(where)}&limit=${limit}&offset=${offset}&sort=-CreatedAt`
  );
  if (!r.ok) return json({ announcements: [], total: 0 });

  const data = await r.json();
  const announcements = data.list || [];

  // Attach read status from D1
  let readIds = new Set();
  if (env.D1 && announcements.length > 0) {
    try {
      const ids = announcements.map(a => String(a.Id));
      const placeholders = ids.map(() => '?').join(',');
      const reads = await env.D1.prepare(
        `SELECT announcement_id FROM announcement_reads WHERE user_id=? AND announcement_id IN (${placeholders})`
      ).bind(String(session.userId), ...ids).all();
      readIds = new Set((reads.results || []).map(r => String(r.announcement_id)));
    } catch { /* D1 table may not exist */ }
  }

  return json({
    announcements: announcements.map(a => ({ ...a, is_read: readIds.has(String(a.Id)) })),
    total: data.pageInfo?.totalRows ?? announcements.length,
    page,
    limit,
  });
}

// ── GET /api/announcements/unread-count ──────────────────────
export async function handleAnnouncementUnreadCount(request, env, { json, url }) {
  const session = await getSession(request, env);
  if (!session) return json({ unread: 0 });

  const courseId = url.searchParams.get('course_id');
  if (!env.NOCO_ANNOUNCEMENTS || !env.D1) return json({ unread: 0 });

  try {
    const now = new Date().toISOString();
    let where = `(IsDeleted,eq,false)~and(PublishedAt,lte,${now})`;
    if (courseId) where += `~and(CourseId,eq,${courseId})`;

    const r = await nocoFetch(env,
      `/api/v2/tables/${env.NOCO_ANNOUNCEMENTS}/records?where=${encodeURIComponent(where)}&fields=Id&limit=200`
    );
    if (!r.ok) return json({ unread: 0 });

    const data = await r.json();
    const allIds = (data.list || []).map(a => String(a.Id));
    if (allIds.length === 0) return json({ unread: 0 });

    const placeholders = allIds.map(() => '?').join(',');
    const reads = await env.D1.prepare(
      `SELECT announcement_id FROM announcement_reads WHERE user_id=? AND announcement_id IN (${placeholders})`
    ).bind(String(session.userId), ...allIds).all();

    const readCount = (reads.results || []).length;
    return json({ unread: allIds.length - readCount });
  } catch {
    return json({ unread: 0 });
  }
}

// ── POST /api/announcements ───────────────────────────────────
export async function handleCreateAnnouncement(request, env, { json }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!isTeacherOrAdmin(session.role)) return json({ error: 'Chỉ giáo viên/admin có thể tạo thông báo' }, 403);

  if (!env.NOCO_ANNOUNCEMENTS) return json({ error: 'Tính năng thông báo chưa được cấu hình' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { course_id, title, content, publish_at, expire_at } = body;
  if (!course_id) return json({ error: 'Thiếu course_id' }, 400);
  if (!title || title.trim().length < 3) return json({ error: 'Tiêu đề ít nhất 3 ký tự' }, 400);
  if (!content || content.trim().length < 5) return json({ error: 'Nội dung không được để trống' }, 400);

  const now = new Date().toISOString();
  // If publish_at not given, publish immediately
  const publishedAt = publish_at || now;

  const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_ANNOUNCEMENTS}/records`, 'POST', {
    CourseId: String(course_id),
    AuthorId: String(session.userId),
    AuthorName: session.email,
    Title: title.trim().slice(0, 255),
    Body: content.trim().slice(0, 20000),
    PublishedAt: publishedAt,
    ExpiredAt: expire_at || null,
    IsDeleted: false,
    CreatedAt: now,
  });

  if (!r.ok) return json({ error: 'Không thể tạo thông báo' }, 502);
  const created = await r.json();
  return json({ ok: true, announcement: created }, 201);
}

// ── PUT /api/announcements/:id ────────────────────────────────
export async function handleUpdateAnnouncement(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!isTeacherOrAdmin(session.role)) return json({ error: 'Không có quyền chỉnh sửa' }, 403);

  const id = path.split('/')[3];
  if (!id || !env.NOCO_ANNOUNCEMENTS) return json({ error: 'Not found' }, 404);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const patch = {};
  if (body.title) patch.Title = body.title.trim().slice(0, 255);
  if (body.content) patch.Body = body.content.trim().slice(0, 20000);
  if (body.publish_at !== undefined) patch.PublishedAt = body.publish_at;
  if (body.expire_at !== undefined) patch.ExpiredAt = body.expire_at;

  if (Object.keys(patch).length === 0) return json({ error: 'Không có gì để cập nhật' }, 400);

  await nocoFetch(env, `/api/v2/tables/${env.NOCO_ANNOUNCEMENTS}/records/${id}`, 'PATCH', patch);
  return json({ ok: true });
}

// ── DELETE /api/announcements/:id ────────────────────────────
export async function handleDeleteAnnouncement(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!isTeacherOrAdmin(session.role)) return json({ error: 'Không có quyền xoá' }, 403);

  const id = path.split('/')[3];
  if (!id || !env.NOCO_ANNOUNCEMENTS) return json({ error: 'Not found' }, 404);

  await nocoFetch(env, `/api/v2/tables/${env.NOCO_ANNOUNCEMENTS}/records/${id}`, 'PATCH', {
    IsDeleted: true,
  });
  return json({ ok: true });
}

// ── POST /api/announcements/:id/read ─────────────────────────
export async function handleMarkAnnouncementRead(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const id = path.split('/')[3];
  if (!id || !env.D1) return json({ ok: true }); // silently succeed

  try {
    await env.D1.prepare(
      `INSERT OR IGNORE INTO announcement_reads (announcement_id, user_id, read_at) VALUES (?,?,?)`
    ).bind(String(id), String(session.userId), new Date().toISOString()).run();
  } catch { /* table may not exist */ }

  return json({ ok: true });
}

/**
 * Portfolio Handler — Student ePortfolio
 *
 * GET    /api/portfolio/:userId              — view portfolio (public if visibility allows)
 * GET    /api/portfolio/my                   — my portfolio entries
 * POST   /api/portfolio/entries              — add entry
 * PUT    /api/portfolio/entries/:id          — edit entry
 * DELETE /api/portfolio/entries/:id          — delete entry
 * PATCH  /api/portfolio/entries/:id/visibility — change visibility
 *
 * Entry types:
 *   - reflection: written reflection on a learning experience
 *   - artifact: link to work (assignment, project, file)
 *   - achievement: badge or certificate earned
 *   - external: link to external work (GitHub, blog, etc.)
 *
 * Visibility:
 *   - private: only student can see
 *   - course:  enrolled students + teacher can see
 *   - public:  anyone with a link can see
 *
 * NocoDB table required:
 *   env.NOCO_PORTFOLIO — PortfolioEntries
 *     Fields: Id, UserId, UserName, Title, Body, Type, ArtifactUrl,
 *             Visibility (private|course|public), CourseId,
 *             Tags, IsDeleted, CreatedAt, UpdatedAt
 */
import { getTokenSecret, verifyToken } from '../auth.js';
import { nocoFetch } from '../db.js';

async function getSession(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '');
  if (!token) return null;
  return verifyToken(token, getTokenSecret(env));
}

// ── GET /api/portfolio/:userId ────────────────────────────────
export async function handleViewPortfolio(request, env, { json, path, url }) {
  // Public portfolios don't require auth
  const session = await getSession(request, env);
  const userId = path.split('/')[3];
  if (!userId || !env.NOCO_PORTFOLIO) return json({ entries: [], profile: null });

  const courseId = url.searchParams.get('course_id');
  const isSelf = session && String(session.userId) === String(userId);
  const isPrivileged = session && (session.role === 'admin' || session.role === 'teacher');

  // Build visibility filter
  let visWhere;
  if (isSelf || isPrivileged) {
    visWhere = `(IsDeleted,eq,false)`; // see everything
  } else if (session) {
    visWhere = `(IsDeleted,eq,false)~and(Visibility,neq,private)`; // see course + public
  } else {
    visWhere = `(IsDeleted,eq,false)~and(Visibility,eq,public)`; // see public only
  }

  let where = `(UserId,eq,${userId})~and${visWhere.slice(0, -1).replace('(', '')}`;
  // Rebuild properly
  where = `(UserId,eq,${userId})~and(IsDeleted,eq,false)`;
  if (!isSelf && !isPrivileged) {
    where += session ? `~and(Visibility,neq,private)` : `~and(Visibility,eq,public)`;
  }
  if (courseId) where += `~and(CourseId,eq,${courseId})`;

  const r = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_PORTFOLIO}/records?where=${encodeURIComponent(where)}&limit=100&sort=-CreatedAt`
  );
  if (!r.ok) return json({ entries: [], profile: null });

  const entries = (await r.json()).list || [];

  // Get user profile
  let profile = null;
  if (env.NOCO_USERS) {
    const uR = await nocoFetch(env, `/api/v2/tables/${env.NOCO_USERS}/records/${userId}?fields=Id,Name,HoTen,Email,Bio`);
    if (uR.ok) {
      const u = await uR.json();
      profile = { id: u.Id, name: u.Name || u.HoTen, bio: u.Bio };
    }
  }

  return json({ entries, profile, total: entries.length });
}

// ── GET /api/portfolio/my ─────────────────────────────────────
export async function handleMyPortfolio(request, env, { json, url }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!env.NOCO_PORTFOLIO) return json({ entries: [] });

  const type = url.searchParams.get('type');
  const courseId = url.searchParams.get('course_id');

  let where = `(UserId,eq,${session.userId})~and(IsDeleted,eq,false)`;
  if (type) where += `~and(Type,eq,${type})`;
  if (courseId) where += `~and(CourseId,eq,${courseId})`;

  const r = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_PORTFOLIO}/records?where=${encodeURIComponent(where)}&limit=100&sort=-CreatedAt`
  );
  if (!r.ok) return json({ entries: [] });
  return json({ entries: (await r.json()).list || [] });
}

// ── POST /api/portfolio/entries ───────────────────────────────
export async function handleCreateEntry(request, env, { json }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!env.NOCO_PORTFOLIO) return json({ error: 'Tính năng portfolio chưa được cấu hình' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { title, content, type = 'reflection', artifact_url, visibility = 'private', course_id, tags } = body;
  if (!title || title.trim().length < 2) return json({ error: 'Tiêu đề ít nhất 2 ký tự' }, 400);
  if (!content || content.trim().length < 5) return json({ error: 'Nội dung ít nhất 5 ký tự' }, 400);

  const validTypes = ['reflection', 'artifact', 'achievement', 'external'];
  const validVis = ['private', 'course', 'public'];
  const now = new Date().toISOString();

  const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_PORTFOLIO}/records`, 'POST', {
    UserId: String(session.userId),
    UserName: session.email,
    Title: title.trim().slice(0, 255),
    Body: content.trim().slice(0, 10000),
    Type: validTypes.includes(type) ? type : 'reflection',
    ArtifactUrl: artifact_url || null,
    Visibility: validVis.includes(visibility) ? visibility : 'private',
    CourseId: course_id ? String(course_id) : null,
    Tags: tags ? (Array.isArray(tags) ? tags.join(',') : String(tags)).slice(0, 500) : null,
    IsDeleted: false,
    CreatedAt: now,
    UpdatedAt: now,
  });

  if (!r.ok) return json({ error: 'Không thể tạo entry' }, 502);
  const created = await r.json();
  return json({ ok: true, entry: created }, 201);
}

// ── PUT /api/portfolio/entries/:id ────────────────────────────
export async function handleUpdateEntry(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const id = path.split('/')[4];
  if (!id || !env.NOCO_PORTFOLIO) return json({ error: 'Not found' }, 404);

  // Verify ownership
  const eR = await nocoFetch(env, `/api/v2/tables/${env.NOCO_PORTFOLIO}/records/${id}`);
  if (!eR.ok) return json({ error: 'Không tìm thấy entry' }, 404);
  const entry = await eR.json();
  if (String(entry.UserId) !== String(session.userId) && session.role !== 'admin')
    return json({ error: 'Không có quyền chỉnh sửa' }, 403);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const patch = { UpdatedAt: new Date().toISOString() };
  if (body.title) patch.Title = body.title.trim().slice(0, 255);
  if (body.content) patch.Body = body.content.trim().slice(0, 10000);
  if (body.artifact_url !== undefined) patch.ArtifactUrl = body.artifact_url;
  if (body.visibility) {
    const validVis = ['private', 'course', 'public'];
    if (validVis.includes(body.visibility)) patch.Visibility = body.visibility;
  }
  if (body.tags !== undefined) patch.Tags = (Array.isArray(body.tags) ? body.tags.join(',') : String(body.tags || '')).slice(0, 500);

  await nocoFetch(env, `/api/v2/tables/${env.NOCO_PORTFOLIO}/records/${id}`, 'PATCH', patch);
  return json({ ok: true });
}

// ── DELETE /api/portfolio/entries/:id ────────────────────────
export async function handleDeleteEntry(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const id = path.split('/')[4];
  if (!id || !env.NOCO_PORTFOLIO) return json({ error: 'Not found' }, 404);

  const eR = await nocoFetch(env, `/api/v2/tables/${env.NOCO_PORTFOLIO}/records/${id}`);
  if (!eR.ok) return json({ error: 'Không tìm thấy entry' }, 404);
  const entry = await eR.json();
  if (String(entry.UserId) !== String(session.userId) && session.role !== 'admin')
    return json({ error: 'Không có quyền xoá' }, 403);

  await nocoFetch(env, `/api/v2/tables/${env.NOCO_PORTFOLIO}/records/${id}`, 'PATCH', {
    IsDeleted: true, UpdatedAt: new Date().toISOString(),
  });
  return json({ ok: true });
}

// ── PATCH /api/portfolio/entries/:id/visibility ──────────────
export async function handleUpdateVisibility(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const id = path.split('/')[4];
  if (!id || !env.NOCO_PORTFOLIO) return json({ error: 'Not found' }, 404);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const validVis = ['private', 'course', 'public'];
  if (!validVis.includes(body.visibility)) return json({ error: 'Visibility phải là: private, course, public' }, 400);

  await nocoFetch(env, `/api/v2/tables/${env.NOCO_PORTFOLIO}/records/${id}`, 'PATCH', {
    Visibility: body.visibility,
  });
  return json({ ok: true, visibility: body.visibility });
}

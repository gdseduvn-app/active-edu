/**
 * Discussion Handler — Course discussions & Q&A
 *
 * GET    /api/discussions?course_id=X        — list topics (paginated)
 * GET    /api/discussions/:id                 — topic + replies
 * POST   /api/discussions                     — create topic
 * PUT    /api/discussions/:id                 — edit topic (author / teacher / admin)
 * DELETE /api/discussions/:id                 — soft delete
 * POST   /api/discussions/:id/reply           — post reply
 * PUT    /api/discussions/replies/:id         — edit reply (author only)
 * DELETE /api/discussions/replies/:id         — soft delete reply
 *
 * NocoDB tables required:
 *   env.NOCO_DISCUSSIONS     — Discussions
 *   env.NOCO_DISC_REPLIES    — DiscussionReplies
 *
 * D1 tables required (created via POST /admin/setup/d1-schema):
 *   discussion_likes (discussion_id, user_id) — like tracking
 */
import { getTokenSecret, verifyToken } from '../auth.js';
import { nocoFetch } from '../db.js';

async function getSession(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '');
  if (!token) return null;
  return verifyToken(token, getTokenSecret(env));
}

function canModerate(role) {
  return role === 'admin' || role === 'teacher';
}

// ── GET /api/discussions?course_id=X ─────────────────────────
export async function handleListDiscussions(request, env, { json, url }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const courseId = url.searchParams.get('course_id');
  if (!courseId) return json({ error: 'Thiếu course_id' }, 400);

  if (!env.NOCO_DISCUSSIONS) return json({ discussions: [], total: 0 });

  const page = parseInt(url.searchParams.get('page') || '1');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 50);
  const offset = (page - 1) * limit;
  const type = url.searchParams.get('type') || null; // 'discussion' | 'question'

  let where = `(CourseId,eq,${courseId})~and(IsDeleted,eq,false)`;
  if (type) where += `~and(Type,eq,${type})`;

  const r = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_DISCUSSIONS}/records?where=${encodeURIComponent(where)}&limit=${limit}&offset=${offset}&sort=-IsPinned,-CreatedAt`
  );
  if (!r.ok) return json({ discussions: [], total: 0 });

  const data = await r.json();
  return json({
    discussions: data.list || [],
    total: data.pageInfo?.totalRows ?? (data.list || []).length,
    page,
    limit,
  });
}

// ── GET /api/discussions/:id ──────────────────────────────────
export async function handleGetDiscussion(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const id = path.split('/')[3];
  if (!id || !env.NOCO_DISCUSSIONS) return json({ error: 'Not found' }, 404);

  const [dR, rR] = await Promise.all([
    nocoFetch(env, `/api/v2/tables/${env.NOCO_DISCUSSIONS}/records/${id}`),
    env.NOCO_DISC_REPLIES
      ? nocoFetch(env,
          `/api/v2/tables/${env.NOCO_DISC_REPLIES}/records?where=${encodeURIComponent(`(DiscussionId,eq,${id})~and(IsDeleted,eq,false)`)}&limit=200&sort=CreatedAt`
        )
      : null,
  ]);

  if (!dR.ok) return json({ error: 'Không tìm thấy thảo luận' }, 404);
  const discussion = await dR.json();
  if (discussion.IsDeleted) return json({ error: 'Thảo luận đã bị xoá' }, 404);

  const replies = rR && rR.ok ? ((await rR.json()).list || []) : [];

  // Add like status from D1 if table exists
  let likedReplyIds = [];
  if (env.D1) {
    try {
      const likes = await env.D1.prepare(
        `SELECT reply_id FROM discussion_likes WHERE user_id=? AND discussion_id=?`
      ).bind(String(session.userId), String(id)).all();
      likedReplyIds = (likes.results || []).map(r => String(r.reply_id));
    } catch { /* table may not exist yet */ }
  }

  return json({ discussion, replies, liked_reply_ids: likedReplyIds });
}

// ── POST /api/discussions ─────────────────────────────────────
export async function handleCreateDiscussion(request, env, { json }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  if (!env.NOCO_DISCUSSIONS) return json({ error: 'Tính năng thảo luận chưa được cấu hình' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { course_id, title, content, type = 'discussion' } = body;
  if (!course_id) return json({ error: 'Thiếu course_id' }, 400);
  if (!title || title.trim().length < 3) return json({ error: 'Tiêu đề ít nhất 3 ký tự' }, 400);
  if (!content || content.trim().length < 10) return json({ error: 'Nội dung ít nhất 10 ký tự' }, 400);

  const now = new Date().toISOString();
  const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_DISCUSSIONS}/records`, 'POST', {
    CourseId: String(course_id),
    AuthorId: String(session.userId),
    AuthorName: session.email,
    Title: title.trim().slice(0, 255),
    Body: content.trim().slice(0, 10000),
    Type: ['discussion', 'question', 'announcement'].includes(type) ? type : 'discussion',
    IsPinned: false,
    IsDeleted: false,
    ReplyCount: 0,
    CreatedAt: now,
    UpdatedAt: now,
  });

  if (!r.ok) return json({ error: 'Không thể tạo thảo luận' }, 502);
  const created = await r.json();
  return json({ ok: true, discussion: created }, 201);
}

// ── PUT /api/discussions/:id ──────────────────────────────────
export async function handleUpdateDiscussion(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const id = path.split('/')[3];
  if (!id || !env.NOCO_DISCUSSIONS) return json({ error: 'Not found' }, 404);

  const dR = await nocoFetch(env, `/api/v2/tables/${env.NOCO_DISCUSSIONS}/records/${id}`);
  if (!dR.ok) return json({ error: 'Không tìm thấy thảo luận' }, 404);
  const discussion = await dR.json();

  const isAuthor = String(discussion.AuthorId) === String(session.userId);
  if (!isAuthor && !canModerate(session.role)) return json({ error: 'Không có quyền chỉnh sửa' }, 403);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const patch = { UpdatedAt: new Date().toISOString() };
  if (body.title) patch.Title = body.title.trim().slice(0, 255);
  if (body.content) patch.Body = body.content.trim().slice(0, 10000);
  if (canModerate(session.role) && typeof body.is_pinned === 'boolean') patch.IsPinned = body.is_pinned;

  await nocoFetch(env, `/api/v2/tables/${env.NOCO_DISCUSSIONS}/records/${id}`, 'PATCH', patch);
  return json({ ok: true });
}

// ── DELETE /api/discussions/:id ───────────────────────────────
export async function handleDeleteDiscussion(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const id = path.split('/')[3];
  if (!id || !env.NOCO_DISCUSSIONS) return json({ error: 'Not found' }, 404);

  const dR = await nocoFetch(env, `/api/v2/tables/${env.NOCO_DISCUSSIONS}/records/${id}`);
  if (!dR.ok) return json({ error: 'Không tìm thấy thảo luận' }, 404);
  const discussion = await dR.json();

  const isAuthor = String(discussion.AuthorId) === String(session.userId);
  if (!isAuthor && !canModerate(session.role)) return json({ error: 'Không có quyền xoá' }, 403);

  await nocoFetch(env, `/api/v2/tables/${env.NOCO_DISCUSSIONS}/records/${id}`, 'PATCH', {
    IsDeleted: true,
    UpdatedAt: new Date().toISOString(),
  });
  return json({ ok: true });
}

// ── POST /api/discussions/:id/reply ──────────────────────────
export async function handleCreateReply(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const id = path.split('/')[3];
  if (!id || !env.NOCO_DISCUSSIONS || !env.NOCO_DISC_REPLIES)
    return json({ error: 'Tính năng chưa được cấu hình' }, 503);

  const dR = await nocoFetch(env, `/api/v2/tables/${env.NOCO_DISCUSSIONS}/records/${id}`);
  if (!dR.ok) return json({ error: 'Không tìm thấy thảo luận' }, 404);
  const discussion = await dR.json();
  if (discussion.IsDeleted) return json({ error: 'Thảo luận đã bị xoá' }, 404);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { content, parent_reply_id } = body;
  if (!content || content.trim().length < 1) return json({ error: 'Nội dung không được để trống' }, 400);

  const now = new Date().toISOString();
  const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_DISC_REPLIES}/records`, 'POST', {
    DiscussionId: String(id),
    ParentReplyId: parent_reply_id ? String(parent_reply_id) : null,
    AuthorId: String(session.userId),
    AuthorName: session.email,
    Body: content.trim().slice(0, 5000),
    Likes: 0,
    IsDeleted: false,
    CreatedAt: now,
  });

  if (!r.ok) return json({ error: 'Không thể đăng trả lời' }, 502);
  const reply = await r.json();

  // Increment reply count (fire-and-forget)
  nocoFetch(env, `/api/v2/tables/${env.NOCO_DISCUSSIONS}/records/${id}`, 'PATCH', {
    ReplyCount: (discussion.ReplyCount || 0) + 1,
    UpdatedAt: now,
  });

  return json({ ok: true, reply }, 201);
}

// ── PUT /api/discussions/replies/:id ─────────────────────────
export async function handleUpdateReply(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const replyId = path.split('/')[4];
  if (!replyId || !env.NOCO_DISC_REPLIES) return json({ error: 'Not found' }, 404);

  const rR = await nocoFetch(env, `/api/v2/tables/${env.NOCO_DISC_REPLIES}/records/${replyId}`);
  if (!rR.ok) return json({ error: 'Không tìm thấy trả lời' }, 404);
  const reply = await rR.json();

  if (String(reply.AuthorId) !== String(session.userId) && !canModerate(session.role))
    return json({ error: 'Không có quyền chỉnh sửa' }, 403);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  if (!body.content) return json({ error: 'Thiếu nội dung' }, 400);

  await nocoFetch(env, `/api/v2/tables/${env.NOCO_DISC_REPLIES}/records/${replyId}`, 'PATCH', {
    Body: body.content.trim().slice(0, 5000),
  });
  return json({ ok: true });
}

// ── DELETE /api/discussions/replies/:id ──────────────────────
export async function handleDeleteReply(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const replyId = path.split('/')[4];
  if (!replyId || !env.NOCO_DISC_REPLIES) return json({ error: 'Not found' }, 404);

  const rR = await nocoFetch(env, `/api/v2/tables/${env.NOCO_DISC_REPLIES}/records/${replyId}`);
  if (!rR.ok) return json({ error: 'Không tìm thấy trả lời' }, 404);
  const reply = await rR.json();

  if (String(reply.AuthorId) !== String(session.userId) && !canModerate(session.role))
    return json({ error: 'Không có quyền xoá' }, 403);

  await nocoFetch(env, `/api/v2/tables/${env.NOCO_DISC_REPLIES}/records/${replyId}`, 'PATCH', {
    IsDeleted: true,
  });
  return json({ ok: true });
}

// ── POST /api/discussions/:id/like ───────────────────────────
export async function handleLikeDiscussion(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const id = path.split('/')[3]; // discussion id
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const replyId = body.reply_id;

  if (!env.D1) return json({ error: 'Like chưa được cấu hình' }, 503);

  try {
    // Toggle like
    const existing = await env.D1.prepare(
      `SELECT id FROM discussion_likes WHERE user_id=? AND discussion_id=? AND reply_id=?`
    ).bind(String(session.userId), String(id), replyId ? String(replyId) : '').first();

    if (existing) {
      await env.D1.prepare(
        `DELETE FROM discussion_likes WHERE user_id=? AND discussion_id=? AND reply_id=?`
      ).bind(String(session.userId), String(id), replyId ? String(replyId) : '').run();

      // Decrement likes in NocoDB reply (fire-and-forget)
      if (replyId && env.NOCO_DISC_REPLIES) {
        const rR = await nocoFetch(env, `/api/v2/tables/${env.NOCO_DISC_REPLIES}/records/${replyId}`);
        if (rR.ok) {
          const reply = await rR.json();
          nocoFetch(env, `/api/v2/tables/${env.NOCO_DISC_REPLIES}/records/${replyId}`, 'PATCH', {
            Likes: Math.max(0, (reply.Likes || 0) - 1),
          });
        }
      }
      return json({ ok: true, liked: false });
    } else {
      await env.D1.prepare(
        `INSERT OR IGNORE INTO discussion_likes (user_id, discussion_id, reply_id, created_at) VALUES (?,?,?,?)`
      ).bind(String(session.userId), String(id), replyId ? String(replyId) : '', new Date().toISOString()).run();

      // Increment likes in NocoDB reply (fire-and-forget)
      if (replyId && env.NOCO_DISC_REPLIES) {
        const rR = await nocoFetch(env, `/api/v2/tables/${env.NOCO_DISC_REPLIES}/records/${replyId}`);
        if (rR.ok) {
          const reply = await rR.json();
          nocoFetch(env, `/api/v2/tables/${env.NOCO_DISC_REPLIES}/records/${replyId}`, 'PATCH', {
            Likes: (reply.Likes || 0) + 1,
          });
        }
      }
      return json({ ok: true, liked: true });
    }
  } catch (e) {
    return json({ error: 'Lỗi xử lý like: ' + e.message }, 500);
  }
}

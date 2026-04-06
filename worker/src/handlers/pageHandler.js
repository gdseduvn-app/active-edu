/**
 * Page (Bài học / WikiPage) Handler
 * Theo đặc tả: Kiến trúc Quản lý Trang (Pages) trong Module — Canvas LMS Style
 *
 * Routes:
 *   GET  /api/courses/:courseId/pages/:articleId          — view page + lock check + next/prev
 *   POST /api/courses/:courseId/pages/:articleId/mark_done — mark item as done
 *   GET  /api/courses/:courseId/pages/:articleId/progress  — get completion state
 *   GET  /api/courses/:courseId/module-outline             — list all items in all modules (for sidebar)
 */

import { getTokenSecret, verifyToken } from '../auth.js';
import { nocoFetch } from '../db.js';

// ── D1 Schema ──────────────────────────────────────────────────────
const D1_MODULE_PROGRESSIONS = `
  CREATE TABLE IF NOT EXISTS module_progressions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    course_id TEXT,
    module_id TEXT,
    item_id TEXT NOT NULL,
    workflow_state TEXT DEFAULT 'unlocked',
    requirement_type TEXT DEFAULT 'must_view',
    viewed_at TEXT,
    completed_at TEXT,
    UNIQUE(user_id, item_id)
  )
`;

async function ensureSchema(env) {
  if (!env.D1) return;
  await env.D1.prepare(D1_MODULE_PROGRESSIONS).run().catch(() => {});
}

async function getProgression(env, userId, itemId) {
  if (!env.D1) return null;
  try {
    return await env.D1.prepare(
      'SELECT * FROM module_progressions WHERE user_id=? AND item_id=?'
    ).bind(String(userId), String(itemId)).first();
  } catch { return null; }
}

async function upsertProgression(env, userId, courseId, moduleId, itemId, state, reqType) {
  if (!env.D1) return;
  const now = new Date().toISOString();
  try {
    await env.D1.prepare(`
      INSERT INTO module_progressions (user_id, course_id, module_id, item_id, workflow_state, requirement_type, viewed_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, item_id) DO UPDATE SET
        workflow_state = CASE WHEN workflow_state = 'completed' THEN 'completed' ELSE excluded.workflow_state END,
        viewed_at      = COALESCE(viewed_at, excluded.viewed_at),
        completed_at   = CASE WHEN excluded.workflow_state = 'completed' THEN excluded.completed_at ELSE completed_at END
    `).bind(
      String(userId), String(courseId || ''), String(moduleId || ''), String(itemId),
      state, reqType,
      state !== 'locked' ? now : null,
      state === 'completed' ? now : null
    ).run();
  } catch(e) { console.error('[pageHandler upsertProgression]', e.message); }
}

// ── Helper: compute next/prev items in same module ────────────────
async function getSiblings(env, moduleId, currentArticleId) {
  if (!env.NOCO_ARTICLE || !moduleId) return { prev: null, next: null };
  const r = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_ARTICLE}/records?where=(ModuleId,eq,${moduleId})~and(Published,eq,true)~and(DeletedAt,is,null)&fields=Id,Title,ItemType&sort=Id&limit=200`
  );
  if (!r.ok) return { prev: null, next: null };
  const items = (await r.json()).list || [];
  const idx = items.findIndex(s => String(s.Id) === String(currentArticleId));
  return {
    prev: idx > 0 ? { id: items[idx - 1].Id, title: items[idx - 1].Title, type: items[idx - 1].ItemType } : null,
    next: idx >= 0 && idx < items.length - 1 ? { id: items[idx + 1].Id, title: items[idx + 1].Title, type: items[idx + 1].ItemType } : null,
    all: items,
    currentIndex: idx,
  };
}

// ── Helper: evaluate lock state ───────────────────────────────────
async function evaluateLock(env, session, module) {
  if (!module) return { locked: false, reason: null };
  if (!module.UnlockCondition && !module.Prerequisites) return { locked: false, reason: null };

  try {
    const { checkModuleUnlock } = await import('../prerequisites.js');
    const cond = module.UnlockCondition || module.Prerequisites;
    const check = await checkModuleUnlock(env, session.userId, cond);
    if (!check.ok) return { locked: true, reason: check.reason || 'Module chưa được mở khoá' };
  } catch {}
  return { locked: false, reason: null };
}

// ══════════════════════════════════════════════════════════════════
// GET /api/courses/:courseId/pages/:articleId
// ══════════════════════════════════════════════════════════════════
export async function handlePageView(request, env, { json, path }) {
  const authHeader = request.headers.get('Authorization') || '';
  const session = await verifyToken(authHeader.replace('Bearer ', ''), getTokenSecret(env));
  if (!session) return json({ error: 'Unauthorized' }, 401);

  // /api/courses/123/pages/456
  const parts = path.split('/');
  const courseId = parts[3];
  const articleId = parts[5];
  if (!articleId || !env.NOCO_ARTICLE) return json({ error: 'Không tìm thấy trang' }, 404);

  await ensureSchema(env);

  // 1. Fetch article
  const ar = await nocoFetch(env, `/api/v2/tables/${env.NOCO_ARTICLE}/records/${articleId}`);
  if (!ar.ok) return json({ error: 'Trang không tồn tại' }, 404);
  const article = await ar.json();
  if (!article.Id) return json({ error: 'Trang không tồn tại' }, 404);
  if (article.Published === false || article.Published === 0)
    return json({ error: 'Trang chưa được xuất bản' }, 403);

  // 2. Fetch module context
  let module = null;
  if (article.ModuleId && env.NOCO_MODULES) {
    const mr = await nocoFetch(env, `/api/v2/tables/${env.NOCO_MODULES}/records/${article.ModuleId}`);
    if (mr.ok) module = await mr.json();
  }

  // 3. Lock evaluation
  const { locked, reason: lockReason } = await evaluateLock(env, session, module);

  // 4. Compute next/prev
  const { prev: prevItem, next: nextItem, all: siblings, currentIndex } =
    await getSiblings(env, article.ModuleId, articleId);

  // 5. Completion requirement (from article field or default)
  let reqType = 'must_view';
  try {
    const reqs = typeof article.CompletionRequirements === 'string'
      ? JSON.parse(article.CompletionRequirements)
      : (article.CompletionRequirements || {});
    if (reqs.mark_done || reqs.must_contribute) reqType = 'mark_done';
    else if (reqs.must_submit) reqType = 'must_submit';
  } catch {}

  // 6. Get / update progression
  let progression = await getProgression(env, session.userId, articleId);
  let completed = progression?.workflow_state === 'completed';

  // Auto-complete for must_view (on successful access)
  if (!locked && reqType === 'must_view' && !completed) {
    await upsertProgression(env, session.userId, courseId, article.ModuleId, articleId, 'completed', 'must_view');
    completed = true;
  } else if (!locked && !progression) {
    // Mark as viewed (not completed yet — needs explicit mark_done)
    await upsertProgression(env, session.userId, courseId, article.ModuleId, articleId, 'unlocked', reqType);
  }

  return json({
    page: {
      id: article.Id,
      title: article.Title || '',
      body: locked ? null : (article.Content || article.Body || ''),
      itemType: article.ItemType || 'article',
      path: article.Path || '',
      updatedAt: article.Updated || article.UpdatedAt || null,
    },
    module: module ? {
      id: module.Id,
      name: module.Name || module.Title || 'Module',
      courseId: module.CourseId || courseId,
    } : null,
    courseId,
    locked,
    lockReason,
    completionRequirement: {
      type: reqType,
      completed,
      viewedAt: progression?.viewed_at || null,
      completedAt: progression?.completed_at || null,
    },
    navigation: {
      previousItem: prevItem,
      nextItem: nextItem,
      totalInModule: siblings.length,
      currentPosition: currentIndex + 1,
    },
  });
}

// ══════════════════════════════════════════════════════════════════
// POST /api/courses/:courseId/pages/:articleId/mark_done
// ══════════════════════════════════════════════════════════════════
export async function handleMarkDone(request, env, { json, path }) {
  const authHeader = request.headers.get('Authorization') || '';
  const session = await verifyToken(authHeader.replace('Bearer ', ''), getTokenSecret(env));
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const parts = path.split('/');
  const courseId = parts[3];
  const articleId = parts[5];
  if (!articleId) return json({ error: 'articleId required' }, 400);

  await ensureSchema(env);

  // Get module context for the article
  let moduleId = null;
  if (env.NOCO_ARTICLE) {
    const ar = await nocoFetch(env, `/api/v2/tables/${env.NOCO_ARTICLE}/records/${articleId}?fields=Id,ModuleId`);
    if (ar.ok) { const a = await ar.json(); moduleId = a.ModuleId; }
  }

  // Check if already completed (don't downgrade)
  const existing = await getProgression(env, session.userId, articleId);
  if (existing?.workflow_state === 'completed') {
    return json({ ok: true, completed: true, alreadyDone: true });
  }

  await upsertProgression(env, session.userId, courseId, moduleId, articleId, 'completed', 'mark_done');

  // Check if entire module is now completed (cascade unlock next module)
  let moduleCompleted = false;
  if (moduleId && env.D1 && env.NOCO_ARTICLE) {
    try {
      // Get all items in this module that have completion requirements
      const ar = await nocoFetch(env,
        `/api/v2/tables/${env.NOCO_ARTICLE}/records?where=(ModuleId,eq,${moduleId})~and(Published,eq,true)&fields=Id,CompletionRequirements&limit=200`
      );
      if (ar.ok) {
        const items = (await ar.json()).list || [];
        const requiredItems = items.filter(it => {
          try {
            const r = typeof it.CompletionRequirements === 'string'
              ? JSON.parse(it.CompletionRequirements)
              : (it.CompletionRequirements || {});
            return r.mark_done || r.must_view || r.must_submit;
          } catch { return false; }
        });

        if (requiredItems.length > 0) {
          const completedIds = await env.D1.prepare(`
            SELECT item_id FROM module_progressions
            WHERE user_id=? AND module_id=? AND workflow_state='completed'
          `).bind(String(session.userId), String(moduleId)).all();

          const completedSet = new Set((completedIds.results || []).map(r => String(r.item_id)));
          moduleCompleted = requiredItems.every(it => completedSet.has(String(it.Id)));
        }
      }
    } catch(e) { console.error('[pageHandler cascade]', e.message); }
  }

  return json({ ok: true, completed: true, moduleCompleted });
}

// ══════════════════════════════════════════════════════════════════
// GET /api/courses/:courseId/pages/:articleId/progress
// ══════════════════════════════════════════════════════════════════
export async function handlePageProgress(request, env, { json, path }) {
  const authHeader = request.headers.get('Authorization') || '';
  const session = await verifyToken(authHeader.replace('Bearer ', ''), getTokenSecret(env));
  if (!session) return json({ completed: false, state: 'unlocked' });

  const parts = path.split('/');
  const articleId = parts[5];
  if (!articleId) return json({ completed: false, state: 'unlocked' });

  await ensureSchema(env);
  const prog = await getProgression(env, session.userId, articleId);
  return json({
    completed: prog?.workflow_state === 'completed',
    state: prog?.workflow_state || 'unlocked',
    viewedAt: prog?.viewed_at || null,
    completedAt: prog?.completed_at || null,
  });
}

// ══════════════════════════════════════════════════════════════════
// GET /api/courses/:courseId/module-outline
// Trả về tất cả modules + items + completion state của user
// Dùng cho sidebar trong page.html
// ══════════════════════════════════════════════════════════════════
export async function handleModuleOutline(request, env, { json, path, url }) {
  const authHeader = request.headers.get('Authorization') || '';
  const session = await verifyToken(authHeader.replace('Bearer ', ''), getTokenSecret(env));
  if (!session) return json({ modules: [] });

  const parts = path.split('/');
  const courseId = parts[3];
  if (!courseId) return json({ modules: [] });

  await ensureSchema(env);

  // Get all modules for course
  let modules = [];
  if (env.NOCO_MODULES) {
    const mr = await nocoFetch(env,
      `/api/v2/tables/${env.NOCO_MODULES}/records?where=(CourseId,eq,${courseId})~and(DeletedAt,is,null)&sort=Id&limit=100`
    );
    if (mr.ok) modules = (await mr.json()).list || [];
  }

  // Get all articles for course (via module membership)
  let allItems = [];
  if (env.NOCO_ARTICLE && modules.length) {
    const modIds = modules.map(m => `(ModuleId,eq,${m.Id})`).join('~or');
    const ar = await nocoFetch(env,
      `/api/v2/tables/${env.NOCO_ARTICLE}/records?where=(${modIds})~and(Published,eq,true)&fields=Id,Title,ItemType,ModuleId,CompletionRequirements&sort=Id&limit=500`
    );
    if (ar.ok) allItems = (await ar.json()).list || [];
  }

  // Get user's completions for this course
  let completedSet = new Set();
  if (env.D1 && courseId) {
    try {
      const rows = await env.D1.prepare(
        `SELECT item_id FROM module_progressions WHERE user_id=? AND course_id=? AND workflow_state='completed'`
      ).bind(String(session.userId), String(courseId)).all();
      completedSet = new Set((rows.results || []).map(r => String(r.item_id)));
    } catch {}
  }

  // Build outline
  const outline = modules.map(mod => {
    const items = allItems
      .filter(it => String(it.ModuleId) === String(mod.Id))
      .map(it => ({
        id: it.Id,
        title: it.Title,
        type: it.ItemType || 'article',
        completed: completedSet.has(String(it.Id)),
        position: it.Position || 0,
      }))
      .sort((a, b) => (a.position || 0) - (b.position || 0) || a.id - b.id);

    const totalRequired = items.filter(it => it.completed !== undefined).length;
    const totalCompleted = items.filter(it => it.completed).length;

    return {
      id: mod.Id,
      name: mod.Name || mod.Title || 'Module',
      workflowState: mod.WorkflowState || 'active',
      items,
      progress: totalRequired > 0 ? Math.round(totalCompleted / totalRequired * 100) : 0,
    };
  });

  return json({ modules: outline, userId: session.userId });
}

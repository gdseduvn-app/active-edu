import { getTokenSecret, verifyToken } from '../auth.js';
import { nocoFetch, fetchAll } from '../db.js';
import { checkPrerequisites, checkModuleUnlock } from '../prerequisites.js';

export async function handlePrereqCheck(request, env, { json, path }) {
  const articleId = path.slice('/api/prereq/'.length);
  if (!articleId) return json({ ok: true });

  const authHeader = request.headers.get('Authorization') || '';
  const secret = getTokenSecret(env);
  const session = await verifyToken(authHeader.replace('Bearer ', ''), secret);
  if (!session) return json({ ok: false, reason: 'Chưa đăng nhập', requireLogin: true });

  if (!env.NOCO_ARTICLE) return json({ ok: true });
  const artR = await nocoFetch(env, `/api/v2/tables/${env.NOCO_ARTICLE}/records/${articleId}?fields=Id,Prerequisites,ModuleId`);
  if (!artR.ok) return json({ ok: true });
  const art = await artR.json();
  if (!art?.Prerequisites) return json({ ok: true });

  return json(await checkPrerequisites(env, session.userId, art.Prerequisites));
}

export async function handleModuleUnlock(request, env, { json, path }) {
  const moduleId = path.slice('/api/module-unlock/'.length);
  if (!moduleId || !env.NOCO_MODULES) return json({ ok: true });

  const authHeader = request.headers.get('Authorization') || '';
  const secret = getTokenSecret(env);
  const session = await verifyToken(authHeader.replace('Bearer ', ''), secret);
  if (!session) return json({ ok: false, reason: 'Chưa đăng nhập', requireLogin: true });

  const modR = await nocoFetch(env, `/api/v2/tables/${env.NOCO_MODULES}/records/${moduleId}?fields=Id,UnlockCondition`);
  if (!modR.ok) return json({ ok: true });
  const mod = await modR.json();
  if (!mod?.UnlockCondition) return json({ ok: true });

  return json(await checkModuleUnlock(env, session.userId, mod.UnlockCondition));
}

export async function handleCourseUnlockStatus(request, env, { json, path }) {
  const courseId = path.split('/')[3];
  if (!courseId || !env.NOCO_MODULES) return json({ statuses: {} });

  const authHeader = request.headers.get('Authorization') || '';
  const secret = getTokenSecret(env);
  const session = await verifyToken(authHeader.replace('Bearer ', ''), secret);
  if (!session) return json({ statuses: {} });

  const modsR = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_MODULES}/records?where=(CourseId,eq,${courseId})&fields=Id,UnlockCondition&limit=100`
  );
  const modules = modsR.ok ? ((await modsR.json()).list || []) : [];
  const lockedModIds = modules.filter(m => m.UnlockCondition).map(m => String(m.Id));
  let progressMap = {};

  if (lockedModIds.length && env.NOCO_ARTICLE && env.NOCO_PROGRESS) {
    const articles = await fetchAll(env,
      `/api/v2/tables/${env.NOCO_ARTICLE}/records?where=(ModuleId,in,${lockedModIds.join(',')})&fields=Id,ModuleId`
    );
    const articleIds = articles.map(a => String(a.Id));

    if (articleIds.length) {
      const progR = await nocoFetch(env,
        `/api/v2/tables/${env.NOCO_PROGRESS}/records?where=(UserId,eq,${session.userId})~and(ArticleId,in,${articleIds.join(',')})&fields=ArticleId,Score&limit=500`
      );
      if (progR.ok) {
        for (const p of ((await progR.json()).list || []))
          progressMap[String(p.ArticleId)] = p.Score || 0;
      }
    }

    const moduleArticles = {};
    for (const a of articles) {
      const mid = String(a.ModuleId);
      if (!moduleArticles[mid]) moduleArticles[mid] = [];
      moduleArticles[mid].push(String(a.Id));
    }

    const statuses = {};
    for (const mod of modules) {
      if (!mod.UnlockCondition) { statuses[mod.Id] = { ok: true }; continue; }
      const m = mod.UnlockCondition.match(/^module:(\d+):score([><=!]+)(\d+)$/);
      if (!m) { statuses[mod.Id] = { ok: true }; continue; }
      const [, refModId, op, val] = m;
      const threshold = parseInt(val);
      const refArticles = moduleArticles[refModId] || [];
      const scores = refArticles.map(aid => progressMap[aid] || 0).filter(s => s > 0);
      const avgScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
      const passed = op === '>=' ? avgScore >= threshold : op === '>' ? avgScore > threshold : avgScore >= threshold;
      statuses[mod.Id] = passed ? { ok: true } : { ok: false, reason: `Cần điểm trung bình ${op}${threshold}% ở module trước (hiện tại: ${avgScore}%)` };
    }
    return json({ statuses });
  }

  return json({ statuses: Object.fromEntries(modules.map(m => [m.Id, { ok: true }])) });
}

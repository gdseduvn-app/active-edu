import { nocoFetch, fetchAll } from './db.js';

// ── Prerequisites & Unlock helpers ───────────────────────────

export function parsePrerequisites(raw) {
  if (!raw) return [];
  return String(raw).split(',').map(s => s.trim()).filter(Boolean);
}

export async function _getUserScore(env, userId, articleId) {
  if (!env.NOCO_PROGRESS) return null;
  const r = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_PROGRESS}/records?where=(UserId,eq,${userId})~and(ArticleId,eq,${encodeURIComponent(articleId)})&limit=1&fields=Completed,Score`
  );
  if (!r.ok) return null;
  const data = await r.json();
  const row = (data.list || [])[0];
  return row ? { completed: !!row.Completed, score: row.Score || 0 } : null;
}

export async function checkPrerequisites(env, userId, prerequisiteRaw) {
  const prereqs = parsePrerequisites(prerequisiteRaw);
  if (!prereqs.length) return { ok: true };

  for (const p of prereqs) {
    const [articleId, condition] = p.split(':');
    const progress = await _getUserScore(env, userId, articleId);
    if (!progress) return { ok: false, missing: articleId, reason: 'Chưa học bài này' };

    if (condition) {
      const m = condition.match(/^score([><=!]+)(\d+)$/);
      if (m) {
        const [, op, val] = m;
        const threshold = parseInt(val);
        const score = progress.score || 0;
        let passed = false;
        if (op === '>=') passed = score >= threshold;
        else if (op === '>') passed = score > threshold;
        else if (op === '<=') passed = score <= threshold;
        else if (op === '<') passed = score < threshold;
        else if (op === '==' || op === '=') passed = score === threshold;
        if (!passed)
          return { ok: false, missing: articleId, reason: `Cần đạt ${threshold}% ở bài #${articleId} (hiện tại: ${score}%)` };
      }
    } else {
      if (!progress.completed)
        return { ok: false, missing: articleId, reason: `Chưa hoàn thành bài #${articleId}` };
    }
  }
  return { ok: true };
}

export async function checkModuleUnlock(env, userId, unlockCondition) {
  if (!unlockCondition || !unlockCondition.trim()) return { ok: true };
  const m = unlockCondition.match(/^module:(\d+):score([><=!]+)(\d+)$/);
  if (!m) return { ok: true };

  const [, refModuleId, op, val] = m;
  const threshold = parseInt(val);

  if (!env.NOCO_ARTICLE) return { ok: true };
  const artList = await fetchAll(env,
    `/api/v2/tables/${env.NOCO_ARTICLE}/records?where=(ModuleId,eq,${refModuleId})&fields=Id`
  );
  const articleIds = artList.map(a => String(a.Id));
  if (!articleIds.length) return { ok: true };

  if (!env.NOCO_PROGRESS) return { ok: true };
  const inFilter = articleIds.map(id => encodeURIComponent(id)).join(',');
  const batchR = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_PROGRESS}/records?where=(UserId,eq,${userId})~and(ArticleId,in,${inFilter})&fields=ArticleId,Score&limit=500`
  );
  const scores = [];
  if (batchR.ok) {
    const bd = await batchR.json();
    for (const p of (bd.list || [])) { if (p.Score) scores.push(p.Score); }
  }

  const avgScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
  let passed = op === '>=' ? avgScore >= threshold : op === '>' ? avgScore > threshold : avgScore >= threshold;
  if (!passed) return { ok: false, reason: `Module ${refModuleId}: cần điểm trung bình ${op}${threshold}% (hiện tại: ${avgScore}%)`, avgScore };
  return { ok: true };
}

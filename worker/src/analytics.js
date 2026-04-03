import { nocoFetch } from './db.js';

// ── Analytics helpers (fire-and-forget) ──────────────────────

async function _getOrCreateAnalytics(env, articleId) {
  const r = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_ANALYTICS}/records?where=(ArticleId,eq,${encodeURIComponent(articleId)})&limit=1`
  );
  const data = await r.json();
  return (data.list || [])[0] || null;
}

export async function updateAnalyticsViews(env, articleId) {
  const row = await _getOrCreateAnalytics(env, articleId);
  if (row) {
    await nocoFetch(env, `/api/v2/tables/${env.NOCO_ANALYTICS}/records`, 'PATCH',
      [{ Id: row.Id, Views: (row.Views || 0) + 1 }]);
  } else {
    await nocoFetch(env, `/api/v2/tables/${env.NOCO_ANALYTICS}/records`, 'POST',
      { ArticleId: articleId, Views: 1, AvgScore: null, FeedbackCounts: '{"easy":0,"hard":0,"example":0}' });
  }
}

export async function updateAnalyticsScore(env, articleId, newScore) {
  const r = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_ANALYTICS}/records?where=(ArticleId,eq,${encodeURIComponent(articleId)})~and(Score,gt,0)&limit=500&fields=Score`
  );
  const data = await r.json();
  const scores = (data.list || []).map(s => s.Score).filter(s => typeof s === 'number');
  if (!scores.length) return;
  const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  const row = await _getOrCreateAnalytics(env, articleId);
  if (row) {
    await nocoFetch(env, `/api/v2/tables/${env.NOCO_ANALYTICS}/records`, 'PATCH',
      [{ Id: row.Id, AvgScore: avg }]);
  } else {
    await nocoFetch(env, `/api/v2/tables/${env.NOCO_ANALYTICS}/records`, 'POST',
      { ArticleId: articleId, Views: 0, AvgScore: avg, FeedbackCounts: '{"easy":0,"hard":0,"example":0}' });
  }
}

export async function updateAnalyticsFeedback(env, articleId, newReaction, oldReaction) {
  const row = await _getOrCreateAnalytics(env, articleId);
  let counts = { easy: 0, hard: 0, example: 0 };
  if (row) {
    try { counts = { ...counts, ...JSON.parse(row.FeedbackCounts || '{}') }; } catch {}
    if (oldReaction && oldReaction !== newReaction && counts[oldReaction] > 0) counts[oldReaction]--;
    counts[newReaction] = (counts[newReaction] || 0) + (oldReaction ? 0 : 1);
    if (oldReaction && oldReaction !== newReaction) counts[newReaction]++;
    await nocoFetch(env, `/api/v2/tables/${env.NOCO_ANALYTICS}/records`, 'PATCH',
      [{ Id: row.Id, FeedbackCounts: JSON.stringify(counts) }]);
  } else {
    counts[newReaction] = 1;
    await nocoFetch(env, `/api/v2/tables/${env.NOCO_ANALYTICS}/records`, 'POST',
      { ArticleId: articleId, Views: 0, AvgScore: null, FeedbackCounts: JSON.stringify(counts) });
  }
}

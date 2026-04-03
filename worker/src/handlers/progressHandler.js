import { getTokenSecret, verifyToken } from '../auth.js';
import { nocoFetch } from '../db.js';
import { idempotencyCheck, idempotencyStore, SEC_HEADERS } from '../middleware.js';
import { updateAnalyticsScore, updateAnalyticsFeedback, updateAnalyticsViews } from '../analytics.js';

export async function handleProgressGet(request, env, { json }) {
  const authHeader = request.headers.get('Authorization') || '';
  const secret = getTokenSecret(env);
  const session = await verifyToken(authHeader.replace('Bearer ', ''), secret);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const r = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_PROGRESS}/records?where=(UserId,eq,${session.userId})&limit=1000&fields=ArticleId,Completed,Score,CompletedAt,Reactions`
  );
  if (!r.ok) return json({ list: [] });
  const data = await r.json();
  return json({ list: data.list || [] });
}

export async function handleProgressPost(request, env, { json, cors }) {
  const authHeader = request.headers.get('Authorization') || '';
  const secret = getTokenSecret(env);
  const session = await verifyToken(authHeader.replace('Bearer ', ''), secret);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const idemKey = request.headers.get('Idempotency-Key');
  if (idemKey) {
    const cached = await idempotencyCheck(env, idemKey);
    if (cached) return new Response(cached.body, { status: cached.status, headers: { ...cors, 'Content-Type': 'application/json', 'X-Idempotent-Replayed': 'true' } });
  }

  const { articleId, completed, score } = await request.json();
  if (!articleId) return json({ error: 'Thiếu articleId' }, 400);

  const existing = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_PROGRESS}/records?where=(UserId,eq,${session.userId})~and(ArticleId,eq,${encodeURIComponent(articleId)})&limit=1&fields=Id,Completed,Score`
  );
  const existData = await existing.json();
  const existRow = (existData.list || [])[0];

  if (existRow) {
    const patch = {};
    if (completed && !existRow.Completed) { patch.Completed = true; patch.CompletedAt = new Date().toISOString(); }
    if (typeof score === 'number' && score > (existRow.Score || 0)) patch.Score = score;
    if (Object.keys(patch).length)
      await nocoFetch(env, `/api/v2/tables/${env.NOCO_PROGRESS}/records`, 'PATCH', [{ Id: existRow.Id, ...patch }]);
  } else {
    await nocoFetch(env, `/api/v2/tables/${env.NOCO_PROGRESS}/records`, 'POST', {
      UserId: session.userId, ArticleId: String(articleId),
      Completed: !!completed, Score: typeof score === 'number' ? score : null,
      CompletedAt: completed ? new Date().toISOString() : null,
    });
  }

  if (typeof score === 'number' && env.NOCO_ANALYTICS)
    updateAnalyticsScore(env, String(articleId), score).catch(() => {});

  const body = JSON.stringify({ ok: true });
  if (idemKey) idempotencyStore(env, idemKey, 200, body);
  return new Response(body, { status: 200, headers: { ...cors, ...SEC_HEADERS, 'Content-Type': 'application/json' } });
}

export async function handleReactions(request, env, { json }) {
  const authHeader = request.headers.get('Authorization') || '';
  const secret = getTokenSecret(env);
  const session = await verifyToken(authHeader.replace('Bearer ', ''), secret);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const { articleId, reaction } = await request.json();
  if (!articleId || !reaction) return json({ error: 'Thiếu thông tin' }, 400);
  if (!['easy', 'hard', 'example'].includes(reaction)) return json({ error: 'Reaction không hợp lệ' }, 400);

  const existing = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_PROGRESS}/records?where=(UserId,eq,${session.userId})~and(ArticleId,eq,${encodeURIComponent(articleId)})&limit=1&fields=Id,Reactions`
  );
  const existData = await existing.json();
  const existRow = (existData.list || [])[0];

  if (existRow) {
    await nocoFetch(env, `/api/v2/tables/${env.NOCO_PROGRESS}/records`, 'PATCH', [{ Id: existRow.Id, Reactions: reaction }]);
  } else {
    await nocoFetch(env, `/api/v2/tables/${env.NOCO_PROGRESS}/records`, 'POST',
      { UserId: session.userId, ArticleId: String(articleId), Reactions: reaction });
  }

  if (env.NOCO_ANALYTICS)
    updateAnalyticsFeedback(env, String(articleId), reaction, existRow?.Reactions || null).catch(() => {});
  return json({ ok: true });
}

export async function handleAnalyticsView(request, env, { json }) {
  const { articleId } = await request.json().catch(() => ({}));
  if (!articleId || !env.NOCO_ANALYTICS) return json({ ok: true });
  updateAnalyticsViews(env, String(articleId)).catch(() => {});
  return json({ ok: true });
}

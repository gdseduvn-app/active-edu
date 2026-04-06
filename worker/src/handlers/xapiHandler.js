/**
 * xAPI Handler — Learning Record Store (LRS) lite
 * Implements xAPI 1.0.3 Statements API (simplified)
 *
 * POST /xapi/statements — Store a statement
 * GET  /xapi/statements — Query statements
 * GET  /xapi/statements/aggregate — Aggregated analytics
 */
import { getTokenSecret, verifyToken } from '../auth.js';

async function getSession(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '');
  if (!token) return null;
  return verifyToken(token, env.TOKEN_SECRET || 'UNSET');
}

// POST /xapi/statements
export async function handleXAPIPost(request, env, { json }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  // Accept single statement or array
  const statements = Array.isArray(body) ? body : [body];
  const ids = [];

  for (const stmt of statements) {
    const verb = stmt.verb?.id || stmt.verb || 'http://adlnet.gov/expapi/verbs/experienced';
    const verbDisplay = stmt.verb?.display?.['vi-VN'] || stmt.verb?.display?.['en-US'] || verb.split('/').pop();
    const obj = stmt.object || {};
    const result = stmt.result || {};
    const ctx = stmt.context?.extensions || {};

    try {
      const r = await env.D1.prepare(`
        INSERT INTO xapi_statements
        (actor_id, actor_email, verb, verb_display, object_id, object_type, object_name,
         result_score_raw, result_score_min, result_score_max, result_success, result_completion,
         result_duration_s, context_course_id, context_module_id, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        session.userId,
        session.email,
        verb,
        verbDisplay,
        obj.id || '',
        obj.objectType || 'Activity',
        obj.definition?.name?.['vi-VN'] || obj.definition?.name?.['en-US'] || '',
        result.score?.raw ?? null,
        result.score?.min ?? 0,
        result.score?.max ?? 100,
        result.success != null ? (result.success ? 1 : 0) : null,
        result.completion != null ? (result.completion ? 1 : 0) : null,
        result.duration ? parseDuration(result.duration) : null,
        ctx['https://activeedu.vn/extensions/course_id'] || null,
        ctx['https://activeedu.vn/extensions/module_id'] || null,
        stmt.timestamp || new Date().toISOString()
      ).run();
      ids.push(r.meta?.last_row_id);
    } catch(e) {
      console.error('[xAPI] Insert error:', e.message);
    }
  }

  return json({ ids, stored: ids.length });
}

// GET /xapi/statements
export async function handleXAPIGet(request, env, { json, url }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const sp = url.searchParams;
  const limit = Math.min(200, parseInt(sp.get('limit') || '50'));
  const offset = parseInt(sp.get('offset') || '0');
  const actor_id = sp.get('actor_id') || (session.role !== 'admin' ? String(session.userId) : null);
  const verb = sp.get('verb') || null;
  const course_id = sp.get('course_id') || null;

  let where = [];
  let params = [];
  if (actor_id) { where.push('actor_id=?'); params.push(parseInt(actor_id)); }
  if (verb) { where.push('verb LIKE ?'); params.push(`%${verb}%`); }
  if (course_id) { where.push('context_course_id=?'); params.push(parseInt(course_id)); }

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const results = await env.D1.prepare(
    `SELECT * FROM xapi_statements ${whereClause} ORDER BY timestamp DESC LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset).all();

  return json({ statements: results.results || [], total: results.results?.length || 0 });
}

// GET /xapi/statements/aggregate
export async function handleXAPIAggregate(request, env, { json, url }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!['admin', 'teacher'].includes(session.role)) return json({ error: 'Forbidden' }, 403);

  const sp = url.searchParams;
  const course_id = sp.get('course_id');
  const days = parseInt(sp.get('days') || '30');

  const courseFilter = course_id ? 'AND context_course_id = ?' : '';
  const params = course_id ? [days, parseInt(course_id)] : [days];

  const [verbStats, dailyActivity, topStudents] = await Promise.all([
    env.D1.prepare(`
      SELECT verb_display, COUNT(*) as count
      FROM xapi_statements
      WHERE timestamp >= datetime('now', '-' || ? || ' days') ${courseFilter}
      GROUP BY verb_display ORDER BY count DESC LIMIT 10
    `).bind(...params).all(),
    env.D1.prepare(`
      SELECT date(timestamp) as day, COUNT(*) as events, COUNT(DISTINCT actor_id) as active_students
      FROM xapi_statements
      WHERE timestamp >= datetime('now', '-' || ? || ' days') ${courseFilter}
      GROUP BY day ORDER BY day DESC LIMIT 30
    `).bind(...params).all(),
    env.D1.prepare(`
      SELECT actor_id, actor_email, COUNT(*) as events,
             AVG(result_score_raw) as avg_score,
             SUM(result_completion) as completions
      FROM xapi_statements
      WHERE timestamp >= datetime('now', '-' || ? || ' days') ${courseFilter}
        AND actor_id IS NOT NULL
      GROUP BY actor_id ORDER BY events DESC LIMIT 20
    `).bind(...params).all(),
  ]);

  return json({
    period_days: days,
    verb_breakdown: verbStats.results || [],
    daily_activity: dailyActivity.results || [],
    top_students: topStudents.results || [],
  });
}

// Parse ISO 8601 duration to seconds (e.g. PT1H30M → 5400)
function parseDuration(iso) {
  const m = iso.match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return null;
  return ((parseInt(m[1]||0)*24 + parseInt(m[2]||0))*60 + parseInt(m[3]||0))*60 + parseInt(m[4]||0);
}

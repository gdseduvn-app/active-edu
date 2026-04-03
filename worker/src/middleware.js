// ── Rate limiter ──────────────────────────────────────────────

const _memRateLimit = new Map();

export async function checkRateLimit(ip, env, prefix = 'rl', maxAttempts = 5, windowSec = 900) {
  const key = `${prefix}:${ip || 'unknown'}`;

  if (env.RATE_LIMIT_KV) {
    try {
      const raw = await env.RATE_LIMIT_KV.get(key);
      const data = raw ? JSON.parse(raw) : { count: 0 };
      data.count++;
      await env.RATE_LIMIT_KV.put(key, JSON.stringify(data), { expirationTtl: windowSec });
      return { allowed: data.count <= maxAttempts, count: data.count };
    } catch { /* fall through to in-memory */ }
  }

  const now = Date.now();
  const entry = _memRateLimit.get(key) || { count: 0, resetAt: now + windowSec * 1000 };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + windowSec * 1000; }
  entry.count++;
  _memRateLimit.set(key, entry);
  return { allowed: entry.count <= maxAttempts, count: entry.count };
}

export async function clearRateLimit(ip, env, prefix = 'rl') {
  const key = `${prefix}:${ip || 'unknown'}`;
  if (env.RATE_LIMIT_KV) {
    try { await env.RATE_LIMIT_KV.delete(key); } catch { }
  }
  _memRateLimit.delete(key);
}

// ── Idempotency-Key helpers ───────────────────────────────────

export async function idempotencyCheck(env, key) {
  if (!env.IDEMPOTENCY_KV || !key) return null;
  try {
    const cached = await env.IDEMPOTENCY_KV.get(`idem:${key}`, { type: 'json' });
    return cached || null;
  } catch { return null; }
}

export async function idempotencyStore(env, key, status, body) {
  if (!env.IDEMPOTENCY_KV || !key) return;
  try {
    await env.IDEMPOTENCY_KV.put(
      `idem:${key}`,
      JSON.stringify({ status, body }),
      { expirationTtl: 86400 }
    );
  } catch {}
}

// ── Shared headers ────────────────────────────────────────────

export function getCors(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Admin-Token, Authorization, Idempotency-Key',
  };
}

export const SEC_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export function makeJson(cors) {
  return (data, status = 200) => new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, ...SEC_HEADERS, 'Content-Type': 'application/json' },
  });
}

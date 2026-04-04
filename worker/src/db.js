// ── NocoDB fetch + pagination helpers ────────────────────────

// nocoFetch với auto-retry khi NocoDB trả 429 (ThrottlerException)
export async function nocoFetch(env, path, method = 'GET', body) {
  const opts = {
    method,
    headers: {
      'xc-token': env.NOCO_TOKEN,
      'Content-Type': 'application/json',
      'Connection': 'keep-alive',
      'Keep-Alive': 'timeout=30, max=100',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
  const url = `${env.NOCO_URL}${path}`;
  // Retry up to 3 lần với exponential backoff: 300ms, 600ms, 1200ms
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url, opts);
    if (r.status !== 429) return r;
    if (i < 2) await new Promise(res => setTimeout(res, 300 * Math.pow(2, i)));
  }
  // Lần cuối — trả về dù 429
  return fetch(url, opts);
}

export async function fetchAll(env, path, pageSize = 500) {
  const results = [];
  let offset = 0;
  const sep = path.includes('?') ? '&' : '?';
  while (true) {
    const r = await nocoFetch(env, `${path}${sep}limit=${pageSize}&offset=${offset}`);
    if (!r.ok) break;
    const data = await r.json();
    const list = data.list || [];
    results.push(...list);
    const total = data.pageInfo?.totalRows ?? data.pageInfo?.total ?? null;
    if (total !== null && results.length >= total) break;
    if (list.length < pageSize) break;
    offset += pageSize;
  }
  return results;
}

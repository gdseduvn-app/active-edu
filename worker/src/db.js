// ── NocoDB fetch + pagination helpers ────────────────────────

export async function nocoFetch(env, path, method = 'GET', body) {
  return fetch(`${env.NOCO_URL}${path}`, {
    method,
    headers: {
      'xc-token': env.NOCO_TOKEN,
      'Content-Type': 'application/json',
      'Connection': 'keep-alive',
      'Keep-Alive': 'timeout=30, max=100',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
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

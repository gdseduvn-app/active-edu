import { nocoFetch, fetchAll } from './db.js';

// ── Referential integrity helpers ─────────────────────────────

export async function _assertExists(env, tableEnvKey, id, label) {
  if (!id || !env[tableEnvKey]) return { ok: false, error: `${label}: table chưa cấu hình` };
  const r = await nocoFetch(env, `/api/v2/tables/${env[tableEnvKey]}/records/${id}`);
  if (!r.ok) return { ok: false, error: `${label} #${id} không tồn tại` };
  const data = await r.json();
  if (!data || !data.Id) return { ok: false, error: `${label} #${id} không tồn tại` };
  return { ok: true, record: data };
}

export async function _countChildren(env, tableEnvKey, fkField, parentId) {
  if (!env[tableEnvKey]) return 0;
  const r = await nocoFetch(env,
    `/api/v2/tables/${env[tableEnvKey]}/records?where=(${fkField},eq,${parentId})&limit=1&fields=Id`
  );
  if (!r.ok) return 0;
  const data = await r.json();
  return data.pageInfo?.totalRows ?? data.pageInfo?.total ?? (data.list?.length ?? 0);
}

export async function _getChildIds(env, tableEnvKey, fkField, parentId) {
  if (!env[tableEnvKey]) return [];
  const list = await fetchAll(env,
    `/api/v2/tables/${env[tableEnvKey]}/records?where=(${fkField},eq,${parentId})&fields=Id`
  );
  return list.map(row => ({ Id: row.Id }));
}

export async function _cascadeDelete(env, tableEnvKey, fkField, parentId) {
  const ids = await _getChildIds(env, tableEnvKey, fkField, parentId);
  if (!ids.length) return 0;
  await nocoFetch(env, `/api/v2/tables/${env[tableEnvKey]}/records`, 'DELETE', ids);
  return ids.length;
}

// ── Soft delete & audit ───────────────────────────────────────

export function _audit(env, action, tableName, recordId, actor, before, after) {
  if (!env.NOCO_AUDIT) return;
  nocoFetch(env, `/api/v2/tables/${env.NOCO_AUDIT}/records`, 'POST', {
    Action:     action,
    TableName:  tableName,
    RecordId:   recordId ? String(recordId) : null,
    ActorId:    actor?.userId  || 0,
    ActorEmail: actor?.email   || 'admin',
    Before:     before ? JSON.stringify(before) : null,
    After:      after  ? JSON.stringify(after)  : null,
    CreatedAt:  new Date().toISOString(),
  }).catch(() => {});
}

export async function _softDelete(env, tableEnvKey, ids, actor) {
  if (!env[tableEnvKey] || !ids.length) return 0;
  const now = new Date().toISOString();
  // Thử soft-delete với DeletedAt + DeletedBy
  const payload = ids.map(id => ({ Id: id, DeletedAt: now, DeletedBy: actor?.userId || 0 }));
  let r = await nocoFetch(env, `/api/v2/tables/${env[tableEnvKey]}/records`, 'PATCH', payload);
  // Nếu 400 (vd: thiếu DeletedBy field), thử lại chỉ với DeletedAt
  if (!r.ok) {
    const payload2 = ids.map(id => ({ Id: id, DeletedAt: now }));
    r = await nocoFetch(env, `/api/v2/tables/${env[tableEnvKey]}/records`, 'PATCH', payload2);
  }
  // Nếu vẫn lỗi (thiếu DeletedAt field), hard-delete
  if (!r.ok) {
    await nocoFetch(env, `/api/v2/tables/${env[tableEnvKey]}/records`, 'DELETE', ids.map(id => ({ Id: id })));
  }
  return ids.length;
}

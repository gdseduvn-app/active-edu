/**
 * AI Session persistence — D1 table: ai_sessions
 *
 * Schema:
 *   user_id, agent_type, session_key (UUID from client),
 *   messages (JSON array [{role, content, ts}]),
 *   token_count, course_id, item_id, created_at, updated_at
 *   UNIQUE(user_id, session_key)
 */

// Tải messages của 1 session (trả [] nếu chưa có)
export async function loadSession(env, userId, sessionKey) {
  if (!env.D1 || !sessionKey) return [];
  try {
    const row = await env.D1.prepare(
      'SELECT messages FROM ai_sessions WHERE user_id=? AND session_key=?'
    ).bind(String(userId), sessionKey).first();
    if (!row) return [];
    return JSON.parse(row.messages || '[]');
  } catch { return []; }
}

// Lưu / cập nhật session sau mỗi lượt chat
export async function saveSession(env, userId, sessionKey, messages, agentType, courseId = null, itemId = null) {
  if (!env.D1 || !sessionKey) return;
  try {
    const now = new Date().toISOString();
    const msgJson = JSON.stringify(messages);
    // Ước tính token count (4 chars ≈ 1 token)
    const tokenCount = Math.round(msgJson.length / 4);
    await env.D1.prepare(`
      INSERT INTO ai_sessions (user_id, agent_type, session_key, messages, token_count, course_id, item_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, session_key) DO UPDATE SET
        messages    = excluded.messages,
        token_count = excluded.token_count,
        updated_at  = excluded.updated_at
    `).bind(String(userId), agentType, sessionKey, msgJson, tokenCount, courseId, itemId, now, now).run();
  } catch (e) { console.error('[aiSession save]', e.message); }
}

// Xoá 1 session (reset conversation)
export async function deleteSession(env, userId, sessionKey) {
  if (!env.D1 || !sessionKey) return;
  try {
    await env.D1.prepare(
      'DELETE FROM ai_sessions WHERE user_id=? AND session_key=?'
    ).bind(String(userId), sessionKey).run();
  } catch {}
}

// Lấy danh sách sessions của 1 user (dùng cho history UI)
export async function listSessions(env, userId, agentType = null, limit = 20) {
  if (!env.D1) return [];
  try {
    const sql = agentType
      ? 'SELECT session_key, agent_type, token_count, course_id, item_id, created_at, updated_at FROM ai_sessions WHERE user_id=? AND agent_type=? ORDER BY updated_at DESC LIMIT ?'
      : 'SELECT session_key, agent_type, token_count, course_id, item_id, created_at, updated_at FROM ai_sessions WHERE user_id=? ORDER BY updated_at DESC LIMIT ?';
    const params = agentType
      ? [String(userId), agentType, limit]
      : [String(userId), limit];
    const result = await env.D1.prepare(sql).bind(...params).all();
    return result.results || [];
  } catch { return []; }
}

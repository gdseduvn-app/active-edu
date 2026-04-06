import { getTokenSecret, verifyToken } from '../auth.js';
import { checkRateLimit } from '../middleware.js';
import { nocoFetch } from '../db.js';
import { loadSession, saveSession, deleteSession, listSessions } from '../aiSession.js';

// ── Kiểm tra quyền dùng AI của user ─────────────────────────
export async function checkAIAccess(env, userId) {
  if (!env.NOCO_USERS) return { ok: false, reason: 'Hệ thống chưa cấu hình bảng Users' };
  try {
    const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_USERS}/records/${userId}?fields=Id,Status,Role`);
    if (!r.ok) return { ok: false, reason: 'Không xác minh được tài khoản' };
    const user = await r.json();
    const status = user.Status || user.TrangThai || 'active';
    if (status === 'inactive' || status === 'banned')
      return { ok: false, reason: 'Tài khoản đã bị vô hiệu hóa' };
    // Admin/teacher luôn có quyền AI
    const role = user.Role || user.VaiTro || 'student';
    if (role === 'admin' || role === 'teacher') return { ok: true };
    // Student: kiểm tra AIAccess nếu field tồn tại
    const r2 = await nocoFetch(env, `/api/v2/tables/${env.NOCO_USERS}/records/${userId}?fields=Id,AIAccess`);
    if (r2.ok) {
      const userData = await r2.json();
      // Nếu field tồn tại và tường minh = false thì từ chối
      if (userData.AIAccess === false || userData.AIAccess === 0)
        return {
          ok: false,
          reason: 'Tài khoản chưa được cấp quyền sử dụng AI. Liên hệ giáo viên để được kích hoạt.',
          noAccess: true,
        };
    }
    // Field không tồn tại hoặc AIAccess = true/null → cho phép mặc định
    return { ok: true };
  } catch {
    return { ok: false, reason: 'Lỗi xác minh quyền AI' };
  }
}

export async function handleSocratic(request, env, { json }) {
  const authHeader = request.headers.get('Authorization') || '';
  const secret = getTokenSecret(env);
  const session = await verifyToken(authHeader.replace('Bearer ', ''), secret);
  if (!session) return json({ error: 'Đăng nhập để dùng AI tutor', requireLogin: true }, 401);

  // ── Kiểm tra quyền AI ──────────────────────────────────────
  const access = await checkAIAccess(env, session.userId);
  if (!access.ok) return json({ error: access.reason, noAccess: access.noAccess || false }, 403);

  const aiRl = await checkRateLimit(`ai:${session.userId}`, env, 'ai', 20, 3600);
  if (!aiRl.allowed) return json({ error: 'Bạn đã dùng AI quá nhiều. Thử lại sau 1 giờ.' }, 429);

  if (!env.ANTHROPIC_API_KEY && !env.AI_GATEWAY_KEY)
    return json({ error: 'AI chưa được cấu hình' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const { message, articleTitle, wordCount, session_key, article_id } = body;
  if (!message || typeof message !== 'string' || message.trim().length === 0)
    return json({ error: 'Thiếu nội dung câu hỏi' }, 400);
  if (!wordCount || wordCount < 50)
    return json({ error: 'Hãy viết ít nhất 50 từ suy nghĩ của mình trước khi hỏi AI' }, 400);

  // Tải lịch sử chat từ D1 (nếu có session_key)
  const history = session_key ? await loadSession(env, session.userId, session_key) : [];

  const systemPrompt = `Bạn là gia sư Socratic cho bài học: "${(articleTitle || 'bài học').slice(0, 100)}".
KHÔNG bao giờ cho đáp án trực tiếp. Chỉ đặt câu hỏi dẫn dắt để học sinh tự tìm ra.
Nếu học sinh hỏi đáp án, hỏi ngược lại: "Em nghĩ bước tiếp theo là gì?"
Trả lời bằng tiếng Việt, ngắn gọn, tối đa 3 câu.`;

  // Xây multi-turn messages: lấy tối đa 10 lượt gần nhất từ lịch sử
  const historyMsgs = history.slice(-10).map(m => ({ role: m.role, content: m.content }));
  const allMessages = [...historyMsgs, { role: 'user', content: message.slice(0, 1000) }];

  const apiKey = env.ANTHROPIC_API_KEY || env.AI_GATEWAY_KEY;
  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 300,
        system: systemPrompt,
        messages: allMessages,
      }),
    });
    if (!claudeRes.ok) {
      console.error('Claude API error:', await claudeRes.text());
      return json({ error: 'AI tạm thời không khả dụng' }, 502);
    }
    const claudeData = await claudeRes.json();
    const reply = claudeData.content?.[0]?.text || '';

    // Lưu session vào D1 (fire-and-forget)
    if (session_key) {
      const now = new Date().toISOString();
      const updatedHistory = [
        ...history,
        { role: 'user',      content: message.slice(0, 1000), ts: now },
        { role: 'assistant', content: reply,                  ts: now },
      ];
      saveSession(env, session.userId, session_key, updatedHistory, 'socratic', null, article_id || null);
    }

    return json({ reply, session_key: session_key || null });
  } catch { return json({ error: 'Lỗi kết nối AI' }, 500); }
}

// ── GET /api/ai/session/:key — lấy lịch sử chat ──────────────
export async function handleGetAISession(request, env, { json, path }) {
  const authHeader = request.headers.get('Authorization') || '';
  const session = await verifyToken(authHeader.replace('Bearer ', ''), getTokenSecret(env));
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const sessionKey = path.split('/').pop();
  if (!sessionKey) return json({ error: 'Thiếu session key' }, 400);
  const messages = await loadSession(env, session.userId, sessionKey);
  return json({ session_key: sessionKey, messages, total: messages.length });
}

// ── DELETE /api/ai/session/:key — xoá session (reset chat) ───
export async function handleDeleteAISession(request, env, { json, path }) {
  const authHeader = request.headers.get('Authorization') || '';
  const session = await verifyToken(authHeader.replace('Bearer ', ''), getTokenSecret(env));
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const sessionKey = path.split('/').pop();
  if (!sessionKey) return json({ error: 'Thiếu session key' }, 400);
  await deleteSession(env, session.userId, sessionKey);
  return json({ ok: true, deleted: sessionKey });
}

// ── GET /api/ai/sessions — danh sách sessions của user ───────
export async function handleListAISessions(request, env, { json, url }) {
  const authHeader = request.headers.get('Authorization') || '';
  const session = await verifyToken(authHeader.replace('Bearer ', ''), getTokenSecret(env));
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const agentType = url.searchParams.get('type') || null;
  const sessions = await listSessions(env, session.userId, agentType);
  return json({ sessions, total: sessions.length });
}

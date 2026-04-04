import { getTokenSecret, verifyToken } from '../auth.js';
import { checkRateLimit } from '../middleware.js';
import { nocoFetch } from '../db.js';

// ── Kiểm tra quyền dùng AI của user ─────────────────────────
export async function checkAIAccess(env, userId) {
  if (!env.NOCO_USERS) return { ok: false, reason: 'Hệ thống chưa cấu hình bảng Users' };
  try {
    const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_USERS}/records/${userId}?fields=Id,AIAccess,Status,Role`);
    if (!r.ok) return { ok: false, reason: 'Không xác minh được tài khoản' };
    const user = await r.json();
    const status = user.Status || user.TrangThai || 'active';
    if (status === 'inactive' || status === 'banned')
      return { ok: false, reason: 'Tài khoản đã bị vô hiệu hóa' };
    // Admin/teacher luôn có quyền AI
    const role = user.Role || user.VaiTro || 'student';
    if (role === 'admin' || role === 'teacher') return { ok: true };
    // Student: cần được cấp AIAccess
    if (!user.AIAccess)
      return {
        ok: false,
        reason: 'Tài khoản chưa được cấp quyền sử dụng AI. Liên hệ giáo viên để được kích hoạt.',
        noAccess: true,
      };
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
  const { message, articleTitle, wordCount } = body;
  if (!message || typeof message !== 'string' || message.trim().length === 0)
    return json({ error: 'Thiếu nội dung câu hỏi' }, 400);
  if (!wordCount || wordCount < 50)
    return json({ error: 'Hãy viết ít nhất 50 từ suy nghĩ của mình trước khi hỏi AI' }, 400);

  const systemPrompt = `Bạn là gia sư Socratic cho bài học: "${(articleTitle || 'bài học').slice(0, 100)}".
KHÔNG bao giờ cho đáp án trực tiếp. Chỉ đặt câu hỏi dẫn dắt để học sinh tự tìm ra.
Nếu học sinh hỏi đáp án, hỏi ngược lại: "Em nghĩ bước tiếp theo là gì?"
Trả lời bằng tiếng Việt, ngắn gọn, tối đa 3 câu.`;

  const apiKey = env.AI_GATEWAY_KEY || env.ANTHROPIC_API_KEY;
  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-20240307',
        max_tokens: 300,
        system: systemPrompt,
        messages: [{ role: 'user', content: message.slice(0, 1000) }],
      }),
    });
    if (!claudeRes.ok) {
      console.error('Claude API error:', await claudeRes.text());
      return json({ error: 'AI tạm thời không khả dụng' }, 502);
    }
    const claudeData = await claudeRes.json();
    return json({ reply: claudeData.content?.[0]?.text || '' });
  } catch { return json({ error: 'Lỗi kết nối AI' }, 500); }
}

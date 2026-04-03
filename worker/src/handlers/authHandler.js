import { getTokenSecret, getPassSalt, makeToken, makeAdminToken, verifyToken, hashPassword, isHashed } from '../auth.js';
import { nocoFetch } from '../db.js';
import { checkRateLimit, clearRateLimit } from '../middleware.js';

// ── Email via Resend ──────────────────────────────────────────

async function sendResetEmail(env, to, displayName, resetLink) {
  if (!env.RESEND_API_KEY) {
    console.error('[Email] RESEND_API_KEY not configured');
    return;
  }
  const html = `<!DOCTYPE html>
<html lang="vi"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',sans-serif">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 16px">
<table width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08);overflow:hidden">
  <tr><td style="background:linear-gradient(135deg,#2563eb,#4338ca);padding:32px;text-align:center">
    <div style="width:48px;height:48px;background:rgba(255,255,255,.2);border-radius:12px;display:inline-flex;align-items:center;justify-content:center;font-size:24px;margin-bottom:12px">⚡</div>
    <h1 style="color:#fff;margin:0;font-size:22px;font-weight:700">ActiveEdu</h1>
    <p style="color:rgba(255,255,255,.8);margin:4px 0 0;font-size:13px">Đặt lại mật khẩu</p>
  </td></tr>
  <tr><td style="padding:36px 32px">
    <p style="color:#1e293b;font-size:15px;margin:0 0 12px">Xin chào <strong>${displayName}</strong>,</p>
    <p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 24px">Chúng tôi nhận được yêu cầu đặt lại mật khẩu cho tài khoản của bạn. Nhấn nút bên dưới để tiếp tục — link có hiệu lực trong <strong>1 giờ</strong>.</p>
    <div style="text-align:center;margin:28px 0">
      <a href="${resetLink}" style="display:inline-block;padding:14px 32px;background:#2563eb;color:#fff;text-decoration:none;border-radius:10px;font-size:15px;font-weight:600">Đặt lại mật khẩu →</a>
    </div>
    <p style="color:#94a3b8;font-size:12px;line-height:1.6;margin:24px 0 0;border-top:1px solid #f1f5f9;padding-top:20px">Nếu bạn không yêu cầu đặt lại mật khẩu, hãy bỏ qua email này. Tài khoản của bạn vẫn an toàn.<br>Link sẽ tự hết hạn sau 1 giờ.</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.EMAIL_FROM || `no-reply@gds.edu.vn`,
      to,
      subject: '🔐 Đặt lại mật khẩu ActiveEdu',
      html,
    }),
  }).catch(e => console.error('[Email] send failed:', e.message));
}

export async function handleAdminAuth(request, env, { json, clientIP }) {
  const rl = await checkRateLimit(clientIP, env, 'admin');
  if (!rl.allowed) return json({ error: 'Quá nhiều lần thử. Vui lòng đợi 15 phút.' }, 429);
  const { password } = await request.json().catch(() => ({}));
  if (!password || password !== env.ADMIN_PASSWORD) {
    await checkRateLimit(clientIP, env, 'admin');
    return json({ error: 'Sai mật khẩu' }, 401);
  }
  await clearRateLimit(clientIP, env, 'admin');
  const secret = getTokenSecret(env);
  const token = await makeAdminToken(secret + ':admin');
  return json({ token, expiresIn: 8 * 3600 });
}

export async function handleLogin(request, env, { json, clientIP }) {
  try {
    const rl = await checkRateLimit(clientIP, env, 'login');
    if (!rl.allowed) return json({ error: 'Quá nhiều lần thử. Vui lòng chờ 15 phút.' }, 429);

    const { email, password } = await request.json();
    if (!email || !password) return json({ error: 'Thiếu email hoặc mật khẩu' }, 400);

    const r = await nocoFetch(env,
      `/api/v2/tables/${env.NOCO_USERS}/records?where=(Email,eq,${encodeURIComponent(email)})&limit=1`
    );
    const data = await r.json();
    const user = (data.list || [])[0];
    if (!user) return json({ error: 'Email hoặc mật khẩu không đúng' }, 401);

    const statusVal = user.Status || user.TrangThai || 'active';
    if (statusVal === 'inactive' || statusVal === 'banned')
      return json({ error: 'Tài khoản đã bị vô hiệu hóa' }, 403);

    const storedPass = user.Password || user.MatKhau || '';
    const salt = getPassSalt(env);
    const hashed = await hashPassword(password, salt);
    const valid = isHashed(storedPass) ? storedPass === hashed : storedPass === password;
    if (!valid) return json({ error: 'Email hoặc mật khẩu không đúng' }, 401);

    if (!isHashed(storedPass)) {
      await nocoFetch(env, `/api/v2/tables/${env.NOCO_USERS}/records`, 'PATCH',
        [{ Id: user.Id, Password: hashed, MatKhau: hashed }]);
    }

    await clearRateLimit(clientIP, env, 'login');
    const secret = getTokenSecret(env);
    const token = await makeToken(user.Id, email, user.Role || user.VaiTro || 'student', secret);
    return json({ token, user: { id: user.Id, email, displayName: user.FullName || user.HoTen || user.Name || email, role: user.Role || user.VaiTro || 'student' } });
  } catch { return json({ error: 'Lỗi server' }, 500); }
}

export async function handleChangePassword(request, env, { json }) {
  try {
    const authHeader = request.headers.get('Authorization') || '';
    const secret = getTokenSecret(env);
    const session = await verifyToken(authHeader.replace('Bearer ', ''), secret);
    if (!session) return json({ error: 'Phiên đăng nhập hết hạn' }, 401);

    const { oldPassword, newPassword } = await request.json();
    if (!oldPassword || !newPassword) return json({ error: 'Thiếu thông tin' }, 400);
    if (newPassword.length < 6) return json({ error: 'Mật khẩu mới tối thiểu 6 ký tự' }, 400);

    const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_USERS}/records/${session.userId}`);
    const user = await r.json();
    const storedPass = user.Password || user.MatKhau || '';
    const salt = getPassSalt(env);
    const oldHashed = await hashPassword(oldPassword, salt);
    const valid = isHashed(storedPass) ? storedPass === oldHashed : storedPass === oldPassword;
    if (!valid) return json({ error: 'Mật khẩu hiện tại không đúng' }, 401);

    const newHashed = await hashPassword(newPassword, salt);
    await nocoFetch(env, `/api/v2/tables/${env.NOCO_USERS}/records`, 'PATCH',
      [{ Id: session.userId, Password: newHashed, MatKhau: newHashed }]);
    return json({ ok: true });
  } catch (e) { return json({ error: e.message }, 500); }
}

export async function handleMe(request, env, { json }) {
  const authHeader = request.headers.get('Authorization') || '';
  const secret = getTokenSecret(env);
  const session = await verifyToken(authHeader.replace('Bearer ', ''), secret);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_USERS}/records/${session.userId}`);
  if (!r.ok) return json({ error: 'User not found' }, 404);
  const user = await r.json();
  const { Password, MatKhau, ...safeUser } = user;
  return json(safeUser);
}

// ── Forgot password: generate token & send email ──────────────

export async function handleForgotPassword(request, env, { json, clientIP }) {
  // Rate limit: 3 requests / 15 min / IP
  const rl = await checkRateLimit(clientIP, env, 'forgot', 3, 900);
  if (!rl.allowed) return json({ error: 'Quá nhiều yêu cầu. Thử lại sau 15 phút.' }, 429);

  const { email } = await request.json().catch(() => ({}));
  if (!email || !email.includes('@')) return json({ error: 'Email không hợp lệ' }, 400);

  // Tìm user (always return ok để tránh email enumeration)
  if (!env.NOCO_USERS || !env.IDEMPOTENCY_KV) return json({ ok: true });
  const r = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_USERS}/records?where=(Email,eq,${encodeURIComponent(email)})&limit=1&fields=Id,Email,FullName,HoTen,Name`
  );
  if (!r.ok) return json({ ok: true });
  const data = await r.json();
  const user = (data.list || [])[0];
  if (!user) return json({ ok: true }); // không lộ user không tồn tại

  // Tạo token ngẫu nhiên 1 lần dùng, TTL 1h
  const token = crypto.randomUUID().replace(/-/g, '');
  await env.IDEMPOTENCY_KV.put(
    `resetpw:${token}`,
    JSON.stringify({ userId: user.Id, email }),
    { expirationTtl: 3600 }
  );

  // Gửi email
  const appUrl = (env.APP_URL || 'https://activelearning.gds.edu.vn').replace(/\/$/, '');
  const resetLink = `${appUrl}/?reset=${token}`;
  const displayName = user.FullName || user.HoTen || user.Name || email;
  await sendResetEmail(env, email, displayName, resetLink);

  return json({ ok: true });
}

// ── Reset password: verify token & update password ────────────

export async function handleResetPassword(request, env, { json }) {
  const { token, newPassword } = await request.json().catch(() => ({}));
  if (!token || !newPassword) return json({ error: 'Thiếu thông tin' }, 400);
  if (newPassword.length < 6) return json({ error: 'Mật khẩu tối thiểu 6 ký tự' }, 400);

  if (!env.IDEMPOTENCY_KV) return json({ error: 'Server chưa cấu hình KV' }, 503);

  // Kiểm tra token trong KV
  const stored = await env.IDEMPOTENCY_KV.get(`resetpw:${token}`, { type: 'json' });
  if (!stored) return json({ error: 'Link đặt lại mật khẩu không hợp lệ hoặc đã hết hạn.' }, 400);

  const { userId, email } = stored;

  // Hash mật khẩu mới
  const salt = getPassSalt(env);
  const hashed = await hashPassword(newPassword, salt);

  // Cập nhật vào NocoDB
  const pr = await nocoFetch(env, `/api/v2/tables/${env.NOCO_USERS}/records`, 'PATCH',
    [{ Id: userId, Password: hashed, MatKhau: hashed }]
  );
  if (!pr.ok) return json({ error: 'Không cập nhật được mật khẩu. Thử lại sau.' }, 500);

  // Xoá token (dùng 1 lần)
  await env.IDEMPOTENCY_KV.delete(`resetpw:${token}`).catch(() => {});

  return json({ ok: true, email });
}

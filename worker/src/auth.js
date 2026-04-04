// ── Crypto & Token helpers ────────────────────────────────────

export async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function hashPassword(plain, salt) {
  return sha256(salt + plain + salt);
}

export function isHashed(storedPass) {
  return typeof storedPass === 'string' && storedPass.length === 64 && /^[0-9a-f]+$/.test(storedPass);
}

// ── Secure secret accessors ───────────────────────────────────

export function getTokenSecret(env) {
  if (env.TOKEN_SECRET) return env.TOKEN_SECRET;
  console.error('[SECURITY] TOKEN_SECRET not configured — all auth will fail until set.');
  return 'UNSET_' + crypto.randomUUID();
}

export function getPassSalt(env) {
  if (env.PASS_SALT) return env.PASS_SALT;
  console.error('[SECURITY] PASS_SALT not configured — password hashing is insecure until set.');
  return 'UNSET_SALT_REPLACE_ME';
}

// ── Student session token ─────────────────────────────────────

export async function makeToken(userId, email, role, secret) {
  const payload = `${userId}:${email}:${role}:${Date.now()}`;
  const sig = await sha256(secret + payload);
  return btoa(payload) + '.' + sig.slice(0, 32);
}

export async function verifyToken(token, secret) {
  try {
    const [b64, sig] = token.split('.');
    if (!b64 || !sig) return null;
    const payload = atob(b64);
    const expected = (await sha256(secret + payload)).slice(0, 32);
    if (sig !== expected) return null;
    const [userId, email, role, ts] = payload.split(':');
    if (Date.now() - Number(ts) > 8 * 60 * 60 * 1000) return null;
    const uid = parseInt(userId, 10);
    if (isNaN(uid) || uid <= 0 || String(uid) !== String(userId).trim()) return null;
    return { userId: uid, email, role };
  } catch { return null; }
}

// ── Admin session token ───────────────────────────────────────

export async function makeAdminToken(secret) {
  const payload = `admin:${Date.now()}`;
  const sig = await sha256(secret + payload);
  return btoa(payload) + '.' + sig.slice(0, 40);
}

export async function verifyAdminToken(token, secret) {
  try {
    const [b64, sig] = token.split('.');
    if (!b64 || !sig) return false;
    const payload = atob(b64);
    const expected = (await sha256(secret + payload)).slice(0, 40);
    if (sig !== expected) return false;
    const [, ts] = payload.split(':');
    return Date.now() - Number(ts) < 8 * 60 * 60 * 1000;
  } catch { return false; }
}

export async function verifyAdminAuth(request, env) {
  const secret = getTokenSecret(env);

  // 1. Admin-Token header (legacy / explicit)
  const adminToken = request.headers.get('Admin-Token');
  if (adminToken && await verifyAdminToken(adminToken, secret + ':admin')) return true;

  // 2. Authorization: Bearer — 2 loại token có thể đến qua đây:
  const authHeader = request.headers.get('Authorization') || '';
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.replace('Bearer ', '');
    // 2a. Admin token từ /admin/auth (unified login gửi qua Bearer)
    if (await verifyAdminToken(token, secret + ':admin')) return true;
    // 2b. User token với role=admin (NocoDB admin account)
    const session = await verifyToken(token, secret);
    if (session && session.role === 'admin') return true;
  }

  return false;
}

// ── Signed question token (exam security) ────────────────────

export async function makeQToken(env, examId, bankId, origIdx) {
  const secret = getTokenSecret(env);
  const data = `${bankId}:${origIdx}`;
  const sig = (await sha256(secret + 'qtok:' + examId + ':' + data)).slice(0, 20);
  return btoa(data) + '.' + sig;
}

export async function verifyQToken(env, examId, qToken) {
  if (!qToken || typeof qToken !== 'string') return null;
  try {
    const dotIdx = qToken.lastIndexOf('.');
    if (dotIdx < 0) return null;
    const b64 = qToken.slice(0, dotIdx);
    const sig  = qToken.slice(dotIdx + 1);
    const data = atob(b64);
    const [bankIdStr, origIdxStr] = data.split(':');
    const secret = getTokenSecret(env);
    const expected = (await sha256(secret + 'qtok:' + examId + ':' + data)).slice(0, 20);
    if (sig !== expected) return null;
    const bankId  = parseInt(bankIdStr,  10);
    const origIdx = parseInt(origIdxStr, 10);
    if (isNaN(bankId) || isNaN(origIdx) || origIdx < 0) return null;
    return { bankId, origIdx };
  } catch { return null; }
}

// ── User payload helper ───────────────────────────────────────

export async function hashUserPayload(payload, env) {
  const salt = getPassSalt(env);
  const plain = payload.Password || payload.MatKhau;
  if (!plain) return payload;
  if (isHashed(plain)) return payload;
  const hashed = await hashPassword(plain, salt);
  return { ...payload, Password: hashed, MatKhau: hashed };
}

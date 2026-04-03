/**
 * ActiveEdu Proxy Worker
 * ─────────────────────────────────────────────────────────────
 * Architecture: GitHub Pages (static) → Cloudflare Worker → NocoDB
 *
 * ENV VARS required (set via Wrangler secrets or dashboard):
 *   NOCO_URL          NocoDB base URL (e.g. https://noco.yourserver.com)
 *   NOCO_TOKEN        NocoDB API token (xc-token)
 *   NOCO_ARTICLE      NocoDB table ID for Articles
 *   NOCO_USERS        NocoDB table ID for Users
 *   NOCO_FOLDERS      NocoDB table ID for Folders
 *   NOCO_PERMS        NocoDB table ID for Permissions
 *   NOCO_PROGRESS     NocoDB table ID for Progress (UserId, ArticleId, Completed, Score, CompletedAt, Reactions)
 *   NOCO_QUIZ         NocoDB table ID for Quiz     (ArticleId, Questions[JSON], CreatedAt)
 *   NOCO_ANALYTICS    NocoDB table ID for Analytics(ArticleId, Views, AvgScore, FeedbackCounts[JSON])
 *   ADMIN_PASSWORD    Admin password (checked on every /admin/* request)
 *   PASS_SALT         Salt for SHA-256 password hashing
 *   TOKEN_SECRET      Secret for signing session tokens
 *   ALLOWED_COUNTRIES Comma-separated ISO country codes, or '*' (default: VN)
 *
 * OPTIONAL ENV:
 *   RATE_LIMIT_KV     KV namespace binding for persistent rate limiting
 *   GDRIVE_SA_JSON    Google Drive Service Account JSON (for Drive upload)
 *   GDRIVE_FOLDER_ID  Google Drive folder ID
 *
 * Password hashing strategy:
 *   - New passwords: SHA-256(PASS_SALT + plain + PASS_SALT)
 *   - Stored as 64-char hex string
 *   - Legacy plain-text passwords auto-upgraded on first login
 *   - Admin creating/updating users: Worker hashes before writing to NocoDB
 */

// ── Route tables ─────────────────────────────────────────────

const PUBLIC_ROUTES = {
  '/api/articles':    env => `/api/v2/tables/${env.NOCO_ARTICLE}/records`,
  '/api/folders':     env => `/api/v2/tables/${env.NOCO_FOLDERS}/records`,
  '/api/permissions': env => `/api/v2/tables/${env.NOCO_PERMS}/records`,
};

/** Admin routes that proxy directly to NocoDB (after auth check) */
const ADMIN_PROXY_ROUTES = {
  '/admin/articles':        env => `/api/v2/tables/${env.NOCO_ARTICLE}/records`,
  '/admin/folders':         env => `/api/v2/tables/${env.NOCO_FOLDERS}/records`,
  '/admin/permissions':     env => `/api/v2/tables/${env.NOCO_PERMS}/records`,
  '/admin/progress':        env => `/api/v2/tables/${env.NOCO_PROGRESS}/records`,
  '/admin/quiz':            env => `/api/v2/tables/${env.NOCO_QUIZ}/records`,
  '/admin/analytics':       env => `/api/v2/tables/${env.NOCO_ANALYTICS}/records`,
  '/admin/fields/articles': env => `/api/v2/tables/${env.NOCO_ARTICLE}/fields`,
  '/admin/fields/users':    env => `/api/v2/tables/${env.NOCO_USERS}/fields`,
};

/** Cache TTL in seconds for public GET routes */
const CACHE_TTL = {
  '/api/articles':    120,
  '/api/folders':     300,
  '/api/permissions': 60,
};

// ── Crypto helpers ────────────────────────────────────────────

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Hash password: SHA-256(salt + plain + salt) → 64-char hex */
async function hashPassword(plain, salt) {
  return sha256(salt + plain + salt);
}

function isHashed(storedPass) {
  return typeof storedPass === 'string' && storedPass.length === 64 && /^[0-9a-f]+$/.test(storedPass);
}

// ── Session token ─────────────────────────────────────────────

/** Create a signed session token (8h expiry) */
async function makeToken(userId, email, role, secret) {
  const payload = `${userId}:${email}:${role}:${Date.now()}`;
  const sig = await sha256(secret + payload);
  return btoa(payload) + '.' + sig.slice(0, 32);
}

/** Verify token; returns { userId, email, role } or null */
async function verifyToken(token, secret) {
  try {
    const [b64, sig] = token.split('.');
    if (!b64 || !sig) return null;
    const payload = atob(b64);
    const expected = (await sha256(secret + payload)).slice(0, 32);
    if (sig !== expected) return null;
    const [userId, email, role, ts] = payload.split(':');
    if (Date.now() - Number(ts) > 8 * 60 * 60 * 1000) return null; // 8h
    return { userId, email, role };
  } catch { return null; }
}

// ── Admin session token (8h, HMAC-signed) ────────────────────

/** Tạo admin token có hạn 8h */
async function makeAdminToken(secret) {
  const payload = `admin:${Date.now()}`;
  const sig = await sha256(secret + payload);
  return btoa(payload) + '.' + sig.slice(0, 40);
}

/** Xác minh admin token; trả true nếu hợp lệ */
async function verifyAdminToken(token, secret) {
  try {
    const [b64, sig] = token.split('.');
    if (!b64 || !sig) return false;
    const payload = atob(b64);
    const expected = (await sha256(secret + payload)).slice(0, 40);
    if (sig !== expected) return false;
    const [, ts] = payload.split(':');
    return Date.now() - Number(ts) < 8 * 60 * 60 * 1000; // 8h
  } catch { return false; }
}

/**
 * Xác thực admin request.
 * Chấp nhận: Admin-Token (session token) HOẶC Admin-Password (legacy).
 * Trả true nếu hợp lệ.
 */
async function verifyAdminAuth(request, env) {
  const adminToken = request.headers.get('Admin-Token');
  if (adminToken) {
    const secret = env.TOKEN_SECRET || 'activeedu_secret_2024';
    return verifyAdminToken(adminToken, secret + ':admin');
  }
  // Legacy fallback: plain-text password
  return request.headers.get('Admin-Password') === env.ADMIN_PASSWORD;
}

// ── NocoDB fetch helper ───────────────────────────────────────

async function nocoFetch(env, path, method = 'GET', body) {
  return fetch(`${env.NOCO_URL}${path}`, {
    method,
    headers: { 'xc-token': env.NOCO_TOKEN, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// ── Rate limiter ──────────────────────────────────────────────

const _memRateLimit = new Map();

async function checkRateLimit(ip, env, prefix = 'rl', maxAttempts = 5, windowSec = 900) {
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

async function clearRateLimit(ip, env, prefix = 'rl') {
  const key = `${prefix}:${ip || 'unknown'}`;
  if (env.RATE_LIMIT_KV) {
    try { await env.RATE_LIMIT_KV.delete(key); } catch { }
  }
  _memRateLimit.delete(key);
}

// ── Google Drive helpers ──────────────────────────────────────

async function getServiceAccountToken(env) {
  const sa = JSON.parse(env.GDRIVE_SA_JSON || '{}');
  if (!sa.private_key) throw new Error('GDRIVE_SA_JSON chưa được cấu hình');

  const now = Math.floor(Date.now() / 1000);
  const toB64Url = s => btoa(s).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const header = toB64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = toB64Url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/drive.file',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600, iat: now,
  }));

  const sigInput = `${header}.${claim}`;
  const pemBody = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  const keyData = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', keyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(sigInput));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${sigInput}.${sigB64}`,
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error('Drive token error: ' + JSON.stringify(tokenData));
  return tokenData.access_token;
}

async function uploadToDrive(env, fileName, htmlContent) {
  const token = await getServiceAccountToken(env);
  const folderId = env.GDRIVE_FOLDER_ID || '';
  const metadata = { name: fileName, mimeType: 'text/html' };
  if (folderId) metadata.parents = [folderId];

  const boundary = '-------activeedu314159265';
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8', '',
    JSON.stringify(metadata),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8', '',
    htmlContent,
    `--${boundary}--`,
  ].join('\r\n');

  const uploadRes = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webContentLink',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary="${boundary}"`,
      },
      body,
    }
  );
  if (!uploadRes.ok) throw new Error('Drive upload error: ' + await uploadRes.text());
  const file = await uploadRes.json();

  // Make file publicly readable
  await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}/permissions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  });
  return file;
}

async function fetchFromDrive(env, fileId) {
  const token = await getServiceAccountToken(env);
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) throw new Error('Drive fetch error: ' + res.status);
  return res.text();
}

// ── Admin user helpers (with server-side password hashing) ────

/**
 * Hash Password/MatKhau fields in a user payload before writing to NocoDB.
 * Called for both POST (create) and PATCH (update) on /admin/users.
 */
async function hashUserPayload(payload, env) {
  const salt = env.PASS_SALT || 'activeedu_salt_2024';
  const plain = payload.Password || payload.MatKhau;
  if (!plain) return payload;
  if (isHashed(plain)) return payload; // already hashed, skip

  const hashed = await hashPassword(plain, salt);
  return { ...payload, Password: hashed, MatKhau: hashed };
}

// ── Analytics helpers (fire-and-forget, called from handlers) ─

async function _getOrCreateAnalytics(env, articleId) {
  const r = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_ANALYTICS}/records?where=(ArticleId,eq,${encodeURIComponent(articleId)})&limit=1`
  );
  const data = await r.json();
  return (data.list || [])[0] || null;
}

async function _updateAnalyticsViews(env, articleId) {
  const row = await _getOrCreateAnalytics(env, articleId);
  if (row) {
    await nocoFetch(env, `/api/v2/tables/${env.NOCO_ANALYTICS}/records`, 'PATCH',
      [{ Id: row.Id, Views: (row.Views || 0) + 1 }]);
  } else {
    await nocoFetch(env, `/api/v2/tables/${env.NOCO_ANALYTICS}/records`, 'POST',
      { ArticleId: articleId, Views: 1, AvgScore: null, FeedbackCounts: '{"easy":0,"hard":0,"example":0}' });
  }
}

async function _updateAnalyticsScore(env, articleId, newScore) {
  // Recalculate AvgScore from all Progress records for this article
  const r = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_PROGRESS}/records?where=(ArticleId,eq,${encodeURIComponent(articleId)})~and(Score,gt,0)&limit=500&fields=Score`
  );
  const data = await r.json();
  const scores = (data.list || []).map(s => s.Score).filter(s => typeof s === 'number');
  if (!scores.length) return;
  const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);

  const row = await _getOrCreateAnalytics(env, articleId);
  if (row) {
    await nocoFetch(env, `/api/v2/tables/${env.NOCO_ANALYTICS}/records`, 'PATCH',
      [{ Id: row.Id, AvgScore: avg }]);
  } else {
    await nocoFetch(env, `/api/v2/tables/${env.NOCO_ANALYTICS}/records`, 'POST',
      { ArticleId: articleId, Views: 0, AvgScore: avg, FeedbackCounts: '{"easy":0,"hard":0,"example":0}' });
  }
}

async function _updateAnalyticsFeedback(env, articleId, newReaction, oldReaction) {
  const row = await _getOrCreateAnalytics(env, articleId);
  let counts = { easy: 0, hard: 0, example: 0 };

  if (row) {
    try { counts = { ...counts, ...JSON.parse(row.FeedbackCounts || '{}') }; } catch { }
    // If user changed reaction, decrement old one
    if (oldReaction && oldReaction !== newReaction && counts[oldReaction] > 0) {
      counts[oldReaction]--;
    }
    counts[newReaction] = (counts[newReaction] || 0) + (oldReaction ? 0 : 1);
    // If switching reactions, always increment new
    if (oldReaction && oldReaction !== newReaction) counts[newReaction]++;

    await nocoFetch(env, `/api/v2/tables/${env.NOCO_ANALYTICS}/records`, 'PATCH',
      [{ Id: row.Id, FeedbackCounts: JSON.stringify(counts) }]);
  } else {
    counts[newReaction] = 1;
    await nocoFetch(env, `/api/v2/tables/${env.NOCO_ANALYTICS}/records`, 'POST',
      { ArticleId: articleId, Views: 0, AvgScore: null, FeedbackCounts: JSON.stringify(counts) });
  }
}

// ── Main fetch handler ────────────────────────────────────────

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Admin-Password, Admin-Token, Authorization',
    };
    const secHeaders = {
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    };

    const json = (data, status = 200) => new Response(JSON.stringify(data), {
      status,
      headers: { ...cors, ...secHeaders, 'Content-Type': 'application/json' },
    });

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(request.url);
    const path = url.pathname;
    const clientIP = request.headers.get('CF-Connecting-IP')
      || request.headers.get('X-Forwarded-For')
      || 'unknown';

    // ── Health check ──────────────────────────────────────────
    if (path === '/api/health') return json({ ok: true, ts: Date.now() });

    // ── Admin login → trả session token ─────────────────────
    if (path === '/admin/auth' && request.method === 'POST') {
      const rl = await checkRateLimit(clientIP, env, 'admin');
      if (!rl.allowed) return json({ error: 'Quá nhiều lần thử. Vui lòng đợi 15 phút.' }, 429);
      const { password } = await request.json().catch(() => ({}));
      if (!password || password !== env.ADMIN_PASSWORD) {
        await checkRateLimit(clientIP, env, 'admin'); // tính thêm attempt
        return json({ error: 'Sai mật khẩu' }, 401);
      }
      await clearRateLimit(clientIP, env, 'admin');
      const secret = env.TOKEN_SECRET || 'activeedu_secret_2024';
      const token = await makeAdminToken(secret + ':admin');
      return json({ token, expiresIn: 8 * 3600 });
    }

    // ── Student login ─────────────────────────────────────────
    if (path === '/api/auth/login' && request.method === 'POST') {
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
        if (statusVal === 'inactive' || statusVal === 'banned') {
          return json({ error: 'Tài khoản đã bị vô hiệu hóa' }, 403);
        }

        const storedPass = user.Password || user.MatKhau || '';
        const salt = env.PASS_SALT || 'activeedu_salt_2024';
        const hashed = await hashPassword(password, salt);

        const valid = isHashed(storedPass) ? storedPass === hashed : storedPass === password;
        if (!valid) return json({ error: 'Email hoặc mật khẩu không đúng' }, 401);

        // Auto-upgrade legacy plain-text password
        if (!isHashed(storedPass)) {
          await nocoFetch(env, `/api/v2/tables/${env.NOCO_USERS}/records`, 'PATCH',
            [{ Id: user.Id, Password: hashed, MatKhau: hashed }]);
        }

        await clearRateLimit(clientIP, env, 'login');
        const secret = env.TOKEN_SECRET || 'activeedu_secret_2024';
        const token = await makeToken(user.Id, email, user.Role || user.VaiTro || 'student', secret);

        return json({
          token,
          user: {
            id: user.Id,
            email,
            displayName: user.FullName || user.HoTen || user.Name || email,
            role: user.Role || user.VaiTro || 'student',
          },
        });
      } catch (e) {
        return json({ error: 'Lỗi server' }, 500);
      }
    }

    // ── Change password ───────────────────────────────────────
    if (path === '/api/auth/change-password' && request.method === 'POST') {
      try {
        const authHeader = request.headers.get('Authorization') || '';
        const secret = env.TOKEN_SECRET || 'activeedu_secret_2024';
        const session = await verifyToken(authHeader.replace('Bearer ', ''), secret);
        if (!session) return json({ error: 'Phiên đăng nhập hết hạn' }, 401);

        const { oldPassword, newPassword } = await request.json();
        if (!oldPassword || !newPassword) return json({ error: 'Thiếu thông tin' }, 400);
        if (newPassword.length < 6) return json({ error: 'Mật khẩu mới tối thiểu 6 ký tự' }, 400);

        const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_USERS}/records/${session.userId}`);
        const user = await r.json();
        const storedPass = user.Password || user.MatKhau || '';
        const salt = env.PASS_SALT || 'activeedu_salt_2024';
        const oldHashed = await hashPassword(oldPassword, salt);
        const valid = isHashed(storedPass) ? storedPass === oldHashed : storedPass === oldPassword;
        if (!valid) return json({ error: 'Mật khẩu hiện tại không đúng' }, 401);

        const newHashed = await hashPassword(newPassword, salt);
        await nocoFetch(env, `/api/v2/tables/${env.NOCO_USERS}/records`, 'PATCH',
          [{ Id: session.userId, Password: newHashed, MatKhau: newHashed }]);
        return json({ ok: true });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // ── Get current user profile ──────────────────────────────
    if (path === '/api/auth/me' && request.method === 'GET') {
      const authHeader = request.headers.get('Authorization') || '';
      const secret = env.TOKEN_SECRET || 'activeedu_secret_2024';
      const session = await verifyToken(authHeader.replace('Bearer ', ''), secret);
      if (!session) return json({ error: 'Unauthorized' }, 401);

      const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_USERS}/records/${session.userId}`);
      if (!r.ok) return json({ error: 'User not found' }, 404);
      const user = await r.json();
      const { Password, MatKhau, ...safeUser } = user;
      return json(safeUser);
    }

    // ── Student: Get reading progress list ───────────────────
    if (path === '/api/progress' && request.method === 'GET') {
      const authHeader = request.headers.get('Authorization') || '';
      const secret = env.TOKEN_SECRET || 'activeedu_secret_2024';
      const session = await verifyToken(authHeader.replace('Bearer ', ''), secret);
      if (!session) return json({ error: 'Unauthorized' }, 401);

      const r = await nocoFetch(env,
        `/api/v2/tables/${env.NOCO_PROGRESS}/records?where=(UserId,eq,${session.userId})&limit=500&fields=ArticleId,Completed,Score,CompletedAt,Reactions`
      );
      if (!r.ok) return json({ list: [] });
      const data = await r.json();
      return json({ list: data.list || [] });
    }

    // ── Student: Upsert reading progress (with optional Score) ──
    if (path === '/api/progress' && request.method === 'POST') {
      const authHeader = request.headers.get('Authorization') || '';
      const secret = env.TOKEN_SECRET || 'activeedu_secret_2024';
      const session = await verifyToken(authHeader.replace('Bearer ', ''), secret);
      if (!session) return json({ error: 'Unauthorized' }, 401);

      const { articleId, completed, score } = await request.json();
      if (!articleId) return json({ error: 'Thiếu articleId' }, 400);

      const existing = await nocoFetch(env,
        `/api/v2/tables/${env.NOCO_PROGRESS}/records?where=(UserId,eq,${session.userId})~and(ArticleId,eq,${encodeURIComponent(articleId)})&limit=1&fields=Id,Completed,Score`
      );
      const existData = await existing.json();
      const existRow = (existData.list || [])[0];

      if (existRow) {
        const patch = {};
        if (completed && !existRow.Completed) {
          patch.Completed = true;
          patch.CompletedAt = new Date().toISOString();
        }
        // Only update score if new score is higher (keep best attempt)
        if (typeof score === 'number' && score > (existRow.Score || 0)) {
          patch.Score = score;
        }
        if (Object.keys(patch).length) {
          await nocoFetch(env, `/api/v2/tables/${env.NOCO_PROGRESS}/records`, 'PATCH',
            [{ Id: existRow.Id, ...patch }]);
        }
      } else {
        await nocoFetch(env, `/api/v2/tables/${env.NOCO_PROGRESS}/records`, 'POST', {
          UserId: session.userId,
          ArticleId: String(articleId),
          Completed: !!completed,
          Score: typeof score === 'number' ? score : null,
          CompletedAt: completed ? new Date().toISOString() : null,
        });
      }

      // Fire-and-forget: update Analytics AvgScore if score provided
      if (typeof score === 'number' && env.NOCO_ANALYTICS) {
        _updateAnalyticsScore(env, String(articleId), score).catch(() => {});
      }
      return json({ ok: true });
    }

    // ── Student: Save reaction → Progress.Reactions + Analytics.FeedbackCounts ──
    if (path === '/api/reactions' && request.method === 'POST') {
      const authHeader = request.headers.get('Authorization') || '';
      const secret = env.TOKEN_SECRET || 'activeedu_secret_2024';
      const session = await verifyToken(authHeader.replace('Bearer ', ''), secret);
      if (!session) return json({ error: 'Unauthorized' }, 401);

      const { articleId, reaction } = await request.json();
      if (!articleId || !reaction) return json({ error: 'Thiếu thông tin' }, 400);
      const allowed = ['easy', 'hard', 'example'];
      if (!allowed.includes(reaction)) return json({ error: 'Reaction không hợp lệ' }, 400);

      const existing = await nocoFetch(env,
        `/api/v2/tables/${env.NOCO_PROGRESS}/records?where=(UserId,eq,${session.userId})~and(ArticleId,eq,${encodeURIComponent(articleId)})&limit=1&fields=Id,Reactions`
      );
      const existData = await existing.json();
      const existRow = (existData.list || [])[0];

      if (existRow) {
        await nocoFetch(env, `/api/v2/tables/${env.NOCO_PROGRESS}/records`, 'PATCH',
          [{ Id: existRow.Id, Reactions: reaction }]);
      } else {
        await nocoFetch(env, `/api/v2/tables/${env.NOCO_PROGRESS}/records`, 'POST', {
          UserId: session.userId, ArticleId: String(articleId), Reactions: reaction,
        });
      }

      // Fire-and-forget: update Analytics.FeedbackCounts
      if (env.NOCO_ANALYTICS) {
        _updateAnalyticsFeedback(env, String(articleId), reaction, existRow?.Reactions || null).catch(() => {});
      }
      return json({ ok: true });
    }

    // ── Student: Increment article view count ─────────────────
    if (path === '/api/analytics/view' && request.method === 'POST') {
      // No auth required — public view tracking
      const { articleId } = await request.json().catch(() => ({}));
      if (!articleId || !env.NOCO_ANALYTICS) return json({ ok: true });
      _updateAnalyticsViews(env, String(articleId)).catch(() => {});
      return json({ ok: true });
    }

    // ── Student: Get quiz for article ─────────────────────────
    if (path.startsWith('/api/quiz/') && request.method === 'GET') {
      const articleId = path.slice('/api/quiz/'.length);
      if (!articleId || !env.NOCO_QUIZ) return json({ questions: [] });

      const r = await nocoFetch(env,
        `/api/v2/tables/${env.NOCO_QUIZ}/records?where=(ArticleId,eq,${encodeURIComponent(articleId)})&limit=1&fields=Id,Questions`
      );
      if (!r.ok) return json({ questions: [] });
      const data = await r.json();
      const row = (data.list || [])[0];
      if (!row || !row.Questions) return json({ questions: [] });

      let questions;
      try { questions = JSON.parse(row.Questions); } catch { return json({ questions: [] }); }

      // Strip `correct` flag — client only sees options without answer
      const sanitized = questions.map((q, qi) => ({
        id: qi,
        question: q.question,
        options: (q.options || []).map((o, oi) => ({
          id: oi,
          text: typeof o === 'string' ? o : o.text,
        })),
        explanation: q.explanation || null,
      }));
      return json({ quizId: row.Id, questions: sanitized });
    }

    // ── Student: Submit quiz answers → return score ───────────
    if (path === '/api/quiz/submit' && request.method === 'POST') {
      const authHeader = request.headers.get('Authorization') || '';
      const secret = env.TOKEN_SECRET || 'activeedu_secret_2024';
      const session = await verifyToken(authHeader.replace('Bearer ', ''), secret);
      if (!session) return json({ error: 'Đăng nhập để nộp bài' }, 401);
      if (!env.NOCO_QUIZ) return json({ error: 'Quiz chưa được cấu hình' }, 503);

      const { articleId, answers } = await request.json();
      // answers: [{ questionId, optionId }]
      if (!articleId || !Array.isArray(answers)) return json({ error: 'Dữ liệu không hợp lệ' }, 400);

      const r = await nocoFetch(env,
        `/api/v2/tables/${env.NOCO_QUIZ}/records?where=(ArticleId,eq,${encodeURIComponent(articleId)})&limit=1&fields=Questions`
      );
      if (!r.ok) return json({ error: 'Không tìm thấy quiz' }, 404);
      const data = await r.json();
      const row = (data.list || [])[0];
      if (!row) return json({ error: 'Không tìm thấy quiz' }, 404);

      let questions;
      try { questions = JSON.parse(row.Questions); } catch { return json({ error: 'Quiz lỗi dữ liệu' }, 500); }

      // Grade answers
      let correct = 0;
      const results = questions.map((q, qi) => {
        const submitted = answers.find(a => a.questionId === qi);
        const correctOption = (q.options || []).findIndex(o =>
          typeof o === 'object' ? o.correct : false
        );
        const isCorrect = submitted !== undefined && submitted.optionId === correctOption;
        if (isCorrect) correct++;
        return {
          questionId: qi,
          correctOptionId: correctOption,
          isCorrect,
          explanation: q.explanation || null,
        };
      });

      const score = Math.round(correct / questions.length * 100);

      // Save score to Progress (fire-and-forget)
      nocoFetch(env,
        `/api/v2/tables/${env.NOCO_PROGRESS}/records?where=(UserId,eq,${session.userId})~and(ArticleId,eq,${encodeURIComponent(articleId)})&limit=1&fields=Id,Score`,
      ).then(async er => {
        const ed = await er.json();
        const existRow = (ed.list || [])[0];
        if (existRow) {
          if (score > (existRow.Score || 0)) {
            await nocoFetch(env, `/api/v2/tables/${env.NOCO_PROGRESS}/records`, 'PATCH',
              [{ Id: existRow.Id, Score: score }]);
          }
        } else {
          await nocoFetch(env, `/api/v2/tables/${env.NOCO_PROGRESS}/records`, 'POST', {
            UserId: session.userId, ArticleId: String(articleId), Score: score,
          });
        }
        if (env.NOCO_ANALYTICS) _updateAnalyticsScore(env, String(articleId), score).catch(() => {});
      }).catch(() => {});

      return json({ score, correct, total: questions.length, results });
    }

    // ── Admin: Google Drive upload ────────────────────────────
    if (path === '/admin/drive-upload' && request.method === 'POST') {
      if (!await verifyAdminAuth(request, env))
        return json({ error: 'Unauthorized' }, 401);
      try {
        const { fileName, content: htmlContent } = await request.json();
        if (!htmlContent) return json({ error: 'Thiếu content' }, 400);
        const file = await uploadToDrive(env, (fileName || 'article') + '.html', htmlContent);
        return json({ fileId: file.id, name: file.name, link: file.webContentLink });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // ── Admin: Google Drive fetch proxy ──────────────────────
    if (path === '/admin/drive-fetch' && request.method === 'GET') {
      if (!await verifyAdminAuth(request, env))
        return json({ error: 'Unauthorized' }, 401);
      try {
        const fileId = url.searchParams.get('fileId');
        if (!fileId) return json({ error: 'Thiếu fileId' }, 400);
        const html = await fetchFromDrive(env, fileId);
        return new Response(html, {
          status: 200,
          headers: { ...cors, 'Content-Type': 'text/html; charset=utf-8' },
        });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // ── Admin: Users (with server-side password hashing) ──────
    if (path.startsWith('/admin/users')) {
      // Common admin auth
      const country = request.headers.get('CF-IPCountry') || '';
      const allowed = (env.ALLOWED_COUNTRIES || 'VN').split(',').map(c => c.trim());
      if (country && !allowed.includes('*') && !allowed.includes(country))
        return json({ error: 'Access denied from your region' }, 403);

      if (!await verifyAdminAuth(request, env)) {
        const adminRl = await checkRateLimit(clientIP, env, 'admin');
        if (!adminRl.allowed) return json({ error: 'Quá nhiều yêu cầu. Thử lại sau 15 phút.' }, 429);
        return json({ error: 'Unauthorized' }, 401);
      }

      const nocoBase = `/api/v2/tables/${env.NOCO_USERS}/records`;
      const suffix = path.slice('/admin/users'.length); // e.g. '' or '/<id>'

      // GET: list or single — pass through
      if (request.method === 'GET') {
        const r = await nocoFetch(env, `${nocoBase}${suffix}${url.search}`);
        const text = await r.text();
        // Strip password fields from response
        try {
          const parsed = JSON.parse(text);
          const strip = u => { if (u && typeof u === 'object') { delete u.Password; delete u.MatKhau; } return u; };
          if (parsed.list) parsed.list = parsed.list.map(strip);
          else strip(parsed);
          return json(parsed, r.status);
        } catch {
          return new Response(text, { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
        }
      }

      // DELETE: pass through
      if (request.method === 'DELETE') {
        const body = await request.text();
        const r = await nocoFetch(env, `${nocoBase}${suffix}${url.search}`, 'DELETE',
          body ? JSON.parse(body) : undefined);
        return new Response(await r.text(), { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
      }

      // POST (create) / PATCH (update): hash password before saving
      if (request.method === 'POST' || request.method === 'PATCH') {
        let rawBody;
        try { rawBody = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

        // rawBody có thể là object hoặc array (NocoDB PATCH dùng array)
        const processOne = async (item) => hashUserPayload(item, env);

        let hashedBody;
        if (Array.isArray(rawBody)) {
          hashedBody = await Promise.all(rawBody.map(processOne));
        } else {
          hashedBody = await processOne(rawBody);
        }

        const r = await nocoFetch(env, `${nocoBase}${suffix}${url.search}`, request.method, hashedBody);
        return new Response(await r.text(), { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
      }

      return json({ error: 'Method not allowed' }, 405);
    }

    // ── Admin: other proxy routes ─────────────────────────────
    let adminNoco = null;
    for (const [route, resolver] of Object.entries(ADMIN_PROXY_ROUTES)) {
      if (path.startsWith(route)) {
        adminNoco = resolver(env) + path.slice(route.length);
        break;
      }
    }
    if (adminNoco !== null) {
      const country = request.headers.get('CF-IPCountry') || '';
      const allowed = (env.ALLOWED_COUNTRIES || 'VN').split(',').map(c => c.trim());
      if (country && !allowed.includes('*') && !allowed.includes(country))
        return json({ error: 'Access denied from your region' }, 403);

      if (!await verifyAdminAuth(request, env)) {
        const adminRl = await checkRateLimit(clientIP, env, 'admin');
        if (!adminRl.allowed) return json({ error: `Quá nhiều yêu cầu (${adminRl.count}). Thử lại sau 15 phút.` }, 429);
        return json({ error: 'Unauthorized' }, 401);
      }

      const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.text();
      const r = await fetch(`${env.NOCO_URL}${adminNoco}${url.search}`, {
        method: request.method,
        headers: { 'xc-token': env.NOCO_TOKEN, 'Content-Type': 'application/json' },
        body,
      });
      return new Response(await r.text(), {
        status: r.status,
        headers: { ...cors, ...secHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── Public routes ─────────────────────────────────────────
    let nocoPath = null, matchedRoute = null;
    for (const [route, resolver] of Object.entries(PUBLIC_ROUTES)) {
      if (path.startsWith(route)) {
        nocoPath = resolver(env) + path.slice(route.length);
        matchedRoute = route;
        break;
      }
    }
    if (!nocoPath) return json({ error: 'Not found' }, 404);

    // Article list: strip Content field (lazy-load)
    const isArticleList = matchedRoute === '/api/articles' && !path.slice('/api/articles'.length).match(/^\/\d+/);
    let finalSearch = url.search;
    if (isArticleList) {
      const sp = new URLSearchParams(url.search);
      if (!sp.has('fields')) {
        sp.set('fields', 'Id,Title,Path,Folder,Access,Updated,Description');
      } else {
        const fields = sp.get('fields').split(',').map(f => f.trim()).filter(f => f !== 'Content');
        sp.set('fields', fields.join(','));
      }
      finalSearch = '?' + sp.toString();
    }

    // Server-side token check for single private article fetches
    const isArticleSingleWhere = matchedRoute === '/api/articles' && url.searchParams.get('where');
    let userSession = null;
    if (isArticleSingleWhere) {
      const authHeader = request.headers.get('Authorization') || '';
      const token = authHeader.replace('Bearer ', '');
      if (token) {
        const secret = env.TOKEN_SECRET || 'activeedu_secret_2024';
        userSession = await verifyToken(token, secret);
      }
    }

    const nocoUrl = `${env.NOCO_URL}${nocoPath}${finalSearch}`;
    const isGet = request.method === 'GET';
    const ttl = CACHE_TTL[matchedRoute] || 60;

    // Cache hit check (list requests only)
    if (isGet && !isArticleSingleWhere) {
      const cached = await caches.default.match(nocoUrl);
      if (cached) {
        return new Response(await cached.text(), {
          headers: { ...cors, 'Content-Type': 'application/json', 'X-Cache': 'HIT' },
        });
      }
    }

    const reqBody = isGet ? undefined : await request.text();
    let nocoResp;
    // Retry on 429 from NocoDB (up to 3 attempts)
    for (let i = 0; i < 3; i++) {
      nocoResp = await fetch(nocoUrl, {
        method: request.method,
        headers: { 'xc-token': env.NOCO_TOKEN, 'Content-Type': 'application/json' },
        body: reqBody,
      });
      if (nocoResp.status !== 429) break;
      await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }

    let responseData = await nocoResp.text();

    // Strip Content for private articles when user not authenticated
    if (isArticleSingleWhere && nocoResp.ok) {
      try {
        const parsed = JSON.parse(responseData);
        for (const row of (parsed.list || [])) {
          if (row.Access === 'private' && !userSession) row.Content = null;
        }
        responseData = JSON.stringify(parsed);
      } catch { }
    }

    const cacheControl = isGet && !isArticleSingleWhere ? `public, max-age=${ttl}` : 'no-store';
    const response = new Response(responseData, {
      status: nocoResp.status,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': cacheControl },
    });

    if (isGet && nocoResp.ok && !isArticleSingleWhere) {
      await caches.default.put(nocoUrl, response.clone());
    }
    return response;
  },
};

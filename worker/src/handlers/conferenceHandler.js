/**
 * Conference Handler — Live video sessions via Jitsi Meet
 *
 * Jitsi Meet is open-source, free, no API key needed.
 * We generate room names + JWT tokens for access control.
 *
 * GET    /api/conferences?course_id=X          — list conferences
 * POST   /api/conferences                       — create conference room (teacher/admin)
 * GET    /api/conferences/:id                   — get conference detail + join URL
 * PATCH  /api/conferences/:id/start             — mark as started (teacher)
 * PATCH  /api/conferences/:id/end               — end conference
 * DELETE /api/conferences/:id                   — cancel
 *
 * NocoDB table required:
 *   env.NOCO_CONFERENCES — Conferences
 *     Fields: Id, CourseId, HostId, HostName, Title, RoomName, Description,
 *             StartAt, EndAt, Status (scheduled|live|ended|cancelled),
 *             MaxParticipants, RecordingUrl, CreatedAt
 *
 * Jitsi config:
 *   env.JITSI_DOMAIN    — Jitsi server domain (default: meet.jit.si)
 *   env.JITSI_APP_ID    — optional app ID for JWT auth
 *   env.JITSI_APP_SECRET — optional secret for JWT tokens
 *
 * Without JITSI_APP_SECRET: open rooms (anyone with link can join)
 * With JITSI_APP_SECRET: JWT-protected rooms (only enrolled students)
 */
import { getTokenSecret, verifyToken } from '../auth.js';
import { nocoFetch } from '../db.js';

async function getSession(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '');
  if (!token) return null;
  return verifyToken(token, getTokenSecret(env));
}

function isTeacherOrAdmin(role) {
  return role === 'admin' || role === 'teacher';
}

function getJitsiDomain(env) {
  return env.JITSI_DOMAIN || 'meet.jit.si';
}

// Generate a safe room name from title + unique suffix
function generateRoomName(title, id) {
  const safe = (title || 'room').toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 30);
  return `activeedu-${safe}-${id}`;
}

// Generate Jitsi JWT token for authenticated rooms
async function makeJitsiToken(env, userId, userName, roomName, isModerator) {
  if (!env.JITSI_APP_ID || !env.JITSI_APP_SECRET) return null;

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: env.JITSI_APP_ID,
    iss: env.JITSI_APP_ID,
    sub: getJitsiDomain(env),
    room: roomName,
    exp: now + 4 * 3600, // 4 hours
    iat: now,
    context: {
      user: {
        id: String(userId),
        name: userName,
        email: userName,
        moderator: isModerator,
      },
      features: { livestreaming: isModerator, recording: isModerator },
    },
  };

  // Create JWT (HS256)
  const toB64Url = s => btoa(s).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const header = toB64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = toB64Url(JSON.stringify(payload));
  const sigInput = `${header}.${body}`;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.JITSI_APP_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(sigInput));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  return `${sigInput}.${sigB64}`;
}

// ── GET /api/conferences?course_id=X ─────────────────────────
export async function handleListConferences(request, env, { json, url }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!env.NOCO_CONFERENCES) return json({ conferences: [] });

  const courseId = url.searchParams.get('course_id');
  const status = url.searchParams.get('status'); // scheduled|live|ended

  let where = `(Status,neq,cancelled)`;
  if (courseId) where = `(CourseId,eq,${courseId})~and(Status,neq,cancelled)`;
  if (status) where += `~and(Status,eq,${status})`;

  const r = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_CONFERENCES}/records?where=${encodeURIComponent(where)}&limit=50&sort=-StartAt`
  );
  if (!r.ok) return json({ conferences: [] });

  const conferences = (await r.json()).list || [];
  // Add join URL for live conferences
  const domain = getJitsiDomain(env);
  return json({
    conferences: conferences.map(c => ({
      ...c,
      join_url: c.Status === 'live' ? `https://${domain}/${c.RoomName}` : null,
    }))
  });
}

// ── GET /api/conferences/:id ──────────────────────────────────
export async function handleGetConference(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!env.NOCO_CONFERENCES) return json({ error: 'Not found' }, 404);

  const id = path.split('/')[3];
  const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_CONFERENCES}/records/${id}`);
  if (!r.ok) return json({ error: 'Không tìm thấy phòng họp' }, 404);
  const conf = await r.json();

  const domain = getJitsiDomain(env);
  const isModerator = isTeacherOrAdmin(session.role) || String(conf.HostId) === String(session.userId);

  // Generate join URL
  let joinUrl = `https://${domain}/${conf.RoomName}`;
  let jitsiToken = null;

  if (env.JITSI_APP_SECRET) {
    jitsiToken = await makeJitsiToken(env, session.userId, session.email, conf.RoomName, isModerator);
    if (jitsiToken) {
      joinUrl = `https://${domain}/${conf.RoomName}?jwt=${jitsiToken}`;
    }
  }

  return json({
    conference: conf,
    join_url: joinUrl,
    is_moderator: isModerator,
    jitsi_domain: domain,
    room_name: conf.RoomName,
  });
}

// ── POST /api/conferences ─────────────────────────────────────
export async function handleCreateConference(request, env, { json }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!isTeacherOrAdmin(session.role)) return json({ error: 'Chỉ giáo viên/admin có thể tạo phòng họp' }, 403);
  if (!env.NOCO_CONFERENCES) return json({ error: 'Tính năng hội nghị chưa được cấu hình' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { course_id, title, description, start_at, end_at, max_participants = 50 } = body;
  if (!course_id) return json({ error: 'Thiếu course_id' }, 400);
  if (!title || title.trim().length < 2) return json({ error: 'Tiêu đề ít nhất 2 ký tự' }, 400);
  if (!start_at) return json({ error: 'Thiếu thời gian bắt đầu (start_at)' }, 400);

  const now = new Date().toISOString();
  // Create placeholder room name (will be finalized with ID)
  const tempRoom = generateRoomName(title, Date.now());

  const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_CONFERENCES}/records`, 'POST', {
    CourseId: String(course_id),
    HostId: String(session.userId),
    HostName: session.email,
    Title: title.trim().slice(0, 255),
    Description: (description || '').trim().slice(0, 2000),
    RoomName: tempRoom,
    StartAt: start_at,
    EndAt: end_at || null,
    Status: 'scheduled',
    MaxParticipants: Math.min(parseInt(max_participants) || 50, 500),
    CreatedAt: now,
  });

  if (!r.ok) return json({ error: 'Không thể tạo phòng họp' }, 502);
  const conf = await r.json();

  // Update room name with actual ID for uniqueness
  const finalRoomName = generateRoomName(title, conf.Id);
  await nocoFetch(env, `/api/v2/tables/${env.NOCO_CONFERENCES}/records/${conf.Id}`, 'PATCH', {
    RoomName: finalRoomName,
  });

  const domain = getJitsiDomain(env);
  return json({
    ok: true,
    conference_id: conf.Id,
    room_name: finalRoomName,
    join_url: `https://${domain}/${finalRoomName}`,
    start_at,
  }, 201);
}

// ── PATCH /api/conferences/:id/start ─────────────────────────
export async function handleStartConference(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!isTeacherOrAdmin(session.role)) return json({ error: 'Không có quyền' }, 403);
  if (!env.NOCO_CONFERENCES) return json({ error: 'Not found' }, 404);

  const id = path.split('/')[3];
  await nocoFetch(env, `/api/v2/tables/${env.NOCO_CONFERENCES}/records/${id}`, 'PATCH', {
    Status: 'live',
    StartAt: new Date().toISOString(),
  });

  const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_CONFERENCES}/records/${id}`);
  const conf = r.ok ? await r.json() : null;
  const domain = getJitsiDomain(env);

  return json({
    ok: true,
    status: 'live',
    join_url: conf ? `https://${domain}/${conf.RoomName}` : null,
  });
}

// ── PATCH /api/conferences/:id/end ───────────────────────────
export async function handleEndConference(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!isTeacherOrAdmin(session.role)) return json({ error: 'Không có quyền' }, 403);
  if (!env.NOCO_CONFERENCES) return json({ error: 'Not found' }, 404);

  const id = path.split('/')[3];

  let body = {};
  try { body = await request.json(); } catch { }

  await nocoFetch(env, `/api/v2/tables/${env.NOCO_CONFERENCES}/records/${id}`, 'PATCH', {
    Status: 'ended',
    EndAt: new Date().toISOString(),
    ...(body.recording_url ? { RecordingUrl: body.recording_url } : {}),
  });
  return json({ ok: true, status: 'ended' });
}

// ── DELETE /api/conferences/:id ───────────────────────────────
export async function handleDeleteConference(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!isTeacherOrAdmin(session.role)) return json({ error: 'Không có quyền' }, 403);
  if (!env.NOCO_CONFERENCES) return json({ error: 'Not found' }, 404);

  const id = path.split('/')[3];
  await nocoFetch(env, `/api/v2/tables/${env.NOCO_CONFERENCES}/records/${id}`, 'PATCH', {
    Status: 'cancelled',
  });
  return json({ ok: true });
}

/**
 * Message Handler — Internal inbox / direct messaging
 *
 * GET    /api/messages/conversations           — list my conversations (inbox)
 * GET    /api/messages/conversations/:id       — messages in a conversation
 * POST   /api/messages                         — start new conversation (send to user(s))
 * POST   /api/messages/conversations/:id/reply — reply to existing conversation
 * PATCH  /api/messages/conversations/:id/read  — mark conversation as read
 * DELETE /api/messages/conversations/:id       — archive conversation (soft)
 *
 * NocoDB tables required:
 *   env.NOCO_CONVERSATIONS  — Conversations
 *     Fields: Id, Subject, CreatedAt, UpdatedAt, CreatedBy
 *   env.NOCO_CONV_PARTS     — ConversationParticipants
 *     Fields: Id, ConvId, UserId, UserName, IsArchived, LastReadAt
 *   env.NOCO_MSG_TABLE      — Messages
 *     Fields: Id, ConvId, SenderId, SenderName, Body, SentAt, IsDeleted
 */
import { getTokenSecret, verifyToken } from '../auth.js';
import { nocoFetch } from '../db.js';

async function getSession(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '');
  if (!token) return null;
  return verifyToken(token, getTokenSecret(env));
}

function hasMessaging(env) {
  return env.NOCO_CONVERSATIONS && env.NOCO_CONV_PARTS && env.NOCO_MSG_TABLE;
}

// ── GET /api/messages/conversations ──────────────────────────
export async function handleListConversations(request, env, { json, url }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!hasMessaging(env)) return json({ conversations: [], total: 0 });

  const page = parseInt(url.searchParams.get('page') || '1');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 50);
  const offset = (page - 1) * limit;

  // Get all participant rows for this user (non-archived)
  const pR = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_CONV_PARTS}/records?where=${encodeURIComponent(`(UserId,eq,${session.userId})~and(IsArchived,eq,false)`)}&limit=${limit}&offset=${offset}&sort=-LastReadAt`
  );
  if (!pR.ok) return json({ conversations: [], total: 0 });

  const pData = await pR.json();
  const parts = pData.list || [];
  if (parts.length === 0) return json({ conversations: [], total: 0 });

  // Fetch conversation details in parallel
  const convIds = parts.map(p => p.ConvId);
  const convPromises = convIds.map(id =>
    nocoFetch(env, `/api/v2/tables/${env.NOCO_CONVERSATIONS}/records/${id}`)
      .then(r => r.ok ? r.json() : null)
  );
  const convResults = await Promise.all(convPromises);

  // Fetch last message for each conversation
  const lastMsgPromises = convIds.map(id =>
    nocoFetch(env,
      `/api/v2/tables/${env.NOCO_MSG_TABLE}/records?where=${encodeURIComponent(`(ConvId,eq,${id})~and(IsDeleted,eq,false)`)}&limit=1&sort=-SentAt`
    ).then(r => r.ok ? r.json() : null)
  );
  const lastMsgResults = await Promise.all(lastMsgPromises);

  const conversations = parts.map((part, i) => {
    const conv = convResults[i];
    const lastMsgData = lastMsgResults[i];
    const lastMsg = lastMsgData?.list?.[0] || null;
    if (!conv) return null;

    const lastReadAt = part.LastReadAt || '';
    const hasUnread = lastMsg && lastMsg.SentAt > lastReadAt && String(lastMsg.SenderId) !== String(session.userId);

    return {
      id: conv.Id,
      subject: conv.Subject,
      last_message: lastMsg ? {
        body: (lastMsg.Body || '').slice(0, 100),
        sent_at: lastMsg.SentAt,
        sender_name: lastMsg.SenderName,
      } : null,
      last_read_at: lastReadAt,
      has_unread: !!hasUnread,
      created_at: conv.CreatedAt,
    };
  }).filter(Boolean);

  return json({
    conversations,
    total: pData.pageInfo?.totalRows ?? conversations.length,
    page,
    limit,
  });
}

// ── GET /api/messages/conversations/:id ──────────────────────
export async function handleGetConversation(request, env, { json, path, url }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!hasMessaging(env)) return json({ error: 'Not found' }, 404);

  const convId = path.split('/')[4];
  if (!convId) return json({ error: 'Not found' }, 404);

  // Verify user is a participant
  const pR = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_CONV_PARTS}/records?where=${encodeURIComponent(`(ConvId,eq,${convId})~and(UserId,eq,${session.userId})`)}&limit=1`
  );
  if (!pR.ok) return json({ error: 'Không tìm thấy' }, 404);
  const pData = await pR.json();
  if (!pData.list?.length) return json({ error: 'Không có quyền truy cập' }, 403);

  const page = parseInt(url.searchParams.get('page') || '1');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '30'), 100);
  const offset = (page - 1) * limit;

  const [convR, msgsR, allPartsR] = await Promise.all([
    nocoFetch(env, `/api/v2/tables/${env.NOCO_CONVERSATIONS}/records/${convId}`),
    nocoFetch(env,
      `/api/v2/tables/${env.NOCO_MSG_TABLE}/records?where=${encodeURIComponent(`(ConvId,eq,${convId})~and(IsDeleted,eq,false)`)}&limit=${limit}&offset=${offset}&sort=SentAt`
    ),
    nocoFetch(env,
      `/api/v2/tables/${env.NOCO_CONV_PARTS}/records?where=${encodeURIComponent(`(ConvId,eq,${convId})`)}&limit=50`
    ),
  ]);

  const conv = convR.ok ? await convR.json() : null;
  const msgsData = msgsR.ok ? await msgsR.json() : { list: [] };
  const participants = allPartsR.ok ? ((await allPartsR.json()).list || []) : [];

  // Auto-mark as read
  const partId = pData.list[0].Id;
  nocoFetch(env, `/api/v2/tables/${env.NOCO_CONV_PARTS}/records/${partId}`, 'PATCH', {
    LastReadAt: new Date().toISOString(),
  });

  return json({
    conversation: conv,
    messages: msgsData.list || [],
    participants: participants.map(p => ({ user_id: p.UserId, name: p.UserName })),
    total: msgsData.pageInfo?.totalRows ?? (msgsData.list || []).length,
    page,
    limit,
  });
}

// ── POST /api/messages ────────────────────────────────────────
export async function handleSendMessage(request, env, { json }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!hasMessaging(env)) return json({ error: 'Tính năng nhắn tin chưa được cấu hình' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { to, subject, content } = body;
  if (!to || !Array.isArray(to) || to.length === 0) return json({ error: 'Thiếu người nhận (to: [userId])' }, 400);
  if (!content || content.trim().length < 1) return json({ error: 'Nội dung không được để trống' }, 400);

  const now = new Date().toISOString();
  const convSubject = (subject || content.trim()).slice(0, 100);

  // Create conversation
  const convR = await nocoFetch(env, `/api/v2/tables/${env.NOCO_CONVERSATIONS}/records`, 'POST', {
    Subject: convSubject,
    CreatedBy: String(session.userId),
    CreatedAt: now,
    UpdatedAt: now,
  });
  if (!convR.ok) return json({ error: 'Không thể tạo cuộc hội thoại' }, 502);
  const conv = await convR.json();
  const convId = conv.Id;

  // Add all participants (sender + recipients)
  const allParticipants = [...new Set([String(session.userId), ...to.map(String)])];
  await Promise.all(allParticipants.map(userId =>
    nocoFetch(env, `/api/v2/tables/${env.NOCO_CONV_PARTS}/records`, 'POST', {
      ConvId: String(convId),
      UserId: userId,
      UserName: userId === String(session.userId) ? session.email : userId,
      IsArchived: false,
      LastReadAt: userId === String(session.userId) ? now : null,
    })
  ));

  // Send first message
  const msgR = await nocoFetch(env, `/api/v2/tables/${env.NOCO_MSG_TABLE}/records`, 'POST', {
    ConvId: String(convId),
    SenderId: String(session.userId),
    SenderName: session.email,
    Body: content.trim().slice(0, 10000),
    SentAt: now,
    IsDeleted: false,
  });
  if (!msgR.ok) return json({ error: 'Không thể gửi tin nhắn' }, 502);
  const message = await msgR.json();

  return json({ ok: true, conversation_id: convId, message }, 201);
}

// ── POST /api/messages/conversations/:id/reply ────────────────
export async function handleReplyMessage(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!hasMessaging(env)) return json({ error: 'Not found' }, 404);

  const convId = path.split('/')[4];
  if (!convId) return json({ error: 'Not found' }, 404);

  // Verify participant
  const pR = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_CONV_PARTS}/records?where=${encodeURIComponent(`(ConvId,eq,${convId})~and(UserId,eq,${session.userId})`)}&limit=1`
  );
  if (!pR.ok) return json({ error: 'Not found' }, 404);
  const pData = await pR.json();
  if (!pData.list?.length) return json({ error: 'Không có quyền truy cập' }, 403);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  if (!body.content || body.content.trim().length < 1) return json({ error: 'Nội dung không được để trống' }, 400);

  const now = new Date().toISOString();
  const msgR = await nocoFetch(env, `/api/v2/tables/${env.NOCO_MSG_TABLE}/records`, 'POST', {
    ConvId: String(convId),
    SenderId: String(session.userId),
    SenderName: session.email,
    Body: body.content.trim().slice(0, 10000),
    SentAt: now,
    IsDeleted: false,
  });

  if (!msgR.ok) return json({ error: 'Không thể gửi tin nhắn' }, 502);
  const message = await msgR.json();

  // Update conversation + sender's LastReadAt (fire-and-forget)
  const partId = pData.list[0].Id;
  Promise.all([
    nocoFetch(env, `/api/v2/tables/${env.NOCO_CONVERSATIONS}/records/${convId}`, 'PATCH', { UpdatedAt: now }),
    nocoFetch(env, `/api/v2/tables/${env.NOCO_CONV_PARTS}/records/${partId}`, 'PATCH', { LastReadAt: now }),
  ]);

  return json({ ok: true, message }, 201);
}

// ── PATCH /api/messages/conversations/:id/read ───────────────
export async function handleMarkConversationRead(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!hasMessaging(env)) return json({ ok: true });

  const convId = path.split('/')[4];
  if (!convId) return json({ ok: true });

  const pR = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_CONV_PARTS}/records?where=${encodeURIComponent(`(ConvId,eq,${convId})~and(UserId,eq,${session.userId})`)}&limit=1`
  );
  if (pR.ok) {
    const pData = await pR.json();
    const part = pData.list?.[0];
    if (part) {
      await nocoFetch(env, `/api/v2/tables/${env.NOCO_CONV_PARTS}/records/${part.Id}`, 'PATCH', {
        LastReadAt: new Date().toISOString(),
      });
    }
  }
  return json({ ok: true });
}

// ── DELETE /api/messages/conversations/:id ───────────────────
export async function handleArchiveConversation(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!hasMessaging(env)) return json({ ok: true });

  const convId = path.split('/')[4];
  if (!convId) return json({ error: 'Not found' }, 404);

  const pR = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_CONV_PARTS}/records?where=${encodeURIComponent(`(ConvId,eq,${convId})~and(UserId,eq,${session.userId})`)}&limit=1`
  );
  if (pR.ok) {
    const pData = await pR.json();
    const part = pData.list?.[0];
    if (part) {
      await nocoFetch(env, `/api/v2/tables/${env.NOCO_CONV_PARTS}/records/${part.Id}`, 'PATCH', {
        IsArchived: true,
      });
    }
  }
  return json({ ok: true });
}

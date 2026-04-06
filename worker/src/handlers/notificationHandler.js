/**
 * Notifications & Achievements
 * GET  /api/notifications          — Get user notifications (unread first)
 * POST /api/notifications/:id/read — Mark as read
 * GET  /api/achievements           — Get student achievements/badges
 */
import { getTokenSecret, verifyToken } from '../auth.js';

async function getSession(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '');
  if (!token) return null;
  const secret = env.TOKEN_SECRET || 'UNSET';
  return verifyToken(token, secret);
}

export async function handleGetNotifications(request, env, { json, url }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const limit = parseInt(url.searchParams.get('limit') || '20');
  const unreadOnly = url.searchParams.get('unread') === '1';

  const where = unreadOnly ? 'WHERE user_id=? AND read=0' : 'WHERE user_id=?';
  const results = await env.D1.prepare(
    `SELECT * FROM notification_queue ${where} ORDER BY created_at DESC LIMIT ?`
  ).bind(session.userId, limit).all();

  const unreadCount = await env.D1.prepare(
    'SELECT COUNT(*) as cnt FROM notification_queue WHERE user_id=? AND read=0'
  ).bind(session.userId).first();

  return json({
    notifications: results.results || [],
    unread_count: unreadCount?.cnt || 0
  });
}

export async function handleMarkNotificationRead(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const id = path.split('/')[3];
  if (id === 'all') {
    await env.D1.prepare('UPDATE notification_queue SET read=1 WHERE user_id=?').bind(session.userId).run();
  } else {
    await env.D1.prepare('UPDATE notification_queue SET read=1 WHERE id=? AND user_id=?').bind(parseInt(id), session.userId).run();
  }
  return json({ ok: true });
}

export async function handleGetAchievements(request, env, { json }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const results = await env.D1.prepare(
    'SELECT * FROM achievements WHERE student_id=? ORDER BY earned_at DESC'
  ).bind(session.userId).all();

  const streak = await env.D1.prepare(
    'SELECT * FROM study_streaks WHERE student_id=?'
  ).bind(session.userId).first();

  return json({
    achievements: results.results || [],
    streak: streak || { current_days: 0, longest_days: 0 }
  });
}

// Internal: award badge (called from other handlers)
export async function awardBadge(env, studentId, badgeCode, badgeName, badgeIcon = '🏆') {
  try {
    await env.D1.prepare(`
      INSERT OR IGNORE INTO achievements (student_id, badge_code, badge_name, badge_icon)
      VALUES (?, ?, ?, ?)
    `).bind(studentId, badgeCode, badgeName, badgeIcon).run();

    // Queue notification
    await env.D1.prepare(`
      INSERT INTO notification_queue (user_id, type, title, body, data)
      VALUES (?, 'achievement', ?, ?, ?)
    `).bind(
      studentId,
      `${badgeIcon} Huy hiệu mới: ${badgeName}`,
      `Bạn vừa đạt được huy hiệu "${badgeName}"!`,
      JSON.stringify({ badge_code: badgeCode, badge_icon: badgeIcon })
    ).run();
  } catch(e) {
    // IGNORE if already exists
  }
}

// Internal: update study streak
export async function updateStudyStreak(env, studentId) {
  try {
    const today = new Date().toISOString().split('T')[0];
    const existing = await env.D1.prepare('SELECT * FROM study_streaks WHERE student_id=?').bind(studentId).first();

    if (!existing) {
      await env.D1.prepare('INSERT INTO study_streaks (student_id, current_days, longest_days, last_study) VALUES (?,1,1,?)').bind(studentId, today).run();
      return 1;
    }

    const lastStudy = existing.last_study?.split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

    let newCurrent = existing.current_days;
    if (lastStudy === today) return newCurrent; // already counted today
    if (lastStudy === yesterday) newCurrent++; // consecutive day
    else newCurrent = 1; // streak broken

    const newLongest = Math.max(newCurrent, existing.longest_days);
    await env.D1.prepare('UPDATE study_streaks SET current_days=?, longest_days=?, last_study=?, updated_at=datetime("now") WHERE student_id=?')
      .bind(newCurrent, newLongest, today, studentId).run();

    // Award streak badges
    if (newCurrent === 7) await awardBadge(env, studentId, 'streak_7', '7 ngày liên tiếp', '🔥');
    if (newCurrent === 30) await awardBadge(env, studentId, 'streak_30', '30 ngày liên tiếp', '⭐');

    return newCurrent;
  } catch(e) {
    return 0;
  }
}

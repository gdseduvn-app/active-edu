/**
 * Peer Review Handler — Student peer assessment
 *
 * POST   /api/assessments/:id/peer-review/assign  — auto-assign peer reviewers (teacher/admin)
 * GET    /api/peer-reviews/assigned                — list reviews assigned to me
 * GET    /api/peer-reviews/received                — list reviews I received
 * GET    /api/peer-reviews/:id                     — get peer review detail
 * POST   /api/peer-reviews/:id/submit              — submit peer review
 * GET    /api/assessments/:id/peer-review-stats    — summary stats (teacher)
 *
 * NocoDB table required:
 *   env.NOCO_PEER_REVIEWS — PeerReviews
 *     Fields: Id, AssessmentId, RevieweeId, RevieweeEmail, ReviewerId, ReviewerEmail,
 *             Status (pending|submitted), Comments, Score, RubricId, SubmittedAt, AssignedAt
 *
 * Algorithm: each student reviews N others (default 2) — no self-review,
 *   avoid already-reviewed pairs. Random assignment from enrolled students.
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

// ── POST /api/assessments/:id/peer-review/assign ─────────────
export async function handleAssignPeerReviews(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!isTeacherOrAdmin(session.role)) return json({ error: 'Chỉ giáo viên/admin có thể phân công chấm chéo' }, 403);
  if (!env.NOCO_PEER_REVIEWS) return json({ error: 'Tính năng chấm chéo chưa được cấu hình' }, 503);

  const assessmentId = path.split('/')[3];

  let body;
  try { body = await request.json(); } catch { body = {}; }
  const reviews_per_student = Math.min(parseInt(body.reviews_per_student) || 2, 5);
  const rubric_id = body.rubric_id || null;

  // Get the assessment to find course_id
  if (!env.NOCO_ASSESSMENTS) return json({ error: 'Không tìm thấy bài kiểm tra' }, 404);
  const aR = await nocoFetch(env, `/api/v2/tables/${env.NOCO_ASSESSMENTS}/records/${assessmentId}`);
  if (!aR.ok) return json({ error: 'Không tìm thấy bài kiểm tra' }, 404);
  const assessment = await aR.json();
  const courseId = assessment.CourseId;

  // Get all students who submitted
  if (!env.NOCO_SUBMISSIONS) return json({ error: 'Không tìm thấy bài nộp' }, 503);
  const subsR = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_SUBMISSIONS}/records?where=${encodeURIComponent(`(AssessmentId,eq,${assessmentId})~and(Status,eq,submitted)`)}&fields=Id,UserId,UserEmail&limit=500`
  );
  if (!subsR.ok) return json({ error: 'Không lấy được danh sách bài nộp' }, 502);
  const submissions = (await subsR.json()).list || [];

  if (submissions.length < 2)
    return json({ error: `Cần ít nhất 2 học sinh nộp bài để phân công chấm chéo (hiện có ${submissions.length})` }, 400);

  // Get existing assignments to avoid duplicates
  const existR = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_PEER_REVIEWS}/records?where=${encodeURIComponent(`(AssessmentId,eq,${assessmentId})`)}&fields=ReviewerId,RevieweeId&limit=1000`
  );
  const existing = existR.ok ? ((await existR.json()).list || []) : [];
  const existPairs = new Set(existing.map(e => `${e.ReviewerId}:${e.RevieweeId}`));

  const now = new Date().toISOString();
  const assignments = [];

  // For each student, assign `reviews_per_student` peers to review
  for (const reviewer of submissions) {
    const others = submissions.filter(s => String(s.UserId) !== String(reviewer.UserId));
    if (others.length === 0) continue;

    // Shuffle and pick N
    const shuffled = [...others].sort(() => Math.random() - 0.5);
    let assigned = 0;
    for (const reviewee of shuffled) {
      if (assigned >= reviews_per_student) break;
      const pair = `${reviewer.UserId}:${reviewee.UserId}`;
      if (existPairs.has(pair)) continue;

      assignments.push({
        AssessmentId: String(assessmentId),
        RevieweeId: String(reviewee.UserId),
        RevieweeEmail: reviewee.UserEmail || '',
        ReviewerId: String(reviewer.UserId),
        ReviewerEmail: reviewer.UserEmail || '',
        Status: 'pending',
        RubricId: rubric_id ? String(rubric_id) : null,
        AssignedAt: now,
      });
      existPairs.add(pair);
      assigned++;
    }
  }

  if (assignments.length === 0)
    return json({ ok: true, message: 'Tất cả đã được phân công rồi', created: 0 });

  // Create all assignments in batches
  const batchSize = 20;
  let created = 0;
  for (let i = 0; i < assignments.length; i += batchSize) {
    const batch = assignments.slice(i, i + batchSize);
    await Promise.all(batch.map(a =>
      nocoFetch(env, `/api/v2/tables/${env.NOCO_PEER_REVIEWS}/records`, 'POST', a)
        .then(r => { if (r.ok) created++; })
    ));
  }

  return json({
    ok: true,
    created,
    total_students: submissions.length,
    reviews_per_student,
    message: `Đã phân công ${created} cặp chấm chéo`,
  });
}

// ── GET /api/peer-reviews/assigned ───────────────────────────
export async function handleMyAssignedReviews(request, env, { json, url }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!env.NOCO_PEER_REVIEWS) return json({ reviews: [] });

  const assessmentId = url.searchParams.get('assessment_id');
  let where = `(ReviewerId,eq,${session.userId})`;
  if (assessmentId) where += `~and(AssessmentId,eq,${assessmentId})`;

  const r = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_PEER_REVIEWS}/records?where=${encodeURIComponent(where)}&limit=50&sort=-AssignedAt`
  );
  if (!r.ok) return json({ reviews: [] });

  return json({ reviews: (await r.json()).list || [] });
}

// ── GET /api/peer-reviews/received ───────────────────────────
export async function handleMyReceivedReviews(request, env, { json, url }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!env.NOCO_PEER_REVIEWS) return json({ reviews: [] });

  const assessmentId = url.searchParams.get('assessment_id');
  let where = `(RevieweeId,eq,${session.userId})~and(Status,eq,submitted)`;
  if (assessmentId) where += `~and(AssessmentId,eq,${assessmentId})`;

  const r = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_PEER_REVIEWS}/records?where=${encodeURIComponent(where)}&limit=50&sort=-SubmittedAt`
  );
  if (!r.ok) return json({ reviews: [] });

  // Strip reviewer identity (anonymous peer review)
  const reviews = ((await r.json()).list || []).map(rv => ({
    id: rv.Id,
    assessment_id: rv.AssessmentId,
    score: rv.Score,
    comments: rv.Comments,
    submitted_at: rv.SubmittedAt,
  }));
  return json({ reviews });
}

// ── GET /api/peer-reviews/:id ─────────────────────────────────
export async function handleGetPeerReview(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!env.NOCO_PEER_REVIEWS) return json({ error: 'Not found' }, 404);

  const id = path.split('/')[3];
  const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_PEER_REVIEWS}/records/${id}`);
  if (!r.ok) return json({ error: 'Không tìm thấy' }, 404);
  const review = await r.json();

  // Only reviewer, reviewee, or teacher can view
  const isReviewer = String(review.ReviewerId) === String(session.userId);
  const isReviewee = String(review.RevieweeId) === String(session.userId);
  if (!isReviewer && !isReviewee && !isTeacherOrAdmin(session.role))
    return json({ error: 'Không có quyền truy cập' }, 403);

  // Hide reviewer identity for reviewee (anonymous)
  if (isReviewee && !isTeacherOrAdmin(session.role)) {
    const { ReviewerId, ReviewerEmail, ...safeReview } = review;
    return json({ review: safeReview });
  }

  return json({ review });
}

// ── POST /api/peer-reviews/:id/submit ────────────────────────
export async function handleSubmitPeerReview(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!env.NOCO_PEER_REVIEWS) return json({ error: 'Not found' }, 404);

  const id = path.split('/')[3];
  const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_PEER_REVIEWS}/records/${id}`);
  if (!r.ok) return json({ error: 'Không tìm thấy phân công chấm chéo' }, 404);
  const review = await r.json();

  if (String(review.ReviewerId) !== String(session.userId))
    return json({ error: 'Đây không phải phân công của bạn' }, 403);

  if (review.Status === 'submitted')
    return json({ error: 'Bạn đã nộp nhận xét này rồi' }, 409);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { comments, score } = body;
  if (!comments || comments.trim().length < 10)
    return json({ error: 'Nhận xét ít nhất 10 ký tự' }, 400);

  const maxScore = 10;
  const finalScore = score !== undefined ? Math.max(0, Math.min(maxScore, parseFloat(score) || 0)) : null;

  await nocoFetch(env, `/api/v2/tables/${env.NOCO_PEER_REVIEWS}/records/${id}`, 'PATCH', {
    Status: 'submitted',
    Comments: comments.trim().slice(0, 5000),
    Score: finalScore,
    SubmittedAt: new Date().toISOString(),
  });

  return json({ ok: true });
}

// ── GET /api/assessments/:id/peer-review-stats ───────────────
export async function handlePeerReviewStats(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!isTeacherOrAdmin(session.role)) return json({ error: 'Không có quyền' }, 403);
  if (!env.NOCO_PEER_REVIEWS) return json({ stats: { total: 0, submitted: 0, pending: 0 } });

  const assessmentId = path.split('/')[3];
  const r = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_PEER_REVIEWS}/records?where=${encodeURIComponent(`(AssessmentId,eq,${assessmentId})`)}&fields=Id,Status,Score,RevieweeId&limit=1000`
  );
  if (!r.ok) return json({ stats: { total: 0, submitted: 0, pending: 0 } });

  const all = (await r.json()).list || [];
  const submitted = all.filter(r => r.Status === 'submitted');
  const pending = all.filter(r => r.Status === 'pending');

  // Average score per reviewee
  const revieweeScores = {};
  for (const rv of submitted) {
    if (rv.Score === null || rv.Score === undefined) continue;
    if (!revieweeScores[rv.RevieweeId]) revieweeScores[rv.RevieweeId] = [];
    revieweeScores[rv.RevieweeId].push(rv.Score);
  }
  const revieweeAvg = Object.entries(revieweeScores).map(([userId, scores]) => ({
    user_id: userId,
    avg_score: scores.reduce((a, b) => a + b, 0) / scores.length,
    review_count: scores.length,
  }));

  return json({
    stats: {
      total: all.length,
      submitted: submitted.length,
      pending: pending.length,
      completion_rate: all.length > 0 ? Math.round(submitted.length / all.length * 100) : 0,
    },
    reviewee_scores: revieweeAvg,
  });
}

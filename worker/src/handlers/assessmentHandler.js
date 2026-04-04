/**
 * Assessment Handler — Quizzes & Surveys
 * Implements spec: ĐẶC TẢ YÊU CẦU & THIẾT KẾ HỆ THỐNG: MODULE QUIZZES & SURVEYS
 *
 * Actors: INS (Instructor/Admin), STU (Student), SYS (Background)
 * Tables: NOCO_ASSESSMENTS, NOCO_ASSESS_QUESTIONS, NOCO_SUBMISSIONS,
 *         NOCO_SUB_ANSWERS, NOCO_ACTION_LOGS
 */

import { getTokenSecret, verifyToken, verifyAdminAuth } from '../auth.js';
import { nocoFetch } from '../db.js';
import { checkRateLimit, SEC_HEADERS } from '../middleware.js';

// ── Utilities ──────────────────────────────────────────────────────
const tryJ = (s, fb = null) => { try { return JSON.parse(s); } catch { return fb; } };

const shuffle = arr => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// Strip correct_answer before sending to student
const toStudentQuestion = q => ({
  id: q.Id,
  type: q.QuestionType,
  content: tryJ(q.Content, { text: q.Content }),
  options: tryJ(q.Options, []),
  points: q.Points || 1,
  position: q.Position || 0,
  isRequired: q.IsRequired !== false,
});

// Log anti-cheat event (fire-and-forget)
function logAction(env, submissionId, eventType, timestamp, ip, meta = null) {
  if (!env.NOCO_ACTION_LOGS) return;
  nocoFetch(env, `/api/v2/tables/${env.NOCO_ACTION_LOGS}/records`, 'POST', {
    SubmissionId: String(submissionId),
    EventType: eventType,
    Timestamp: timestamp,
    IpAddress: ip,
    Metadata: meta ? JSON.stringify(meta) : null,
  }).catch(() => {});
}

// ══════════════════════════════════════════════════════════════════
// STUDENT API
// ══════════════════════════════════════════════════════════════════

/**
 * GET /api/assessments[?courseId=X&moduleId=Y]
 * FR-01: List published assessments visible to student
 */
export async function handleAssessmentList(request, env, { json, url }) {
  if (!env.NOCO_ASSESSMENTS) return json({ list: [] });
  const sp = url.searchParams;
  const parts = [`(Status,eq,published)`];
  if (sp.get('courseId')) parts.push(`(CourseId,eq,${sp.get('courseId')})`);
  if (sp.get('moduleId')) parts.push(`(ModuleId,eq,${sp.get('moduleId')})`);
  const where = parts.join('~and');
  const r = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_ASSESSMENTS}/records?where=${encodeURIComponent(where)}&fields=Id,Title,AssessmentType,TimeLimit,DueDate,CourseId,ModuleId,MaxAttempts&limit=200&sort=CreatedAt`
  );
  if (!r.ok) return json({ list: [] });
  return json(await r.json());
}

/**
 * GET /api/assessments/:id
 * Returns assessment config + questions WITHOUT correct answers (FR-05)
 */
export async function handleAssessmentGet(request, env, { json, path }) {
  const id = path.split('/')[3];
  if (!id || !env.NOCO_ASSESSMENTS) return json({ error: 'Không tìm thấy' }, 404);

  const ar = await nocoFetch(env, `/api/v2/tables/${env.NOCO_ASSESSMENTS}/records/${id}`);
  if (!ar.ok) return json({ error: 'Không tìm thấy' }, 404);
  const a = await ar.json();
  if (a.Status !== 'published') return json({ error: 'Bài chưa được công bố' }, 403);

  // FR-02: Time window check
  const now = new Date();
  if (a.AvailableFrom && new Date(a.AvailableFrom) > now)
    return json({ error: `Chưa mở: Bài bắt đầu lúc ${a.AvailableFrom}` }, 403);
  if (a.UntilDate && new Date(a.UntilDate) < now)
    return json({ error: 'Đã hết thời gian làm bài' }, 410);

  // Get questions (strip answers)
  let questions = [];
  if (env.NOCO_ASSESS_QUESTIONS) {
    const qr = await nocoFetch(env,
      `/api/v2/tables/${env.NOCO_ASSESS_QUESTIONS}/records?where=(AssessmentId,eq,${id})&sort=Position&limit=200`
    );
    questions = qr.ok ? ((await qr.json()).list || []) : [];
  }

  // FR-03: Shuffle questions/answers
  if (a.ShuffleQuestions) questions = shuffle(questions);
  if (a.ShuffleAnswers) {
    questions = questions.map(q => ({
      ...q, Options: JSON.stringify(shuffle(tryJ(q.Options, [])))
    }));
  }

  const isSurvey = a.AssessmentType?.includes('survey');
  return json({
    id: a.Id,
    title: a.Title,
    description: a.Description || '',
    type: a.AssessmentType,
    timeLimit: a.TimeLimit || 0,
    maxAttempts: a.MaxAttempts || 1,
    oneAtATime: a.OneAtATime || false,
    // FR-04: Anonymous flag only for surveys
    isAnonymous: isSurvey ? (a.IsAnonymous || false) : false,
    requiresCode: !!a.AccessCode,
    questionsTotal: questions.length,
    questions: questions.map(toStudentQuestion),
  });
}

/**
 * POST /api/assessments/:id/start
 * FR-06: Create Session — server records StartTime (not client time)
 * Validates: time window, access code, IP filter, max attempts
 */
export async function handleAssessmentStart(request, env, { json, path }) {
  const authHeader = request.headers.get('Authorization') || '';
  const session = await verifyToken(authHeader.replace('Bearer ', ''), getTokenSecret(env));
  if (!session) return json({ error: 'Đăng nhập để làm bài' }, 401);

  const id = path.match(/\/api\/assessments\/(\d+)\/start/)?.[1];
  if (!id || !env.NOCO_ASSESSMENTS) return json({ error: 'Không tìm thấy' }, 404);

  // Rate limit: 20 attempts per hour per user
  const rl = await checkRateLimit(`assess_start:${session.userId}`, env, 'assess_start', 20, 3600);
  if (!rl.allowed) return json({ error: 'Quá nhiều lần thử. Thử lại sau 1 giờ.' }, 429);

  const ar = await nocoFetch(env, `/api/v2/tables/${env.NOCO_ASSESSMENTS}/records/${id}`);
  if (!ar.ok) return json({ error: 'Không tìm thấy bài đánh giá' }, 404);
  const a = await ar.json();
  if (a.Status !== 'published') return json({ error: 'Bài chưa được công bố' }, 403);

  // FR-02: Time window
  const now = new Date();
  if (a.AvailableFrom && new Date(a.AvailableFrom) > now)
    return json({ error: 'Chưa đến thời gian làm bài' }, 403);
  if (a.UntilDate && new Date(a.UntilDate) < now)
    return json({ error: 'Đã hết thời gian làm bài (UntilDate)' }, 410);

  const body = await request.json().catch(() => ({}));
  const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';

  // FR-03: Access code
  if (a.AccessCode && body.accessCode !== a.AccessCode)
    return json({ error: 'Mã truy cập không đúng' }, 403);

  // FR-03: IP filter
  if (a.IpFilter) {
    const allowed = a.IpFilter.split(',').map(s => s.trim()).filter(Boolean);
    if (allowed.length && !allowed.some(ip => clientIp.startsWith(ip)))
      return json({ error: 'IP không được phép truy cập bài này' }, 403);
  }

  if (!env.NOCO_SUBMISSIONS) return json({ error: 'Submissions chưa cấu hình (NOCO_SUBMISSIONS)' }, 503);

  // Check max attempts (FR-09 side)
  if (a.MaxAttempts > 0) {
    const prevR = await nocoFetch(env,
      `/api/v2/tables/${env.NOCO_SUBMISSIONS}/records?where=(AssessmentId,eq,${id})~and(UserId,eq,${session.userId})~and(Status,neq,in_progress)&limit=1&fields=Id`
    );
    const prev = prevR.ok ? ((await prevR.json()).list || []) : [];
    if (prev.length >= a.MaxAttempts)
      return json({ error: `Đã đạt số lần làm tối đa (${a.MaxAttempts} lần)` }, 409);
  }

  // Resume if already in_progress
  const inProgressR = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_SUBMISSIONS}/records?where=(AssessmentId,eq,${id})~and(UserId,eq,${session.userId})~and(Status,eq,in_progress)&limit=1`
  );
  if (inProgressR.ok) {
    const existing = ((await inProgressR.json()).list || [])[0];
    if (existing) {
      // Check if timed out server-side
      if (a.TimeLimit > 0) {
        const elapsedMin = (now - new Date(existing.StartTime)) / 60000;
        if (elapsedMin > a.TimeLimit + 1) {
          // Auto-submit timed out session
          await nocoFetch(env, `/api/v2/tables/${env.NOCO_SUBMISSIONS}/records`, 'PATCH', [{
            Id: existing.Id, Status: 'submitted', EndTime: now.toISOString(),
            TotalScore: 0, ScorePercent: 0, TimedOut: true,
          }]);
          logAction(env, existing.Id, 'timeout', now.toISOString(), clientIp);
          return json({ error: 'Phiên làm bài đã hết giờ và được tự động nộp.' }, 409);
        }
      }
      // Resume session
      const elapsedSec = Math.floor((now - new Date(existing.StartTime)) / 1000);
      return json({
        submissionId: existing.Id,
        resuming: true,
        startTime: existing.StartTime,
        elapsedSeconds: elapsedSec,
        timeLimit: a.TimeLimit || 0,
      });
    }
  }

  // Create new submission — FR-06: server records StartTime
  const sr = await nocoFetch(env, `/api/v2/tables/${env.NOCO_SUBMISSIONS}/records`, 'POST', {
    AssessmentId: parseInt(id),
    UserId: session.userId,
    UserName: session.name || session.email || '',
    Status: 'in_progress',
    StartTime: now.toISOString(),
    IpAddress: clientIp,
  });
  if (!sr.ok) return json({ error: 'Không tạo được phiên làm bài: ' + await sr.text() }, 500);
  const submission = await sr.json();

  logAction(env, submission.Id, 'started', now.toISOString(), clientIp);

  return json({
    submissionId: submission.Id,
    resuming: false,
    startTime: now.toISOString(),
    timeLimit: a.TimeLimit || 0,
  });
}

/**
 * PATCH /api/submissions/:id/save
 * FR-07: Auto-save answers (called every 15s or on answer change)
 * Saves to KV immediately; async sync to DB optional
 */
export async function handleSubmissionSave(request, env, { json, path }) {
  const authHeader = request.headers.get('Authorization') || '';
  const session = await verifyToken(authHeader.replace('Bearer ', ''), getTokenSecret(env));
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const subId = path.match(/\/api\/submissions\/(\d+)\/save/)?.[1];
  if (!subId) return json({ error: 'Invalid submission ID' }, 400);

  const body = await request.json().catch(() => ({}));
  const { answers } = body; // [{ questionId, answerData }]
  if (!Array.isArray(answers)) return json({ error: 'answers must be array' }, 400);

  const savedAt = new Date().toISOString();

  // FR-07: Save to KV immediately (fast path, 24h TTL)
  if (env.IDEMPOTENCY_KV) {
    await env.IDEMPOTENCY_KV.put(
      `autosave:${subId}:${session.userId}`,
      JSON.stringify({ answers, savedAt }),
      { expirationTtl: 86400 }
    );
  }

  // FR-08: Log answer_saved event (fire-and-forget)
  logAction(env, subId, 'answer_saved', savedAt, request.headers.get('CF-Connecting-IP') || 'unknown',
    { count: answers.length });

  return json({ ok: true, savedAt });
}

/**
 * POST /api/submissions/:id/log-event
 * FR-08: Log activity events (focus_lost, focus_gained, etc.)
 */
export async function handleActionLogEvent(request, env, { json, path }) {
  const authHeader = request.headers.get('Authorization') || '';
  const session = await verifyToken(authHeader.replace('Bearer ', ''), getTokenSecret(env));
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const subId = path.match(/\/api\/submissions\/(\d+)\/log/)?.[1];
  if (!subId) return json({ error: 'Invalid' }, 400);

  const body = await request.json().catch(() => ({}));
  const validEvents = ['focus_lost', 'focus_gained', 'answer_saved', 'page_change', 'started', 'submitted'];
  if (!validEvents.includes(body.eventType)) return json({ error: 'Invalid event type' }, 400);

  logAction(env, subId, body.eventType, new Date().toISOString(),
    request.headers.get('CF-Connecting-IP') || 'unknown', body.meta || null);

  return json({ ok: true });
}

/**
 * POST /api/submissions/:id/submit
 * FR-09: Final submit — triggered by student or timeout
 * FR-10/11: Auto-grade quiz or assign max score for graded survey
 * FR-04: Anonymous survey — submission_id set to null in answers
 */
export async function handleSubmissionSubmit(request, env, { json, path }) {
  const authHeader = request.headers.get('Authorization') || '';
  const session = await verifyToken(authHeader.replace('Bearer ', ''), getTokenSecret(env));
  if (!session) return json({ error: 'Đăng nhập để nộp bài' }, 401);

  const subId = path.match(/\/api\/submissions\/(\d+)\/submit/)?.[1];
  if (!subId || !env.NOCO_SUBMISSIONS) return json({ error: 'Invalid' }, 400);

  const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';

  // Get and verify submission ownership
  const sr = await nocoFetch(env, `/api/v2/tables/${env.NOCO_SUBMISSIONS}/records/${subId}`);
  if (!sr.ok) return json({ error: 'Phiên làm bài không tồn tại' }, 404);
  const sub = await sr.json();
  if (String(sub.UserId) !== String(session.userId)) return json({ error: 'Forbidden' }, 403);
  if (sub.Status === 'submitted' || sub.Status === 'graded')
    return json({ error: 'Đã nộp bài rồi' }, 409);

  // Get assessment
  const ar = await nocoFetch(env, `/api/v2/tables/${env.NOCO_ASSESSMENTS}/records/${sub.AssessmentId}`);
  if (!ar.ok) return json({ error: 'Không tìm thấy đề' }, 404);
  const a = await ar.json();

  const now = new Date();

  // FR-09: Server-side timer check (not trusting client time)
  const startTime = new Date(sub.StartTime);
  const elapsedMin = (now - startTime) / 60000;
  const timedOut = a.TimeLimit > 0 && elapsedMin > (a.TimeLimit + 2); // 2 min grace

  const body = await request.json().catch(() => ({}));
  let answers = body.answers || [];

  // FR-07: Fallback to KV auto-save if no answers in body
  if (!answers.length && env.IDEMPOTENCY_KV) {
    const kv = await env.IDEMPOTENCY_KV.get(`autosave:${subId}:${session.userId}`);
    if (kv) answers = tryJ(kv, {})?.answers || [];
  }

  // Get questions with correct answers (server-side)
  let questions = [];
  if (env.NOCO_ASSESS_QUESTIONS) {
    const qr = await nocoFetch(env,
      `/api/v2/tables/${env.NOCO_ASSESS_QUESTIONS}/records?where=(AssessmentId,eq,${sub.AssessmentId})&sort=Position&limit=200`
    );
    questions = qr.ok ? ((await qr.json()).list || []) : [];
  }

  const isSurvey = a.AssessmentType?.includes('survey');
  const isGradedSurvey = a.AssessmentType === 'graded_survey';
  // FR-04: Anonymous survey flag
  const isAnonymous = isSurvey && a.IsAnonymous;

  let totalScore = 0;
  let maxScore = 0;
  const answerRecords = [];

  // FR-10: Auto-grade quiz | FR-11: Survey auto-scoring
  for (const q of questions) {
    const pts = q.Points || 1;
    maxScore += pts;
    const submitted = answers.find(
      a => String(a.questionId) === String(q.Id)
    );
    let isCorrect = null;
    let scored = 0;

    if (!isSurvey) {
      // Quiz: compare answers
      if (q.CorrectAnswer && submitted?.answerData !== undefined) {
        const correct = tryJ(q.CorrectAnswer);
        const userAns = submitted.answerData;
        if (Array.isArray(correct)) {
          const userArr = Array.isArray(userAns) ? [...userAns].sort() : [String(userAns)];
          isCorrect = userArr.join(',') === [...correct].sort().join(',');
        } else {
          isCorrect = String(userAns) === String(correct);
        }
        if (isCorrect) { scored = pts; totalScore += pts; }
      }
    } else if (isGradedSurvey) {
      // FR-11: Graded survey → max score for submitting
      scored = pts;
      totalScore += pts;
    }

    // FR-04: Anonymous → submission_id = null in answers
    answerRecords.push({
      SubmissionId: isAnonymous ? null : parseInt(subId),
      AssessmentId: sub.AssessmentId,
      QuestionId: q.Id,
      AnswerData: JSON.stringify(submitted?.answerData ?? null),
      IsCorrect: isCorrect,
      ScoreEarned: scored,
    });
  }

  // Save individual answers async
  if (env.NOCO_SUB_ANSWERS && answerRecords.length) {
    nocoFetch(env, `/api/v2/tables/${env.NOCO_SUB_ANSWERS}/records`, 'POST', answerRecords)
      .catch(() => {});
  }

  const scorePercent = maxScore > 0 ? Math.round(totalScore / maxScore * 100) : 0;
  const passingScore = a.PassingScore || 60;
  const passed = scorePercent >= passingScore;

  // Update submission record
  await nocoFetch(env, `/api/v2/tables/${env.NOCO_SUBMISSIONS}/records`, 'PATCH', [{
    Id: parseInt(subId),
    Status: 'submitted',
    EndTime: now.toISOString(),
    TotalScore: totalScore,
    MaxScore: maxScore,
    ScorePercent: scorePercent,
    Passed: passed,
    TimedOut: timedOut,
  }]);

  // Update progress gradebook (async, non-blocking)
  if (env.NOCO_PROGRESS) {
    const progressKey = `assessment_${sub.AssessmentId}`;
    nocoFetch(env,
      `/api/v2/tables/${env.NOCO_PROGRESS}/records?where=(UserId,eq,${session.userId})~and(ArticleId,eq,${progressKey})&limit=1&fields=Id,Score`
    ).then(async pr => {
      const row = ((await pr.json()).list || [])[0];
      if (row) {
        if (scorePercent > (row.Score || 0))
          await nocoFetch(env, `/api/v2/tables/${env.NOCO_PROGRESS}/records`, 'PATCH', [{ Id: row.Id, Score: scorePercent, Completed: passed }]);
      } else {
        await nocoFetch(env, `/api/v2/tables/${env.NOCO_PROGRESS}/records`, 'POST', {
          UserId: session.userId, ArticleId: progressKey,
          Score: scorePercent, Completed: passed, CompletedAt: now.toISOString(),
        });
      }
    }).catch(() => {});
  }

  // FR-08: Log submit event
  logAction(env, subId, 'submitted', now.toISOString(), clientIp, { scorePercent, timedOut });

  // Cleanup KV
  if (env.IDEMPOTENCY_KV)
    env.IDEMPOTENCY_KV.delete(`autosave:${subId}:${session.userId}`).catch(() => {});

  return json({
    ok: true,
    submissionId: parseInt(subId),
    isSurvey,
    scorePercent,
    totalScore,
    maxScore,
    passed,
    passingScore,
    timedOut,
  });
}

/**
 * GET /api/submissions/:id/result
 * Returns full result with correct answers (after submission)
 */
export async function handleSubmissionResult(request, env, { json, path }) {
  const authHeader = request.headers.get('Authorization') || '';
  const session = await verifyToken(authHeader.replace('Bearer ', ''), getTokenSecret(env));
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const subId = path.match(/\/api\/submissions\/(\d+)\/result/)?.[1];
  if (!subId || !env.NOCO_SUBMISSIONS) return json({ error: 'Not found' }, 404);

  const sr = await nocoFetch(env, `/api/v2/tables/${env.NOCO_SUBMISSIONS}/records/${subId}`);
  if (!sr.ok) return json({ error: 'Không tìm thấy phiên làm bài' }, 404);
  const sub = await sr.json();
  if (String(sub.UserId) !== String(session.userId)) return json({ error: 'Forbidden' }, 403);
  if (sub.Status === 'in_progress') return json({ error: 'Bài chưa được nộp' }, 400);

  const ar = await nocoFetch(env, `/api/v2/tables/${env.NOCO_ASSESSMENTS}/records/${sub.AssessmentId}`);
  const a = ar.ok ? await ar.json() : {};

  const qr = env.NOCO_ASSESS_QUESTIONS
    ? await nocoFetch(env, `/api/v2/tables/${env.NOCO_ASSESS_QUESTIONS}/records?where=(AssessmentId,eq,${sub.AssessmentId})&sort=Position&limit=200`)
    : null;
  const questions = qr?.ok ? ((await qr.json()).list || []) : [];

  // Get answers (only for non-anonymous)
  let answers = [];
  const isAnonymous = a.IsAnonymous && a.AssessmentType?.includes('survey');
  if (!isAnonymous && env.NOCO_SUB_ANSWERS) {
    const ansr = await nocoFetch(env,
      `/api/v2/tables/${env.NOCO_SUB_ANSWERS}/records?where=(SubmissionId,eq,${subId})&limit=200`
    );
    answers = ansr.ok ? ((await ansr.json()).list || []) : [];
  }

  return json({
    submission: {
      id: sub.Id, status: sub.Status,
      startTime: sub.StartTime, endTime: sub.EndTime,
      totalScore: sub.TotalScore, maxScore: sub.MaxScore,
      scorePercent: sub.ScorePercent, passed: sub.Passed, timedOut: sub.TimedOut,
    },
    assessment: {
      title: a.Title, type: a.AssessmentType,
      passingScore: a.PassingScore || 60,
    },
    questions: questions.map(q => {
      const ans = answers.find(a => a.QuestionId === q.Id);
      const isSurvey = a.AssessmentType?.includes?.('survey');
      return {
        id: q.Id,
        content: tryJ(q.Content, { text: q.Content }),
        type: q.QuestionType,
        options: tryJ(q.Options, []),
        // Only show correct answer for quizzes
        correctAnswer: !isSurvey ? tryJ(q.CorrectAnswer) : null,
        yourAnswer: ans ? tryJ(ans.AnswerData) : null,
        isCorrect: ans?.IsCorrect ?? null,
        scoreEarned: ans?.ScoreEarned ?? 0,
        points: q.Points || 1,
        explanation: q.Explanation || null,
      };
    }),
  });
}

// ══════════════════════════════════════════════════════════════════
// ADMIN API
// ══════════════════════════════════════════════════════════════════

/**
 * GET /admin/submissions[?assessmentId=X]
 * FR-12: Admin views all submissions
 */
export async function handleAdminSubmissions(request, env, { json, url }) {
  if (!await verifyAdminAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
  if (!env.NOCO_SUBMISSIONS) return json({ list: [] });
  const qs = url.searchParams;
  const parts = [];
  if (qs.get('assessmentId')) parts.push(`(AssessmentId,eq,${qs.get('assessmentId')})`);
  if (qs.get('userId')) parts.push(`(UserId,eq,${qs.get('userId')})`);
  const where = parts.length ? `&where=${encodeURIComponent(parts.join('~and'))}` : '';
  const r = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_SUBMISSIONS}/records?limit=200&sort=-StartTime${where}`
  );
  if (!r.ok) return json({ list: [] });
  return json(await r.json());
}

/**
 * PATCH /admin/submissions/:id/grade
 * FR-12: SpeedGrader — manual grading for essay questions
 */
export async function handleAdminGrade(request, env, { json, path }) {
  if (!await verifyAdminAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
  const subId = path.match(/\/admin\/submissions\/(\d+)\/grade/)?.[1];
  if (!subId) return json({ error: 'Invalid submission ID' }, 400);

  const body = await request.json().catch(() => ({}));
  // { answerGrades: [{answerId, score, feedback}], finalScore, status }

  if (env.NOCO_SUB_ANSWERS && body.answerGrades?.length) {
    const patches = body.answerGrades.map(ag => ({
      Id: ag.answerId, ScoreEarned: ag.score, Feedback: ag.feedback || '',
    }));
    await nocoFetch(env, `/api/v2/tables/${env.NOCO_SUB_ANSWERS}/records`, 'PATCH', patches);
  }

  if (body.finalScore !== undefined && env.NOCO_SUBMISSIONS) {
    await nocoFetch(env, `/api/v2/tables/${env.NOCO_SUBMISSIONS}/records`, 'PATCH', [{
      Id: parseInt(subId),
      TotalScore: body.finalScore,
      Status: 'graded',
      GradedAt: new Date().toISOString(),
    }]);
  }

  return json({ ok: true });
}

/**
 * GET /admin/assessments/:id/export
 * FR-14: Export CSV — nullify UserId/UserName if is_anonymous
 */
export async function handleAssessmentExport(request, env, { path, cors }) {
  const badAuth = () => new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401, headers: { ...cors, 'Content-Type': 'application/json' }
  });
  if (!await verifyAdminAuth(request, env)) return badAuth();

  const id = path.match(/\/admin\/assessments\/(\d+)\/export/)?.[1];
  if (!id) return new Response('Invalid', { status: 400 });

  const ar = await nocoFetch(env, `/api/v2/tables/${env.NOCO_ASSESSMENTS}/records/${id}`);
  if (!ar.ok) return new Response('Not found', { status: 404 });
  const a = await ar.json();
  // FR-14: is_anonymous → nullify user columns at query level
  const isAnonymous = a.IsAnonymous && a.AssessmentType?.includes('survey');

  const qr = env.NOCO_ASSESS_QUESTIONS
    ? await nocoFetch(env, `/api/v2/tables/${env.NOCO_ASSESS_QUESTIONS}/records?where=(AssessmentId,eq,${id})&sort=Position&limit=200`)
    : null;
  const questions = qr?.ok ? ((await qr.json()).list || []) : [];

  const sr = env.NOCO_SUBMISSIONS
    ? await nocoFetch(env, `/api/v2/tables/${env.NOCO_SUBMISSIONS}/records?where=(AssessmentId,eq,${id})&limit=2000`)
    : null;
  const submissions = sr?.ok ? ((await sr.json()).list || []) : [];

  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;

  // FR-14: Build header — blank user columns if anonymous
  const qHeaders = questions.map(q => {
    const c = tryJ(q.Content, {});
    return esc((c.text || `Q${q.Position || q.Id}`).slice(0, 60));
  });
  const header = [
    isAnonymous ? esc('UserId_ANONYMOUS') : esc('UserId'),
    isAnonymous ? esc('UserName_ANONYMOUS') : esc('UserName'),
    esc('StartTime'), esc('EndTime'), esc('Status'),
    esc('TotalScore'), esc('MaxScore'), esc('ScorePercent'), esc('Passed'),
    ...qHeaders,
  ].join(',');

  const rows = [header];
  for (const sub of submissions) {
    let answers = [];
    if (env.NOCO_SUB_ANSWERS) {
      const ansr = await nocoFetch(env,
        `/api/v2/tables/${env.NOCO_SUB_ANSWERS}/records?where=(SubmissionId,eq,${sub.Id})&limit=200`
      );
      answers = ansr.ok ? ((await ansr.json()).list || []) : [];
    }

    const row = [
      // FR-14: nullify user identity for anonymous surveys
      isAnonymous ? esc('') : esc(sub.UserId),
      isAnonymous ? esc('') : esc(sub.UserName || ''),
      esc(sub.StartTime), esc(sub.EndTime || ''),
      esc(sub.Status), esc(sub.TotalScore ?? ''),
      esc(sub.MaxScore ?? ''), esc(sub.ScorePercent ?? ''),
      esc(sub.Passed ? 'Yes' : 'No'),
      ...questions.map(q => {
        const ans = answers.find(an => an.QuestionId === q.Id);
        return esc(ans ? tryJ(ans.AnswerData) ?? '' : '');
      }),
    ].join(',');
    rows.push(row);
  }

  return new Response(rows.join('\n'), {
    status: 200,
    headers: {
      ...cors, 'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="assessment_${id}_${a.AssessmentType}_export.csv"`,
    },
  });
}

/**
 * DELETE /admin/assessments/safe
 * Cascade: delete questions + submissions + answers + action logs
 */
export async function handleAssessmentDelete(request, env, { json }) {
  if (!await verifyAdminAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
  const body = await request.json().catch(() => ([]));
  const ids = Array.isArray(body) ? body.map(r => r.Id) : [body.Id];
  if (!ids.length) return json({ error: 'Thiếu Id' }, 400);

  try {
    for (const id of ids) {
      // Delete questions
      if (env.NOCO_ASSESS_QUESTIONS) {
        const qr = await nocoFetch(env,
          `/api/v2/tables/${env.NOCO_ASSESS_QUESTIONS}/records?where=(AssessmentId,eq,${id})&fields=Id&limit=500`
        );
        const qids = qr.ok ? ((await qr.json()).list || []).map(q => ({ Id: q.Id })) : [];
        if (qids.length) await nocoFetch(env, `/api/v2/tables/${env.NOCO_ASSESS_QUESTIONS}/records`, 'DELETE', qids);
      }
      // Delete submissions + their answers + logs
      if (env.NOCO_SUBMISSIONS) {
        const sr = await nocoFetch(env,
          `/api/v2/tables/${env.NOCO_SUBMISSIONS}/records?where=(AssessmentId,eq,${id})&fields=Id&limit=2000`
        );
        const subs = sr.ok ? ((await sr.json()).list || []) : [];
        for (const sub of subs) {
          if (env.NOCO_SUB_ANSWERS) {
            const ansr = await nocoFetch(env,
              `/api/v2/tables/${env.NOCO_SUB_ANSWERS}/records?where=(SubmissionId,eq,${sub.Id})&fields=Id&limit=1000`
            );
            const aids = ansr.ok ? ((await ansr.json()).list || []).map(a => ({ Id: a.Id })) : [];
            if (aids.length) await nocoFetch(env, `/api/v2/tables/${env.NOCO_SUB_ANSWERS}/records`, 'DELETE', aids);
          }
          if (env.NOCO_ACTION_LOGS) {
            const lr = await nocoFetch(env,
              `/api/v2/tables/${env.NOCO_ACTION_LOGS}/records?where=(SubmissionId,eq,${sub.Id})&fields=Id&limit=1000`
            );
            const lids = lr.ok ? ((await lr.json()).list || []).map(l => ({ Id: l.Id })) : [];
            if (lids.length) await nocoFetch(env, `/api/v2/tables/${env.NOCO_ACTION_LOGS}/records`, 'DELETE', lids);
          }
        }
        const sids = subs.map(s => ({ Id: s.Id }));
        if (sids.length) await nocoFetch(env, `/api/v2/tables/${env.NOCO_SUBMISSIONS}/records`, 'DELETE', sids);
      }
      // Finally delete assessment
      const dr = await nocoFetch(env, `/api/v2/tables/${env.NOCO_ASSESSMENTS}/records`, 'DELETE', [{ Id: id }]);
      if (!dr.ok) throw new Error(`NocoDB delete failed (${dr.status}): ${await dr.text().catch(() => '')}`);
    }
  } catch (e) {
    return json({ error: e.message || 'Delete failed' }, 500);
  }
  return json({ ok: true, deleted: ids.length });
}

/**
 * GET /admin/action-logs?submissionId=X
 * FR-08: View anti-cheat logs for a submission
 */
export async function handleAdminActionLogs(request, env, { json, url }) {
  if (!await verifyAdminAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
  if (!env.NOCO_ACTION_LOGS) return json({ list: [] });
  const subId = url.searchParams.get('submissionId');
  if (!subId) return json({ error: 'submissionId required' }, 400);
  const r = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_ACTION_LOGS}/records?where=(SubmissionId,eq,${subId})&sort=Timestamp&limit=500`
  );
  if (!r.ok) return json({ list: [] });
  return json(await r.json());
}

// ── Admin: tạo Assessment ──────────────────────────────────────────
export async function handleAssessmentCreate(request, env, { json, cors }) {
  if (!await verifyAdminAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
  if (!env.NOCO_ASSESSMENTS) return json({ error: 'NOCO_ASSESSMENTS chưa cấu hình' }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  // Validate required fields
  if (!body.Title) return json({ error: 'Title bắt buộc' }, 422);
  if (!body.AssessmentType) return json({ error: 'AssessmentType bắt buộc' }, 422);
  const validTypes = ['graded_quiz', 'practice_quiz', 'graded_survey', 'ungraded_survey'];
  if (!validTypes.includes(body.AssessmentType))
    return json({ error: `AssessmentType phải là một trong: ${validTypes.join(', ')}` }, 422);

  // Validate time limit
  if (body.TimeLimitMinutes != null && body.TimeLimitMinutes < 1)
    return json({ error: 'Thời gian làm bài phải ≥ 1 phút' }, 422);

  // Ensure Questions is valid JSON array if provided
  if (body.Questions) {
    const qs = tryJ(typeof body.Questions === 'string' ? body.Questions : JSON.stringify(body.Questions), null);
    if (!Array.isArray(qs)) return json({ error: 'Questions phải là mảng JSON' }, 422);
  }

  // Strip system fields
  delete body.CreatedAt; delete body.UpdatedAt;

  const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_ASSESSMENTS}/records`, 'POST', body);
  const text = await r.text();
  return new Response(text, { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

// ── Admin: cập nhật Assessment ─────────────────────────────────────
export async function handleAssessmentUpdate(request, env, { json, path, cors }) {
  if (!await verifyAdminAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
  if (!env.NOCO_ASSESSMENTS) return json({ error: 'NOCO_ASSESSMENTS chưa cấu hình' }, 500);

  const assessId = parseInt(path.split('/').pop());
  if (!assessId) return json({ error: 'ID không hợp lệ' }, 400);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  // Validate type if provided
  if (body.AssessmentType) {
    const validTypes = ['graded_quiz', 'practice_quiz', 'graded_survey', 'ungraded_survey'];
    if (!validTypes.includes(body.AssessmentType))
      return json({ error: `AssessmentType phải là một trong: ${validTypes.join(', ')}` }, 422);
  }

  if (body.TimeLimitMinutes != null && body.TimeLimitMinutes < 1)
    return json({ error: 'Thời gian làm bài phải ≥ 1 phút' }, 422);

  // Strip system fields
  delete body.CreatedAt; delete body.UpdatedAt;
  body.Id = assessId;

  const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_ASSESSMENTS}/records`, 'PATCH', [body]);
  const text = await r.text();
  return new Response(text, { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

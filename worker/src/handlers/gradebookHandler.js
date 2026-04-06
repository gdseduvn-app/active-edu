/**
 * Gradebook Handler — Assignment Groups, Weighted Gradebook, SpeedGrader
 *
 * Routes:
 *   GET    /admin/assignment-groups?course_id=
 *   POST   /admin/assignment-groups
 *   PATCH  /admin/assignment-groups/:id
 *   DELETE /admin/assignment-groups/:id
 *   GET    /admin/gradebook?course_id=
 *   GET    /admin/speedgrader/:submission_id
 *   POST   /admin/speedgrader/:submission_id/ai-draft
 */

import { verifyAdminAuth } from '../auth.js';
import { nocoFetch } from '../db.js';

// ── Helpers ────────────────────────────────────────────────────────────────

const tryJ = (s, fb = null) => { try { return JSON.parse(s); } catch { return fb; } };

function letterGrade(pct) {
  if (pct >= 90) return 'A';
  if (pct >= 80) return 'B';
  if (pct >= 70) return 'C';
  if (pct >= 60) return 'D';
  return 'F';
}

// ── Assignment Groups ──────────────────────────────────────────────────────

/**
 * GET /admin/assignment-groups?course_id=
 */
export async function handleAssignmentGroupList(request, env, { json, url }) {
  if (!await verifyAdminAuth(request, env)) return json({ error: 'Unauthorized' }, 401);

  if (!env.NOCO_ASSIGNMENT_GROUPS) {
    return json({ groups: [], note: 'NOCO_ASSIGNMENT_GROUPS not configured' });
  }

  const courseId = url.searchParams.get('course_id');
  if (!courseId) return json({ error: 'course_id required' }, 400);

  const r = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_ASSIGNMENT_GROUPS}/records?where=(CourseId,eq,${courseId})&sort=Id&limit=100`
  );
  if (!r.ok) return json({ groups: [], error: 'NocoDB error' }, r.status);

  const data = await r.json();
  return json({ groups: data.list || [] });
}

/**
 * POST /admin/assignment-groups
 * Body: { CourseId, Name, Weight, DroppingLowest }
 */
export async function handleAssignmentGroupCreate(request, env, { json }) {
  if (!await verifyAdminAuth(request, env)) return json({ error: 'Unauthorized' }, 401);

  if (!env.NOCO_ASSIGNMENT_GROUPS) {
    return json({ error: 'NOCO_ASSIGNMENT_GROUPS not configured' }, 503);
  }

  const body = await request.json().catch(() => ({}));
  const { CourseId, Name, Weight, DroppingLowest = 0 } = body;

  if (!CourseId || !Name) return json({ error: 'CourseId and Name are required' }, 400);

  const weight = Math.min(100, Math.max(0, parseFloat(Weight) || 0));

  const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_ASSIGNMENT_GROUPS}/records`, 'POST', {
    CourseId: parseInt(CourseId),
    Name: String(Name),
    Weight: weight,
    DroppingLowest: parseInt(DroppingLowest) || 0,
    Position: 0,
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    return json({ error: 'Failed to create assignment group', detail: txt.slice(0, 300) }, r.status);
  }

  const created = await r.json();
  return json({ ok: true, group: created });
}

/**
 * PATCH /admin/assignment-groups/:id
 */
export async function handleAssignmentGroupUpdate(request, env, { json, path }) {
  if (!await verifyAdminAuth(request, env)) return json({ error: 'Unauthorized' }, 401);

  if (!env.NOCO_ASSIGNMENT_GROUPS) {
    return json({ error: 'NOCO_ASSIGNMENT_GROUPS not configured' }, 503);
  }

  const id = path.match(/\/admin\/assignment-groups\/(\d+)/)?.[1];
  if (!id) return json({ error: 'Invalid id' }, 400);

  const body = await request.json().catch(() => ({}));

  // Clamp weight if provided
  if (body.Weight !== undefined) {
    body.Weight = Math.min(100, Math.max(0, parseFloat(body.Weight) || 0));
  }

  const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_ASSIGNMENT_GROUPS}/records`, 'PATCH', [{
    Id: parseInt(id),
    ...body,
  }]);

  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    return json({ error: 'Failed to update assignment group', detail: txt.slice(0, 300) }, r.status);
  }

  return json({ ok: true });
}

/**
 * DELETE /admin/assignment-groups/:id
 */
export async function handleAssignmentGroupDelete(request, env, { json, path }) {
  if (!await verifyAdminAuth(request, env)) return json({ error: 'Unauthorized' }, 401);

  if (!env.NOCO_ASSIGNMENT_GROUPS) {
    return json({ error: 'NOCO_ASSIGNMENT_GROUPS not configured' }, 503);
  }

  const id = path.match(/\/admin\/assignment-groups\/(\d+)/)?.[1];
  if (!id) return json({ error: 'Invalid id' }, 400);

  const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_ASSIGNMENT_GROUPS}/records`, 'DELETE', {
    Id: parseInt(id),
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    return json({ error: 'Failed to delete assignment group', detail: txt.slice(0, 300) }, r.status);
  }

  return json({ ok: true });
}

// ── Weighted Gradebook ─────────────────────────────────────────────────────

/**
 * GET /admin/gradebook?course_id=
 * Returns weighted gradebook for all enrolled students in a course.
 */
export async function handleWeightedGradebook(request, env, { json, url }) {
  if (!await verifyAdminAuth(request, env)) return json({ error: 'Unauthorized' }, 401);

  const courseId = url.searchParams.get('course_id');
  if (!courseId) return json({ error: 'course_id required' }, 400);

  // Fetch enrollments
  let enrollments = [];
  if (env.NOCO_ENROLLMENTS) {
    const er = await nocoFetch(env,
      `/api/v2/tables/${env.NOCO_ENROLLMENTS}/records?where=(CourseId,eq,${courseId})&limit=500&fields=Id,UserId,UserName,UserEmail,Status`
    );
    if (er.ok) enrollments = (await er.json()).list || [];
  }

  // Fetch assessments for course
  let assessments = [];
  if (env.NOCO_ASSESSMENTS) {
    const ar = await nocoFetch(env,
      `/api/v2/tables/${env.NOCO_ASSESSMENTS}/records?where=(CourseId,eq,${courseId})&limit=200&fields=Id,Title,AssignmentGroupId,MaxScore`
    );
    if (ar.ok) assessments = (await ar.json()).list || [];
  }

  // Fetch assignment groups
  let groups = [];
  if (env.NOCO_ASSIGNMENT_GROUPS) {
    const gr = await nocoFetch(env,
      `/api/v2/tables/${env.NOCO_ASSIGNMENT_GROUPS}/records?where=(CourseId,eq,${courseId})&limit=100&sort=Position`
    );
    if (gr.ok) groups = (await gr.json()).list || [];
  }

  // Fetch submissions for course
  let submissions = [];
  if (env.NOCO_SUBMISSIONS) {
    const sr = await nocoFetch(env,
      `/api/v2/tables/${env.NOCO_SUBMISSIONS}/records?where=(CourseId,eq,${courseId})~and(Status,neq,in_progress)&limit=2000&fields=Id,UserId,AssessmentId,ScorePercent,Status`
    );
    if (sr.ok) submissions = (await sr.json()).list || [];
  }

  // Build lookup: assessmentId -> group
  const assessmentToGroup = {};
  for (const a of assessments) {
    if (a.AssignmentGroupId) assessmentToGroup[String(a.Id)] = String(a.AssignmentGroupId);
  }

  // Group submissions by userId -> groupId -> scores[]
  const submissionsByUser = {};
  for (const sub of submissions) {
    const uid = String(sub.UserId);
    if (!submissionsByUser[uid]) submissionsByUser[uid] = {};
    const gid = assessmentToGroup[String(sub.AssessmentId)];
    if (!gid) continue;
    if (!submissionsByUser[uid][gid]) submissionsByUser[uid][gid] = [];
    submissionsByUser[uid][gid].push(sub.ScorePercent ?? 0);
  }

  // Compute weighted grade per student
  const students = enrollments.map(enr => {
    const uid = String(enr.UserId);
    const userSubs = submissionsByUser[uid] || {};
    const groupBreakdown = {};
    let weighted_total = 0;
    let totalWeight = 0;

    for (const group of groups) {
      const gid = String(group.Id);
      let scores = [...(userSubs[gid] || [])];

      // Drop lowest N scores
      const drop = parseInt(group.DroppingLowest) || 0;
      if (drop > 0 && scores.length > drop) {
        scores.sort((a, b) => a - b);
        scores = scores.slice(drop);
      }

      const avg = scores.length > 0
        ? scores.reduce((s, v) => s + v, 0) / scores.length
        : 0;

      const weight = parseFloat(group.Weight) || 0;
      weighted_total += avg * (weight / 100);
      totalWeight += weight;

      groupBreakdown[gid] = { avg: Math.round(avg * 10) / 10, scores };
    }

    // Normalize if weights don't sum to 100
    let finalScore = totalWeight > 0 && totalWeight !== 100
      ? Math.round((weighted_total / totalWeight) * 100 * 10) / 10
      : Math.round(weighted_total * 10) / 10;

    return {
      userId: enr.UserId,
      name: enr.UserName || '',
      email: enr.UserEmail || '',
      groups: groupBreakdown,
      weighted_total: finalScore,
      letter_grade: letterGrade(finalScore),
    };
  });

  return json({ students, assessments, groups });
}

// ── SpeedGrader ────────────────────────────────────────────────────────────

/**
 * GET /admin/speedgrader/:submission_id
 * Returns submission + answers + questions for manual grading interface.
 */
export async function handleSpeedGrader(request, env, { json, path }) {
  if (!await verifyAdminAuth(request, env)) return json({ error: 'Unauthorized' }, 401);

  const subId = path.match(/\/admin\/speedgrader\/(\d+)/)?.[1];
  if (!subId) return json({ error: 'Invalid submission_id' }, 400);

  if (!env.NOCO_SUBMISSIONS) return json({ error: 'NOCO_SUBMISSIONS not configured' }, 503);

  // Fetch submission
  const sr = await nocoFetch(env, `/api/v2/tables/${env.NOCO_SUBMISSIONS}/records/${subId}`);
  if (!sr.ok) return json({ error: 'Submission not found' }, 404);
  const submission = await sr.json();

  // Fetch sub_answers
  let answers = [];
  if (env.NOCO_SUB_ANSWERS) {
    const ansr = await nocoFetch(env,
      `/api/v2/tables/${env.NOCO_SUB_ANSWERS}/records?where=(SubmissionId,eq,${subId})&limit=200`
    );
    if (ansr.ok) answers = (await ansr.json()).list || [];
  }

  // Fetch questions for the assessment
  let questions = [];
  if (env.NOCO_ASSESS_QUESTIONS && submission.AssessmentId) {
    const qr = await nocoFetch(env,
      `/api/v2/tables/${env.NOCO_ASSESS_QUESTIONS}/records?where=(AssessmentId,eq,${submission.AssessmentId})&sort=Id&limit=200`
    );
    if (qr.ok) questions = (await qr.json()).list || [];
  }

  // Merge answers into questions
  const questionsWithAnswers = questions.map(q => {
    const ans = answers.find(a => String(a.QuestionId) === String(q.Id));
    return {
      ...q,
      studentAnswer: ans ? tryJ(ans.AnswerData, ans.AnswerData) : null,
      scoreEarned: ans?.ScoreEarned ?? null,
      isCorrect: ans?.IsCorrect ?? null,
      answerId: ans?.Id ?? null,
    };
  });

  return json({
    submission,
    questions: questionsWithAnswers,
    answers,
  });
}

/**
 * POST /admin/speedgrader/:submission_id/ai-draft
 * Calls Claude Haiku to generate scoring drafts for open/essay questions.
 */
export async function handleSpeedGraderAI(request, env, { json, path }) {
  if (!await verifyAdminAuth(request, env)) return json({ error: 'Unauthorized' }, 401);

  const subId = path.match(/\/admin\/speedgrader\/(\d+)\/ai-draft/)?.[1];
  if (!subId) return json({ error: 'Invalid submission_id' }, 400);

  if (!env.NOCO_SUBMISSIONS) return json({ error: 'NOCO_SUBMISSIONS not configured' }, 503);
  if (!env.AI_GATEWAY_KEY) return json({ error: 'AI_GATEWAY_KEY not configured' }, 503);

  // Fetch submission
  const sr = await nocoFetch(env, `/api/v2/tables/${env.NOCO_SUBMISSIONS}/records/${subId}`);
  if (!sr.ok) return json({ error: 'Submission not found' }, 404);
  const submission = await sr.json();

  // Fetch sub_answers
  let answers = [];
  if (env.NOCO_SUB_ANSWERS) {
    const ansr = await nocoFetch(env,
      `/api/v2/tables/${env.NOCO_SUB_ANSWERS}/records?where=(SubmissionId,eq,${subId})&limit=200`
    );
    if (ansr.ok) answers = (await ansr.json()).list || [];
  }

  // Fetch questions
  let questions = [];
  if (env.NOCO_ASSESS_QUESTIONS && submission.AssessmentId) {
    const qr = await nocoFetch(env,
      `/api/v2/tables/${env.NOCO_ASSESS_QUESTIONS}/records?where=(AssessmentId,eq,${submission.AssessmentId})&sort=Id&limit=200`
    );
    if (qr.ok) questions = (await qr.json()).list || [];
  }

  // Build grading payload — only include open/essay questions
  const gradableTypes = ['essay', 'open', 'short_answer', 'long_answer'];
  const gradableQs = questions
    .filter(q => gradableTypes.includes((q.QuestionType || '').toLowerCase()))
    .map(q => {
      const ans = answers.find(a => String(a.QuestionId) === String(q.Id));
      return {
        question_id: q.Id,
        type: q.QuestionType,
        points: q.Points || 1,
        question_text: tryJ(q.Content, { text: q.Content })?.text || q.Content,
        rubric: q.Rubric || null,
        student_answer: ans ? tryJ(ans.AnswerData, ans.AnswerData) : null,
      };
    });

  if (gradableQs.length === 0) {
    return json({
      ai_drafts: [],
      overall_feedback: 'Không có câu hỏi tự luận để chấm.',
      total_suggested: 0,
      note: 'No essay/open questions found in this submission.',
    });
  }

  // Call Claude Haiku
  const provider = (env.AI_PROVIDER || 'anthropic').toLowerCase();
  let aiResult = null;

  try {
    if (provider === 'anthropic') {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': env.AI_GATEWAY_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          max_tokens: 2048,
          system: 'You are an educational grading assistant. Given student answers and question rubrics, provide: 1) A suggested score (0-100) for each essay/open question, 2) Specific feedback in Vietnamese, 3) Overall feedback. Be fair and educational. Respond in JSON format only.',
          messages: [{
            role: 'user',
            content: `Please grade the following student answers and return JSON with this structure:
{
  "drafts": [{"question_id": ..., "suggested_score": 0-100, "feedback": "..."}],
  "overall_feedback": "..."
}

Questions and student answers:
${JSON.stringify(gradableQs, null, 2)}`,
          }],
        }),
      });

      if (!resp.ok) {
        const errTxt = await resp.text().catch(() => '');
        return json({ error: 'AI API error', detail: errTxt.slice(0, 300) }, resp.status);
      }

      const aiResp = await resp.json();
      const content = aiResp.content?.[0]?.text || '';
      aiResult = tryJ(content);
      if (!aiResult) {
        // Try extracting JSON from text
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) aiResult = tryJ(jsonMatch[0]);
      }
    } else {
      // OpenAI
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.AI_GATEWAY_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: 'You are an educational grading assistant. Given student answers and question rubrics, provide: 1) A suggested score (0-100) for each essay/open question, 2) Specific feedback in Vietnamese, 3) Overall feedback. Be fair and educational. Respond in JSON format only.',
            },
            {
              role: 'user',
              content: `Please grade the following student answers and return JSON with this structure:
{"drafts": [{"question_id": ..., "suggested_score": 0-100, "feedback": "..."}], "overall_feedback": "..."}

${JSON.stringify(gradableQs, null, 2)}`,
            },
          ],
        }),
      });

      if (!resp.ok) {
        const errTxt = await resp.text().catch(() => '');
        return json({ error: 'AI API error', detail: errTxt.slice(0, 300) }, resp.status);
      }

      const aiResp = await resp.json();
      aiResult = tryJ(aiResp.choices?.[0]?.message?.content || '');
    }
  } catch (e) {
    return json({ error: 'AI call failed', detail: e.message }, 500);
  }

  if (!aiResult) {
    return json({ error: 'Failed to parse AI response' }, 500);
  }

  const drafts = (aiResult.drafts || []).map(d => ({
    question_id: d.question_id,
    suggested_score: Math.min(100, Math.max(0, parseFloat(d.suggested_score) || 0)),
    feedback: d.feedback || '',
  }));

  const totalSuggested = drafts.reduce((sum, d) => {
    const q = gradableQs.find(q => String(q.question_id) === String(d.question_id));
    if (!q) return sum;
    return sum + (d.suggested_score / 100) * (q.points || 1);
  }, 0);

  return json({
    ai_drafts: drafts,
    overall_feedback: aiResult.overall_feedback || '',
    total_suggested: Math.round(totalSuggested * 10) / 10,
  });
}

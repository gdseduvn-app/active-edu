/**
 * Data Tools — NocoDB query implementations for AI Agent tool calls
 *
 * All functions query NocoDB REST API v2 via nocoFetch().
 * In Phase 2, hot-path tables (Student_Mastery, action_logs) will
 * be migrated to Cloudflare D1 — this file will be updated to query D1.
 */

import { nocoFetch } from '../db.js';

export async function executeDataTools(toolName, input, env, _ctx) {
  switch (toolName) {
    case 'data_get_student_profile':      return getStudentProfile(input, env);
    case 'data_get_student_mastery':      return getStudentMastery(input, env);
    case 'data_list_course_students':     return listCourseStudents(input, env);
    case 'data_get_outcome_tree':         return getOutcomeTree(input, env);
    case 'data_get_item_response_history':return getItemResponseHistory(input, env);
    default: return { error: `Unknown data tool: ${toolName}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function getStudentProfile(input, env) {
  const { student_id } = input;
  if (!student_id) return { error: 'student_id is required.' };

  // Fetch user record
  const r = await nocoFetch(
    env,
    `/api/v2/tables/${env.NOCO_USERS}/records/${student_id}` +
    `?fields=Id,Name,Email,Role,Status,AIAccess`
  );
  if (!r.ok) return { error: `User not found (status ${r.status}).` };
  const user = await r.json();

  // Fetch enrollment count
  let enrollmentCount = 0;
  let enrolledCourseIds = [];
  if (env.NOCO_ENROLLMENTS) {
    const er = await nocoFetch(
      env,
      `/api/v2/tables/${env.NOCO_ENROLLMENTS}/records` +
      `?where=(UserId,eq,${student_id})~and(WorkflowState,eq,active)` +
      `&fields=Id,CourseId&limit=100`
    );
    if (er.ok) {
      const ed = await er.json();
      const enrollments = ed.list || [];
      enrollmentCount = enrollments.length;
      enrolledCourseIds = enrollments.map(e => e.CourseId).filter(Boolean);
    }
  }

  return {
    id:          user.Id,
    name:        user.Name,
    email:       user.Email,
    role:        user.Role || 'student',
    status:      user.Status || 'active',
    ai_access:   !!user.AIAccess,
    enrollments: enrollmentCount,
    enrolled_course_ids: enrolledCourseIds,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

async function getStudentMastery(input, env) {
  const { student_id, subject, grade } = input;
  if (!student_id) return { error: 'student_id is required.' };

  // Phase 1: query NocoDB Student_Mastery table (if it exists)
  // Phase 2: this will query Cloudflare D1 for better performance
  if (!env.NOCO_STUDENT_MASTERY) {
    return {
      student_id,
      mastery_records: [],
      note: 'Student_Mastery table not yet configured (Phase 1 pending). Run /admin/setup/schema-phase1.',
    };
  }

  let where = `(StudentId,eq,${student_id})`;
  if (subject) where += `~and(Subject,eq,${subject})`;
  if (grade)   where += `~and(Grade,eq,${grade})`;

  const r = await nocoFetch(
    env,
    `/api/v2/tables/${env.NOCO_STUDENT_MASTERY}/records` +
    `?where=${encodeURIComponent(where)}` +
    `&fields=Id,StudentId,OutcomeId,OutcomeCode,Score,Attempts,UpdatedAt` +
    `&limit=500`
  );
  if (!r.ok) return { error: `Mastery fetch failed (status ${r.status}).` };
  const data = await r.json();
  const records = (data.list || []).map(m => ({
    outcome_id:   m.OutcomeId,
    outcome_code: m.OutcomeCode,
    score:        m.Score ?? 0,
    attempts:     m.Attempts ?? 0,
    updated_at:   m.UpdatedAt,
  }));

  return {
    student_id,
    subject_filter: subject || null,
    grade_filter:   grade || null,
    mastery_records: records,
    summary: {
      total:    records.length,
      mastered: records.filter(r => r.score >= 0.8).length,
      partial:  records.filter(r => r.score >= 0.4 && r.score < 0.8).length,
      gaps:     records.filter(r => r.score < 0.4).length,
      avg_score: records.length
        ? parseFloat((records.reduce((s, r) => s + r.score, 0) / records.length).toFixed(3))
        : 0,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────

async function listCourseStudents(input, env) {
  const { course_id, limit = 50 } = input;
  if (!course_id) return { error: 'course_id is required.' };
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));

  // Get enrollments for the course
  if (!env.NOCO_ENROLLMENTS)
    return { error: 'NOCO_ENROLLMENTS table not configured.' };

  const er = await nocoFetch(
    env,
    `/api/v2/tables/${env.NOCO_ENROLLMENTS}/records` +
    `?where=(CourseId,eq,${course_id})~and(WorkflowState,eq,active)` +
    `&fields=Id,UserId,UserName,UserEmail,EnrolledAt` +
    `&limit=${safeLimit}`
  );
  if (!er.ok) return { error: `Enrollment fetch failed (${er.status}).` };
  const enData = await er.json();
  const enrollments = enData.list || [];

  // Fetch latest submissions per student for this course
  let submissionMap = new Map();
  if (env.NOCO_SUBMISSIONS && enrollments.length > 0) {
    const sr = await nocoFetch(
      env,
      `/api/v2/tables/${env.NOCO_SUBMISSIONS}/records` +
      `?where=(CourseId,eq,${course_id})` +
      `&sort=-CreatedAt&limit=500` +
      `&fields=StudentId,Score,Status`
    );
    if (sr.ok) {
      const sd = await sr.json();
      for (const sub of (sd.list || [])) {
        if (!submissionMap.has(sub.StudentId)) {
          submissionMap.set(sub.StudentId, { latest_score: sub.Score, status: sub.Status });
        }
      }
    }
  }

  const students = enrollments.map(e => {
    const sub = submissionMap.get(e.UserId) || {};
    return {
      student_id:   e.UserId,
      name:         e.UserName,
      email:        e.UserEmail,
      enrolled_at:  e.EnrolledAt,
      latest_score: sub.latest_score ?? null,
      submission_status: sub.status ?? 'no_submissions',
    };
  });

  return {
    course_id,
    student_count: students.length,
    students,
    stats: {
      submitted:    students.filter(s => s.submission_status !== 'no_submissions').length,
      no_activity:  students.filter(s => s.submission_status === 'no_submissions').length,
      avg_score:    (() => {
        const scored = students.filter(s => s.latest_score !== null);
        return scored.length
          ? parseFloat((scored.reduce((s, v) => s + v.latest_score, 0) / scored.length).toFixed(2))
          : null;
      })(),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────

async function getOutcomeTree(input, env) {
  const { subject, grade, max_depth = 3 } = input;

  if (!env.NOCO_OUTCOMES) {
    return {
      outcomes: [],
      note: 'NOCO_OUTCOMES table not yet configured. Run POST /admin/setup/schema-phase1.',
    };
  }

  let where = '';
  if (subject) where += `(Subject,eq,${subject})`;
  if (grade)   where += (where ? '~and' : '') + `(Grade,eq,${grade})`;

  const url =
    `/api/v2/tables/${env.NOCO_OUTCOMES}/records` +
    (where ? `?where=${encodeURIComponent(where)}&` : '?') +
    `fields=Id,Code,Subject,Grade,Level,TitleVi,Description,ParentId,EstimatedHours` +
    `&limit=1000`;

  const r = await nocoFetch(env, url);
  if (!r.ok) return { error: `Outcomes fetch failed (${r.status}).` };
  const data = await r.json();
  const flat = (data.list || []).map(o => ({
    id:              o.Id,
    code:            o.Code,
    subject:         o.Subject,
    grade:           o.Grade,
    level:           o.Level ?? 1,
    title_vi:        o.TitleVi,
    description:     o.Description,
    parent_id:       o.ParentId ?? null,
    estimated_hours: o.EstimatedHours ?? 1,
  }));

  // Build tree from flat list up to max_depth
  const depth = Math.min(4, Math.max(1, Number(max_depth) || 3));
  const tree = buildTree(flat, null, 1, depth);

  return {
    subject_filter: subject || null,
    grade_filter:   grade || null,
    total_outcomes: flat.length,
    tree,
  };
}

function buildTree(nodes, parentId, currentDepth, maxDepth) {
  if (currentDepth > maxDepth) return [];
  return nodes
    .filter(n => n.parent_id === parentId)
    .map(n => ({
      ...n,
      children: buildTree(nodes, n.id, currentDepth + 1, maxDepth),
    }));
}

// ─────────────────────────────────────────────────────────────────────────────

async function getItemResponseHistory(input, env) {
  const { student_id, course_id, limit = 100 } = input;
  if (!student_id) return { error: 'student_id is required.' };
  const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));

  if (!env.NOCO_SUBMISSIONS)
    return { error: 'NOCO_SUBMISSIONS table not configured.' };

  let where = `(StudentId,eq,${student_id})`;
  if (course_id) where += `~and(CourseId,eq,${course_id})`;

  const r = await nocoFetch(
    env,
    `/api/v2/tables/${env.NOCO_SUBMISSIONS}/records` +
    `?where=${encodeURIComponent(where)}` +
    `&sort=CreatedAt` +
    `&fields=Id,ItemId,ItemTitle,Score,MaxScore,Correct,CreatedAt,TimeSpentSeconds` +
    `&limit=${safeLimit}`
  );
  if (!r.ok) return { error: `Submissions fetch failed (${r.status}).` };
  const data = await r.json();
  const records = (data.list || []).map(s => ({
    item_id:           s.ItemId,
    item_title:        s.ItemTitle,
    correct:           s.Correct === true || s.Score >= s.MaxScore ? 1 : 0,
    score:             s.Score ?? 0,
    max_score:         s.MaxScore ?? 1,
    normalized_score:  s.MaxScore ? parseFloat((s.Score / s.MaxScore).toFixed(3)) : null,
    timestamp:         s.CreatedAt,
    time_spent_seconds: s.TimeSpentSeconds ?? null,
  }));

  // Compute raw sequence for BKT input
  const observations = records.map(r => r.correct);

  return {
    student_id,
    course_id: course_id || null,
    n_responses: records.length,
    observations,   // Ready for algo_bayesian_knowledge_tracing
    records,
    stats: {
      correct_rate: records.length
        ? parseFloat((records.filter(r => r.correct === 1).length / records.length).toFixed(3))
        : null,
      avg_time_seconds: (() => {
        const timed = records.filter(r => r.time_spent_seconds !== null);
        return timed.length
          ? Math.round(timed.reduce((s, r) => s + r.time_spent_seconds, 0) / timed.length)
          : null;
      })(),
    },
  };
}

/**
 * Analysis Tools — Higher-level tools that combine data queries + algorithms
 *
 * These tools orchestrate multiple data fetches and run algorithmic analysis
 * to produce actionable insights for the AI Agent.
 */

import { nocoFetch } from '../db.js';
import { executeAlgorithmTools } from './algorithmTools.js';

export async function executeAnalysisTools(toolName, input, env, ctx) {
  switch (toolName) {
    case 'analysis_student_risk_score':    return computeStudentRiskScore(input, env, ctx);
    case 'analysis_class_mastery_heatmap': return computeClassMasteryHeatmap(input, env, ctx);
    case 'analysis_adaptive_next_items':   return computeAdaptiveNextItems(input, env, ctx);
    default: return { error: `Unknown analysis tool: ${toolName}` };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. STUDENT RISK SCORE
//    Multi-signal risk model: engagement + performance + pacing + peer comparison
// ═══════════════════════════════════════════════════════════════════════════

async function computeStudentRiskScore(input, env, _ctx) {
  const { student_id, course_id, lookback_days = 14 } = input;
  if (!student_id || !course_id)
    return { error: 'student_id and course_id are required.' };

  const signals = {};

  // ── Signal 1: Submission activity in lookback window ──────────────────
  let recentSubmissions = 0, avgScore = null, totalSubmissions = 0;
  if (env.NOCO_SUBMISSIONS) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - lookback_days);
    const r = await nocoFetch(
      env,
      `/api/v2/tables/${env.NOCO_SUBMISSIONS}/records` +
      `?where=(StudentId,eq,${student_id})~and(CourseId,eq,${course_id})` +
      `&fields=Score,MaxScore,CreatedAt&limit=200&sort=-CreatedAt`
    );
    if (r.ok) {
      const d = await r.json();
      const subs = d.list || [];
      totalSubmissions = subs.length;
      recentSubmissions = subs.filter(s =>
        s.CreatedAt && new Date(s.CreatedAt) >= cutoff
      ).length;
      const scored = subs.filter(s => s.MaxScore > 0);
      if (scored.length > 0) {
        avgScore = scored.reduce((sum, s) => sum + s.Score / s.MaxScore, 0) / scored.length;
      }
    }
  }
  signals.engagement = recentSubmissions;
  signals.avg_score  = avgScore;

  // ── Signal 2: Course mastery (if Student_Mastery exists) ──────────────
  let masteryScore = null;
  if (env.NOCO_STUDENT_MASTERY) {
    const mr = await nocoFetch(
      env,
      `/api/v2/tables/${env.NOCO_STUDENT_MASTERY}/records` +
      `?where=(StudentId,eq,${student_id})&fields=Score&limit=100`
    );
    if (mr.ok) {
      const md = await mr.json();
      const records = md.list || [];
      if (records.length > 0) {
        masteryScore = records.reduce((s, r) => s + (r.Score || 0), 0) / records.length;
      }
    }
  }
  signals.mastery = masteryScore;

  // ── Compute risk score (0-100) ─────────────────────────────────────────
  let riskScore = 50; // Start at neutral

  // No activity: +30 risk
  if (recentSubmissions === 0 && totalSubmissions === 0) riskScore += 35;
  else if (recentSubmissions === 0) riskScore += 20; // Had activity before, gone quiet

  // Low performance: +20 risk if avg < 0.5
  if (avgScore !== null) {
    if (avgScore < 0.4)      riskScore += 25;
    else if (avgScore < 0.6) riskScore += 15;
    else if (avgScore < 0.75) riskScore += 5;
    else riskScore -= 10; // Good performance lowers risk
  }

  // Low mastery: +15 risk
  if (masteryScore !== null) {
    if (masteryScore < 0.4)      riskScore += 15;
    else if (masteryScore < 0.6) riskScore += 8;
    else riskScore -= 5;
  }

  riskScore = Math.max(0, Math.min(100, Math.round(riskScore)));

  const riskLevel =
    riskScore >= 75 ? 'critical' :
    riskScore >= 50 ? 'high'     :
    riskScore >= 30 ? 'medium'   :
    'low';

  // Interventions
  const interventions = [];
  if (recentSubmissions === 0)
    interventions.push({ type: 're_engagement', message: `Không có hoạt động trong ${lookback_days} ngày qua. Liên hệ học sinh.` });
  if (avgScore !== null && avgScore < 0.5)
    interventions.push({ type: 'remediation', message: `Điểm trung bình thấp (${(avgScore * 100).toFixed(0)}%). Cần bổ trợ kiến thức.` });
  if (masteryScore !== null && masteryScore < 0.4)
    interventions.push({ type: 'teacher_alert', message: `Mức độ thành thạo chuẩn đầu ra thấp. Cần xem xét kế hoạch học tập.` });

  return {
    tool: 'analysis_student_risk_score',
    student_id,
    course_id,
    lookback_days,
    risk_score:  riskScore,
    risk_level:  riskLevel,
    signals: {
      recent_submissions:  recentSubmissions,
      total_submissions:   totalSubmissions,
      avg_score:           avgScore !== null ? parseFloat(avgScore.toFixed(3)) : null,
      mastery_score:       masteryScore !== null ? parseFloat(masteryScore.toFixed(3)) : null,
    },
    interventions,
    interpretation:
      `Risk score: ${riskScore}/100 (${riskLevel}). ` +
      (interventions.length > 0
        ? `${interventions.length} intervention(s) recommended.`
        : 'No immediate interventions needed.'),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. CLASS MASTERY HEATMAP
//    Matrix: student × outcome → score
//    Identifies struggling concepts and advanced students
// ═══════════════════════════════════════════════════════════════════════════

async function computeClassMasteryHeatmap(input, env, _ctx) {
  const { course_id, subject } = input;
  if (!course_id) return { error: 'course_id is required.' };

  // Fetch enrolled students
  let students = [];
  if (env.NOCO_ENROLLMENTS) {
    const er = await nocoFetch(
      env,
      `/api/v2/tables/${env.NOCO_ENROLLMENTS}/records` +
      `?where=(CourseId,eq,${course_id})~and(WorkflowState,eq,active)` +
      `&fields=UserId,UserName&limit=200`
    );
    if (er.ok) {
      const ed = await er.json();
      students = (ed.list || []).map(e => ({ id: e.UserId, name: e.UserName }));
    }
  }

  if (students.length === 0)
    return { course_id, heatmap: {}, message: 'No enrolled students found.' };

  // Fetch outcomes for the subject
  let outcomes = [];
  if (env.NOCO_OUTCOMES) {
    let where = '';
    if (subject) where = `?where=${encodeURIComponent(`(Subject,eq,${subject})`)}&`;
    else where = '?';
    const or = await nocoFetch(
      env,
      `/api/v2/tables/${env.NOCO_OUTCOMES}/records` +
      `${where}fields=Id,Code,TitleVi,Level&limit=100`
    );
    if (or.ok) {
      const od = await or.json();
      outcomes = (od.list || []).map(o => ({
        id: o.Id, code: o.Code, title: o.TitleVi, level: o.Level
      }));
    }
  }

  // Fetch all mastery records for all students in this class
  const heatmap = {};
  const outcomeTotals = {};  // For column averages

  if (env.NOCO_STUDENT_MASTERY && students.length > 0 && outcomes.length > 0) {
    const studentIds = students.map(s => s.id).join(',');
    const mr = await nocoFetch(
      env,
      `/api/v2/tables/${env.NOCO_STUDENT_MASTERY}/records` +
      `?where=(StudentId,in,${encodeURIComponent(studentIds)})` +
      `&fields=StudentId,OutcomeCode,Score&limit=5000`
    );
    if (mr.ok) {
      const md = await mr.json();
      for (const rec of (md.list || [])) {
        if (!heatmap[rec.StudentId]) heatmap[rec.StudentId] = {};
        heatmap[rec.StudentId][rec.OutcomeCode] = parseFloat((rec.Score || 0).toFixed(3));
        if (!outcomeTotals[rec.OutcomeCode])
          outcomeTotals[rec.OutcomeCode] = { sum: 0, count: 0 };
        outcomeTotals[rec.OutcomeCode].sum   += rec.Score || 0;
        outcomeTotals[rec.OutcomeCode].count += 1;
      }
    }
  }

  // Outcome averages (class-wide) — identify struggling concepts
  const outcomeAverages = Object.entries(outcomeTotals).map(([code, { sum, count }]) => ({
    outcome_code: code,
    class_avg:    parseFloat((sum / count).toFixed(3)),
    n_students:   count,
  })).sort((a, b) => a.class_avg - b.class_avg);

  const struggling_concepts = outcomeAverages
    .filter(o => o.class_avg < 0.5)
    .slice(0, 10);

  // Student row averages
  const studentAverages = students.map(s => {
    const scores = Object.values(heatmap[s.id] || {});
    const avg = scores.length
      ? scores.reduce((a, v) => a + v, 0) / scores.length
      : null;
    return { student_id: s.id, name: s.name, avg_mastery: avg !== null ? parseFloat(avg.toFixed(3)) : null };
  }).sort((a, b) => (a.avg_mastery ?? 0) - (b.avg_mastery ?? 0));

  const advanced_students   = studentAverages.filter(s => (s.avg_mastery ?? 0) >= 0.85);
  const at_risk_students    = studentAverages.filter(s => (s.avg_mastery ?? 0) < 0.4 && s.avg_mastery !== null);

  const allScores = studentAverages.filter(s => s.avg_mastery !== null).map(s => s.avg_mastery);
  const class_avg_mastery = allScores.length
    ? parseFloat((allScores.reduce((a, v) => a + v, 0) / allScores.length).toFixed(3))
    : null;

  return {
    tool: 'analysis_class_mastery_heatmap',
    course_id,
    subject_filter:    subject || null,
    n_students:        students.length,
    n_outcomes:        outcomes.length,
    class_avg_mastery,
    heatmap,
    student_averages:  studentAverages,
    outcome_averages:  outcomeAverages,
    struggling_concepts,
    advanced_students,
    at_risk_students,
    note: env.NOCO_STUDENT_MASTERY
      ? (outcomes.length === 0 ? 'Outcomes table empty — run Phase 1 seed.' : null)
      : 'NOCO_STUDENT_MASTERY not configured. Run Phase 1 setup.',
    interpretation:
      `Class of ${students.length} students across ${outcomes.length} outcomes. ` +
      `Class avg mastery: ${class_avg_mastery !== null ? (class_avg_mastery * 100).toFixed(0) + '%' : 'N/A'}. ` +
      `${struggling_concepts.length} struggling concept(s). ` +
      `${at_risk_students.length} at-risk student(s).`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. ADAPTIVE NEXT ITEMS
//    Selects items in the Zone of Proximal Development using IRT + BKT + gap analysis
// ═══════════════════════════════════════════════════════════════════════════

async function computeAdaptiveNextItems(input, env, ctx) {
  const { student_id, course_id, strategy = 'zpd', max_items = 5 } = input;
  if (!student_id || !course_id)
    return { error: 'student_id and course_id are required.' };

  const safeMax = Math.min(20, Math.max(1, Number(max_items) || 5));

  // Fetch available items for this course
  let items = [];
  if (env.NOCO_ITEMS) {
    const ir = await nocoFetch(
      env,
      `/api/v2/tables/${env.NOCO_ITEMS}/records` +
      `?where=(CourseId,eq,${course_id})` +
      `&fields=Id,Title,Type,Difficulty,OutcomeIds,EstimatedMinutes` +
      `&limit=200`
    );
    if (ir.ok) {
      const id = await ir.json();
      items = id.list || [];
    }
  }

  if (items.length === 0)
    return { student_id, course_id, recommended_items: [], message: 'No items found for this course.' };

  // Fetch student response history
  let responses = [];
  let observations = [];
  if (env.NOCO_SUBMISSIONS) {
    const sr = await nocoFetch(
      env,
      `/api/v2/tables/${env.NOCO_SUBMISSIONS}/records` +
      `?where=(StudentId,eq,${student_id})~and(CourseId,eq,${course_id})` +
      `&fields=ItemId,Score,MaxScore,CreatedAt&sort=CreatedAt&limit=200`
    );
    if (sr.ok) {
      const sd = await sr.json();
      const subs = sd.list || [];
      responses = subs.map(s => ({
        item_id: s.ItemId,
        correct: (s.Score >= s.MaxScore) ? 1 : 0,
        b: null, a: null, c: null,
      }));
      observations = responses.map(r => r.correct);
    }
  }

  // Run BKT to get current knowledge estimate
  let bktResult = null;
  if (observations.length > 0) {
    bktResult = await executeAlgorithmTools(
      'algo_bayesian_knowledge_tracing',
      { observations },
      env, ctx
    );
  }

  // Track attempted item IDs
  const attemptedItemIds = new Set(responses.map(r => r.item_id).filter(Boolean));

  // Score items by strategy
  const scored = items.map(item => {
    const difficulty = item.Difficulty ?? 0.5; // 0=easy, 1=hard
    const currentKnowledge = bktResult?.final_knowledge_prob ?? 0.5;
    let score = 0;
    let rationale = '';

    switch (strategy) {
      case 'zpd': {
        // Zone of Proximal Development: match item difficulty to current knowledge + small stretch
        const zpd_target = Math.min(0.9, currentKnowledge + 0.15);
        const distance = Math.abs(difficulty - zpd_target);
        score = 1 - distance;
        rationale = `ZPD target difficulty ${(zpd_target * 100).toFixed(0)}%, item difficulty ${(difficulty * 100).toFixed(0)}%`;
        break;
      }
      case 'gap_fill': {
        // Prioritise items the student hasn't attempted yet
        score = attemptedItemIds.has(String(item.Id)) ? 0 : 1 - difficulty * 0.3;
        rationale = attemptedItemIds.has(String(item.Id)) ? 'Already attempted' : 'Not yet attempted';
        break;
      }
      case 'spaced_review': {
        // Prioritise items attempted but showing forgetting signs (low recent scores)
        score = attemptedItemIds.has(String(item.Id)) ? 0.8 : 0.2;
        rationale = 'Due for spaced review';
        break;
      }
      case 'challenge': {
        // Stretch items above current knowledge
        score = difficulty > currentKnowledge ? difficulty : 0;
        rationale = `Challenge item (difficulty ${(difficulty * 100).toFixed(0)}%)`;
        break;
      }
    }

    return { item, score, rationale, difficulty, currentKnowledge };
  });

  // Sort by score descending, deduplicate by type
  const recommended = scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, safeMax)
    .map(({ item, score, rationale, difficulty }) => ({
      item_id:              item.Id,
      title:                item.Title,
      type:                 item.Type,
      estimated_minutes:    item.EstimatedMinutes ?? null,
      difficulty_estimate:  parseFloat(difficulty.toFixed(2)),
      recommendation_score: parseFloat(score.toFixed(3)),
      rationale,
      already_attempted:    attemptedItemIds.has(String(item.Id)),
    }));

  return {
    tool: 'analysis_adaptive_next_items',
    student_id,
    course_id,
    strategy,
    current_knowledge_bkt: bktResult?.final_knowledge_prob ?? null,
    n_available_items:     items.length,
    n_attempted_items:     attemptedItemIds.size,
    recommended_items:     recommended,
    interpretation:
      `Strategy: ${strategy}. ` +
      `Current estimated knowledge: ${bktResult ? (bktResult.final_knowledge_prob * 100).toFixed(0) + '%' : 'N/A (no history)'}. ` +
      `Recommending ${recommended.length} item(s) from ${items.length} available.`,
  };
}

/**
 * Algorithm Tools — Pure learning-science algorithm implementations
 * No external dependencies. Runs entirely in Cloudflare Workers V8.
 *
 * Algorithms:
 *   algo_bayesian_knowledge_tracing  — BKT hidden Markov model
 *   algo_item_response_theory        — IRT 3-Parameter Logistic (3PL)
 *   algo_spaced_repetition           — SM-2 (SuperMemo) algorithm
 *   algo_knowledge_graph_path        — Prerequisite DAG + shortest path
 *   algo_knowledge_gap_analysis      — Gap analysis + remediation plan
 *   algo_learning_curve_fit          — Power Law / Exponential curve fitting
 */

export async function executeAlgorithmTools(toolName, input, _env, _ctx) {
  switch (toolName) {
    case 'algo_bayesian_knowledge_tracing': return runBKT(input);
    case 'algo_item_response_theory':       return runIRT(input);
    case 'algo_spaced_repetition':          return runSM2(input);
    case 'algo_knowledge_graph_path':       return runKnowledgeGraphPath(input);
    case 'algo_knowledge_gap_analysis':     return runKnowledgeGapAnalysis(input);
    case 'algo_learning_curve_fit':         return runLearningCurveFit(input);
    default: return { error: `Unknown algorithm tool: ${toolName}` };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. BAYESIAN KNOWLEDGE TRACING (BKT)
//    Clark & Koedinger (1994) — 4-parameter hidden Markov model
//    Hidden state: K (known) or ¬K (not known)
// ═══════════════════════════════════════════════════════════════════════════

function runBKT(input) {
  const {
    observations,
    p_l0 = 0.30,   // Prior P(K₀) — initial knowledge
    p_t  = 0.09,   // P(T)  — learning/transition rate
    p_s  = 0.10,   // P(S)  — slip rate (know but wrong)
    p_g  = 0.20,   // P(G)  — guess rate (don't know but right)
    mastery_threshold = 0.95,
  } = input;

  if (!Array.isArray(observations) || observations.length === 0)
    return { error: 'observations must be a non-empty array of 0/1 values.' };

  // Validate params
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0));
  const L0  = clamp(p_l0, 0.001, 0.999);
  const T   = clamp(p_t,  0.001, 0.999);
  const S   = clamp(p_s,  0.001, 0.499);
  const G   = clamp(p_g,  0.001, 0.499);
  const MT  = clamp(mastery_threshold, 0.5, 0.999);

  const trajectory = [];
  let pK = L0;

  for (let i = 0; i < observations.length; i++) {
    const obs = observations[i] === 1 ? 1 : 0;

    // Step 1: Update P(K | observation) using Bayes rule
    let pKgivenObs;
    if (obs === 1) {
      // P(correct | K) = 1 - S,  P(correct | ¬K) = G
      const pCorrect = pK * (1 - S) + (1 - pK) * G;
      pKgivenObs = (pK * (1 - S)) / pCorrect;
    } else {
      // P(incorrect | K) = S,  P(incorrect | ¬K) = 1 - G
      const pIncorrect = pK * S + (1 - pK) * (1 - G);
      pKgivenObs = (pK * S) / pIncorrect;
    }

    // Step 2: Apply learning transition
    const pKnext = pKgivenObs + (1 - pKgivenObs) * T;

    trajectory.push({
      trial:           i + 1,
      observation:     obs,
      p_knowledge:     parseFloat(pKnext.toFixed(4)),
      mastered:        pKnext >= MT,
    });

    pK = pKnext;
  }

  // Estimate remaining practice needed to reach mastery threshold
  let practiceNeeded = 0;
  if (pK < MT) {
    let sim = pK;
    // Simulate with assumed correct responses (optimistic path)
    while (sim < MT && practiceNeeded < 100) {
      const simCorrect = sim * (1 - S) + (1 - sim) * G;
      const simKgiven = (sim * (1 - S)) / simCorrect;
      sim = simKgiven + (1 - simKgiven) * T;
      practiceNeeded++;
    }
  }

  // Interpretation band
  const band =
    pK >= 0.95 ? 'mastered' :
    pK >= 0.75 ? 'emerging' :
    pK >= 0.50 ? 'developing' :
    'not_started';

  return {
    algorithm: 'BKT',
    parameters: { p_l0: L0, p_t: T, p_s: S, p_g: G },
    n_trials:   observations.length,
    final_knowledge_prob: parseFloat(pK.toFixed(4)),
    mastered:   pK >= MT,
    band,
    recommended_practice_count: practiceNeeded,
    trajectory,
    interpretation: `After ${observations.length} attempts, estimated knowledge P(K) = ${(pK * 100).toFixed(1)}%. ` +
      (pK >= MT
        ? 'Student has reached mastery threshold.'
        : `Approximately ${practiceNeeded} more correct-response trials needed for mastery.`),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. ITEM RESPONSE THEORY — 3PL Model
//    P(correct | θ, a, b, c) = c + (1-c) / (1 + exp(-a*(θ - b)))
//    θ = student ability (logit scale, ~N(0,1))
//    a = discrimination, b = difficulty, c = pseudo-guessing
// ═══════════════════════════════════════════════════════════════════════════

function irt3pl(theta, a = 1.0, b = 0.0, c = 0.2) {
  return c + (1 - c) / (1 + Math.exp(-a * (theta - b)));
}

function runIRT(input) {
  const { responses = [], target_items = [] } = input;

  if (responses.length === 0)
    return { error: 'responses array must not be empty.' };

  // MLE estimation of θ using grid search + Newton-Raphson refinement
  // Grid search: θ ∈ [-4, 4] with step 0.1 → find max log-likelihood
  function logLikelihood(theta) {
    let ll = 0;
    for (const r of responses) {
      const a = r.a ?? 1.0, b = r.b ?? 0.0, c = r.c ?? 0.2;
      const p = irt3pl(theta, a, b, c);
      const y = r.correct === 1 ? 1 : 0;
      ll += y * Math.log(Math.max(p, 1e-10)) + (1 - y) * Math.log(Math.max(1 - p, 1e-10));
    }
    return ll;
  }

  // Grid search
  let bestTheta = 0, bestLL = -Infinity;
  for (let t = -4; t <= 4; t += 0.1) {
    const ll = logLikelihood(t);
    if (ll > bestLL) { bestLL = ll; bestTheta = t; }
  }

  // Newton-Raphson refinement (3 iterations)
  const h = 0.001;
  for (let iter = 0; iter < 5; iter++) {
    const g  = (logLikelihood(bestTheta + h) - logLikelihood(bestTheta - h)) / (2 * h);
    const hess = (logLikelihood(bestTheta + h) - 2 * logLikelihood(bestTheta) + logLikelihood(bestTheta - h)) / (h * h);
    if (hess >= 0) break;
    bestTheta -= g / hess;
    bestTheta = Math.max(-4, Math.min(4, bestTheta));
  }

  // Item-level diagnostics
  const itemFit = responses.map((r, i) => {
    const a = r.a ?? 1.0, b = r.b ?? 0.0, c = r.c ?? 0.2;
    const predicted = irt3pl(bestTheta, a, b, c);
    const observed = r.correct === 1 ? 1 : 0;
    return {
      item_id:        r.item_id ?? `item_${i + 1}`,
      difficulty_b:   b,
      discrimination_a: a,
      predicted_prob: parseFloat(predicted.toFixed(4)),
      observed:       observed,
      residual:       parseFloat((observed - predicted).toFixed(4)),
    };
  });

  // Ability percentile (based on N(0,1) approximation)
  const theta = parseFloat(bestTheta.toFixed(3));
  const percentile = Math.round(
    (0.5 * (1 + erf(theta / Math.SQRT2))) * 100
  );

  // Predictions for target items
  const predictions = target_items.map(item => ({
    item_id:          item.item_id ?? 'unknown',
    difficulty_b:     item.b ?? 0,
    predicted_prob:   parseFloat(irt3pl(theta, item.a ?? 1.0, item.b ?? 0.0, item.c ?? 0.2).toFixed(4)),
    recommended:      irt3pl(theta, item.a ?? 1.0, item.b ?? 0.0, item.c ?? 0.2) > 0.6,
  }));

  // Band
  const abilityBand =
    theta > 1.5  ? 'advanced' :
    theta > 0.5  ? 'proficient' :
    theta > -0.5 ? 'basic' :
    theta > -1.5 ? 'below_basic' :
    'far_below_basic';

  return {
    algorithm:       'IRT-3PL',
    theta,
    ability_band:    abilityBand,
    percentile,
    n_items:         responses.length,
    log_likelihood:  parseFloat(bestLL.toFixed(4)),
    item_fit:        itemFit,
    target_predictions: predictions,
    interpretation:
      `Estimated ability θ = ${theta} (${abilityBand}, ${percentile}th percentile). ` +
      `Based on ${responses.length} responses.`,
  };
}

// Approximation of error function for percentile computation
function erf(x) {
  const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x);
  return sign * y;
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. SM-2 SPACED REPETITION (SuperMemo Algorithm 2)
//    Wozniak (1987/1994)
//    Computes next review interval and updated ease factor per item
// ═══════════════════════════════════════════════════════════════════════════

function runSM2(input) {
  const { items = [], today } = input;

  if (items.length === 0)
    return { error: 'items array must not be empty.' };

  const todayDate = today ? new Date(today) : new Date();
  if (isNaN(todayDate.getTime()))
    return { error: 'Invalid today date.' };

  const schedule = items.map(item => {
    const q   = Math.max(0, Math.min(5, Number(item.quality) || 0));
    let rep   = Math.max(0, Number(item.repetitions)   || 0);
    let ef    = Math.max(1.3, Number(item.ease_factor) || 2.5);
    let intv  = Math.max(1,   Number(item.interval_days) || 1);

    // SM-2 core logic
    if (q >= 3) {
      // Correct response
      if (rep === 0)      intv = 1;
      else if (rep === 1) intv = 6;
      else                intv = Math.round(intv * ef);
      rep += 1;
    } else {
      // Incorrect — reset
      rep  = 0;
      intv = 1;
    }

    // Update ease factor: EF' = EF + (0.1 - (5-q)*(0.08 + (5-q)*0.02))
    ef = ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
    ef = Math.max(1.3, parseFloat(ef.toFixed(3)));

    // Compute stability (Ebbinghaus): S = intv / ln(1/retention_threshold)
    const retention = 0.9;
    const stability = parseFloat((intv / Math.log(1 / retention)).toFixed(2));

    // Next review date
    const nextReview = new Date(todayDate);
    nextReview.setDate(nextReview.getDate() + intv);

    // Memory state label
    const memState =
      q === 5 ? 'perfect'   :
      q === 4 ? 'confident' :
      q === 3 ? ('hesitant') :
      q === 2 ? 'forgot_hint' :
      q === 1 ? 'forgot'    :
      'blackout';

    return {
      item_id:         item.item_id,
      quality_given:   q,
      memory_state:    memState,
      new_repetitions: rep,
      new_ease_factor: ef,
      interval_days:   intv,
      stability_S:     stability,
      next_review_date: nextReview.toISOString().slice(0, 10),
      overdue:         item.last_reviewed
        ? Math.max(0, Math.round(
            (todayDate - new Date(item.last_reviewed)) / 86400000 - (item.interval_days || 1)
          ))
        : null,
    };
  });

  // Sort by urgency: items due earliest first
  const sorted = [...schedule].sort((a, b) =>
    new Date(a.next_review_date) - new Date(b.next_review_date)
  );

  // Aggregate stats
  const overdue    = schedule.filter(s => s.overdue !== null && s.overdue > 0);
  const dueToday   = schedule.filter(s => s.next_review_date === todayDate.toISOString().slice(0, 10));
  const avgEF      = parseFloat((schedule.reduce((sum, s) => sum + s.new_ease_factor, 0) / schedule.length).toFixed(3));

  return {
    algorithm:     'SM-2',
    computed_date: todayDate.toISOString().slice(0, 10),
    n_items:       items.length,
    stats: {
      overdue_count:   overdue.length,
      due_today_count: dueToday.length,
      average_ease_factor: avgEF,
    },
    schedule: sorted,
    interpretation:
      `${overdue.length} item(s) overdue, ${dueToday.length} due today out of ${items.length} total. ` +
      `Average ease factor: ${avgEF}.`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. KNOWLEDGE GRAPH PATH — Prerequisite DAG + Shortest Path
//    Topological sort (Kahn's algo) + BFS path from current state to target
// ═══════════════════════════════════════════════════════════════════════════

function runKnowledgeGraphPath(input) {
  const {
    outcomes = [],
    student_mastery = [],
    target_outcome_code,
    mastery_threshold = 0.8,
  } = input;

  if (!target_outcome_code)
    return { error: 'target_outcome_code is required.' };

  // Build maps
  const byCode  = new Map(outcomes.map(o => [o.code, o]));
  const byId    = new Map(outcomes.map(o => [o.id, o]));

  if (!byCode.has(target_outcome_code))
    return { error: `Target outcome "${target_outcome_code}" not found in provided outcomes.` };

  // Build adjacency list (code → prerequisite codes)
  const prereqMap = new Map();
  for (const o of outcomes) {
    const prereqs = (o.prerequisites || []).map(p => {
      // Accept either code or id as prerequisite reference
      if (byCode.has(p)) return p;
      if (byId.has(p))   return byId.get(p).code;
      return null;
    }).filter(Boolean);
    prereqMap.set(o.code, prereqs);
  }

  // Mastered set
  const masteredCodes = new Set(
    student_mastery
      .filter(m => (m.score || 0) >= mastery_threshold)
      .map(m => m.outcome_code)
  );

  // BFS from target backwards to find all prerequisites not yet mastered
  const needed = [];
  const visited = new Set();

  function collectPrereqs(code) {
    if (visited.has(code)) return;
    visited.add(code);
    const prereqs = prereqMap.get(code) || [];
    for (const p of prereqs) {
      collectPrereqs(p);
    }
    if (!masteredCodes.has(code)) {
      needed.push(code);
    }
  }

  collectPrereqs(target_outcome_code);

  // Topological sort of needed items (Kahn's algorithm)
  const inDegree = new Map(needed.map(c => [c, 0]));
  const edges = new Map(needed.map(c => [c, []]));

  for (const code of needed) {
    for (const prereq of (prereqMap.get(code) || [])) {
      if (inDegree.has(prereq)) {
        edges.get(prereq).push(code);
        inDegree.set(code, (inDegree.get(code) || 0) + 1);
      }
    }
  }

  const queue = needed.filter(c => (inDegree.get(c) || 0) === 0);
  const topoPath = [];

  while (queue.length > 0) {
    const curr = queue.shift();
    topoPath.push(curr);
    for (const next of (edges.get(curr) || [])) {
      const deg = (inDegree.get(next) || 1) - 1;
      inDegree.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }

  // Estimate hours
  const estimatedHours = topoPath.reduce((sum, code) => {
    const o = byCode.get(code);
    return sum + (o?.estimated_hours || 1);
  }, 0);

  // Graph stats
  const totalEdges = [...prereqMap.values()].reduce((s, v) => s + v.length, 0);

  return {
    algorithm: 'KnowledgeGraph-BFS',
    target: target_outcome_code,
    mastery_threshold,
    total_outcomes_in_graph: outcomes.length,
    graph_stats: {
      nodes: outcomes.length,
      edges: totalEdges,
      mastered_nodes: masteredCodes.size,
      unmastered_nodes: outcomes.length - masteredCodes.size,
    },
    gaps: topoPath.filter(c => c !== target_outcome_code),
    path: topoPath,
    already_mastered: [...masteredCodes],
    estimated_hours: parseFloat(estimatedHours.toFixed(1)),
    has_cycles: topoPath.length < needed.length,
    interpretation:
      topoPath.length === 0
        ? `Student has already mastered all prerequisites for "${target_outcome_code}".`
        : `${topoPath.length} outcomes to learn before reaching "${target_outcome_code}". ` +
          `Estimated ${estimatedHours.toFixed(1)} hours of study.`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. KNOWLEDGE GAP ANALYSIS
//    Compare student mastery profile against target outcomes
//    Prioritize by impact × urgency (deadline proximity)
// ═══════════════════════════════════════════════════════════════════════════

function runKnowledgeGapAnalysis(input) {
  const {
    student_mastery  = [],
    target_outcomes  = [],
    mastery_threshold  = 0.8,
    partial_threshold  = 0.4,
  } = input;

  if (target_outcomes.length === 0)
    return { error: 'target_outcomes must not be empty.' };

  const masteryMap = new Map(
    student_mastery.map(m => [m.outcome_code, m.score || 0])
  );

  const now = Date.now();
  const gaps = [], partial = [], mastered = [];

  for (const target of target_outcomes) {
    const score = masteryMap.get(target.code) ?? 0;
    const weight = target.weight ?? 1.0;

    // Days until deadline (urgency)
    let daysLeft = null;
    let urgency  = 0;
    if (target.deadline) {
      daysLeft = Math.ceil((new Date(target.deadline).getTime() - now) / 86400000);
      urgency  = daysLeft <= 0 ? 1 : Math.min(1, 30 / daysLeft); // Higher urgency as deadline nears
    }

    const impact  = (1 - score) * weight;
    const priority = parseFloat((impact * (1 + urgency)).toFixed(3));

    const item = {
      outcome_code:  target.code,
      current_score: parseFloat(score.toFixed(3)),
      target_score:  mastery_threshold,
      gap_size:      parseFloat(Math.max(0, mastery_threshold - score).toFixed(3)),
      weight,
      days_until_deadline: daysLeft,
      urgency:       parseFloat(urgency.toFixed(3)),
      priority_score: priority,
    };

    if (score >= mastery_threshold)     mastered.push(item);
    else if (score >= partial_threshold) partial.push(item);
    else                                 gaps.push(item);
  }

  // Sort by priority descending
  const sortByPriority = arr => arr.sort((a, b) => b.priority_score - a.priority_score);
  sortByPriority(gaps);
  sortByPriority(partial);

  // Remediation plan: gaps first, then partial, ordered by priority
  const remediation_plan = [
    ...gaps.map(g => ({ ...g, action: 'full_remediation', estimated_sessions: Math.ceil(g.gap_size * 10) })),
    ...partial.map(p => ({ ...p, action: 'reinforcement', estimated_sessions: Math.ceil(p.gap_size * 5) })),
  ].slice(0, 10);

  const totalItems   = target_outcomes.length;
  const gap_score    = parseFloat(
    (gaps.length / totalItems + partial.length / (totalItems * 2)).toFixed(3)
  );

  return {
    algorithm: 'KnowledgeGapAnalysis',
    summary: {
      total_targets: totalItems,
      mastered_count: mastered.length,
      partial_count:  partial.length,
      gap_count:      gaps.length,
      gap_score,       // 0 = no gaps, 1 = all gaps
      overall_status:
        gap_score < 0.1 ? 'on_track' :
        gap_score < 0.3 ? 'minor_gaps' :
        gap_score < 0.6 ? 'significant_gaps' :
        'critical_gaps',
    },
    gaps,
    partial,
    mastered,
    remediation_plan,
    interpretation:
      `${mastered.length}/${totalItems} outcomes mastered. ` +
      `${gaps.length} full gaps, ${partial.length} partial. ` +
      `Overall gap score: ${(gap_score * 100).toFixed(0)}% — ` +
      (gap_score < 0.1 ? 'on track.' : gap_score < 0.3 ? 'minor remediation needed.' : 'significant intervention required.'),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. LEARNING CURVE FIT
//    Power Law of Practice: y = a·x^(-b) + c  (error decreases with practice)
//    Exponential:           y = c·(1 - exp(-b·x))  (performance increases)
//    Uses Gauss-Newton linearization (log-transform for power law)
// ═══════════════════════════════════════════════════════════════════════════

function runLearningCurveFit(input) {
  const {
    performance_series = [],
    model_type = 'auto',
    mastery_threshold = 0.85,
  } = input;

  if (performance_series.length < 3)
    return { error: 'Need at least 3 data points for curve fitting.' };

  const xs = performance_series.map(p => Number(p.trial));
  const ys = performance_series.map(p => Math.max(0.001, Math.min(0.999, Number(p.score))));

  function fitExponential(xs, ys) {
    // y ≈ A*(1 - exp(-k*x))  →  linearize: -ln(1-y) = k*x
    // Least squares on k, A
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    const n = xs.length;
    const transformedY = ys.map(y => -Math.log(1 - Math.min(y, 0.999)));

    for (let i = 0; i < n; i++) {
      sumX  += xs[i];
      sumY  += transformedY[i];
      sumXY += xs[i] * transformedY[i];
      sumX2 += xs[i] * xs[i];
    }
    const k  = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const b0 = (sumY - k * sumX) / n;
    const A  = Math.max(0.01, Math.min(1, ys[ys.length - 1] + 0.05)); // approx asymptote

    const predicted = xs.map(x => A * (1 - Math.exp(-Math.max(0, k) * x)));
    const r2 = computeR2(ys, predicted);

    return { A: parseFloat(A.toFixed(4)), k: parseFloat(k.toFixed(4)), r2, model: 'exponential', predicted };
  }

  function fitPowerLaw(xs, ys) {
    // y = a * x^(-b) + c  —  simplified: (y-c) = a*x^(-b)
    // Assume c ≈ asymptote = max(ys), linearize: ln(y - c) = ln(a) - b*ln(x)
    const c = Math.min(0.05, ys[0] * 0.5);  // small floor
    const adjustedY = ys.map(y => Math.max(0.001, y - c));

    let sumLnX = 0, sumLnY = 0, sumLnXlnY = 0, sumLnX2 = 0;
    const n = xs.length;

    for (let i = 0; i < n; i++) {
      const lx = Math.log(xs[i]);
      const ly = Math.log(adjustedY[i]);
      sumLnX    += lx;
      sumLnY    += ly;
      sumLnXlnY += lx * ly;
      sumLnX2   += lx * lx;
    }

    const b    = -(n * sumLnXlnY - sumLnX * sumLnY) / (n * sumLnX2 - sumLnX * sumLnX);
    const lnA  = (sumLnY + b * sumLnX) / n;
    const a    = Math.exp(lnA);

    const predicted = xs.map(x => Math.min(1, a * Math.pow(x, -Math.max(0.001, b)) + c));
    const r2 = computeR2(ys, predicted);

    return {
      a: parseFloat(a.toFixed(4)),
      b: parseFloat(b.toFixed(4)),
      c: parseFloat(c.toFixed(4)),
      r2, model: 'power_law', predicted
    };
  }

  function computeR2(actual, predicted) {
    const mean = actual.reduce((s, v) => s + v, 0) / actual.length;
    const ssTot = actual.reduce((s, v) => s + (v - mean) ** 2, 0);
    const ssRes = actual.reduce((s, v, i) => s + (v - predicted[i]) ** 2, 0);
    return parseFloat((1 - ssRes / ssTot).toFixed(4));
  }

  let selected;
  if (model_type === 'exponential') {
    selected = fitExponential(xs, ys);
  } else if (model_type === 'power_law') {
    selected = fitPowerLaw(xs, ys);
  } else {
    // Auto: pick best R²
    const exp = fitExponential(xs, ys);
    const pow = fitPowerLaw(xs, ys);
    selected = exp.r2 >= pow.r2 ? exp : pow;
  }

  // Predict mastery date
  let trialsToMastery = null;
  let predictedMasteryDate = null;
  const currentScore = ys[ys.length - 1];

  if (currentScore < mastery_threshold) {
    // Solve for x: threshold = A*(1-exp(-k*x)) → x = -ln(1 - T/A)/k
    if (selected.model === 'exponential' && selected.k > 0) {
      const ratio = mastery_threshold / (selected.A || 1);
      if (ratio < 1) {
        trialsToMastery = Math.ceil(-Math.log(1 - ratio) / selected.k);
      }
    } else if (selected.model === 'power_law' && selected.b > 0) {
      // (T - c) = a * x^(-b) → x = (a / (T-c))^(1/b)
      const diff = mastery_threshold - (selected.c || 0);
      if (diff > 0 && selected.a > 0) {
        trialsToMastery = Math.ceil(Math.pow(selected.a / diff, 1 / selected.b));
      }
    }

    // Estimate date: assume 1 session/day
    if (trialsToMastery !== null) {
      const sessions = performance_series.filter(p => p.timestamp).length;
      const daysPerSession = sessions > 1 ? 1 : 2;
      const masteryDate = new Date();
      masteryDate.setDate(masteryDate.getDate() + trialsToMastery * daysPerSession);
      predictedMasteryDate = masteryDate.toISOString().slice(0, 10);
    }
  }

  // Trajectory assessment
  const n = ys.length;
  const recentTrend =
    n >= 3 ? ys.slice(-3).reduce((s, v) => s + v, 0) / 3 - ys.slice(0, 3).reduce((s, v) => s + v, 0) / 3 : 0;
  const trajectory =
    recentTrend > 0.05  ? 'improving'   :
    recentTrend < -0.05 ? 'declining'   :
    'plateaued';

  return {
    algorithm:    selected.model === 'exponential' ? 'ExponentialLearningCurve' : 'PowerLawOfPractice',
    model:        selected.model,
    params:       selected.model === 'exponential'
      ? { A_asymptote: selected.A, k_rate: selected.k }
      : { a: selected.a, b_decay: selected.b, c_floor: selected.c },
    r_squared:    selected.r2,
    n_trials:     n,
    current_score:   parseFloat(currentScore.toFixed(3)),
    mastery_threshold,
    current_trajectory: trajectory,
    predicted_mastery_date: predictedMasteryDate,
    trials_to_mastery: trialsToMastery,
    fitted_values: xs.map((x, i) => ({
      trial: x,
      actual:    parseFloat(ys[i].toFixed(4)),
      predicted: parseFloat(selected.predicted[i].toFixed(4)),
      error:     parseFloat((ys[i] - selected.predicted[i]).toFixed(4)),
    })),
    interpretation:
      `${selected.model === 'exponential' ? 'Exponential' : 'Power Law'} fit (R²=${selected.r2}). ` +
      `Current score: ${(currentScore * 100).toFixed(0)}%. Trend: ${trajectory}. ` +
      (predictedMasteryDate
        ? `Predicted mastery by ${predictedMasteryDate} (~${trialsToMastery} more sessions).`
        : currentScore >= mastery_threshold
          ? 'Mastery threshold already reached!'
          : 'Cannot predict mastery date with current data.'),
  };
}

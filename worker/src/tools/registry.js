/**
 * Tool Registry — AURA AI Agent Framework
 *
 * Architecture:
 *   Each tool = { name, description, inputSchema, execute(input, env, ctx) }
 *
 *   To add a new tool for research:
 *     1. Define the tool object with name/description/inputSchema/execute
 *     2. Push it into the TOOLS array
 *     3. The agentic loop auto-discovers it — no other changes needed
 *
 * Tool categories:
 *   DATA_*        — Query NocoDB / Cloudflare D1
 *   ALGO_*        — Pure learning science algorithms (BKT, IRT, SM-2, KG)
 *   ANALYSIS_*    — Higher-level analytics that combine data + algorithms
 *   META_*        — Agent introspection / reasoning artifacts
 */

import { executeDataTools }      from './dataTools.js';
import { executeAlgorithmTools } from './algorithmTools.js';
import { executeAnalysisTools }  from './analysisTools.js';

// ── Tool Definitions (shown to Claude as JSON Schema) ─────────────────────────
export const TOOLS = [

  // ══════════════════════════════════════════════════════════════
  // DATA TOOLS
  // ══════════════════════════════════════════════════════════════

  {
    name: 'data_get_student_profile',
    description:
      'Retrieve a student profile from the database including: name, email, role, AI access, ' +
      'enrollment list, and total courses enrolled. Use this before any personalization task.',
    inputSchema: {
      type: 'object',
      properties: {
        student_id: { type: 'string', description: 'Numeric string ID of the student in NocoDB.' },
      },
      required: ['student_id'],
    },
  },

  {
    name: 'data_get_student_mastery',
    description:
      'Fetch all mastery scores for a student across learning outcomes (chuẩn đầu ra). ' +
      'Returns a list of { outcome_id, outcome_code, score 0-1, attempts, updated_at }.',
    inputSchema: {
      type: 'object',
      properties: {
        student_id: { type: 'string' },
        subject:    { type: 'string', description: 'Optional filter, e.g. "TOAN", "VAN", "ENG".' },
        grade:      { type: 'string', description: 'Optional filter, e.g. "L01", "L10".' },
      },
      required: ['student_id'],
    },
  },

  {
    name: 'data_list_course_students',
    description:
      'List all enrolled students in a course with their latest submission scores and progress percentage.',
    inputSchema: {
      type: 'object',
      properties: {
        course_id: { type: 'string' },
        limit:     { type: 'number', description: 'Max students to return (default 50, max 200).' },
      },
      required: ['course_id'],
    },
  },

  {
    name: 'data_get_outcome_tree',
    description:
      'Retrieve the CT GDPT 2018 (TT17/2025) outcome hierarchy. ' +
      'Returns a tree of: subject → grade_band → competency_group → specific_outcome. ' +
      'Each node has: id, code (e.g. TOAN.L01.NL1.b), title_vi, description, parent_id.',
    inputSchema: {
      type: 'object',
      properties: {
        subject:    { type: 'string', description: 'Filter by subject code, e.g. "TOAN".' },
        grade:      { type: 'string', description: 'Filter by grade, e.g. "L03".' },
        max_depth:  { type: 'number', description: 'Tree depth to return (1-4, default 3).' },
      },
      required: [],
    },
  },

  {
    name: 'data_get_item_response_history',
    description:
      'Retrieve a student\'s complete response history for all quiz/assessment items in a course. ' +
      'Returns: [{ item_id, item_title, correct, score, timestamp, time_spent_seconds }]. ' +
      'Used as input for BKT and IRT algorithms.',
    inputSchema: {
      type: 'object',
      properties: {
        student_id: { type: 'string' },
        course_id:  { type: 'string', description: 'Optional: filter by course.' },
        limit:      { type: 'number', description: 'Max records (default 100).' },
      },
      required: ['student_id'],
    },
  },

  // ══════════════════════════════════════════════════════════════
  // ALGORITHM TOOLS  (pure computation — no DB calls)
  // ══════════════════════════════════════════════════════════════

  {
    name: 'algo_bayesian_knowledge_tracing',
    description:
      'Run the Bayesian Knowledge Tracing (BKT) algorithm on a sequence of observed responses. ' +
      'Estimates the hidden "knowledge state" P(Kn) after each observation. ' +
      'Input: observation sequence (1=correct, 0=incorrect) + BKT parameters. ' +
      'Output: { final_knowledge_prob, trajectory[], mastered: boolean, recommended_practice_count }.',
    inputSchema: {
      type: 'object',
      properties: {
        observations: {
          type: 'array',
          items: { type: 'number', enum: [0, 1] },
          description: 'Ordered list of 0/1 (0=incorrect, 1=correct).',
        },
        p_l0:  { type: 'number', description: 'P(L0) — prior knowledge. Default 0.3.' },
        p_t:   { type: 'number', description: 'P(T)  — learning/transition rate. Default 0.09.' },
        p_s:   { type: 'number', description: 'P(S)  — slip rate. Default 0.1.' },
        p_g:   { type: 'number', description: 'P(G)  — guess rate. Default 0.2.' },
        mastery_threshold: { type: 'number', description: 'P(Ln) >= threshold → mastered. Default 0.95.' },
      },
      required: ['observations'],
    },
  },

  {
    name: 'algo_item_response_theory',
    description:
      'Run Item Response Theory (IRT) 3-Parameter Logistic model. ' +
      'Given a student\'s response pattern and item parameters, estimate student ability θ ' +
      'and compute expected probability of success for new items. ' +
      'Output: { theta (ability estimate), item_fit[], ability_percentile, recommendations }.',
    inputSchema: {
      type: 'object',
      properties: {
        responses: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              item_id:   { type: 'string' },
              correct:   { type: 'number', enum: [0, 1] },
              a:         { type: 'number', description: 'Discrimination parameter (default 1.0).' },
              b:         { type: 'number', description: 'Difficulty parameter in logits (default 0.0).' },
              c:         { type: 'number', description: 'Pseudo-guessing parameter (default 0.2).' },
            },
            required: ['correct'],
          },
        },
        target_items: {
          type: 'array',
          description: 'Items to predict probability of success for (optional).',
          items: {
            type: 'object',
            properties: {
              item_id: { type: 'string' },
              a: { type: 'number' },
              b: { type: 'number' },
              c: { type: 'number' },
            },
          },
        },
      },
      required: ['responses'],
    },
  },

  {
    name: 'algo_spaced_repetition',
    description:
      'Compute the optimal review schedule using the SM-2 spaced repetition algorithm (Ebbinghaus). ' +
      'Given a list of items with their last review quality scores, returns the next review date ' +
      'and updated ease factors for each item. ' +
      'Output: { schedule: [{ item_id, next_review_date, interval_days, ease_factor, stability }] }.',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              item_id:       { type: 'string' },
              quality:       { type: 'number', description: 'Response quality 0-5 (0=blackout, 5=perfect).' },
              repetitions:   { type: 'number', description: 'Number of times reviewed so far.' },
              ease_factor:   { type: 'number', description: 'Current ease factor (default 2.5).' },
              interval_days: { type: 'number', description: 'Current interval in days (default 1).' },
              last_reviewed: { type: 'string', description: 'ISO date of last review.' },
            },
            required: ['item_id', 'quality'],
          },
        },
        today: { type: 'string', description: 'ISO date string for "today" (default: now).' },
      },
      required: ['items'],
    },
  },

  {
    name: 'algo_knowledge_graph_path',
    description:
      'Build a knowledge dependency graph from outcomes and compute the optimal learning path ' +
      'from a student\'s current mastery state to a target outcome. ' +
      'Uses topological sort + Dijkstra shortest path on prerequisite edges. ' +
      'Output: { path: [outcome_code], gaps: [outcome_code], estimated_hours, graph_stats }.',
    inputSchema: {
      type: 'object',
      properties: {
        outcomes: {
          type: 'array',
          description: 'List of outcome nodes.',
          items: {
            type: 'object',
            properties: {
              id:           { type: 'string' },
              code:         { type: 'string' },
              prerequisites: { type: 'array', items: { type: 'string' }, description: 'List of prerequisite outcome codes.' },
              estimated_hours: { type: 'number' },
            },
            required: ['id', 'code'],
          },
        },
        student_mastery: {
          type: 'array',
          description: 'Outcomes the student has already mastered.',
          items: { type: 'object', properties: { outcome_code: { type: 'string' }, score: { type: 'number' } } },
        },
        target_outcome_code: { type: 'string', description: 'The outcome to reach.' },
        mastery_threshold:   { type: 'number', description: 'Min score to consider mastered (default 0.8).' },
      },
      required: ['outcomes', 'target_outcome_code'],
    },
  },

  {
    name: 'algo_knowledge_gap_analysis',
    description:
      'Compute the knowledge gap between a student\'s current mastery profile and a target profile. ' +
      'Identifies: missing skills, partially mastered skills, and fully mastered skills. ' +
      'Generates a prioritized remediation plan ranked by impact × urgency. ' +
      'Output: { gaps[], partial[], mastered[], gap_score (0-1), remediation_plan[] }.',
    inputSchema: {
      type: 'object',
      properties: {
        student_mastery: {
          type: 'array',
          items: { type: 'object', properties: { outcome_code: { type: 'string' }, score: { type: 'number' } } },
        },
        target_outcomes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              code:     { type: 'string' },
              weight:   { type: 'number', description: 'Importance weight 0-1.' },
              deadline: { type: 'string', description: 'ISO date when this outcome should be achieved.' },
            },
            required: ['code'],
          },
        },
        mastery_threshold:  { type: 'number', description: 'Min score for "mastered" (default 0.8).' },
        partial_threshold:  { type: 'number', description: 'Min score for "partial" (default 0.4).' },
      },
      required: ['student_mastery', 'target_outcomes'],
    },
  },

  {
    name: 'algo_learning_curve_fit',
    description:
      'Fit a learning curve model to a student\'s performance-over-time data. ' +
      'Supports: Power Law of Practice, Exponential Learning Curve. ' +
      'Estimates: learning rate, asymptote (max predicted performance), and ' +
      'time to reach mastery threshold. ' +
      'Output: { model, params, r_squared, predicted_mastery_date, current_trajectory }.',
    inputSchema: {
      type: 'object',
      properties: {
        performance_series: {
          type: 'array',
          description: 'Chronological performance scores.',
          items: {
            type: 'object',
            properties: {
              trial:     { type: 'number', description: 'Trial/session number (1-indexed).' },
              score:     { type: 'number', description: 'Performance score 0-1.' },
              timestamp: { type: 'string', description: 'ISO date (optional).' },
            },
            required: ['trial', 'score'],
          },
        },
        model_type: {
          type: 'string',
          enum: ['power_law', 'exponential', 'auto'],
          description: '"auto" selects the best-fit model. Default: "auto".',
        },
        mastery_threshold: { type: 'number', description: 'Score considered mastered. Default 0.85.' },
      },
      required: ['performance_series'],
    },
  },

  // ══════════════════════════════════════════════════════════════
  // ANALYSIS TOOLS (combine data + algorithms)
  // ══════════════════════════════════════════════════════════════

  {
    name: 'analysis_student_risk_score',
    description:
      'Compute a comprehensive at-risk score for a student using multiple signals: ' +
      'engagement (login frequency, time-on-task), performance (scores, mastery), ' +
      'progression (pacing vs expected), and social (peer comparison). ' +
      'Returns a risk score 0-100 with factor breakdown and intervention recommendations.',
    inputSchema: {
      type: 'object',
      properties: {
        student_id:  { type: 'string' },
        course_id:   { type: 'string' },
        lookback_days: { type: 'number', description: 'Days to look back for engagement data (default 14).' },
      },
      required: ['student_id', 'course_id'],
    },
  },

  {
    name: 'analysis_class_mastery_heatmap',
    description:
      'Generate a mastery heatmap for an entire class across all learning outcomes. ' +
      'Identifies clusters of struggling students, concept misconceptions, and ' +
      'class-wide knowledge gaps. ' +
      'Output: { heatmap: { student_id × outcome_code → score }, ' +
      'struggling_concepts[], advanced_students[], class_avg_mastery }.',
    inputSchema: {
      type: 'object',
      properties: {
        course_id: { type: 'string' },
        subject:   { type: 'string', description: 'Filter outcomes by subject.' },
      },
      required: ['course_id'],
    },
  },

  {
    name: 'analysis_adaptive_next_items',
    description:
      'Recommend the next 3-5 learning items for a student based on their BKT state, ' +
      'IRT ability estimate, and knowledge gap analysis. ' +
      'Selects items in the "zone of proximal development" — slightly above current ability. ' +
      'Output: { recommended_items: [{ item_id, title, rationale, estimated_difficulty }] }.',
    inputSchema: {
      type: 'object',
      properties: {
        student_id:    { type: 'string' },
        course_id:     { type: 'string' },
        strategy:      {
          type: 'string',
          enum: ['zpd', 'gap_fill', 'spaced_review', 'challenge'],
          description: 'zpd=zone of proximal dev, gap_fill=fill knowledge gaps, spaced_review=due for review, challenge=stretch.',
        },
        max_items: { type: 'number', description: 'Number of items to recommend (default 5).' },
      },
      required: ['student_id', 'course_id'],
    },
  },

  // ══════════════════════════════════════════════════════════════
  // META TOOLS
  // ══════════════════════════════════════════════════════════════

  {
    name: 'meta_save_reasoning',
    description:
      'Save a reasoning step to the agent trace log for research inspection. ' +
      'Use this to record your thought process, hypotheses, and intermediate conclusions. ' +
      'This creates an auditable reasoning chain that researchers can inspect.',
    inputSchema: {
      type: 'object',
      properties: {
        step:       { type: 'string', description: 'Short label for this reasoning step.' },
        hypothesis: { type: 'string', description: 'What you are currently hypothesizing.' },
        evidence:   { type: 'string', description: 'Evidence supporting or refuting the hypothesis.' },
        confidence: { type: 'number', description: 'Confidence 0-1 in current hypothesis.' },
      },
      required: ['step', 'hypothesis'],
    },
  },

  {
    name: 'meta_create_intervention',
    description:
      'Create and save an intervention recommendation for a student or class. ' +
      'Interventions are logged and surfaced to teachers in the dashboard. ' +
      'Output: { intervention_id, created: true }.',
    inputSchema: {
      type: 'object',
      properties: {
        target_type:      { type: 'string', enum: ['student', 'class'] },
        target_id:        { type: 'string', description: 'Student ID or Course ID.' },
        intervention_type: {
          type: 'string',
          enum: ['remediation', 'enrichment', 're_engagement', 'teacher_alert', 'peer_support'],
        },
        priority:         { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
        message_vi:       { type: 'string', description: 'Intervention message in Vietnamese.' },
        suggested_items:  { type: 'array', items: { type: 'string' }, description: 'Item IDs to assign.' },
      },
      required: ['target_type', 'target_id', 'intervention_type', 'priority', 'message_vi'],
    },
  },
];

// ── Convert TOOLS to Claude API format ───────────────────────────────────────
export function getClaudeToolDefinitions() {
  return TOOLS.map(tool => ({
    name:        tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

// ── Central tool executor ─────────────────────────────────────────────────────
/**
 * Execute a tool by name with the given input.
 * @param {string} toolName
 * @param {object} input      Validated input from Claude
 * @param {object} env        Cloudflare Worker env bindings
 * @param {object} ctx        Extra context (userId, agentTrace[], etc.)
 * @returns {Promise<object>} Tool result (always a plain object)
 */
export async function executeTool(toolName, input, env, ctx = {}) {
  const startTime = Date.now();

  try {
    let result;

    if (toolName.startsWith('data_')) {
      result = await executeDataTools(toolName, input, env, ctx);
    } else if (toolName.startsWith('algo_')) {
      result = await executeAlgorithmTools(toolName, input, env, ctx);
    } else if (toolName.startsWith('analysis_')) {
      result = await executeAnalysisTools(toolName, input, env, ctx);
    } else if (toolName === 'meta_save_reasoning') {
      // Append to the agent trace in context
      if (Array.isArray(ctx.agentTrace)) {
        ctx.agentTrace.push({ ...input, timestamp: new Date().toISOString() });
      }
      result = { saved: true, trace_length: ctx.agentTrace?.length || 1 };
    } else if (toolName === 'meta_create_intervention') {
      result = await createIntervention(input, env, ctx);
    } else {
      result = { error: `Unknown tool: ${toolName}` };
    }

    return {
      ...result,
      _tool_meta: {
        tool: toolName,
        duration_ms: Date.now() - startTime,
        ok: !result.error,
      },
    };
  } catch (err) {
    console.error(`[Tool:${toolName}] Error:`, err.message);
    return {
      error: `Tool execution failed: ${err.message}`,
      _tool_meta: { tool: toolName, duration_ms: Date.now() - startTime, ok: false },
    };
  }
}

// ── Intervention helper ───────────────────────────────────────────────────────
async function createIntervention(input, env, _ctx) {
  // In Phase 2 this will write to D1; for now, mock a successful save
  const id = `INT-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  // TODO: await env.D1.prepare('INSERT INTO interventions ...').run();
  return { intervention_id: id, created: true, message: 'Intervention saved (mock until D1 migration).' };
}

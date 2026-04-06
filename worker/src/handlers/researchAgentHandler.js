/**
 * Research Agent Handler — Agentic loop with Claude Tool Use API
 *
 * Endpoint:  POST /ai/research-agent
 *
 * This handler implements a true multi-turn agentic loop:
 *   1. Send task + tool definitions to Claude
 *   2. Claude calls tools → Worker executes them
 *   3. Results fed back to Claude → continues reasoning
 *   4. Loop until stop_reason = "end_turn" (max MAX_ITERATIONS)
 *   5. Return: final response + full reasoning trace
 *
 * Research modes:
 *   diagnose    — Full diagnosis of a student's learning state
 *   predict     — Predict performance trajectory + mastery date
 *   plan        — Generate adaptive learning path
 *   risk        — Class-wide at-risk analysis
 *   freeform    — Open-ended research query with full tool access
 *
 * Authorization:
 *   - Teachers & Admins: full access (all modes)
 *   - Students: limited (only "diagnose" and "plan" for themselves)
 */

import { getTokenSecret, verifyToken, verifyAdminAuth } from '../auth.js';
import { checkAIAccess } from './aiHandler.js';
import { getClaudeToolDefinitions, executeTool } from '../tools/registry.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const MAX_ITERATIONS   = 8;    // Safety cap on agentic loop turns
const MAX_TOKENS       = 4096;
const CLAUDE_MODEL     = 'claude-haiku-4-5';
const RATE_LIMIT_MAX   = 20;
const RATE_LIMIT_WINDOW = 3_600_000; // 1 hour

// In-memory rate limiter
const _rateLimits = new Map();
function localRateLimit(key, max, windowMs = RATE_LIMIT_WINDOW) {
  const now = Date.now();
  let e = _rateLimits.get(key);
  if (!e || now > e.resetAt) e = { count: 0, resetAt: now + windowMs };
  e.count++;
  _rateLimits.set(key, e);
  return { allowed: e.count <= max, count: e.count };
}

// ── Mode system prompts ────────────────────────────────────────────────────────
const MODE_PROMPTS = {
  diagnose: `You are an educational diagnostic AI agent. Your task is to produce a
comprehensive learning diagnosis for a specific student.

Steps you MUST follow:
1. Call data_get_student_profile to understand the student.
2. Call data_get_item_response_history to get their performance data.
3. Call algo_bayesian_knowledge_tracing on their observations sequence.
4. Call data_get_student_mastery if available.
5. Call algo_knowledge_gap_analysis with their mastery data.
6. Call algo_learning_curve_fit on their performance series.
7. Use meta_save_reasoning at each key conclusion.
8. Synthesize a clear, actionable diagnosis in Vietnamese.

Return a structured JSON diagnosis:
{ summary_vi, knowledge_level, bkt_result, learning_curve, gaps, strengths, recommendations[] }`,

  predict: `You are a learning prediction AI agent. Your task is to predict a student's
future performance and mastery trajectory.

Steps you MUST follow:
1. Call data_get_item_response_history to get historical data.
2. Call algo_learning_curve_fit to fit their learning curve.
3. Call algo_bayesian_knowledge_tracing to estimate current state.
4. If outcomes data available, call algo_knowledge_graph_path for target.
5. Call meta_save_reasoning with your prediction hypothesis.
6. Produce a prediction with confidence intervals.

Return JSON: { predicted_mastery_date, confidence, trajectory, risk_factors[], accelerators[] }`,

  plan: `You are an adaptive learning path planner. Your task is to create a personalized
learning plan for a student.

Steps you MUST follow:
1. Call data_get_student_profile and data_get_student_mastery.
2. Call data_get_outcome_tree to get the curriculum structure.
3. Call algo_knowledge_gap_analysis to identify priority gaps.
4. Call algo_knowledge_graph_path to find the optimal route.
5. Call analysis_adaptive_next_items to get concrete item recommendations.
6. Call algo_spaced_repetition for items needing review.
7. Synthesize into a weekly learning plan.

Return JSON: { weekly_plan[], total_weeks, priority_outcomes[], spaced_review_schedule[] }`,

  risk: `You are a class risk analysis AI agent. Your task is to identify at-risk students
and class-wide knowledge gaps.

Steps you MUST follow:
1. Call data_list_course_students to get the class roster.
2. For each student (max 10 to stay within limits), call analysis_student_risk_score.
3. Call analysis_class_mastery_heatmap for the big picture.
4. Use meta_save_reasoning to document your findings.
5. Prioritize interventions by urgency.

Return JSON: { at_risk_students[], struggling_concepts[], interventions[], class_summary }`,

  freeform: `You are a powerful educational research AI agent with access to student data,
learning algorithms, and analysis tools. Answer the researcher's question using whatever
combination of tools is most appropriate.

Guidelines:
- Use meta_save_reasoning to document your thought process.
- Be systematic: gather data before drawing conclusions.
- Always ground conclusions in data from tool results.
- Respond in Vietnamese unless the question is in English.
- For sensitive student data, anonymize in your final response.`,
};

// ── Main handler ──────────────────────────────────────────────────────────────

/**
 * POST /ai/research-agent
 * Body: {
 *   mode: 'diagnose' | 'predict' | 'plan' | 'risk' | 'freeform',
 *   task: string,                // The research question / task
 *   context?: {
 *     student_id?: string,
 *     course_id?:  string,
 *     [extra]:     any,          // Additional context passed to AI
 *   },
 *   return_trace?: boolean,      // Include full reasoning trace in response
 * }
 */
export async function handleResearchAgent(request, env, { json, clientIP }) {
  // ── Auth: must be logged in, teacher/admin OR student accessing own data ──
  const authHeader = request.headers.get('Authorization') || '';
  const secret  = getTokenSecret(env);
  const session = await verifyToken(authHeader.replace('Bearer ', ''), secret);
  if (!session) return json({ error: 'Yêu cầu đăng nhập.', requireLogin: true }, 401);

  const access = await checkAIAccess(env, session.userId);
  if (!access.ok) return json({ error: access.reason, noAccess: true }, 403);

  // Rate limit per user
  const rl = localRateLimit(`research:${session.userId}`, RATE_LIMIT_MAX);
  if (!rl.allowed) return json({ error: 'Quá nhiều yêu cầu. Thử lại sau 1 giờ.' }, 429);

  if (!env.ANTHROPIC_API_KEY && !env.AI_GATEWAY_KEY) return json({ error: 'AI chưa được cấu hình.' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { mode = 'freeform', task, context = {}, return_trace = false } = body;

  if (!task || typeof task !== 'string' || !task.trim())
    return json({ error: 'Thiếu trường task.' }, 400);

  const validModes = ['diagnose', 'predict', 'plan', 'risk', 'freeform'];
  if (!validModes.includes(mode))
    return json({ error: `mode phải là một trong: ${validModes.join(', ')}` }, 400);

  // Students can only access diagnose/plan for themselves
  const userRole = session.role || 'student';
  if (userRole === 'student') {
    if (!['diagnose', 'plan'].includes(mode))
      return json({ error: 'Học sinh chỉ được dùng chế độ "diagnose" và "plan".' }, 403);
    // Force student_id to their own ID
    if (context.student_id && String(context.student_id) !== String(session.userId))
      return json({ error: 'Không thể truy cập dữ liệu của học sinh khác.' }, 403);
    context.student_id = String(session.userId);
  }

  // ── Prepare agentic loop ──────────────────────────────────────────────────
  const systemPrompt = MODE_PROMPTS[mode];
  const toolDefs     = getClaudeToolDefinitions();
  const agentTrace   = [];  // Reasoning + tool call log

  // Build initial user message with context
  const contextStr = Object.keys(context).length > 0
    ? `\n\nContext:\n${JSON.stringify(context, null, 2)}`
    : '';
  const initialMessage = `${task}${contextStr}`;

  // Messages array for multi-turn conversation
  const messages = [
    { role: 'user', content: initialMessage }
  ];

  let finalResponse = null;
  let iterations    = 0;
  let totalInputTokens  = 0;
  let totalOutputTokens = 0;

  // ── Agentic loop ────────────────────────────────────────────────────────────
  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const claudePayload = {
      model:      CLAUDE_MODEL,
      max_tokens: MAX_TOKENS,
      system:     systemPrompt,
      tools:      toolDefs,
      messages,
    };

    let claudeRes;
    try {
      claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key':          env.ANTHROPIC_API_KEY || env.AI_GATEWAY_KEY,
          'anthropic-version':  '2023-06-01',
          'Content-Type':       'application/json',
        },
        body: JSON.stringify(claudePayload),
      });
    } catch (err) {
      return json({ error: `AI fetch error: ${err.message}` }, 502);
    }

    if (!claudeRes.ok) {
      const errText = await claudeRes.text().catch(() => '');
      console.error('[ResearchAgent] Claude API error:', claudeRes.status, errText);
      return json({ error: `AI API error (${claudeRes.status})` }, 502);
    }

    const claudeData = await claudeRes.json();
    totalInputTokens  += claudeData.usage?.input_tokens  || 0;
    totalOutputTokens += claudeData.usage?.output_tokens || 0;

    const stopReason  = claudeData.stop_reason;
    const contentBlocks = claudeData.content || [];

    // Add assistant turn to messages
    messages.push({ role: 'assistant', content: contentBlocks });

    // Extract any text blocks for the trace
    const textBlocks = contentBlocks.filter(b => b.type === 'text');
    if (textBlocks.length > 0) {
      agentTrace.push({
        iteration: iterations,
        type:      'reasoning',
        text:      textBlocks.map(b => b.text).join('\n'),
      });
    }

    // ── If Claude is done, extract final response ─────────────────────────
    if (stopReason === 'end_turn') {
      const lastTextBlock = textBlocks[textBlocks.length - 1];
      finalResponse = lastTextBlock?.text ?? null;

      // Try to parse structured JSON from response
      if (finalResponse) {
        const stripped = finalResponse
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/\s*```\s*$/, '')
          .trim();
        try {
          finalResponse = JSON.parse(stripped);
        } catch {
          // Keep as string if not JSON
        }
      }
      break;
    }

    // ── Handle tool_use stop ──────────────────────────────────────────────
    if (stopReason === 'tool_use') {
      const toolUseBlocks = contentBlocks.filter(b => b.type === 'tool_use');

      // Execute all tools in parallel
      const toolResults = await Promise.all(
        toolUseBlocks.map(async (toolCall) => {
          const toolCtx = { agentTrace, userId: session.userId };
          const result  = await executeTool(toolCall.name, toolCall.input || {}, env, toolCtx);

          // Log tool call to trace
          agentTrace.push({
            iteration:   iterations,
            type:        'tool_call',
            tool:        toolCall.name,
            input:       toolCall.input,
            result_keys: Object.keys(result),
            duration_ms: result._tool_meta?.duration_ms,
            ok:          result._tool_meta?.ok !== false,
          });

          return {
            type:        'tool_result',
            tool_use_id: toolCall.id,
            content:     JSON.stringify(result),
          };
        })
      );

      // Feed tool results back to Claude
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // max_tokens or other stop — collect what we have
    if (textBlocks.length > 0) {
      finalResponse = textBlocks.map(b => b.text).join('\n');
    }
    break;
  }

  // ── Build response ────────────────────────────────────────────────────────
  const response = {
    mode,
    iterations,
    result: finalResponse,
    token_usage: {
      input:  totalInputTokens,
      output: totalOutputTokens,
      total:  totalInputTokens + totalOutputTokens,
    },
  };

  if (return_trace) {
    response.trace = agentTrace;
  }

  // Summary stats for researcher
  response.agent_stats = {
    tool_calls_made:    agentTrace.filter(e => e.type === 'tool_call').length,
    reasoning_steps:    agentTrace.filter(e => e.type === 'reasoning').length,
    tools_used:         [...new Set(agentTrace.filter(e => e.type === 'tool_call').map(e => e.tool))],
    completed:          iterations < MAX_ITERATIONS,
    hit_iteration_cap:  iterations >= MAX_ITERATIONS,
  };

  return json(response);
}

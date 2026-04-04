/**
 * AI Agent Handler — 5 AI-powered endpoints for ActiveEdu LMS
 *
 * Endpoints:
 *   POST /ai/curriculum-agent   — Curriculum DAG generator
 *   POST /ai/assessment-agent   — Quiz/question generator
 *   POST /ai/coaching-agent     — Socratic tutor (Zero-draft enforced)
 *   POST /ai/analytics-agent    — Learning analytics (admin only)
 *   POST /ai/content-agent      — Content improvement/summarize/translate (admin only)
 */

import { verifyAdminAuth } from '../auth.js';
import { nocoFetch } from '../db.js';
import { checkRateLimit } from '../middleware.js';

// ── In-memory rate limit store (module scope, per-IP per-route) ──────────────
const _rateLimits = new Map();

/**
 * Simple in-memory rate limiter as a fallback (complements middleware.js).
 * Uses a sliding window keyed by `${prefix}:${ip}`.
 * @param {string} ip
 * @param {string} prefix  e.g. 'coaching-agent'
 * @param {number} max     max requests in the window
 * @param {number} windowMs  window in milliseconds (default 1 hour)
 */
function localRateLimit(ip, prefix, max, windowMs = 3_600_000) {
  const key = `${prefix}:${ip || 'unknown'}`;
  const now = Date.now();
  let entry = _rateLimits.get(key);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + windowMs };
  }
  entry.count++;
  _rateLimits.set(key, entry);
  return { allowed: entry.count <= max, count: entry.count, resetAt: entry.resetAt };
}

// ── AI provider helper ────────────────────────────────────────────────────────

/**
 * Call the configured AI provider (Claude or OpenAI) and return the text response.
 * Falls back gracefully: returns null on network/parse errors.
 *
 * @param {object} env              Cloudflare Worker env bindings
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {number} [maxTokens=1024]
 * @returns {Promise<string|null>}
 */
async function callAI(env, systemPrompt, userMessage, maxTokens = 1024) {
  const apiKey = env.AI_GATEWAY_KEY;
  const provider = (env.AI_PROVIDER || 'claude').toLowerCase();

  if (!apiKey) return null;

  try {
    if (provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
        }),
      });
      if (!res.ok) {
        console.error('[AI Agent] OpenAI error:', res.status, await res.text());
        return null;
      }
      const data = await res.json();
      return data?.choices?.[0]?.message?.content ?? null;
    }

    // Default: Claude
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-20240307',
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });
    if (!res.ok) {
      console.error('[AI Agent] Claude error:', res.status, await res.text());
      return null;
    }
    const data = await res.json();
    return data?.content?.[0]?.text ?? null;
  } catch (err) {
    console.error('[AI Agent] fetch exception:', err.message);
    return null;
  }
}

/**
 * Attempt to parse a JSON string that may be wrapped in markdown code fences.
 * Returns the parsed value or null.
 */
function parseAIJson(text) {
  if (!text) return null;
  // Strip optional ```json ... ``` or ``` ... ``` fences
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try { return JSON.parse(stripped); } catch { return null; }
}

// ── 1. Curriculum Agent ───────────────────────────────────────────────────────

/**
 * POST /ai/curriculum-agent
 * Body: { courseId, prompt, existingModules? }
 * Returns: { dag: { nodes[], edges[] } }
 */
export async function handleCurriculumAgent(request, env, { json, clientIP }) {
  // Rate limit: 50 requests/IP/hour
  const rl = localRateLimit(clientIP, 'curriculum-agent', 50);
  if (!rl.allowed) return json({ error: 'Quá nhiều yêu cầu. Thử lại sau 1 giờ.' }, 429);

  if (!env.AI_GATEWAY_KEY) return json({ error: 'AI chưa được cấu hình' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { courseId, prompt, existingModules } = body;
  if (!prompt || typeof prompt !== 'string' || !prompt.trim())
    return json({ error: 'Thiếu trường prompt' }, 400);
  if (!courseId) return json({ error: 'Thiếu trường courseId' }, 400);

  const systemPrompt =
    'You are a Curriculum Design Agent. Generate a structured course DAG (Directed Acyclic Graph) ' +
    "based on the instructor's prompt. Output JSON with nodes (lessons) and edges (prerequisites). " +
    'Each node: {id, title, type: \'core\'|\'satellite\'|\'remedial\', estimatedMinutes, learningObjectives[]}. ' +
    "Each edge: {from, to, condition: 'always'|'score_above_80'|'score_below_60'}. " +
    'Return ONLY valid JSON — no prose, no markdown fences.';

  const userMessage =
    `Course ID: ${String(courseId).slice(0, 100)}\n` +
    `Instructor prompt: ${prompt.slice(0, 2000)}\n` +
    (existingModules ? `Existing modules (for context): ${JSON.stringify(existingModules).slice(0, 1000)}` : '');

  const aiText = await callAI(env, systemPrompt, userMessage, 2048);
  if (!aiText) return json({ error: 'AI tạm thời không khả dụng' }, 502);

  const dag = parseAIJson(aiText);
  if (!dag) {
    // Return raw if JSON parsing fails so the client can still see the output
    return json({ dag: null, raw: aiText });
  }
  return json({ dag });
}

// ── 2. Assessment Agent ───────────────────────────────────────────────────────

/**
 * POST /ai/assessment-agent
 * Body: { content, questionCount?: 5, difficulty?: 'medium', types?: ['mcq','truefalse'] }
 * Returns: { questions: Question[] }
 */
export async function handleAssessmentAgent(request, env, { json, clientIP }) {
  // Rate limit: 10 requests/IP/hour
  const rl = localRateLimit(clientIP, 'assessment-agent', 10);
  if (!rl.allowed) return json({ error: 'Quá nhiều yêu cầu. Thử lại sau 1 giờ.' }, 429);

  if (!env.AI_GATEWAY_KEY) return json({ error: 'AI chưa được cấu hình' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const {
    content,
    questionCount = 5,
    difficulty = 'medium',
    types = ['mcq', 'truefalse'],
  } = body;

  if (!content || typeof content !== 'string' || !content.trim())
    return json({ error: 'Thiếu trường content' }, 400);

  const count = Math.min(Math.max(Number(questionCount) || 5, 1), 20);
  const allowedDifficulty = ['easy', 'medium', 'hard'];
  const safeD = allowedDifficulty.includes(difficulty) ? difficulty : 'medium';
  const safeTypes = Array.isArray(types) && types.length ? types : ['mcq', 'truefalse'];

  const systemPrompt =
    'You are an Assessment Design Agent. Generate quiz questions from the provided lesson content. ' +
    'Output a JSON array of questions. ' +
    'Each question: {type, question, options[]?, correct, explanation, bloomsLevel: 1-6}. ' +
    "Bloom's levels: 1=Remember, 2=Understand, 3=Apply, 4=Analyze, 5=Evaluate, 6=Create. " +
    'Return ONLY valid JSON array — no prose, no markdown fences.';

  const userMessage =
    `Generate ${count} questions at difficulty level "${safeD}".\n` +
    `Allowed question types: ${safeTypes.join(', ')}.\n` +
    `Lesson content:\n${content.slice(0, 4000)}`;

  const aiText = await callAI(env, systemPrompt, userMessage, 2048);
  if (!aiText) return json({ error: 'AI tạm thời không khả dụng' }, 502);

  const questions = parseAIJson(aiText);
  if (!Array.isArray(questions)) {
    return json({ questions: null, raw: aiText });
  }
  return json({ questions });
}

// ── 3. Coaching Agent ─────────────────────────────────────────────────────────

/**
 * POST /ai/coaching-agent
 * Body: { studentMessage, context: { lessonTitle, submissionDraft, previousMessages[] } }
 * Returns: { response, type: 'socratic' } or { blocked: true, message }
 *
 * Zero-draft enforcement: submissionDraft must be >= 50 words before AI responds.
 */
export async function handleCoachingAgent(request, env, { json, clientIP }) {
  // Rate limit: 20 requests/IP/hour
  const rl = localRateLimit(clientIP, 'coaching-agent', 20);
  if (!rl.allowed) return json({ error: 'Quá nhiều yêu cầu. Thử lại sau 1 giờ.' }, 429);

  if (!env.AI_GATEWAY_KEY) return json({ error: 'AI chưa được cấu hình' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { studentMessage, context = {} } = body;
  if (!studentMessage || typeof studentMessage !== 'string' || !studentMessage.trim())
    return json({ error: 'Thiếu trường studentMessage' }, 400);

  const { lessonTitle = '', submissionDraft = '', previousMessages = [] } = context;

  // Zero-draft check: count words in the student's submission draft
  const draftWordCount = submissionDraft
    ? submissionDraft.trim().split(/\s+/).filter(Boolean).length
    : 0;

  if (draftWordCount < 50) {
    return json({
      blocked: true,
      message: 'Hãy viết ít nhất 50 từ trình bày suy nghĩ của bạn trước khi hỏi AI.',
    });
  }

  // Build conversation history for context (max last 6 messages to stay within tokens)
  const recentHistory = Array.isArray(previousMessages)
    ? previousMessages.slice(-6)
    : [];
  const historyText = recentHistory
    .map(m => `${m.role === 'assistant' ? 'Tutor' : 'Student'}: ${String(m.content || '').slice(0, 300)}`)
    .join('\n');

  const systemPrompt =
    'You are a Socratic AI Tutor. NEVER give direct answers. ALWAYS respond with questions that ' +
    "guide the student to discover the answer themselves. If the student asks 'what is X?', ask " +
    "'What do you already know about X? How does it connect to Y which you learned earlier?' " +
    'Respond in Vietnamese unless student writes in another language. Max 3 sentences per response.';

  const userMessage =
    (lessonTitle ? `Lesson: ${String(lessonTitle).slice(0, 200)}\n` : '') +
    (historyText ? `Conversation so far:\n${historyText}\n\n` : '') +
    `Student's draft (${draftWordCount} words):\n${submissionDraft.slice(0, 1000)}\n\n` +
    `Student's question: ${studentMessage.slice(0, 500)}`;

  const aiText = await callAI(env, systemPrompt, userMessage, 400);
  if (!aiText) return json({ error: 'AI tạm thời không khả dụng' }, 502);

  return json({ response: aiText, type: 'socratic' });
}

// ── 4. Analytics Agent ────────────────────────────────────────────────────────

/**
 * POST /ai/analytics-agent
 * Body: { courseId }
 * Admin only. Fetches recent submissions for the course from NocoDB, then
 * calls AI to generate risk alerts and insights.
 * Returns: { alerts[], summary, insights[] }
 */
export async function handleAnalyticsAgent(request, env, { json, clientIP }) {
  // Admin auth required
  if (!await verifyAdminAuth(request, env)) return json({ error: 'Unauthorized' }, 401);

  // Rate limit: 50 requests/IP/hour
  const rl = localRateLimit(clientIP, 'analytics-agent', 50);
  if (!rl.allowed) return json({ error: 'Quá nhiều yêu cầu. Thử lại sau 1 giờ.' }, 429);

  if (!env.AI_GATEWAY_KEY) return json({ error: 'AI chưa được cấu hình' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { courseId } = body;
  if (!courseId) return json({ error: 'Thiếu trường courseId' }, 400);

  // Fetch recent submissions for this course from NocoDB
  let submissions = [];
  if (env.NOCO_SUBMISSIONS) {
    try {
      const r = await nocoFetch(
        env,
        `/api/v2/tables/${env.NOCO_SUBMISSIONS}/records` +
          `?where=(CourseId,eq,${encodeURIComponent(courseId)})` +
          `&sort=-CreatedAt&limit=200` +
          `&fields=Id,StudentId,StudentName,Score,Status,SubmittedAt,AssessmentId`
      );
      if (r.ok) {
        const data = await r.json();
        submissions = data.list || [];
      }
    } catch (err) {
      console.error('[Analytics Agent] NocoDB fetch error:', err.message);
    }
  }

  const systemPrompt =
    'You are a Learning Analytics Agent. Analyze the student submission data and identify: ' +
    '1) Students at risk (low scores, no submissions), ' +
    '2) Concepts where many students struggle, ' +
    '3) Recommended interventions. ' +
    'Output JSON: { alerts: [{type, severity:\'low\'|\'medium\'|\'high\', message, affectedStudents[], recommendation}], summary, insights[] }. ' +
    'Return ONLY valid JSON — no prose, no markdown fences.';

  const userMessage =
    `Course ID: ${String(courseId).slice(0, 100)}\n` +
    `Total submissions analysed: ${submissions.length}\n` +
    `Submission data (JSON):\n${JSON.stringify(submissions).slice(0, 4000)}`;

  const aiText = await callAI(env, systemPrompt, userMessage, 2048);
  if (!aiText) return json({ error: 'AI tạm thời không khả dụng' }, 502);

  const analytics = parseAIJson(aiText);
  if (!analytics) {
    return json({ alerts: [], summary: null, insights: [], raw: aiText });
  }

  return json({
    alerts: analytics.alerts || [],
    summary: analytics.summary || null,
    insights: analytics.insights || [],
  });
}

// ── 5. Content Agent ──────────────────────────────────────────────────────────

/**
 * POST /ai/content-agent
 * Body: { content, action: 'improve'|'summarize'|'translate'|'accessibility_check' }
 * Admin only.
 * Returns: { result, suggestions[] }
 */
export async function handleContentAgent(request, env, { json, clientIP }) {
  // Admin auth required
  if (!await verifyAdminAuth(request, env)) return json({ error: 'Unauthorized' }, 401);

  // Rate limit: 50 requests/IP/hour
  const rl = localRateLimit(clientIP, 'content-agent', 50);
  if (!rl.allowed) return json({ error: 'Quá nhiều yêu cầu. Thử lại sau 1 giờ.' }, 429);

  if (!env.AI_GATEWAY_KEY) return json({ error: 'AI chưa được cấu hình' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { content, action } = body;
  if (!content || typeof content !== 'string' || !content.trim())
    return json({ error: 'Thiếu trường content' }, 400);

  const allowedActions = ['improve', 'summarize', 'translate', 'accessibility_check'];
  if (!action || !allowedActions.includes(action))
    return json({ error: `action phải là một trong: ${allowedActions.join(', ')}` }, 400);

  let systemPrompt;
  let userMessage;

  switch (action) {
    case 'improve':
      systemPrompt =
        'You are an expert educational content editor. Improve the provided lesson content for ' +
        'clarity, engagement, and pedagogical effectiveness. Fix grammar, enhance structure, and ' +
        'make it more student-friendly. Return JSON: { result: "<improved content>", suggestions: ["<suggestion 1>", ...] }. ' +
        'Return ONLY valid JSON — no prose, no markdown fences.';
      userMessage = `Improve this content:\n${content.slice(0, 5000)}`;
      break;

    case 'summarize':
      systemPrompt =
        'You are an expert at summarizing educational content. Create a concise, accurate summary ' +
        'that captures the key learning points. Return JSON: { result: "<summary>", suggestions: ["<key point 1>", ...] }. ' +
        'Return ONLY valid JSON — no prose, no markdown fences.';
      userMessage = `Summarize this content:\n${content.slice(0, 5000)}`;
      break;

    case 'translate':
      systemPrompt =
        'You are a professional translator specializing in educational content. ' +
        'Translate the provided content into Vietnamese while preserving technical terminology, ' +
        'formatting, and pedagogical intent. Return JSON: { result: "<translated content>", suggestions: ["<translation note 1>", ...] }. ' +
        'Return ONLY valid JSON — no prose, no markdown fences.';
      userMessage = `Translate this content to Vietnamese:\n${content.slice(0, 5000)}`;
      break;

    case 'accessibility_check':
      systemPrompt =
        'You are an accessibility and inclusive design expert for e-learning. ' +
        'Review the provided content and check for: ' +
        '1) Missing alt text for images (look for <img> tags without alt attributes), ' +
        '2) Reading level (target grade 8–10 for general audiences), ' +
        '3) Document structure (proper heading hierarchy, lists, paragraphs), ' +
        '4) Colour/contrast issues mentioned in the text, ' +
        '5) Plain language and avoidance of jargon without explanation. ' +
        'Return JSON: { result: "<overall accessibility assessment>", suggestions: ["<specific issue and fix 1>", ...] }. ' +
        'Return ONLY valid JSON — no prose, no markdown fences.';
      userMessage = `Perform accessibility check on this content:\n${content.slice(0, 5000)}`;
      break;
  }

  const aiText = await callAI(env, systemPrompt, userMessage, 2048);
  if (!aiText) return json({ error: 'AI tạm thời không khả dụng' }, 502);

  const parsed = parseAIJson(aiText);
  if (!parsed) {
    return json({ result: aiText, suggestions: [] });
  }
  return json({
    result: parsed.result ?? null,
    suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
  });
}

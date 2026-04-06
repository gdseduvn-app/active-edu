/**
 * Adaptive Recommendation Engine
 * Route: GET /api/student/recommendations?course_id=X
 *
 * Algorithm:
 * 1. Lấy student mastery từ D1 (student_mastery table)
 * 2. Xác định weak outcomes: bkt_state < 0.6 hoặc chưa học (null)
 * 3. Lấy alignments cho course → outcome → article mapping
 * 4. Filter bỏ articles student đã hoàn thành (NOCO_PROGRESS)
 * 5. Sort theo priority: (1-bkt_state) × alignment_strength
 * 6. Trả về top 5 recommendations
 */

import { verifyToken, getTokenSecret } from '../auth.js';
import { nocoFetch } from '../db.js';

// ── GET /api/student/recommendations?course_id=X ─────────────
export async function handleStudentRecommendations(request, env, { json, url }) {
  // 1. Xác thực token học sinh
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return json({ error: 'Unauthorized' }, 401);

  const secret = getTokenSecret(env);
  const session = await verifyToken(token, secret);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const userId = String(session.userId);
  const courseId = url.searchParams.get('course_id');
  if (!courseId) return json({ error: 'Thiếu course_id' }, 400);

  if (!env.NOCO_ALIGNMENTS) return json({ recommendations: [] });

  // 2. Lấy alignments cho course: outcome_code → article_id, alignment_strength
  const alr = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_ALIGNMENTS}/records?where=${encodeURIComponent(`(CourseId,eq,${courseId})`)}&limit=200&fields=ItemId,OutcomeCode,OutcomeId,AlignmentStrength`
  );
  if (!alr.ok) return json({ recommendations: [] });
  const alignments = (await alr.json()).list || [];
  if (!alignments.length) return json({ recommendations: [] });

  const outcomeCodes = [...new Set(alignments.map(a => a.OutcomeCode).filter(Boolean))];

  // 3. Lấy mastery của học sinh này từ D1
  const masteryMap = {}; // outcomeCode → bkt_state
  if (env.D1 && outcomeCodes.length) {
    try {
      const placeholders = outcomeCodes.map(() => '?').join(',');
      const result = await env.D1.prepare(
        `SELECT outcome_code, bkt_state FROM student_mastery WHERE student_id = ? AND outcome_code IN (${placeholders})`
      ).bind(userId, ...outcomeCodes).all();
      for (const row of (result.results || [])) {
        masteryMap[row.outcome_code] = row.bkt_state;
      }
    } catch (e) { console.error('[D1 mastery read]', e.message); }
  }

  // 4. Xác định weak outcomes: bkt_state < 0.6 hoặc chưa có data (null = 0)
  const weakOutcomes = outcomeCodes.filter(code => (masteryMap[code] ?? 0) < 0.6);
  if (!weakOutcomes.length) return json({ recommendations: [], message: 'Tất cả chuẩn đầu ra đã đạt!' });

  // 5. Lấy outcome titles cho weak outcomes
  const outcomeDetails = {};
  if (env.NOCO_OUTCOMES && weakOutcomes.length) {
    try {
      const encoded = weakOutcomes.map(c => `(Code,eq,${c})`).join('~or');
      const oR = await nocoFetch(env,
        `/api/v2/tables/${env.NOCO_OUTCOMES}/records?where=${encodeURIComponent(encoded)}&fields=Code,TitleVi&limit=50`
      );
      if (oR.ok) {
        for (const o of ((await oR.json()).list || [])) outcomeDetails[o.Code] = o;
      }
    } catch {}
  }

  // 6. Build candidate articles từ weak outcomes × alignments
  // candidateMap: articleId → { outcomeCode, alignmentStrength, bktState }
  const candidateMap = {};
  for (const al of alignments) {
    if (!al.ItemId || !weakOutcomes.includes(al.OutcomeCode)) continue;
    const key = String(al.ItemId);
    const bkt = masteryMap[al.OutcomeCode] ?? 0;
    const strength = parseFloat(al.AlignmentStrength) || 0.5;
    const priority = (1 - bkt) * strength; // higher = cần học hơn

    if (!candidateMap[key] || candidateMap[key].priority < priority) {
      candidateMap[key] = {
        article_id: key,
        outcome_code: al.OutcomeCode,
        alignment_strength: strength,
        bkt_state: bkt,
        priority,
      };
    }
  }

  const candidateIds = Object.keys(candidateMap);
  if (!candidateIds.length) return json({ recommendations: [] });

  // 7. Filter bỏ articles đã hoàn thành
  let completedIds = new Set();
  if (env.NOCO_PROGRESS && candidateIds.length) {
    try {
      const inFilter = candidateIds.join(',');
      const pr = await nocoFetch(env,
        `/api/v2/tables/${env.NOCO_PROGRESS}/records?where=${encodeURIComponent(`(UserId,eq,${userId})~and(ArticleId,in,${inFilter})~and(Completed,eq,true)`)}&fields=ArticleId&limit=200`
      );
      if (pr.ok) {
        for (const p of ((await pr.json()).list || [])) completedIds.add(String(p.ArticleId));
      }
    } catch {}
  }

  const pendingIds = candidateIds.filter(id => !completedIds.has(id));
  if (!pendingIds.length) return json({ recommendations: [], message: 'Tất cả bài học liên quan đã hoàn thành!' });

  // 8. Lấy article titles
  let articleTitles = {};
  if (env.NOCO_ARTICLE && pendingIds.length) {
    try {
      const inFilter = pendingIds.join(',');
      const ar = await nocoFetch(env,
        `/api/v2/tables/${env.NOCO_ARTICLE}/records?where=${encodeURIComponent(`(Id,in,${inFilter})`)}&fields=Id,Title,ModuleId&limit=50`
      );
      if (ar.ok) {
        for (const a of ((await ar.json()).list || [])) articleTitles[String(a.Id)] = a;
      }
    } catch {}
  }

  // 9. Build final recommendations, sort by priority desc, top 5
  const recommendations = pendingIds
    .map(id => {
      const cand = candidateMap[id];
      const article = articleTitles[id] || {};
      const outTitle = outcomeDetails[cand.outcome_code]?.TitleVi || cand.outcome_code;
      const bktPct = Math.round(cand.bkt_state * 100);
      return {
        article_id: id,
        title: article.Title || `Bài #${id}`,
        module_id: article.ModuleId ? String(article.ModuleId) : null,
        outcome_code: cand.outcome_code,
        outcome_title: outTitle,
        priority: cand.bkt_state === 0 ? 'high' : cand.bkt_state < 0.4 ? 'high' : 'medium',
        reason: cand.bkt_state === 0
          ? `Chưa học chuẩn: ${outTitle}`
          : `Cần cải thiện: ${outTitle} (${bktPct}% thành thạo)`,
        _priority_score: cand.priority,
      };
    })
    .sort((a, b) => b._priority_score - a._priority_score)
    .slice(0, 5)
    .map(({ _priority_score, ...r }) => r); // bỏ internal field

  return json({ recommendations });
}

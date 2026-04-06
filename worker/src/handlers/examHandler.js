import { getTokenSecret, verifyToken, makeQToken, verifyQToken } from '../auth.js';
import { nocoFetch } from '../db.js';
import { checkRateLimit, idempotencyCheck, idempotencyStore, SEC_HEADERS } from '../middleware.js';

export async function handleExamList(request, env, { json, url }) {
  if (!env.NOCO_EXAMS) return json({ list: [] });
  const r = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_EXAMS}/records?where=(Status,eq,published)&fields=Id,Title,Description,ModuleId,TimeLimit,PassScore,TotalPoints&limit=200${url.search ? '&' + url.search.slice(1) : ''}`
  );
  return json(await r.json());
}

export async function handleQBankList(request, env, { json, url }) {
  if (!env.NOCO_QBANK) return json({ list: [] });
  const r = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_QBANK}/records?fields=Id,Title,GroupName,Description,QuestionCount&limit=200${url.search ? '&' + url.search.slice(1) : ''}`
  );
  return json(await r.json());
}

export async function handleExamGet(request, env, { json, path }) {
  const examId = path.slice('/api/exam/'.length);
  if (!examId || !env.NOCO_EXAMS || !env.NOCO_EXAM_SECTIONS || !env.NOCO_QBANK)
    return json({ error: 'Exam chưa được cấu hình' }, 503);

  const examR = await nocoFetch(env, `/api/v2/tables/${env.NOCO_EXAMS}/records/${examId}`);
  if (!examR.ok) return json({ error: 'Không tìm thấy đề thi' }, 404);
  const exam = await examR.json();
  if (exam.Status !== 'published') return json({ error: 'Đề thi chưa công bố' }, 403);

  const secR = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_EXAM_SECTIONS}/records?where=(ExamId,eq,${examId})&sort=Id&limit=100`
  );
  const sections = (await secR.json()).list || [];
  if (!sections.length) return json({ error: 'Đề thi chưa có phần nào' }, 400);

  const resultSections = [];
  let totalPoints = 0;

  for (const sec of sections) {
    const bankR = await nocoFetch(env, `/api/v2/tables/${env.NOCO_QBANK}/records/${sec.BankId}`);
    if (!bankR.ok) continue;
    const bank = await bankR.json();
    let allQuestions = [];
    try { allQuestions = JSON.parse(bank.Questions || '[]'); } catch { continue; }

    const count = Math.min(sec.QuestionCount || 1, allQuestions.length);
    const shuffled = [...allQuestions];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const sampled = shuffled.slice(0, count);
    totalPoints += count * (sec.PointsPerQuestion || 1);

    const sanitized = await Promise.all(sampled.map(async (q, qi) => {
      const origIdx = allQuestions.indexOf(q);
      const qToken = await makeQToken(env, examId, sec.BankId, origIdx);
      return {
        id: `${sec.Id}_${qi}`, sectionId: sec.Id, qToken,
        question: q.question, type: q.type || 'mcq',
        options: (q.options || []).map((o, oi) => ({ id: oi, text: typeof o === 'string' ? o : o.text })),
        points: sec.PointsPerQuestion || 1,
      };
    }));

    resultSections.push({ sectionId: sec.Id, bankTitle: bank.Title || '', pointsPerQuestion: sec.PointsPerQuestion || 1, questions: sanitized });
  }

  return json({ examId: exam.Id, title: exam.Title, description: exam.Description || '', timeLimit: exam.TimeLimit || 0, passScore: exam.PassScore || 60, totalPoints, sections: resultSections });
}

export async function handleExamSubmit(request, env, { json, path, cors }) {
  const authHeader = request.headers.get('Authorization') || '';
  const secret = getTokenSecret(env);
  const session = await verifyToken(authHeader.replace('Bearer ', ''), secret);
  if (!session) return json({ error: 'Đăng nhập để nộp bài' }, 401);

  const submitRl = await checkRateLimit(`submit:${session.userId}`, env, 'submit', 30, 3600);
  if (!submitRl.allowed) return json({ error: 'Nộp bài quá nhiều lần. Thử lại sau 1 giờ.' }, 429);

  const examIdemKey = request.headers.get('Idempotency-Key');
  if (examIdemKey) {
    const cached = await idempotencyCheck(env, examIdemKey);
    if (cached) return new Response(cached.body, { status: cached.status, headers: { ...cors, 'Content-Type': 'application/json', 'X-Idempotent-Replayed': 'true' } });
  }

  const examId = path.slice('/api/exam/'.length).replace('/submit', '');
  const body = await request.json().catch(() => ({}));
  const { answers, totalPoints } = body;
  if (!Array.isArray(answers)) return json({ error: 'Dữ liệu không hợp lệ' }, 400);
  if (!env.NOCO_QBANK || !env.NOCO_EXAM_SECTIONS) return json({ error: 'Server chưa cấu hình' }, 503);

  const bySection = {};
  for (const ans of answers) {
    if (!bySection[ans.sectionId]) bySection[ans.sectionId] = [];
    bySection[ans.sectionId].push(ans);
  }

  let earnedPoints = 0;
  const sectionResults = [];

  for (const [sectionId, sectionAnswers] of Object.entries(bySection)) {
    const secR = await nocoFetch(env, `/api/v2/tables/${env.NOCO_EXAM_SECTIONS}/records?where=(Id,eq,${sectionId})&limit=1`);
    const sec = ((await secR.json()).list || [])[0];
    if (!sec) continue;

    const bankR = await nocoFetch(env, `/api/v2/tables/${env.NOCO_QBANK}/records/${sec.BankId}`);
    if (!bankR.ok) continue;
    let allQ = [];
    try { allQ = JSON.parse((await bankR.json()).Questions || '[]'); } catch { continue; }

    let sectionCorrect = 0;
    const qResults = [];
    for (const ans of sectionAnswers) {
      const decoded = await verifyQToken(env, examId, ans.qToken);
      if (!decoded) { qResults.push({ questionId: ans.questionId, isCorrect: false, correctOptionId: -1 }); continue; }
      if (decoded.bankId !== sec.BankId) { qResults.push({ questionId: ans.questionId, isCorrect: false, correctOptionId: -1 }); continue; }
      const q = allQ[decoded.origIdx];
      if (!q) continue;
      const correctIdx = (q.options || []).findIndex(o => typeof o === 'object' ? o.correct : false);
      const isCorrect = ans.optionId === correctIdx;
      if (isCorrect) { sectionCorrect++; earnedPoints += sec.PointsPerQuestion || 1; }
      qResults.push({ questionId: ans.questionId, correctOptionId: correctIdx, isCorrect, explanation: q.explanation || null });
    }
    sectionResults.push({ sectionId, correct: sectionCorrect, results: qResults });
  }

  const possible = totalPoints || 100;
  const scorePercent = Math.round((earnedPoints / possible) * 100);

  if (env.NOCO_PROGRESS) {
    (async () => {
      const key = `exam_${examId}`;
      const ex = await nocoFetch(env, `/api/v2/tables/${env.NOCO_PROGRESS}/records?where=(UserId,eq,${session.userId})~and(ArticleId,eq,${key})&limit=1&fields=Id,Score`);
      const row = ((await ex.json()).list || [])[0];
      if (row) {
        if (scorePercent > (row.Score || 0))
          await nocoFetch(env, `/api/v2/tables/${env.NOCO_PROGRESS}/records`, 'PATCH', [{ Id: row.Id, Score: scorePercent, Completed: scorePercent >= 60 }]);
      } else {
        await nocoFetch(env, `/api/v2/tables/${env.NOCO_PROGRESS}/records`, 'POST', { UserId: session.userId, ArticleId: key, Score: scorePercent, Completed: scorePercent >= 60, CompletedAt: new Date().toISOString() });
      }
    })().catch(() => {});
  }

  const resultBody = JSON.stringify({ score: scorePercent, earnedPoints, totalPoints: possible, sectionResults });
  if (examIdemKey) idempotencyStore(env, examIdemKey, 200, resultBody);
  return new Response(resultBody, { status: 200, headers: { ...cors, ...SEC_HEADERS, 'Content-Type': 'application/json' } });
}

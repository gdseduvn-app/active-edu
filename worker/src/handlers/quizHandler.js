import { getTokenSecret, verifyToken } from '../auth.js';
import { nocoFetch } from '../db.js';
import { updateAnalyticsScore } from '../analytics.js';

export async function handleQuizGet(request, env, { json, path }) {
  const articleId = path.slice('/api/quiz/'.length);
  if (!articleId || !env.NOCO_QUIZ) return json({ questions: [] });

  const r = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_QUIZ}/records?where=(ArticleId,eq,${encodeURIComponent(articleId)})&limit=1&fields=Id,Questions`
  );
  if (!r.ok) return json({ questions: [] });
  const data = await r.json();
  const row = (data.list || [])[0];
  if (!row || !row.Questions) return json({ questions: [] });

  let questions;
  try { questions = JSON.parse(row.Questions); } catch { return json({ questions: [] }); }

  const sanitized = questions.map((q, qi) => ({
    id: qi, question: q.question,
    options: (q.options || []).map((o, oi) => ({ id: oi, text: typeof o === 'string' ? o : o.text })),
    explanation: q.explanation || null,
  }));
  return json({ quizId: row.Id, questions: sanitized });
}

export async function handleQuizSubmit(request, env, { json }) {
  const authHeader = request.headers.get('Authorization') || '';
  const secret = getTokenSecret(env);
  const session = await verifyToken(authHeader.replace('Bearer ', ''), secret);
  if (!session) return json({ error: 'Đăng nhập để nộp bài' }, 401);
  if (!env.NOCO_QUIZ) return json({ error: 'Quiz chưa được cấu hình' }, 503);

  const { articleId, answers } = await request.json();
  if (!articleId || !Array.isArray(answers)) return json({ error: 'Dữ liệu không hợp lệ' }, 400);

  const r = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_QUIZ}/records?where=(ArticleId,eq,${encodeURIComponent(articleId)})&limit=1&fields=Questions`
  );
  if (!r.ok) return json({ error: 'Không tìm thấy quiz' }, 404);
  const data = await r.json();
  const row = (data.list || [])[0];
  if (!row) return json({ error: 'Không tìm thấy quiz' }, 404);

  let questions;
  try { questions = JSON.parse(row.Questions); } catch { return json({ error: 'Quiz lỗi dữ liệu' }, 500); }

  let correct = 0;
  const results = questions.map((q, qi) => {
    const submitted = answers.find(a => a.questionId === qi);
    const correctOption = (q.options || []).findIndex(o => typeof o === 'object' ? o.correct : false);
    const isCorrect = submitted !== undefined && submitted.optionId === correctOption;
    if (isCorrect) correct++;
    return { questionId: qi, correctOptionId: correctOption, isCorrect, explanation: q.explanation || null };
  });

  const score = Math.round(correct / questions.length * 100);

  nocoFetch(env,
    `/api/v2/tables/${env.NOCO_PROGRESS}/records?where=(UserId,eq,${session.userId})~and(ArticleId,eq,${encodeURIComponent(articleId)})&limit=1&fields=Id,Score`
  ).then(async er => {
    const ed = await er.json();
    const existRow = (ed.list || [])[0];
    if (existRow) {
      if (score > (existRow.Score || 0))
        await nocoFetch(env, `/api/v2/tables/${env.NOCO_PROGRESS}/records`, 'PATCH', [{ Id: existRow.Id, Score: score }]);
    } else {
      await nocoFetch(env, `/api/v2/tables/${env.NOCO_PROGRESS}/records`, 'POST',
        { UserId: session.userId, ArticleId: String(articleId), Score: score });
    }
    if (env.NOCO_ANALYTICS) updateAnalyticsScore(env, String(articleId), score).catch(() => {});
  }).catch(() => {});

  return json({ score, correct, total: questions.length, results });
}

/**
 * Rubric Handler — Assessment rubrics with criteria & ratings
 *
 * GET    /api/rubrics?course_id=X              — list rubrics in course
 * GET    /api/rubrics/:id                       — rubric with all criteria & ratings
 * POST   /api/rubrics                           — create rubric (teacher/admin)
 * PUT    /api/rubrics/:id                       — update rubric metadata
 * DELETE /api/rubrics/:id                       — delete rubric (soft)
 * POST   /api/rubrics/:id/criteria              — add criterion to rubric
 * PUT    /api/rubrics/criteria/:id              — update criterion
 * DELETE /api/rubrics/criteria/:id              — remove criterion
 * POST   /api/submissions/:id/rubric-grade      — grade submission using rubric
 * GET    /api/submissions/:id/rubric-result     — get rubric grade for a submission
 *
 * NocoDB tables required:
 *   env.NOCO_RUBRICS         — Rubrics
 *     Fields: Id, CourseId, Title, Description, TotalPoints, IsDeleted, CreatedBy, CreatedAt
 *   env.NOCO_RUBRIC_CRITERIA — RubricCriteria
 *     Fields: Id, RubricId, Description, MaxPoints, OrderNum
 *   env.NOCO_RUBRIC_RATINGS  — RubricRatings (rating levels per criterion)
 *     Fields: Id, CriteriaId, RubricId, Description, Points
 *
 * D1 table (via /admin/setup/d1-schema):
 *   rubric_grades (submission_id, rubric_id, grader_id, criteria_scores JSON, total, comment, graded_at)
 */
import { getTokenSecret, verifyToken, verifyAdminAuth } from '../auth.js';
import { nocoFetch } from '../db.js';

async function getSession(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '');
  if (!token) return null;
  return verifyToken(token, getTokenSecret(env));
}

function isTeacherOrAdmin(role) {
  return role === 'admin' || role === 'teacher';
}

// ── GET /api/rubrics?course_id=X ─────────────────────────────
export async function handleListRubrics(request, env, { json, url }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const courseId = url.searchParams.get('course_id');
  if (!env.NOCO_RUBRICS) return json({ rubrics: [] });

  let where = `(IsDeleted,eq,false)`;
  if (courseId) where += `~and(CourseId,eq,${courseId})`;

  const r = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_RUBRICS}/records?where=${encodeURIComponent(where)}&limit=100&sort=-CreatedAt`
  );
  if (!r.ok) return json({ rubrics: [] });
  const data = await r.json();
  return json({ rubrics: data.list || [] });
}

// ── GET /api/rubrics/:id ──────────────────────────────────────
export async function handleGetRubric(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const id = path.split('/')[3];
  if (!id || !env.NOCO_RUBRICS) return json({ error: 'Not found' }, 404);

  const rR = await nocoFetch(env, `/api/v2/tables/${env.NOCO_RUBRICS}/records/${id}`);
  if (!rR.ok) return json({ error: 'Không tìm thấy rubric' }, 404);
  const rubric = await rR.json();
  if (rubric.IsDeleted) return json({ error: 'Rubric đã bị xoá' }, 404);

  // Fetch criteria
  let criteria = [];
  if (env.NOCO_RUBRIC_CRITERIA) {
    const cR = await nocoFetch(env,
      `/api/v2/tables/${env.NOCO_RUBRIC_CRITERIA}/records?where=${encodeURIComponent(`(RubricId,eq,${id})`)}&limit=50&sort=OrderNum`
    );
    if (cR.ok) criteria = (await cR.json()).list || [];
  }

  // Fetch ratings for each criterion
  let ratingsMap = {};
  if (env.NOCO_RUBRIC_RATINGS && criteria.length > 0) {
    const cIds = criteria.map(c => `(CriteriaId,eq,${c.Id})`).join('~or');
    const ratingR = await nocoFetch(env,
      `/api/v2/tables/${env.NOCO_RUBRIC_RATINGS}/records?where=${encodeURIComponent(cIds)}&limit=500&sort=Points`
    );
    if (ratingR.ok) {
      for (const rating of ((await ratingR.json()).list || [])) {
        if (!ratingsMap[rating.CriteriaId]) ratingsMap[rating.CriteriaId] = [];
        ratingsMap[rating.CriteriaId].push(rating);
      }
    }
  }

  const criteriaWithRatings = criteria.map(c => ({
    ...c,
    ratings: (ratingsMap[c.Id] || []).sort((a, b) => b.Points - a.Points),
  }));

  return json({ rubric, criteria: criteriaWithRatings });
}

// ── POST /api/rubrics ─────────────────────────────────────────
export async function handleCreateRubric(request, env, { json }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!isTeacherOrAdmin(session.role)) return json({ error: 'Chỉ giáo viên/admin có thể tạo rubric' }, 403);
  if (!env.NOCO_RUBRICS) return json({ error: 'Tính năng rubric chưa được cấu hình' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { course_id, title, description, criteria = [] } = body;
  if (!course_id) return json({ error: 'Thiếu course_id' }, 400);
  if (!title || title.trim().length < 2) return json({ error: 'Tiêu đề ít nhất 2 ký tự' }, 400);

  // Calculate total points from criteria
  const totalPoints = criteria.reduce((sum, c) => sum + (parseInt(c.max_points) || 0), 0);
  const now = new Date().toISOString();

  const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_RUBRICS}/records`, 'POST', {
    CourseId: String(course_id),
    Title: title.trim().slice(0, 255),
    Description: (description || '').trim().slice(0, 2000),
    TotalPoints: totalPoints,
    IsDeleted: false,
    CreatedBy: String(session.userId),
    CreatedAt: now,
  });

  if (!r.ok) return json({ error: 'Không thể tạo rubric' }, 502);
  const rubric = await r.json();
  const rubricId = rubric.Id;

  // Create criteria in parallel if provided
  if (criteria.length > 0 && env.NOCO_RUBRIC_CRITERIA) {
    await Promise.all(criteria.map((c, i) =>
      nocoFetch(env, `/api/v2/tables/${env.NOCO_RUBRIC_CRITERIA}/records`, 'POST', {
        RubricId: String(rubricId),
        Description: (c.description || c.title || '').slice(0, 500),
        MaxPoints: parseInt(c.max_points) || 10,
        OrderNum: i + 1,
      }).then(async r2 => {
        if (r2.ok && c.ratings?.length && env.NOCO_RUBRIC_RATINGS) {
          const criterion = await r2.json();
          await Promise.all(c.ratings.map(rating =>
            nocoFetch(env, `/api/v2/tables/${env.NOCO_RUBRIC_RATINGS}/records`, 'POST', {
              CriteriaId: String(criterion.Id),
              RubricId: String(rubricId),
              Description: rating.description || '',
              Points: parseInt(rating.points) || 0,
            })
          ));
        }
      })
    ));
  }

  return json({ ok: true, rubric_id: rubricId, rubric }, 201);
}

// ── PUT /api/rubrics/:id ──────────────────────────────────────
export async function handleUpdateRubric(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!isTeacherOrAdmin(session.role)) return json({ error: 'Không có quyền chỉnh sửa' }, 403);

  const id = path.split('/')[3];
  if (!id || !env.NOCO_RUBRICS) return json({ error: 'Not found' }, 404);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const patch = {};
  if (body.title) patch.Title = body.title.trim().slice(0, 255);
  if (body.description !== undefined) patch.Description = body.description.trim().slice(0, 2000);

  if (Object.keys(patch).length > 0) {
    await nocoFetch(env, `/api/v2/tables/${env.NOCO_RUBRICS}/records/${id}`, 'PATCH', patch);
  }
  return json({ ok: true });
}

// ── DELETE /api/rubrics/:id ───────────────────────────────────
export async function handleDeleteRubric(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!isTeacherOrAdmin(session.role)) return json({ error: 'Không có quyền xoá' }, 403);

  const id = path.split('/')[3];
  if (!id || !env.NOCO_RUBRICS) return json({ error: 'Not found' }, 404);

  await nocoFetch(env, `/api/v2/tables/${env.NOCO_RUBRICS}/records/${id}`, 'PATCH', { IsDeleted: true });
  return json({ ok: true });
}

// ── POST /api/rubrics/:id/criteria ────────────────────────────
export async function handleAddCriterion(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!isTeacherOrAdmin(session.role)) return json({ error: 'Không có quyền' }, 403);
  if (!env.NOCO_RUBRIC_CRITERIA) return json({ error: 'Chưa cấu hình' }, 503);

  const rubricId = path.split('/')[3];

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { description, max_points, order_num, ratings = [] } = body;
  if (!description) return json({ error: 'Thiếu mô tả tiêu chí' }, 400);

  const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_RUBRIC_CRITERIA}/records`, 'POST', {
    RubricId: String(rubricId),
    Description: description.slice(0, 500),
    MaxPoints: parseInt(max_points) || 10,
    OrderNum: order_num || 99,
  });
  if (!r.ok) return json({ error: 'Không thể thêm tiêu chí' }, 502);
  const criterion = await r.json();

  // Add ratings
  if (ratings.length > 0 && env.NOCO_RUBRIC_RATINGS) {
    await Promise.all(ratings.map(rating =>
      nocoFetch(env, `/api/v2/tables/${env.NOCO_RUBRIC_RATINGS}/records`, 'POST', {
        CriteriaId: String(criterion.Id),
        RubricId: String(rubricId),
        Description: rating.description || '',
        Points: parseInt(rating.points) || 0,
      })
    ));
  }

  // Recalculate rubric total
  if (env.NOCO_RUBRIC_CRITERIA) {
    const allCR = await nocoFetch(env,
      `/api/v2/tables/${env.NOCO_RUBRIC_CRITERIA}/records?where=${encodeURIComponent(`(RubricId,eq,${rubricId})`)}&fields=MaxPoints&limit=100`
    );
    if (allCR.ok) {
      const allC = (await allCR.json()).list || [];
      const newTotal = allC.reduce((s, c) => s + (c.MaxPoints || 0), 0);
      nocoFetch(env, `/api/v2/tables/${env.NOCO_RUBRICS}/records/${rubricId}`, 'PATCH', { TotalPoints: newTotal });
    }
  }

  return json({ ok: true, criterion }, 201);
}

// ── POST /api/submissions/:id/rubric-grade ────────────────────
export async function handleRubricGrade(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!isTeacherOrAdmin(session.role)) return json({ error: 'Chỉ giáo viên/admin có thể chấm rubric' }, 403);

  const submissionId = path.split('/')[3];
  if (!submissionId) return json({ error: 'Not found' }, 404);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { rubric_id, scores, comment = '' } = body;
  // scores: { [criteriaId]: points_awarded }
  if (!rubric_id) return json({ error: 'Thiếu rubric_id' }, 400);
  if (!scores || typeof scores !== 'object') return json({ error: 'Thiếu scores ({ criteriaId: points })' }, 400);

  // Validate: check all criteria exist and scores are in range
  let totalAwarded = 0;
  const criteriaScores = {};
  if (env.NOCO_RUBRIC_CRITERIA) {
    const cR = await nocoFetch(env,
      `/api/v2/tables/${env.NOCO_RUBRIC_CRITERIA}/records?where=${encodeURIComponent(`(RubricId,eq,${rubric_id})`)}&limit=100`
    );
    if (cR.ok) {
      const criteria = (await cR.json()).list || [];
      for (const c of criteria) {
        const awarded = Math.max(0, Math.min(c.MaxPoints || 0, parseFloat(scores[c.Id] ?? scores[String(c.Id)] ?? 0)));
        criteriaScores[c.Id] = awarded;
        totalAwarded += awarded;
      }
    }
  } else {
    // If criteria table not set up, just sum all scores given
    for (const [k, v] of Object.entries(scores)) {
      criteriaScores[k] = parseFloat(v) || 0;
      totalAwarded += criteriaScores[k];
    }
  }

  const now = new Date().toISOString();

  if (env.D1) {
    try {
      await env.D1.prepare(
        `INSERT OR REPLACE INTO rubric_grades
         (submission_id, rubric_id, grader_id, criteria_scores, total, comment, graded_at)
         VALUES (?,?,?,?,?,?,?)`
      ).bind(
        String(submissionId),
        String(rubric_id),
        String(session.userId),
        JSON.stringify(criteriaScores),
        totalAwarded,
        comment.slice(0, 2000),
        now
      ).run();
    } catch (e) {
      // D1 table may not exist yet — create inline
      try {
        await env.D1.prepare(`CREATE TABLE IF NOT EXISTS rubric_grades (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          submission_id TEXT NOT NULL,
          rubric_id TEXT NOT NULL,
          grader_id TEXT,
          criteria_scores TEXT,
          total REAL DEFAULT 0,
          comment TEXT,
          graded_at TEXT,
          UNIQUE(submission_id, rubric_id)
        )`).run();
        await env.D1.prepare(
          `INSERT OR REPLACE INTO rubric_grades (submission_id, rubric_id, grader_id, criteria_scores, total, comment, graded_at) VALUES (?,?,?,?,?,?,?)`
        ).bind(String(submissionId), String(rubric_id), String(session.userId), JSON.stringify(criteriaScores), totalAwarded, comment.slice(0, 2000), now).run();
      } catch (e2) {
        return json({ error: 'Không thể lưu điểm rubric: ' + e2.message }, 500);
      }
    }
  }

  // Update submission score in NocoDB (if NOCO_SUBMISSIONS is set)
  if (env.NOCO_SUBMISSIONS) {
    nocoFetch(env, `/api/v2/tables/${env.NOCO_SUBMISSIONS}/records/${submissionId}`, 'PATCH', {
      Score: totalAwarded,
      GradedAt: now,
      GradedBy: String(session.userId),
      RubricComment: comment.slice(0, 2000),
    });
  }

  return json({ ok: true, total: totalAwarded, criteria_scores: criteriaScores });
}

// ── GET /api/submissions/:id/rubric-result ────────────────────
export async function handleRubricResult(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const submissionId = path.split('/')[3];
  if (!submissionId || !env.D1) return json({ grade: null });

  try {
    const grade = await env.D1.prepare(
      `SELECT * FROM rubric_grades WHERE submission_id=? ORDER BY graded_at DESC LIMIT 1`
    ).bind(String(submissionId)).first();

    if (!grade) return json({ grade: null });

    let criteriaDetail = [];
    if (grade.criteria_scores && env.NOCO_RUBRIC_CRITERIA) {
      const scores = JSON.parse(grade.criteria_scores || '{}');
      const cIds = Object.keys(scores);
      if (cIds.length > 0) {
        const cR = await nocoFetch(env,
          `/api/v2/tables/${env.NOCO_RUBRIC_CRITERIA}/records?where=${encodeURIComponent(cIds.map(id => `(Id,eq,${id})`).join('~or'))}&limit=50&sort=OrderNum`
        );
        if (cR.ok) {
          criteriaDetail = (await cR.json()).list.map(c => ({
            id: c.Id,
            description: c.Description,
            max_points: c.MaxPoints,
            awarded: scores[c.Id] || 0,
          }));
        }
      }
    }

    return json({
      grade: {
        submission_id: grade.submission_id,
        rubric_id: grade.rubric_id,
        total: grade.total,
        comment: grade.comment,
        graded_at: grade.graded_at,
        criteria: criteriaDetail,
        criteria_scores: JSON.parse(grade.criteria_scores || '{}'),
      }
    });
  } catch {
    return json({ grade: null });
  }
}

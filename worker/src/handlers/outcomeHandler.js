/**
 * Outcome Handler — CT GDPT 2018 (TT17/2025) Endpoints
 *
 * Endpoints:
 *   GET  /api/outcomes               — List outcomes (filterable by subject/grade/level)
 *   GET  /api/outcomes/:id           — Get single outcome with children
 *   POST /api/outcomes               — Create outcome (admin/teacher only)
 *   GET  /api/alignments             — Get item↔outcome alignments for a course/item
 *   POST /api/alignments             — Create alignment (admin/teacher only)
 *   DELETE /api/alignments/:id       — Remove alignment (admin/teacher only)
 *
 * Admin setup:
 *   POST /admin/setup/schema-phase1  — Create all 3 Phase-1 tables in NocoDB
 *   POST /admin/setup/seed-outcomes  — Seed CT GDPT 2018 base outcomes structure
 */

import { nocoFetch } from '../db.js';
import { getTokenSecret, verifyToken, verifyAdminAuth } from '../auth.js';

// ── Auth helpers ──────────────────────────────────────────────────────────────
async function requireTeacherOrAdmin(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const secret  = getTokenSecret(env);
  const session = await verifyToken(authHeader.replace('Bearer ', ''), secret);
  if (!session) return null;
  if (!['admin', 'teacher'].includes(session.role || '')) return null;
  return session;
}

// ── GET /api/outcomes ─────────────────────────────────────────────────────────
export async function handleListOutcomes(request, env, { json }) {
  if (!env.NOCO_OUTCOMES)
    return json({ outcomes: [], note: 'NOCO_OUTCOMES not configured. Run POST /admin/setup/schema-phase1.' });

  const url = new URL(request.url);
  const subject  = url.searchParams.get('subject')  || '';
  const grade    = url.searchParams.get('grade')    || '';
  const level    = url.searchParams.get('level')    || '';
  const parentId = url.searchParams.get('parent_id') || '';
  const search   = url.searchParams.get('q')        || '';
  const limit    = Math.min(500, parseInt(url.searchParams.get('limit') || '200'));

  const filters = [];
  if (subject)  filters.push(`(Subject,eq,${subject})`);
  if (grade)    filters.push(`(Grade,eq,${grade})`);
  if (level)    filters.push(`(Level,eq,${level})`);
  if (parentId) filters.push(`(ParentId,eq,${parentId})`);
  if (search)   filters.push(`(TitleVi,like,%${search}%)`);

  const where = filters.length ? `?where=${encodeURIComponent(filters.join('~and'))}&` : '?';

  const r = await nocoFetch(
    env,
    `/api/v2/tables/${env.NOCO_OUTCOMES}/records` +
    `${where}fields=Id,Code,Subject,Grade,Level,TitleVi,Description,ParentId,EstimatedHours` +
    `&limit=${limit}&sort=Code`
  );

  if (!r.ok) return json({ error: `NocoDB error (${r.status})` }, r.status);
  const data = await r.json();

  return json({
    outcomes: data.list || [],
    total:    data.pageInfo?.totalRows ?? (data.list || []).length,
  });
}

// ── GET /api/outcomes/:id ─────────────────────────────────────────────────────
export async function handleGetOutcome(request, env, { json, path }) {
  if (!env.NOCO_OUTCOMES) return json({ error: 'NOCO_OUTCOMES not configured.' }, 503);

  const id = path.split('/').pop();
  const r  = await nocoFetch(
    env,
    `/api/v2/tables/${env.NOCO_OUTCOMES}/records/${id}` +
    `?fields=Id,Code,Subject,Grade,Level,TitleVi,Description,ParentId,EstimatedHours`
  );
  if (!r.ok) return json({ error: 'Outcome not found.' }, 404);
  const outcome = await r.json();

  // Fetch children
  const cr = await nocoFetch(
    env,
    `/api/v2/tables/${env.NOCO_OUTCOMES}/records` +
    `?where=${encodeURIComponent(`(ParentId,eq,${id})`)}` +
    `&fields=Id,Code,TitleVi,Level&limit=100&sort=Code`
  );
  const children = cr.ok ? (await cr.json()).list || [] : [];

  return json({ ...outcome, children });
}

// ── POST /api/outcomes ────────────────────────────────────────────────────────
export async function handleCreateOutcome(request, env, { json }) {
  const session = await requireTeacherOrAdmin(request, env);
  if (!session) return json({ error: 'Yêu cầu quyền giáo viên hoặc admin.' }, 403);
  if (!env.NOCO_OUTCOMES) return json({ error: 'NOCO_OUTCOMES not configured.' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { Code, Subject, Grade, Level, TitleVi, Description, ParentId, EstimatedHours } = body;
  if (!Code || !TitleVi) return json({ error: 'Code and TitleVi are required.' }, 400);

  const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_OUTCOMES}/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Code, Subject, Grade: Grade || '', Level: Level || 1,
      TitleVi, Description: Description || '', ParentId: ParentId || null,
      EstimatedHours: EstimatedHours || 1 }),
  });

  if (!r.ok) return json({ error: `Create failed (${r.status})` }, r.status);
  return json(await r.json(), 201);
}

// ── GET /api/alignments ───────────────────────────────────────────────────────
export async function handleListAlignments(request, env, { json }) {
  if (!env.NOCO_ALIGNMENTS) return json({ alignments: [], note: 'NOCO_ALIGNMENTS not configured.' });

  const url    = new URL(request.url);
  const itemId = url.searchParams.get('item_id')   || '';
  const courseId= url.searchParams.get('course_id') || '';

  const filters = [];
  if (itemId)   filters.push(`(ItemId,eq,${itemId})`);
  if (courseId) filters.push(`(CourseId,eq,${courseId})`);

  const where = filters.length
    ? `?where=${encodeURIComponent(filters.join('~and'))}&`
    : '?';

  const r = await nocoFetch(
    env,
    `/api/v2/tables/${env.NOCO_ALIGNMENTS}/records` +
    `${where}fields=Id,ItemId,CourseId,OutcomeId,OutcomeCode,AlignmentStrength,CreatedBy` +
    `&limit=200`
  );
  if (!r.ok) return json({ error: `NocoDB error (${r.status})` }, r.status);
  const data = await r.json();
  return json({ alignments: data.list || [] });
}

// ── POST /api/alignments ──────────────────────────────────────────────────────
export async function handleCreateAlignment(request, env, { json }) {
  const session = await requireTeacherOrAdmin(request, env);
  if (!session) return json({ error: 'Yêu cầu quyền giáo viên hoặc admin.' }, 403);
  if (!env.NOCO_ALIGNMENTS) return json({ error: 'NOCO_ALIGNMENTS not configured.' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { ItemId, CourseId, OutcomeId, OutcomeCode, AlignmentStrength = 1.0 } = body;
  if (!ItemId || !OutcomeId) return json({ error: 'ItemId and OutcomeId are required.' }, 400);

  const strength = Math.max(0, Math.min(1, Number(AlignmentStrength) || 1.0));

  const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_ALIGNMENTS}/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ItemId, CourseId: CourseId || null, OutcomeId,
      OutcomeCode: OutcomeCode || '', AlignmentStrength: strength,
      CreatedBy: session.userId }),
  });

  if (!r.ok) return json({ error: `Create failed (${r.status})` }, r.status);
  return json(await r.json(), 201);
}

// ── DELETE /api/alignments/:id ────────────────────────────────────────────────
export async function handleDeleteAlignment(request, env, { json, path }) {
  const session = await requireTeacherOrAdmin(request, env);
  if (!session) return json({ error: 'Yêu cầu quyền giáo viên hoặc admin.' }, 403);
  if (!env.NOCO_ALIGNMENTS) return json({ error: 'NOCO_ALIGNMENTS not configured.' }, 503);

  const id = path.split('/').pop();
  const r  = await nocoFetch(env, `/api/v2/tables/${env.NOCO_ALIGNMENTS}/records/${id}`, {
    method: 'DELETE',
  });
  if (!r.ok) return json({ error: `Delete failed (${r.status})` }, r.status);
  return json({ deleted: true, id });
}

// ── POST /admin/setup/schema-phase1 ──────────────────────────────────────────
/**
 * Creates 3 tables in NocoDB via Meta API:
 *   Outcomes, Outcome_Alignments, Student_Mastery
 * Idempotent — skips tables that already exist.
 */
export async function handleSetupSchemaPhase1(request, env, { json }) {
  if (!await verifyAdminAuth(request, env)) return json({ error: 'Unauthorized' }, 401);

  // Accept nocoJwt + nocoUrl + projectId from request body to bypass WAF
  const body = await request.json().catch(() => ({}));
  const baseUrl   = body.nocoUrl  || env.NOCO_URL  || '';
  const projectId = body.projectId || env.NOCO_PROJECT_ID || '';
  const apiToken  = body.nocoJwt  || env.NOCO_API_TOKEN   || '';
  const results   = {};

  if (!baseUrl) return json({
    error: 'nocoUrl required',
    hint: 'POST body: { nocoUrl, nocoJwt, projectId }. Get nocoJwt from NocoDB UI → Team & Auth → API Tokens.',
  }, 400);

  // Helper: create a table via NocoDB meta API
  async function createTableIfNeeded(tableName, envKey, fields) {
    if (env[envKey]) {
      results[tableName] = { status: 'already_configured', table_id: env[envKey] };
      return;
    }
    try {
      // NocoDB v2: POST /api/v1/db/meta/projects/:projectId/tables
      const endpoint = projectId
        ? `${baseUrl}/api/v1/db/meta/projects/${projectId}/tables`
        : `${baseUrl}/api/v1/meta/tables`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'xc-auth':      apiToken,
          'xc-token':     apiToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: tableName, columns: fields }),
      });
      if (res.ok) {
        const d = await res.json();
        results[tableName] = {
          status: 'created',
          table_id: d.id,
          cmd: `echo "${d.id}" | npx wrangler secret put NOCO_${envKey.replace('NOCO_','')}`,
        };
      } else {
        const txt = await res.text().catch(() => '');
        results[tableName] = { status: 'error', code: res.status, message: txt.slice(0, 300) };
      }
    } catch (e) {
      results[tableName] = { status: 'exception', message: e.message };
    }
  }

  // ── Table 1: Outcomes ────────────────────────────────────────────────────
  await createTableIfNeeded('Outcomes', 'NOCO_OUTCOMES', [
    { title: 'Code',           uidt: 'SingleLineText' },
    { title: 'Subject',        uidt: 'SingleLineText' },
    { title: 'Grade',          uidt: 'SingleLineText' },
    { title: 'Level',          uidt: 'Number',         cdf: '1' },
    { title: 'TitleVi',        uidt: 'SingleLineText' },
    { title: 'Description',    uidt: 'LongText' },
    { title: 'ParentId',       uidt: 'Number' },
    { title: 'EstimatedHours', uidt: 'Decimal',        cdf: '1' },
    { title: 'Prerequisites',  uidt: 'LongText',  comment: 'JSON array of prerequisite outcome codes' },
  ]);

  // ── Table 2: Outcome_Alignments ──────────────────────────────────────────
  await createTableIfNeeded('Outcome_Alignments', 'NOCO_ALIGNMENTS', [
    { title: 'ItemId',            uidt: 'Number' },
    { title: 'CourseId',          uidt: 'Number' },
    { title: 'OutcomeId',         uidt: 'Number' },
    { title: 'OutcomeCode',       uidt: 'SingleLineText' },
    { title: 'AlignmentStrength', uidt: 'Decimal', cdf: '1.0', comment: '0-1, 1=full alignment' },
    { title: 'CreatedBy',         uidt: 'Number' },
  ]);

  // ── Table 3: Student_Mastery ─────────────────────────────────────────────
  await createTableIfNeeded('Student_Mastery', 'NOCO_STUDENT_MASTERY', [
    { title: 'StudentId',   uidt: 'Number' },
    { title: 'OutcomeId',   uidt: 'Number' },
    { title: 'OutcomeCode', uidt: 'SingleLineText' },
    { title: 'Subject',     uidt: 'SingleLineText' },
    { title: 'Grade',       uidt: 'SingleLineText' },
    { title: 'Score',       uidt: 'Decimal', cdf: '0', comment: '0-1, 1=fully mastered' },
    { title: 'Attempts',    uidt: 'Number',  cdf: '0' },
    { title: 'BktState',    uidt: 'Decimal', cdf: '0.3', comment: 'BKT P(Knowledge) estimate' },
    { title: 'IrtTheta',    uidt: 'Decimal', comment: 'IRT ability estimate (logits)' },
  ]);

  return json({
    message: 'Phase 1 schema setup complete.',
    results,
    next_steps: [
      'Copy the table_id values above into wrangler.toml env vars.',
      'Run POST /admin/setup/seed-outcomes to seed CT GDPT 2018 outcomes.',
      'Deploy worker: npx wrangler deploy',
    ],
  });
}

// ── POST /admin/setup/seed-outcomes ──────────────────────────────────────────
/**
 * Seeds the Outcomes table with the CT GDPT 2018 base structure.
 * Includes: 5 phẩm chất + 10 năng lực chung + subject stubs for 8 core subjects.
 * Teachers/admins can expand with detailed yêu cầu cần đạt per grade.
 */
export async function handleSeedOutcomes(request, env, { json }) {
  if (!await verifyAdminAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
  if (!env.NOCO_OUTCOMES) return json({ error: 'NOCO_OUTCOMES not configured. Run schema-phase1 first.' }, 503);

  const seedData = [
    // ── Phẩm chất (Character traits) ─────────────────────────────────────
    { Code: 'PC.01', Subject: 'CHUNG', Grade: 'ALL', GradeBand: 'CHUNG', Level: 1, TitleVi: 'Yêu nước', Description: 'Yêu thiên nhiên, di sản văn hoá, quê hương, đất nước; có ý thức bảo vệ môi trường tự nhiên và sự đa dạng sinh học', EstimatedHours: 0, ParentCode: null },
    { Code: 'PC.02', Subject: 'CHUNG', Grade: 'ALL', GradeBand: 'CHUNG', Level: 1, TitleVi: 'Nhân ái', Description: 'Yêu con người; tôn trọng sự khác biệt về nhận thức, lối sống; cảm thông, sẵn sàng giúp đỡ mọi người', EstimatedHours: 0, ParentCode: null },
    { Code: 'PC.03', Subject: 'CHUNG', Grade: 'ALL', GradeBand: 'CHUNG', Level: 1, TitleVi: 'Chăm chỉ', Description: 'Luôn cố gắng vươn lên đạt kết quả tốt; không ngừng học hỏi và vươn lên trong cuộc sống', EstimatedHours: 0, ParentCode: null },
    { Code: 'PC.04', Subject: 'CHUNG', Grade: 'ALL', GradeBand: 'CHUNG', Level: 1, TitleVi: 'Trung thực', Description: 'Nhận thức và hành động theo lẽ phải; luôn thành thật và đúng hẹn; giữ lời; không gian lận', EstimatedHours: 0, ParentCode: null },
    { Code: 'PC.05', Subject: 'CHUNG', Grade: 'ALL', GradeBand: 'CHUNG', Level: 1, TitleVi: 'Trách nhiệm', Description: 'Có trách nhiệm với bản thân, gia đình, xã hội; thực hiện tốt nghĩa vụ học sinh, công dân', EstimatedHours: 0, ParentCode: null },
    // ── Năng lực chung (Core competencies) ───────────────────────────────
    { Code: 'NLC.01', Subject: 'CHUNG', Grade: 'ALL', GradeBand: 'CHUNG', Level: 1, TitleVi: 'Tự chủ và tự học', Description: 'Tự xác định mục tiêu học tập; lập và thực hiện kế hoạch học tập; biết điều chỉnh cảm xúc và hành vi của bản thân', EstimatedHours: 0, ParentCode: null },
    { Code: 'NLC.02', Subject: 'CHUNG', Grade: 'ALL', GradeBand: 'CHUNG', Level: 1, TitleVi: 'Giao tiếp và hợp tác', Description: 'Tiếp nhận, xử lí thông tin và biểu đạt hiệu quả; biết lắng nghe và phản hồi tích cực; hợp tác với bạn bè và thầy cô', EstimatedHours: 0, ParentCode: null },
    { Code: 'NLC.03', Subject: 'CHUNG', Grade: 'ALL', GradeBand: 'CHUNG', Level: 1, TitleVi: 'Giải quyết vấn đề và sáng tạo', Description: 'Nhận ra ý tưởng mới; phát hiện và làm rõ vấn đề; đề xuất và lựa chọn giải pháp; thực hiện và đánh giá giải pháp', EstimatedHours: 0, ParentCode: null },
    // ── Năng lực đặc thù (Domain-specific competencies) ──────────────────
    { Code: 'NLD.01', Subject: 'CHUNG', Grade: 'ALL', GradeBand: 'CHUNG', Level: 1, TitleVi: 'Năng lực ngôn ngữ', Description: 'Sử dụng tiếng Việt và ngoại ngữ để giao tiếp, học tập; biết tiếp nhận và tạo lập các kiểu văn bản khác nhau', EstimatedHours: 0, ParentCode: null },
    { Code: 'NLD.02', Subject: 'CHUNG', Grade: 'ALL', GradeBand: 'CHUNG', Level: 1, TitleVi: 'Năng lực tính toán', Description: 'Sử dụng ngôn ngữ toán học để mô tả và giải quyết các tình huống thực tiễn; tư duy lô-gíc và lập luận toán học', EstimatedHours: 0, ParentCode: null },
    { Code: 'NLD.03', Subject: 'CHUNG', Grade: 'ALL', GradeBand: 'CHUNG', Level: 1, TitleVi: 'Năng lực khoa học', Description: 'Nhận thức thế giới tự nhiên và xã hội; tìm hiểu và vận dụng kiến thức khoa học để giải thích hiện tượng', EstimatedHours: 0, ParentCode: null },
    { Code: 'NLD.04', Subject: 'CHUNG', Grade: 'ALL', GradeBand: 'CHUNG', Level: 1, TitleVi: 'Năng lực công nghệ', Description: 'Sử dụng và quản lí thiết bị, công cụ kĩ thuật; thiết kế và cải tiến các sản phẩm kĩ thuật', EstimatedHours: 0, ParentCode: null },
    { Code: 'NLD.05', Subject: 'CHUNG', Grade: 'ALL', GradeBand: 'CHUNG', Level: 1, TitleVi: 'Năng lực tin học', Description: 'Sử dụng công nghệ thông tin và truyền thông trong học tập và cuộc sống; giải quyết vấn đề với sự trợ giúp của CNTT', EstimatedHours: 0, ParentCode: null },
    { Code: 'NLD.06', Subject: 'CHUNG', Grade: 'ALL', GradeBand: 'CHUNG', Level: 1, TitleVi: 'Năng lực thẩm mĩ', Description: 'Nhận ra và cảm nhận cái đẹp; phân tích và đánh giá cái đẹp trong cuộc sống, nghệ thuật; tạo ra sản phẩm thẩm mĩ', EstimatedHours: 0, ParentCode: null },
    { Code: 'NLD.07', Subject: 'CHUNG', Grade: 'ALL', GradeBand: 'CHUNG', Level: 1, TitleVi: 'Năng lực thể chất', Description: 'Chăm sóc và bảo vệ sức khoẻ; vận động cơ bản và tham gia các hoạt động thể dục thể thao phù hợp', EstimatedHours: 0, ParentCode: null },
    // ── Toán (per-grade) ──────────────────────────────────────────────────
    { Code: 'TOAN.L01', Subject: 'TOAN', Grade: 'L01', GradeBand: 'TH', Level: 1, TitleVi: 'Toán lớp 1', Description: 'Đọc, viết, so sánh số đến 100; phép tính cộng, trừ trong phạm vi 100; nhận dạng hình phẳng, hình khối; đo độ dài, đọc giờ đúng', EstimatedHours: 105, ParentCode: null },
    { Code: 'TOAN.L02', Subject: 'TOAN', Grade: 'L02', GradeBand: 'TH', Level: 1, TitleVi: 'Toán lớp 2', Description: 'Số và phép tính đến 1000; nhân, chia đơn giản; yếu tố thống kê; hình học cơ bản và đo lường', EstimatedHours: 175, ParentCode: null },
    { Code: 'TOAN.L03', Subject: 'TOAN', Grade: 'L03', GradeBand: 'TH', Level: 1, TitleVi: 'Toán lớp 3', Description: 'Số tự nhiên đến 100 000; bốn phép tính; phân số đơn giản; chu vi, diện tích hình đơn giản', EstimatedHours: 175, ParentCode: null },
    { Code: 'TOAN.L04', Subject: 'TOAN', Grade: 'L04', GradeBand: 'TH', Level: 1, TitleVi: 'Toán lớp 4', Description: 'Số tự nhiên; phân số và các phép tính với phân số; hình học phẳng; số đo thời gian và diện tích', EstimatedHours: 175, ParentCode: null },
    { Code: 'TOAN.L05', Subject: 'TOAN', Grade: 'L05', GradeBand: 'TH', Level: 1, TitleVi: 'Toán lớp 5', Description: 'Số thập phân và phần trăm; tỉ số và tỉ lệ; diện tích, thể tích hình không gian cơ bản', EstimatedHours: 175, ParentCode: null },
    { Code: 'TOAN.L06', Subject: 'TOAN', Grade: 'L06', GradeBand: 'THCS', Level: 1, TitleVi: 'Toán lớp 6', Description: 'Số nguyên; phân số và số thập phân; hình học: góc, tam giác, đa giác; thống kê và xác suất sơ cấp', EstimatedHours: 140, ParentCode: null },
    { Code: 'TOAN.L07', Subject: 'TOAN', Grade: 'L07', GradeBand: 'THCS', Level: 1, TitleVi: 'Toán lớp 7', Description: 'Số hữu tỉ; tỉ lệ và hàm số; tam giác và quan hệ giữa các yếu tố trong tam giác; thống kê biểu đồ', EstimatedHours: 140, ParentCode: null },
    { Code: 'TOAN.L08', Subject: 'TOAN', Grade: 'L08', GradeBand: 'THCS', Level: 1, TitleVi: 'Toán lớp 8', Description: 'Phân thức đại số; phương trình và hệ phương trình bậc nhất; tứ giác; hình lăng trụ và hình chóp', EstimatedHours: 140, ParentCode: null },
    { Code: 'TOAN.L09', Subject: 'TOAN', Grade: 'L09', GradeBand: 'THCS', Level: 1, TitleVi: 'Toán lớp 9', Description: 'Căn thức bậc hai; hàm số bậc nhất và bậc hai; đường tròn và vị trí tương đối; hệ phương trình', EstimatedHours: 140, ParentCode: null },
    { Code: 'TOAN.L10', Subject: 'TOAN', Grade: 'L10', GradeBand: 'THPT', Level: 1, TitleVi: 'Toán lớp 10', Description: 'Mệnh đề và tập hợp; hàm số bậc nhất, bậc hai; hệ thức lượng trong tam giác; vectơ; thống kê', EstimatedHours: 105, ParentCode: null },
    { Code: 'TOAN.L11', Subject: 'TOAN', Grade: 'L11', GradeBand: 'THPT', Level: 1, TitleVi: 'Toán lớp 11', Description: 'Hàm số lượng giác; tổ hợp và xác suất; giới hạn và tính liên tục; đạo hàm và ứng dụng', EstimatedHours: 105, ParentCode: null },
    { Code: 'TOAN.L12', Subject: 'TOAN', Grade: 'L12', GradeBand: 'THPT', Level: 1, TitleVi: 'Toán lớp 12', Description: 'Hàm số và khảo sát đồ thị; tích phân và ứng dụng; số phức; hình học không gian tổng hợp', EstimatedHours: 105, ParentCode: null },
    // ── Toán (cross-grade strands) ────────────────────────────────────────
    { Code: 'TOAN.TH.SO_PHEP_TINH', Subject: 'TOAN', Grade: null, GradeBand: 'CHUNG', Level: 2, TitleVi: 'Số và phép tính (Tiểu học)', Description: 'Đọc, viết, so sánh, sắp xếp số tự nhiên và phân số; thực hiện bốn phép tính; giải bài toán có lời văn', EstimatedHours: null, ParentCode: null },
    { Code: 'TOAN.TH.HINH_HOC', Subject: 'TOAN', Grade: null, GradeBand: 'CHUNG', Level: 2, TitleVi: 'Hình học và đo lường (Tiểu học)', Description: 'Nhận dạng, mô tả hình phẳng và hình khối; tính chu vi, diện tích; đo độ dài, khối lượng, thể tích, thời gian', EstimatedHours: null, ParentCode: null },
    { Code: 'TOAN.TH.THONG_KE', Subject: 'TOAN', Grade: null, GradeBand: 'CHUNG', Level: 2, TitleVi: 'Thống kê và xác suất (Tiểu học)', Description: 'Đọc biểu đồ tranh, cột; thu thập và mô tả dữ liệu; nhận biết khả năng xảy ra của sự kiện', EstimatedHours: null, ParentCode: null },
    { Code: 'TOAN.THCS.SO', Subject: 'TOAN', Grade: null, GradeBand: 'CHUNG', Level: 2, TitleVi: 'Số và đại số (THCS)', Description: 'Số nguyên, số hữu tỉ, số thực; biểu thức đại số; phương trình và hệ phương trình; hàm số', EstimatedHours: null, ParentCode: null },
    { Code: 'TOAN.THCS.HINH_HOC', Subject: 'TOAN', Grade: null, GradeBand: 'CHUNG', Level: 2, TitleVi: 'Hình học (THCS)', Description: 'Tam giác, tứ giác, đường tròn; phép biến hình; hình không gian cơ bản; hệ thức lượng', EstimatedHours: null, ParentCode: null },
    { Code: 'TOAN.THCS.THONG_KE', Subject: 'TOAN', Grade: null, GradeBand: 'CHUNG', Level: 2, TitleVi: 'Thống kê và xác suất (THCS)', Description: 'Bảng số liệu, biểu đồ; số trung bình, trung vị, tứ phân vị; xác suất thực nghiệm và lí thuyết', EstimatedHours: null, ParentCode: null },
    { Code: 'TOAN.THPT.DAI_SO', Subject: 'TOAN', Grade: null, GradeBand: 'CHUNG', Level: 2, TitleVi: 'Đại số và giải tích (THPT)', Description: 'Hàm số, giới hạn, đạo hàm, tích phân; tổ hợp, xác suất; số phức và phương trình bậc cao', EstimatedHours: null, ParentCode: null },
    { Code: 'TOAN.THPT.HINH_HOC', Subject: 'TOAN', Grade: null, GradeBand: 'CHUNG', Level: 2, TitleVi: 'Hình học (THPT)', Description: 'Vectơ và toạ độ trong không gian; hình học phẳng và không gian; đường thẳng, mặt phẳng', EstimatedHours: null, ParentCode: null },
    // ── Ngữ văn (per-grade) ───────────────────────────────────────────────
    { Code: 'VAN.L01', Subject: 'VAN', Grade: 'L01', GradeBand: 'TH', Level: 1, TitleVi: 'Ngữ văn lớp 1', Description: 'Học vần, nhận biết 29 chữ cái; đọc đúng và viết đúng chính tả từ, câu ngắn; nghe-hiểu văn bản đơn giản', EstimatedHours: 420, ParentCode: null },
    { Code: 'VAN.L02', Subject: 'VAN', Grade: 'L02', GradeBand: 'TH', Level: 1, TitleVi: 'Ngữ văn lớp 2', Description: 'Đọc hiểu văn bản ngắn; viết câu và đoạn văn ngắn; kể chuyện đơn giản; mở rộng vốn từ theo chủ đề', EstimatedHours: 350, ParentCode: null },
    { Code: 'VAN.L03', Subject: 'VAN', Grade: 'L03', GradeBand: 'TH', Level: 1, TitleVi: 'Ngữ văn lớp 3', Description: 'Đọc hiểu văn bản truyện và thơ; viết đoạn văn kể, tả; dùng câu đúng ngữ pháp; trình bày bài viết rõ ràng', EstimatedHours: 245, ParentCode: null },
    { Code: 'VAN.L04', Subject: 'VAN', Grade: 'L04', GradeBand: 'TH', Level: 1, TitleVi: 'Ngữ văn lớp 4', Description: 'Đọc hiểu văn bản thông tin và văn học; viết bài văn kể chuyện, miêu tả; nói trước lớp tự tin', EstimatedHours: 245, ParentCode: null },
    { Code: 'VAN.L05', Subject: 'VAN', Grade: 'L05', GradeBand: 'TH', Level: 1, TitleVi: 'Ngữ văn lớp 5', Description: 'Đọc hiểu văn bản đa dạng thể loại; viết bài văn miêu tả, nghị luận ngắn; trình bày ý kiến rõ ràng', EstimatedHours: 245, ParentCode: null },
    { Code: 'VAN.L06', Subject: 'VAN', Grade: 'L06', GradeBand: 'THCS', Level: 1, TitleVi: 'Ngữ văn lớp 6', Description: 'Đọc hiểu truyện, thơ, kí; viết bài văn kể chuyện sáng tạo và tả cảnh; phân tích đặc điểm thể loại', EstimatedHours: 140, ParentCode: null },
    { Code: 'VAN.L07', Subject: 'VAN', Grade: 'L07', GradeBand: 'THCS', Level: 1, TitleVi: 'Ngữ văn lớp 7', Description: 'Đọc hiểu thơ trữ tình và văn bản nghị luận; viết đoạn văn ghi lại cảm xúc; thuyết trình về một vấn đề', EstimatedHours: 140, ParentCode: null },
    { Code: 'VAN.L08', Subject: 'VAN', Grade: 'L08', GradeBand: 'THCS', Level: 1, TitleVi: 'Ngữ văn lớp 8', Description: 'Đọc hiểu tiểu thuyết, truyện, truyện thơ, văn nghị luận; viết bài phân tích tác phẩm văn học', EstimatedHours: 140, ParentCode: null },
    { Code: 'VAN.L09', Subject: 'VAN', Grade: 'L09', GradeBand: 'THCS', Level: 1, TitleVi: 'Ngữ văn lớp 9', Description: 'Đọc hiểu văn học trung đại và hiện đại; viết bài nghị luận văn học; tổng kết kĩ năng đọc-viết THCS', EstimatedHours: 140, ParentCode: null },
    { Code: 'VAN.L10', Subject: 'VAN', Grade: 'L10', GradeBand: 'THPT', Level: 1, TitleVi: 'Ngữ văn lớp 10', Description: 'Đọc hiểu văn học dân gian và văn học trung đại; viết văn nghị luận xã hội; phân tích tác phẩm sử thi, truyện', EstimatedHours: 105, ParentCode: null },
    { Code: 'VAN.L11', Subject: 'VAN', Grade: 'L11', GradeBand: 'THPT', Level: 1, TitleVi: 'Ngữ văn lớp 11', Description: 'Đọc hiểu văn học lãng mạn, hiện thực; viết báo cáo nghiên cứu; phân tích truyện ngắn và thơ hiện đại', EstimatedHours: 105, ParentCode: null },
    { Code: 'VAN.L12', Subject: 'VAN', Grade: 'L12', GradeBand: 'THPT', Level: 1, TitleVi: 'Ngữ văn lớp 12', Description: 'Đọc hiểu văn học hiện đại và đương đại; viết bài nghị luận văn học tổng hợp; ôn tập kĩ năng THPT', EstimatedHours: 105, ParentCode: null },
    // ── Ngữ văn (cross-grade strands) ────────────────────────────────────
    { Code: 'VAN.DOC_HIEU', Subject: 'VAN', Grade: null, GradeBand: 'CHUNG', Level: 2, TitleVi: 'Đọc hiểu văn bản', Description: 'Đọc đúng, đọc hiểu các kiểu văn bản: văn học, thông tin, nghị luận; phân tích hình thức và nội dung', EstimatedHours: null, ParentCode: null },
    { Code: 'VAN.VIET', Subject: 'VAN', Grade: null, GradeBand: 'CHUNG', Level: 2, TitleVi: 'Viết', Description: 'Viết đúng chính tả, ngữ pháp; viết đoạn và bài văn theo yêu cầu thể loại; quy trình viết 4 bước', EstimatedHours: null, ParentCode: null },
    { Code: 'VAN.NOI_NGHE', Subject: 'VAN', Grade: null, GradeBand: 'CHUNG', Level: 2, TitleVi: 'Nói và nghe', Description: 'Trình bày, thảo luận, tranh luận; nghe và nhận xét ý kiến; kết hợp ngôn ngữ với phương tiện phi ngôn ngữ', EstimatedHours: null, ParentCode: null },
    { Code: 'VAN.KIEN_THUC', Subject: 'VAN', Grade: null, GradeBand: 'CHUNG', Level: 2, TitleVi: 'Kiến thức tiếng Việt và văn học', Description: 'Từ vựng, ngữ pháp, phong cách ngôn ngữ; thể loại văn học; lịch sử văn học Việt Nam và thế giới', EstimatedHours: null, ParentCode: null },
    // ── Tiếng Anh (per-grade) ─────────────────────────────────────────────
    { Code: 'ENG.L03', Subject: 'ENG', Grade: 'L03', GradeBand: 'TH', Level: 1, TitleVi: 'Tiếng Anh lớp 3', Description: 'Nghe-nói-đọc-viết với 300 từ vựng; các mẫu câu hỏi-đáp đơn giản; chủ đề quen thuộc: gia đình, trường học, màu sắc', EstimatedHours: 70, ParentCode: null },
    { Code: 'ENG.L04', Subject: 'ENG', Grade: 'L04', GradeBand: 'TH', Level: 1, TitleVi: 'Tiếng Anh lớp 4', Description: 'Mở rộng 500 từ vựng; câu đơn và câu ghép cơ bản; đọc đoạn văn ngắn; viết câu đúng cú pháp', EstimatedHours: 70, ParentCode: null },
    { Code: 'ENG.L05', Subject: 'ENG', Grade: 'L05', GradeBand: 'TH', Level: 1, TitleVi: 'Tiếng Anh lớp 5', Description: '700 từ vựng; thì hiện tại và quá khứ đơn; đọc hiểu đoạn văn; viết đoạn ngắn về chủ đề quen thuộc', EstimatedHours: 70, ParentCode: null },
    { Code: 'ENG.L06', Subject: 'ENG', Grade: 'L06', GradeBand: 'THCS', Level: 1, TitleVi: 'Tiếng Anh lớp 6', Description: 'Đạt chuẩn A1 CEFR; ngữ pháp: thì hiện tại, quá khứ, tương lai; 4 kĩ năng cân bằng; ~1000 từ vựng', EstimatedHours: 105, ParentCode: null },
    { Code: 'ENG.L07', Subject: 'ENG', Grade: 'L07', GradeBand: 'THCS', Level: 1, TitleVi: 'Tiếng Anh lớp 7', Description: 'Đạt chuẩn A1+; câu phức, mệnh đề quan hệ cơ bản; đọc hiểu văn bản 150-200 từ; viết đoạn có liên kết', EstimatedHours: 105, ParentCode: null },
    { Code: 'ENG.L08', Subject: 'ENG', Grade: 'L08', GradeBand: 'THCS', Level: 1, TitleVi: 'Tiếng Anh lớp 8', Description: 'Đạt chuẩn A2 CEFR; ngữ pháp nâng cao; đọc hiểu đa thể loại; viết email, đoạn mô tả; nghe bản tin', EstimatedHours: 105, ParentCode: null },
    { Code: 'ENG.L09', Subject: 'ENG', Grade: 'L09', GradeBand: 'THCS', Level: 1, TitleVi: 'Tiếng Anh lớp 9', Description: 'Đạt chuẩn A2+; câu điều kiện, bị động; đọc hiểu văn bản thông tin; viết bài về chủ đề xã hội', EstimatedHours: 105, ParentCode: null },
    { Code: 'ENG.L10', Subject: 'ENG', Grade: 'L10', GradeBand: 'THPT', Level: 1, TitleVi: 'Tiếng Anh lớp 10', Description: 'Đạt chuẩn B1 CEFR; đọc hiểu bài báo; viết luận 150 từ; thuyết trình; nghe thông tin chi tiết', EstimatedHours: 105, ParentCode: null },
    { Code: 'ENG.L11', Subject: 'ENG', Grade: 'L11', GradeBand: 'THPT', Level: 1, TitleVi: 'Tiếng Anh lớp 11', Description: 'Đạt chuẩn B1+; đọc hiểu văn bản học thuật; viết luận so sánh; nghe và ghi chú; thảo luận nhóm', EstimatedHours: 105, ParentCode: null },
    { Code: 'ENG.L12', Subject: 'ENG', Grade: 'L12', GradeBand: 'THPT', Level: 1, TitleVi: 'Tiếng Anh lớp 12', Description: 'Đạt chuẩn B2 CEFR; đọc hiểu đa thể loại; viết essay 250 từ; thi THPTQG và luyện thi quốc tế', EstimatedHours: 105, ParentCode: null },
    // ── Tiếng Anh (cross-grade strands) ──────────────────────────────────
    { Code: 'ENG.NGHE', Subject: 'ENG', Grade: null, GradeBand: 'CHUNG', Level: 2, TitleVi: 'Nghe (Listening)', Description: 'Nghe và hiểu các cuộc hội thoại, bản tin, bài giảng theo trình độ từ A1 đến B2 CEFR', EstimatedHours: null, ParentCode: null },
    { Code: 'ENG.NOI', Subject: 'ENG', Grade: null, GradeBand: 'CHUNG', Level: 2, TitleVi: 'Nói (Speaking)', Description: 'Giao tiếp hội thoại, thuyết trình, thảo luận; phát âm chuẩn; sử dụng ngữ điệu phù hợp', EstimatedHours: null, ParentCode: null },
    { Code: 'ENG.DOC', Subject: 'ENG', Grade: null, GradeBand: 'CHUNG', Level: 2, TitleVi: 'Đọc (Reading)', Description: 'Đọc hiểu văn bản thông tin, truyện, bài báo; nhận diện ý chính và chi tiết; suy luận ngữ nghĩa', EstimatedHours: null, ParentCode: null },
    { Code: 'ENG.VIET_ENG', Subject: 'ENG', Grade: null, GradeBand: 'CHUNG', Level: 2, TitleVi: 'Viết (Writing)', Description: 'Viết câu, đoạn, bài văn đúng ngữ pháp; dùng từ nối; viết email, luận điểm theo cấu trúc', EstimatedHours: null, ParentCode: null },
    { Code: 'ENG.NGANG', Subject: 'ENG', Grade: null, GradeBand: 'CHUNG', Level: 2, TitleVi: 'Kiến thức ngôn ngữ', Description: 'Từ vựng theo chủ đề; ngữ pháp từ A1 đến B2; ngữ âm và phát âm; ngữ dụng giao tiếp', EstimatedHours: null, ParentCode: null },
    // ── Vật lí (per-grade) ────────────────────────────────────────────────
    { Code: 'LY.L10', Subject: 'LY', Grade: 'L10', GradeBand: 'THPT', Level: 1, TitleVi: 'Vật lí lớp 10', Description: 'Mở đầu về vật lí; động học; động lực học; công và năng lượng; nhiệt học; các quy luật chất khí', EstimatedHours: 70, ParentCode: null },
    { Code: 'LY.L11', Subject: 'LY', Grade: 'L11', GradeBand: 'THPT', Level: 1, TitleVi: 'Vật lí lớp 11', Description: 'Trường điện; dòng điện không đổi; từ trường; cảm ứng điện từ; khúc xạ ánh sáng và quang lí', EstimatedHours: 70, ParentCode: null },
    { Code: 'LY.L12', Subject: 'LY', Grade: 'L12', GradeBand: 'THPT', Level: 1, TitleVi: 'Vật lí lớp 12', Description: 'Dao động; sóng cơ và âm thanh; điện xoay chiều; lượng tử ánh sáng; vật lí hạt nhân; vũ trụ học', EstimatedHours: 70, ParentCode: null },
    // ── Vật lí (cross-grade strands) ─────────────────────────────────────
    { Code: 'LY.NL_VAT_LI', Subject: 'LY', Grade: null, GradeBand: 'CHUNG', Level: 2, TitleVi: 'Năng lực vật lí', Description: 'Nhận thức vật lí; tìm hiểu thế giới tự nhiên dưới góc độ vật lí; vận dụng kiến thức, kĩ năng vật lí', EstimatedHours: null, ParentCode: null },
    { Code: 'LY.THPT.DONG_HOC', Subject: 'LY', Grade: null, GradeBand: 'CHUNG', Level: 2, TitleVi: 'Động học và động lực học', Description: 'Chuyển động thẳng, tròn, rơi tự do; các định luật Newton; ma sát; dao động; năng lượng cơ học', EstimatedHours: null, ParentCode: null },
    { Code: 'LY.THPT.NHIET_HOC', Subject: 'LY', Grade: null, GradeBand: 'CHUNG', Level: 2, TitleVi: 'Nhiệt học', Description: 'Thuyết động học phân tử; các định luật chất khí; nguyên lí nhiệt động lực học', EstimatedHours: null, ParentCode: null },
    { Code: 'LY.THPT.DIEN_TU', Subject: 'LY', Grade: null, GradeBand: 'CHUNG', Level: 2, TitleVi: 'Điện và từ', Description: 'Điện trường, tụ điện; dòng điện; từ trường; cảm ứng điện từ; dao động và sóng điện từ', EstimatedHours: null, ParentCode: null },
    { Code: 'LY.THPT.QUANG_HAT', Subject: 'LY', Grade: null, GradeBand: 'CHUNG', Level: 2, TitleVi: 'Quang học và vật lí hiện đại', Description: 'Phản xạ, khúc xạ, giao thoa ánh sáng; lượng tử ánh sáng; phóng xạ; phản ứng hạt nhân', EstimatedHours: null, ParentCode: null },
    // ── Hóa học (per-grade) ───────────────────────────────────────────────
    { Code: 'HOA.L10', Subject: 'HOA', Grade: 'L10', GradeBand: 'THPT', Level: 1, TitleVi: 'Hóa học lớp 10', Description: 'Cấu tạo nguyên tử; bảng tuần hoàn các nguyên tố hoá học; liên kết hoá học; phản ứng oxi hoá - khử', EstimatedHours: 70, ParentCode: null },
    { Code: 'HOA.L11', Subject: 'HOA', Grade: 'L11', GradeBand: 'THPT', Level: 1, TitleVi: 'Hóa học lớp 11', Description: 'Cân bằng hoá học; nitrogen và sulfur; đại cương về hoá học hữu cơ; hydrocarbon và dẫn xuất halogen', EstimatedHours: 70, ParentCode: null },
    { Code: 'HOA.L12', Subject: 'HOA', Grade: 'L12', GradeBand: 'THPT', Level: 1, TitleVi: 'Hóa học lớp 12', Description: 'Ester, lipid; carbohydrate; hợp chất chứa nitrogen; polymer; đại cương về kim loại và phi kim', EstimatedHours: 70, ParentCode: null },
    // ── Hóa học (cross-grade strands) ────────────────────────────────────
    { Code: 'HOA.NL_HOA_HOC', Subject: 'HOA', Grade: null, GradeBand: 'CHUNG', Level: 2, TitleVi: 'Năng lực hoá học', Description: 'Nhận thức hoá học; tìm hiểu thế giới tự nhiên dưới góc độ hoá học; vận dụng kiến thức hoá học vào thực tiễn', EstimatedHours: null, ParentCode: null },
    { Code: 'HOA.THPT.VO_CO', Subject: 'HOA', Grade: null, GradeBand: 'CHUNG', Level: 2, TitleVi: 'Hoá học vô cơ', Description: 'Nguyên tử, phân tử, ion; liên kết hoá học; dung dịch và điện li; kim loại và phi kim quan trọng', EstimatedHours: null, ParentCode: null },
    { Code: 'HOA.THPT.HUU_CO', Subject: 'HOA', Grade: null, GradeBand: 'CHUNG', Level: 2, TitleVi: 'Hoá học hữu cơ', Description: 'Hydrocarbon; dẫn xuất của hydrocarbon; hợp chất thiên nhiên; polymer và ứng dụng', EstimatedHours: null, ParentCode: null },
    // ── Sinh học (per-grade) ──────────────────────────────────────────────
    { Code: 'SINH.L10', Subject: 'SINH', Grade: 'L10', GradeBand: 'THPT', Level: 1, TitleVi: 'Sinh học lớp 10', Description: 'Tế bào - đơn vị cơ sở của sự sống; sinh học phân tử; chuyển hoá vật chất và năng lượng; phân bào', EstimatedHours: 70, ParentCode: null },
    { Code: 'SINH.L11', Subject: 'SINH', Grade: 'L11', GradeBand: 'THPT', Level: 1, TitleVi: 'Sinh học lớp 11', Description: 'Trao đổi chất và năng lượng ở thực vật, động vật; cảm ứng; sinh trưởng và phát triển; sinh sản', EstimatedHours: 70, ParentCode: null },
    { Code: 'SINH.L12', Subject: 'SINH', Grade: 'L12', GradeBand: 'THPT', Level: 1, TitleVi: 'Sinh học lớp 12', Description: 'Di truyền học Mendel và phân tử; tiến hoá; sinh thái học và bảo vệ môi trường', EstimatedHours: 70, ParentCode: null },
    // ── Sinh học (cross-grade strands) ───────────────────────────────────
    { Code: 'SINH.NL_SINH_HOC', Subject: 'SINH', Grade: null, GradeBand: 'CHUNG', Level: 2, TitleVi: 'Năng lực sinh học', Description: 'Nhận thức sinh học; tìm hiểu thế giới sống; vận dụng kiến thức sinh học giải thích hiện tượng thực tiễn', EstimatedHours: null, ParentCode: null },
    { Code: 'SINH.THPT.TE_BAO', Subject: 'SINH', Grade: null, GradeBand: 'CHUNG', Level: 2, TitleVi: 'Sinh học tế bào', Description: 'Thành phần hoá học; cấu trúc và chức năng tế bào; trao đổi chất qua màng; phân chia tế bào', EstimatedHours: null, ParentCode: null },
    { Code: 'SINH.THPT.DI_TRUYEN', Subject: 'SINH', Grade: null, GradeBand: 'CHUNG', Level: 2, TitleVi: 'Di truyền học', Description: 'Quy luật di truyền Mendel và mở rộng; di truyền liên kết; đột biến; di truyền người', EstimatedHours: null, ParentCode: null },
    { Code: 'SINH.THPT.TIEN_HOA', Subject: 'SINH', Grade: null, GradeBand: 'CHUNG', Level: 2, TitleVi: 'Tiến hoá và sinh thái', Description: 'Bằng chứng và cơ chế tiến hoá; loài và quần thể; hệ sinh thái; bảo vệ môi trường', EstimatedHours: null, ParentCode: null },
    // ── Lịch sử (per-grade) ───────────────────────────────────────────────
    { Code: 'SU.L10', Subject: 'SU', Grade: 'L10', GradeBand: 'THPT', Level: 1, TitleVi: 'Lịch sử lớp 10', Description: 'Lịch sử và sử học; các nền văn minh thế giới cổ đại; Đông Nam Á từ cổ đại đến thế kỉ X; Việt Nam thời kì đầu', EstimatedHours: 52, ParentCode: null },
    { Code: 'SU.L11', Subject: 'SU', Grade: 'L11', GradeBand: 'THPT', Level: 1, TitleVi: 'Lịch sử lớp 11', Description: 'Thế giới cận đại (thế kỉ XVI - XIX); cách mạng tư sản; chủ nghĩa thực dân; Việt Nam từ TK XVI đến giữa TK XIX', EstimatedHours: 52, ParentCode: null },
    { Code: 'SU.L12', Subject: 'SU', Grade: 'L12', GradeBand: 'THPT', Level: 1, TitleVi: 'Lịch sử lớp 12', Description: 'Thế giới hiện đại (1917 đến nay); Việt Nam từ 1919 đến nay; Chiến tranh giải phóng và xây dựng đất nước', EstimatedHours: 52, ParentCode: null },
    // ── Lịch sử (cross-grade strands) ────────────────────────────────────
    { Code: 'SU.NL_LICH_SU', Subject: 'SU', Grade: null, GradeBand: 'CHUNG', Level: 2, TitleVi: 'Năng lực lịch sử', Description: 'Tìm hiểu lịch sử; nhận thức và tư duy lịch sử; vận dụng kiến thức, kĩ năng lịch sử vào thực tiễn', EstimatedHours: null, ParentCode: null },
    { Code: 'SU.THPT.LS_THE_GIOI', Subject: 'SU', Grade: null, GradeBand: 'CHUNG', Level: 2, TitleVi: 'Lịch sử thế giới', Description: 'Từ cổ đại đến hiện đại: văn minh, cách mạng, chiến tranh, toàn cầu hoá; quan hệ quốc tế đương đại', EstimatedHours: null, ParentCode: null },
    { Code: 'SU.THPT.LS_VN', Subject: 'SU', Grade: null, GradeBand: 'CHUNG', Level: 2, TitleVi: 'Lịch sử Việt Nam', Description: 'Từ buổi đầu dựng nước đến thế kỉ XXI; kháng chiến, cách mạng, đổi mới và hội nhập quốc tế', EstimatedHours: null, ParentCode: null },
    // ── Địa lí (per-grade) ────────────────────────────────────────────────
    { Code: 'DIA.L10', Subject: 'DIA', Grade: 'L10', GradeBand: 'THPT', Level: 1, TitleVi: 'Địa lí lớp 10', Description: 'Bản đồ; Trái Đất và vũ trụ; địa lí tự nhiên đại cương; địa lí dân cư; địa lí các ngành kinh tế', EstimatedHours: 52, ParentCode: null },
    { Code: 'DIA.L11', Subject: 'DIA', Grade: 'L11', GradeBand: 'THPT', Level: 1, TitleVi: 'Địa lí lớp 11', Description: 'Địa lí thế giới: các khu vực; vấn đề toàn cầu; địa lí một số quốc gia điển hình', EstimatedHours: 52, ParentCode: null },
    { Code: 'DIA.L12', Subject: 'DIA', Grade: 'L12', GradeBand: 'THPT', Level: 1, TitleVi: 'Địa lí lớp 12', Description: 'Địa lí Việt Nam: tự nhiên, dân cư, kinh tế-xã hội các vùng; hội nhập quốc tế và phát triển bền vững', EstimatedHours: 52, ParentCode: null },
    // ── Địa lí (cross-grade strands) ─────────────────────────────────────
    { Code: 'DIA.NL_DIA_LI', Subject: 'DIA', Grade: null, GradeBand: 'CHUNG', Level: 2, TitleVi: 'Năng lực địa lí', Description: 'Nhận thức khoa học địa lí; tìm hiểu địa lí; vận dụng kiến thức địa lí giải quyết vấn đề thực tiễn', EstimatedHours: null, ParentCode: null },
    { Code: 'DIA.THPT.TU_NHIEN', Subject: 'DIA', Grade: null, GradeBand: 'CHUNG', Level: 2, TitleVi: 'Địa lí tự nhiên', Description: 'Trái Đất, khí hậu, thuỷ quyển, địa hình; thiên tai; tài nguyên thiên nhiên và bảo vệ môi trường', EstimatedHours: null, ParentCode: null },
    { Code: 'DIA.THPT.KINH_TE_XH', Subject: 'DIA', Grade: null, GradeBand: 'CHUNG', Level: 2, TitleVi: 'Địa lí kinh tế - xã hội', Description: 'Dân cư, đô thị hoá; các ngành kinh tế; liên kết kinh tế; phát triển bền vững vùng và quốc gia', EstimatedHours: null, ParentCode: null },
    // ── Tin học (per-grade) ───────────────────────────────────────────────
    { Code: 'TIN.L03', Subject: 'TIN', Grade: 'L03', GradeBand: 'TH', Level: 1, TitleVi: 'Tin học lớp 3', Description: 'Làm quen máy tính; sử dụng chuột và bàn phím; vẽ và tô màu bằng phần mềm đồ hoạ đơn giản', EstimatedHours: 35, ParentCode: null },
    { Code: 'TIN.L04', Subject: 'TIN', Grade: 'L04', GradeBand: 'TH', Level: 1, TitleVi: 'Tin học lớp 4', Description: 'Soạn thảo văn bản cơ bản; định dạng văn bản; lưu và mở tệp; sử dụng internet an toàn', EstimatedHours: 35, ParentCode: null },
    { Code: 'TIN.L05', Subject: 'TIN', Grade: 'L05', GradeBand: 'TH', Level: 1, TitleVi: 'Tin học lớp 5', Description: 'Trình chiếu bài thuyết trình đơn giản; tạo bảng dữ liệu; giải quyết vấn đề với sự trợ giúp của máy tính', EstimatedHours: 35, ParentCode: null },
    { Code: 'TIN.L06', Subject: 'TIN', Grade: 'L06', GradeBand: 'THCS', Level: 1, TitleVi: 'Tin học lớp 6', Description: 'Tổ chức thông tin trong máy tính; xử lí văn bản và tính toán; mạng thông tin; đạo đức số', EstimatedHours: 35, ParentCode: null },
    { Code: 'TIN.L07', Subject: 'TIN', Grade: 'L07', GradeBand: 'THCS', Level: 1, TitleVi: 'Tin học lớp 7', Description: 'Phần mềm bảng tính nâng cao; biểu đồ và thống kê; giới thiệu lập trình trực quan (Scratch/Python cơ bản)', EstimatedHours: 35, ParentCode: null },
    { Code: 'TIN.L08', Subject: 'TIN', Grade: 'L08', GradeBand: 'THCS', Level: 1, TitleVi: 'Tin học lớp 8', Description: 'Lập trình Python cơ bản; cấu trúc điều kiện và lặp; giải quyết bài toán thuật toán đơn giản', EstimatedHours: 35, ParentCode: null },
    { Code: 'TIN.L09', Subject: 'TIN', Grade: 'L09', GradeBand: 'THCS', Level: 1, TitleVi: 'Tin học lớp 9', Description: 'Lập trình Python nâng cao; hàm; xử lí tệp; CSDL cơ bản; dự án phần mềm nhỏ', EstimatedHours: 35, ParentCode: null },
    { Code: 'TIN.L10', Subject: 'TIN', Grade: 'L10', GradeBand: 'THPT', Level: 1, TitleVi: 'Tin học lớp 10', Description: 'Giải quyết vấn đề với máy tính; xử lí thông tin dạng văn bản và số; giới thiệu khoa học máy tính', EstimatedHours: 70, ParentCode: null },
    { Code: 'TIN.L11', Subject: 'TIN', Grade: 'L11', GradeBand: 'THPT', Level: 1, TitleVi: 'Tin học lớp 11', Description: 'Lập trình hướng đối tượng; thuật toán và độ phức tạp; mạng máy tính; bảo mật thông tin', EstimatedHours: 70, ParentCode: null },
    { Code: 'TIN.L12', Subject: 'TIN', Grade: 'L12', GradeBand: 'THPT', Level: 1, TitleVi: 'Tin học lớp 12', Description: 'Dự án phần mềm; trí tuệ nhân tạo cơ bản; big data; định hướng nghề nghiệp CNTT', EstimatedHours: 70, ParentCode: null },
    // ── Tin học (cross-grade strands) ─────────────────────────────────────
    { Code: 'TIN.NL_TIN_HOC', Subject: 'TIN', Grade: null, GradeBand: 'CHUNG', Level: 2, TitleVi: 'Năng lực tin học', Description: 'Sử dụng và quản lí phương tiện CNTT; xử lí thông tin; giải quyết vấn đề với sự trợ giúp của CNTT; chia sẻ kinh nghiệm số', EstimatedHours: null, ParentCode: null },
    { Code: 'TIN.CS.LAP_TRINH', Subject: 'TIN', Grade: null, GradeBand: 'CHUNG', Level: 2, TitleVi: 'Lập trình và tư duy máy tính', Description: 'Tư duy thuật toán; lập trình cấu trúc; gỡ lỗi; ứng dụng công nghệ số giải quyết bài toán thực tế', EstimatedHours: null, ParentCode: null },
    { Code: 'TIN.CS.MANG_THONG_TIN', Subject: 'TIN', Grade: null, GradeBand: 'CHUNG', Level: 2, TitleVi: 'Mạng và thông tin số', Description: 'Internet và dịch vụ; bảo mật và quyền riêng tư; công dân số; đạo đức sử dụng CNTT', EstimatedHours: null, ParentCode: null },
    // ── Công nghệ (per-grade) ─────────────────────────────────────────────
    { Code: 'CN.L03', Subject: 'CN', Grade: 'L03', GradeBand: 'TH', Level: 1, TitleVi: 'Công nghệ lớp 3', Description: 'Nhận biết một số sản phẩm công nghệ thông dụng; sử dụng an toàn và bảo quản đồ dùng học tập', EstimatedHours: 35, ParentCode: null },
    { Code: 'CN.L04', Subject: 'CN', Grade: 'L04', GradeBand: 'TH', Level: 1, TitleVi: 'Công nghệ lớp 4', Description: 'Tìm hiểu một số nghề nghiệp và sản phẩm công nghệ; thực hành lắp ráp mô hình đơn giản', EstimatedHours: 35, ParentCode: null },
    { Code: 'CN.L05', Subject: 'CN', Grade: 'L05', GradeBand: 'TH', Level: 1, TitleVi: 'Công nghệ lớp 5', Description: 'Quy trình tạo ra sản phẩm; nhà ở và đồ dùng trong gia đình; an toàn sử dụng thiết bị điện', EstimatedHours: 35, ParentCode: null },
    { Code: 'CN.L06', Subject: 'CN', Grade: 'L06', GradeBand: 'THCS', Level: 1, TitleVi: 'Công nghệ lớp 6', Description: 'Nhận thức công nghệ; thiết kế và vẽ kĩ thuật cơ bản; lắp ghép mô hình cơ khí và điện đơn giản', EstimatedHours: 35, ParentCode: null },
    { Code: 'CN.L07', Subject: 'CN', Grade: 'L07', GradeBand: 'THCS', Level: 1, TitleVi: 'Công nghệ lớp 7', Description: 'Trồng trọt: kĩ thuật canh tác và bảo vệ thực vật; chăn nuôi: kĩ thuật chăm sóc vật nuôi', EstimatedHours: 35, ParentCode: null },
    { Code: 'CN.L08', Subject: 'CN', Grade: 'L08', GradeBand: 'THCS', Level: 1, TitleVi: 'Công nghệ lớp 8', Description: 'Thiết kế kĩ thuật; vẽ và đọc bản vẽ kĩ thuật; cơ khí và điện dân dụng cơ bản', EstimatedHours: 35, ParentCode: null },
    { Code: 'CN.L09', Subject: 'CN', Grade: 'L09', GradeBand: 'THCS', Level: 1, TitleVi: 'Công nghệ lớp 9', Description: 'Định hướng nghề nghiệp kĩ thuật; lắp đặt điện và điện tử; cơ khí và chế tạo sản phẩm', EstimatedHours: 35, ParentCode: null },
    { Code: 'CN.L10', Subject: 'CN', Grade: 'L10', GradeBand: 'THPT', Level: 1, TitleVi: 'Công nghệ lớp 10', Description: 'Nhập môn công nghệ và kĩ thuật; thiết kế kĩ thuật; vật liệu và gia công; hệ thống kĩ thuật', EstimatedHours: 52, ParentCode: null },
    { Code: 'CN.L11', Subject: 'CN', Grade: 'L11', GradeBand: 'THPT', Level: 1, TitleVi: 'Công nghệ lớp 11', Description: 'Công nghệ và đổi mới sáng tạo; điện tử số; lập trình nhúng; công nghệ chế tạo hiện đại', EstimatedHours: 52, ParentCode: null },
    { Code: 'CN.L12', Subject: 'CN', Grade: 'L12', GradeBand: 'THPT', Level: 1, TitleVi: 'Công nghệ lớp 12', Description: 'Dự án kĩ thuật; khởi nghiệp công nghệ; kĩ thuật số và trí tuệ nhân tạo ứng dụng; định hướng nghề', EstimatedHours: 52, ParentCode: null },
    // ── Công nghệ (cross-grade strands) ──────────────────────────────────
    { Code: 'CN.NL_CONG_NGHE', Subject: 'CN', Grade: null, GradeBand: 'CHUNG', Level: 2, TitleVi: 'Năng lực công nghệ', Description: 'Nhận thức công nghệ; giao tiếp công nghệ; sử dụng công nghệ; đánh giá công nghệ; thiết kế kĩ thuật', EstimatedHours: null, ParentCode: null },
    // ── Khoa học tự nhiên (THCS) ──────────────────────────────────────────
    { Code: 'KHTN.L06', Subject: 'KHTN', Grade: 'L06', GradeBand: 'THCS', Level: 1, TitleVi: 'Khoa học tự nhiên lớp 6', Description: 'Mở đầu về KHTN; chất và sự biến đổi; vật sống; năng lượng và sự biến đổi; Trái Đất và bầu trời', EstimatedHours: 140, ParentCode: null },
    { Code: 'KHTN.L07', Subject: 'KHTN', Grade: 'L07', GradeBand: 'THCS', Level: 1, TitleVi: 'Khoa học tự nhiên lớp 7', Description: 'Nguyên tử, nguyên tố, phân tử; tốc độ, lực; âm thanh và ánh sáng; sinh học tế bào; sinh thái học sơ bộ', EstimatedHours: 140, ParentCode: null },
    { Code: 'KHTN.L08', Subject: 'KHTN', Grade: 'L08', GradeBand: 'THCS', Level: 1, TitleVi: 'Khoa học tự nhiên lớp 8', Description: 'Phản ứng hoá học; axit-bazơ-muối; điện và từ; cơ thể người; sinh học di truyền sơ bộ', EstimatedHours: 140, ParentCode: null },
    { Code: 'KHTN.L09', Subject: 'KHTN', Grade: 'L09', GradeBand: 'THCS', Level: 1, TitleVi: 'Khoa học tự nhiên lớp 9', Description: 'Năng lượng và điện; hoá hữu cơ sơ bộ; sinh học tiến hoá; Trái Đất và vũ trụ; tổng kết liên môn', EstimatedHours: 140, ParentCode: null },
    // ── Khoa học tự nhiên (cross-grade strands) ───────────────────────────
    { Code: 'KHTN.NL_KHTN', Subject: 'KHTN', Grade: null, GradeBand: 'CHUNG', Level: 2, TitleVi: 'Năng lực khoa học tự nhiên', Description: 'Nhận thức KHTN; tìm hiểu tự nhiên; vận dụng kiến thức KHTN giải thích và ứng dụng thực tiễn', EstimatedHours: null, ParentCode: null },
    { Code: 'KHTN.THCS.VAT_CHAT', Subject: 'KHTN', Grade: null, GradeBand: 'CHUNG', Level: 2, TitleVi: 'Chất và vật liệu', Description: 'Tính chất vật lí và hoá học; biến đổi vật lí và hoá học; nguyên tử, phân tử, ion; hỗn hợp và dung dịch', EstimatedHours: null, ParentCode: null },
    { Code: 'KHTN.THCS.NANG_LUONG', Subject: 'KHTN', Grade: null, GradeBand: 'CHUNG', Level: 2, TitleVi: 'Năng lượng', Description: 'Các dạng năng lượng; chuyển hoá năng lượng; năng lượng điện và từ; bảo toàn năng lượng', EstimatedHours: null, ParentCode: null },
    { Code: 'KHTN.THCS.VAT_SONG', Subject: 'KHTN', Grade: null, GradeBand: 'CHUNG', Level: 2, TitleVi: 'Vật sống', Description: 'Cấu trúc và chức năng tế bào; sinh lí động vật và thực vật; di truyền học cơ bản; tiến hoá sơ bộ', EstimatedHours: null, ParentCode: null },
    { Code: 'KHTN.THCS.TRAI_DAT', Subject: 'KHTN', Grade: null, GradeBand: 'CHUNG', Level: 2, TitleVi: 'Trái Đất và bầu trời', Description: 'Cấu tạo Trái Đất; khí quyển; Hệ Mặt Trời; Ngân Hà; thiên tai và bảo vệ môi trường', EstimatedHours: null, ParentCode: null },
    // ── Khoa học (Tiểu học) ───────────────────────────────────────────────
    { Code: 'KHOA.L04', Subject: 'KHOA', Grade: 'L04', GradeBand: 'TH', Level: 1, TitleVi: 'Khoa học lớp 4', Description: 'Vật chất và năng lượng; thực vật và động vật; con người và sức khoẻ; môi trường và tài nguyên', EstimatedHours: 70, ParentCode: null },
    { Code: 'KHOA.L05', Subject: 'KHOA', Grade: 'L05', GradeBand: 'TH', Level: 1, TitleVi: 'Khoa học lớp 5', Description: 'Chất và hỗn hợp; năng lượng mặt trời; cơ thể người và sức khoẻ; sinh thái và môi trường', EstimatedHours: 70, ParentCode: null },
    // ── Tự nhiên và Xã hội (Tiểu học) ────────────────────────────────────
    { Code: 'TNXH.L01', Subject: 'TNXH', Grade: 'L01', GradeBand: 'TH', Level: 1, TitleVi: 'Tự nhiên và Xã hội lớp 1', Description: 'Gia đình; trường học; cộng đồng địa phương; thực vật và động vật; bầu trời và Trái Đất', EstimatedHours: 70, ParentCode: null },
    { Code: 'TNXH.L02', Subject: 'TNXH', Grade: 'L02', GradeBand: 'TH', Level: 1, TitleVi: 'Tự nhiên và Xã hội lớp 2', Description: 'Gia đình với các mối quan hệ; trường học và cộng đồng; thực vật, động vật và môi trường', EstimatedHours: 70, ParentCode: null },
    { Code: 'TNXH.L03', Subject: 'TNXH', Grade: 'L03', GradeBand: 'TH', Level: 1, TitleVi: 'Tự nhiên và Xã hội lớp 3', Description: 'Cộng đồng địa phương; thực vật và động vật đa dạng; Mặt Trời, Mặt Trăng và các vì sao', EstimatedHours: 70, ParentCode: null },
    // ── GDCD / GDKT&PL ────────────────────────────────────────────────────
    { Code: 'GDCD.L06', Subject: 'GDCD', Grade: 'L06', GradeBand: 'THCS', Level: 1, TitleVi: 'GDCD lớp 6', Description: 'Tự nhận thức bản thân; ứng xử với gia đình và bạn bè; quyền và bổn phận học sinh; pháp luật cơ bản', EstimatedHours: 35, ParentCode: null },
    { Code: 'GDCD.L07', Subject: 'GDCD', Grade: 'L07', GradeBand: 'THCS', Level: 1, TitleVi: 'GDCD lớp 7', Description: 'Phòng, chống tệ nạn xã hội; quyền trẻ em; bảo vệ môi trường; quyền và nghĩa vụ công dân cơ bản', EstimatedHours: 35, ParentCode: null },
    { Code: 'GDCD.L08', Subject: 'GDCD', Grade: 'L08', GradeBand: 'THCS', Level: 1, TitleVi: 'GDCD lớp 8', Description: 'Sống có trách nhiệm; pháp luật và kỉ luật; phòng chống vi phạm pháp luật; quyền và nghĩa vụ lao động', EstimatedHours: 35, ParentCode: null },
    { Code: 'GDCD.L09', Subject: 'GDCD', Grade: 'L09', GradeBand: 'THCS', Level: 1, TitleVi: 'GDCD lớp 9', Description: 'Chí công vô tư; nghĩa vụ bảo vệ Tổ quốc; hội nhập quốc tế; pháp luật về hôn nhân và gia đình', EstimatedHours: 35, ParentCode: null },
    { Code: 'GDCD.L10', Subject: 'GDCD', Grade: 'L10', GradeBand: 'THPT', Level: 1, TitleVi: 'GDKT&PL lớp 10 (Giáo dục kinh tế)', Description: 'Các hoạt động kinh tế cơ bản; thị trường và giá cả; tiêu dùng thông minh; việc làm và thu nhập', EstimatedHours: 35, ParentCode: null },
    { Code: 'GDCD.L11', Subject: 'GDCD', Grade: 'L11', GradeBand: 'THPT', Level: 1, TitleVi: 'GDKT&PL lớp 11 (Giáo dục pháp luật)', Description: 'Hiến pháp; quyền con người; pháp luật hình sự, dân sự, hành chính; thực hành pháp luật', EstimatedHours: 35, ParentCode: null },
    { Code: 'GDCD.L12', Subject: 'GDCD', Grade: 'L12', GradeBand: 'THPT', Level: 1, TitleVi: 'GDKT&PL lớp 12 (Kinh tế - Pháp luật nâng cao)', Description: 'Kinh tế vĩ mô và vi mô; hội nhập kinh tế; pháp luật quốc tế; quyền chính trị và bầu cử', EstimatedHours: 35, ParentCode: null },
    // ── Lịch sử và Địa lí tích hợp (Tiểu học + THCS) ────────────────────
    { Code: 'LSDL_TH.L04', Subject: 'LSDL_TH', Grade: 'L04', GradeBand: 'TH', Level: 1, TitleVi: 'Lịch sử và Địa lí lớp 4', Description: 'Đất nước, con người và văn hoá các vùng miền Việt Nam; lịch sử dựng nước và giữ nước thời kì đầu', EstimatedHours: 35, ParentCode: null },
    { Code: 'LSDL_TH.L05', Subject: 'LSDL_TH', Grade: 'L05', GradeBand: 'TH', Level: 1, TitleVi: 'Lịch sử và Địa lí lớp 5', Description: 'Việt Nam và thế giới thế kỉ XX; địa lí Việt Nam trong ASEAN; di sản văn hoá và thiên nhiên', EstimatedHours: 35, ParentCode: null },
    { Code: 'LSDL_THCS.L06', Subject: 'LSDL_THCS', Grade: 'L06', GradeBand: 'THCS', Level: 1, TitleVi: 'Lịch sử và Địa lí lớp 6', Description: 'Văn minh thế giới cổ đại; Việt Nam thời tiền sử và thời kì đầu; địa lí đại cương và châu lục', EstimatedHours: 35, ParentCode: null },
    { Code: 'LSDL_THCS.L07', Subject: 'LSDL_THCS', Grade: 'L07', GradeBand: 'THCS', Level: 1, TitleVi: 'Lịch sử và Địa lí lớp 7', Description: 'Thế giới trung đại; Việt Nam từ thế kỉ X - XVI; địa lí châu Á và Việt Nam', EstimatedHours: 35, ParentCode: null },
    { Code: 'LSDL_THCS.L08', Subject: 'LSDL_THCS', Grade: 'L08', GradeBand: 'THCS', Level: 1, TitleVi: 'Lịch sử và Địa lí lớp 8', Description: 'Thế giới cận đại; Việt Nam TK XVI - XIX; địa lí tự nhiên và dân cư Việt Nam', EstimatedHours: 35, ParentCode: null },
    { Code: 'LSDL_THCS.L09', Subject: 'LSDL_THCS', Grade: 'L09', GradeBand: 'THCS', Level: 1, TitleVi: 'Lịch sử và Địa lí lớp 9', Description: 'Thế giới hiện đại; Việt Nam từ 1919 đến nay; địa lí kinh tế - xã hội Việt Nam; hội nhập quốc tế', EstimatedHours: 35, ParentCode: null },
    // ── Âm nhạc ──────────────────────────────────────────────────────────
    { Code: 'AN.L01', Subject: 'AN', Grade: 'L01', GradeBand: 'TH', Level: 1, TitleVi: 'Âm nhạc lớp 1', Description: 'Nghe nhạc, hát bài đơn giản; nhận biết âm thanh cao thấp; vỗ tay đúng nhịp; yêu thích âm nhạc', EstimatedHours: 70, ParentCode: null },
    { Code: 'AN.L02', Subject: 'AN', Grade: 'L02', GradeBand: 'TH', Level: 1, TitleVi: 'Âm nhạc lớp 2', Description: 'Hát đúng cao độ và trường độ; đọc nhạc nốt đơn giản; biểu diễn bài hát theo nhóm', EstimatedHours: 70, ParentCode: null },
    { Code: 'AN.L03', Subject: 'AN', Grade: 'L03', GradeBand: 'TH', Level: 1, TitleVi: 'Âm nhạc lớp 3', Description: 'Hát đúng lời và giai điệu; đọc nhạc 2-3 nốt; nhận biết một số nhạc cụ dân tộc và phương Tây', EstimatedHours: 70, ParentCode: null },
    { Code: 'AN.L04', Subject: 'AN', Grade: 'L04', GradeBand: 'TH', Level: 1, TitleVi: 'Âm nhạc lớp 4', Description: 'Hát biểu cảm; đọc nhạc 4-5 nốt; gõ đệm theo tiết tấu; giới thiệu nhạc sĩ Việt Nam và thế giới', EstimatedHours: 70, ParentCode: null },
    { Code: 'AN.L05', Subject: 'AN', Grade: 'L05', GradeBand: 'TH', Level: 1, TitleVi: 'Âm nhạc lớp 5', Description: 'Biểu diễn bài hát có chất lượng; đọc nhạc hoàn chỉnh; tham gia nhóm nhạc; cảm nhận phong cách', EstimatedHours: 70, ParentCode: null },
    { Code: 'AN.L06', Subject: 'AN', Grade: 'L06', GradeBand: 'THCS', Level: 1, TitleVi: 'Âm nhạc lớp 6', Description: 'Học nhạc cụ cơ bản; hát hoà âm đơn giản; đọc nhạc thành thạo; nghe và phân tích tác phẩm', EstimatedHours: 35, ParentCode: null },
    { Code: 'AN.L07', Subject: 'AN', Grade: 'L07', GradeBand: 'THCS', Level: 1, TitleVi: 'Âm nhạc lớp 7', Description: 'Học nhạc cụ nâng cao; hát đơn và song ca; sáng tác giai điệu đơn giản; âm nhạc dân gian Việt Nam', EstimatedHours: 35, ParentCode: null },
    { Code: 'AN.L08', Subject: 'AN', Grade: 'L08', GradeBand: 'THCS', Level: 1, TitleVi: 'Âm nhạc lớp 8', Description: 'Biểu diễn nhạc cụ và hát; phân tích hình thức âm nhạc; tìm hiểu âm nhạc thế giới', EstimatedHours: 35, ParentCode: null },
    { Code: 'AN.L09', Subject: 'AN', Grade: 'L09', GradeBand: 'THCS', Level: 1, TitleVi: 'Âm nhạc lớp 9', Description: 'Tổng kết năng lực âm nhạc THCS; dự án âm nhạc; giới thiệu sự nghiệp âm nhạc', EstimatedHours: 35, ParentCode: null },
    { Code: 'AN.L10', Subject: 'AN', Grade: 'L10', GradeBand: 'THPT', Level: 1, TitleVi: 'Âm nhạc lớp 10', Description: 'Nhạc cụ và thanh nhạc định hướng chuyên sâu; phân tích tác phẩm âm nhạc cổ điển và đương đại', EstimatedHours: 35, ParentCode: null },
    { Code: 'AN.L11', Subject: 'AN', Grade: 'L11', GradeBand: 'THPT', Level: 1, TitleVi: 'Âm nhạc lớp 11', Description: 'Thực hành biểu diễn âm nhạc; sáng tác và phối âm đơn giản; tìm hiểu ngành âm nhạc', EstimatedHours: 35, ParentCode: null },
    { Code: 'AN.L12', Subject: 'AN', Grade: 'L12', GradeBand: 'THPT', Level: 1, TitleVi: 'Âm nhạc lớp 12', Description: 'Dự án âm nhạc tổng hợp; trình diễn; định hướng học tập và nghề nghiệp âm nhạc', EstimatedHours: 35, ParentCode: null },
    // ── Mĩ thuật ──────────────────────────────────────────────────────────
    { Code: 'MT.L01', Subject: 'MT', Grade: 'L01', GradeBand: 'TH', Level: 1, TitleVi: 'Mĩ thuật lớp 1', Description: 'Nhận biết màu sắc cơ bản và sắc độ; vẽ hình đơn giản; xé dán sáng tạo; cảm nhận vẻ đẹp', EstimatedHours: 70, ParentCode: null },
    { Code: 'MT.L02', Subject: 'MT', Grade: 'L02', GradeBand: 'TH', Level: 1, TitleVi: 'Mĩ thuật lớp 2', Description: 'Vẽ hình theo chủ đề; phối màu cơ bản; làm đồ thủ công 3D; nhận xét sản phẩm mĩ thuật', EstimatedHours: 70, ParentCode: null },
    { Code: 'MT.L03', Subject: 'MT', Grade: 'L03', GradeBand: 'TH', Level: 1, TitleVi: 'Mĩ thuật lớp 3', Description: 'Vẽ và tô màu sáng tạo; in hình đơn giản; nặn đất sét; quan sát và mô tả vẻ đẹp thiên nhiên', EstimatedHours: 70, ParentCode: null },
    { Code: 'MT.L04', Subject: 'MT', Grade: 'L04', GradeBand: 'TH', Level: 1, TitleVi: 'Mĩ thuật lớp 4', Description: 'Vẽ theo quan sát; kí hoạ nhanh; trang trí sản phẩm; nhận xét tác phẩm tranh dân gian', EstimatedHours: 70, ParentCode: null },
    { Code: 'MT.L05', Subject: 'MT', Grade: 'L05', GradeBand: 'TH', Level: 1, TitleVi: 'Mĩ thuật lớp 5', Description: 'Vẽ chân dung và phong cảnh; thiết kế sản phẩm ứng dụng; đánh giá tác phẩm nghệ thuật', EstimatedHours: 70, ParentCode: null },
    { Code: 'MT.L06', Subject: 'MT', Grade: 'L06', GradeBand: 'THCS', Level: 1, TitleVi: 'Mĩ thuật lớp 6', Description: 'Ngôn ngữ tạo hình: đường nét, hình, màu, đậm nhạt; thực hành 2D và 3D; phân tích tác phẩm', EstimatedHours: 35, ParentCode: null },
    { Code: 'MT.L07', Subject: 'MT', Grade: 'L07', GradeBand: 'THCS', Level: 1, TitleVi: 'Mĩ thuật lớp 7', Description: 'Nguyên lí tạo hình; chất liệu vẽ; thiết kế đồ hoạ cơ bản; phân tích vẻ đẹp hình thức và nội dung', EstimatedHours: 35, ParentCode: null },
    { Code: 'MT.L08', Subject: 'MT', Grade: 'L08', GradeBand: 'THCS', Level: 1, TitleVi: 'Mĩ thuật lớp 8', Description: 'Hội hoạ, đồ hoạ, điêu khắc; thủ công mĩ nghệ; kết nối mĩ thuật với các lĩnh vực khác', EstimatedHours: 35, ParentCode: null },
    { Code: 'MT.L09', Subject: 'MT', Grade: 'L09', GradeBand: 'THCS', Level: 1, TitleVi: 'Mĩ thuật lớp 9', Description: 'Dự án mĩ thuật tích hợp liên môn; trình bày tác phẩm; định hướng nghề nghiệp liên quan', EstimatedHours: 35, ParentCode: null },
    { Code: 'MT.L10', Subject: 'MT', Grade: 'L10', GradeBand: 'THPT', Level: 1, TitleVi: 'Mĩ thuật lớp 10', Description: 'Vận dụng kiến thức mĩ thuật cơ bản theo định hướng nghề; phân tích tác phẩm trong bối cảnh lịch sử', EstimatedHours: 35, ParentCode: null },
    { Code: 'MT.L11', Subject: 'MT', Grade: 'L11', GradeBand: 'THPT', Level: 1, TitleVi: 'Mĩ thuật lớp 11', Description: 'Sáng tạo cá nhân qua hình thức đa dạng; đánh giá theo tiêu chí thẩm mĩ; nghiên cứu nghệ thuật thị giác', EstimatedHours: 35, ParentCode: null },
    { Code: 'MT.L12', Subject: 'MT', Grade: 'L12', GradeBand: 'THPT', Level: 1, TitleVi: 'Mĩ thuật lớp 12', Description: 'Dự án sáng tạo tổng hợp; triển lãm tác phẩm; định hướng nghề nghiệp mĩ thuật và thiết kế', EstimatedHours: 35, ParentCode: null },
    // ── Giáo dục thể chất ─────────────────────────────────────────────────
    { Code: 'GDTC.L01', Subject: 'GDTC', Grade: 'L01', GradeBand: 'TH', Level: 1, TitleVi: 'Thể dục lớp 1', Description: 'Tư thế cơ bản; đi, chạy, nhảy, ném đơn giản; trò chơi vận động; hình thành thói quen vận động', EstimatedHours: 70, ParentCode: null },
    { Code: 'GDTC.L02', Subject: 'GDTC', Grade: 'L02', GradeBand: 'TH', Level: 1, TitleVi: 'Thể dục lớp 2', Description: 'Bài tập thể dục nhịp điệu; trò chơi vận động tập thể; phát triển thể lực và kĩ năng vận động cơ bản', EstimatedHours: 70, ParentCode: null },
    { Code: 'GDTC.L03', Subject: 'GDTC', Grade: 'L03', GradeBand: 'TH', Level: 1, TitleVi: 'Thể dục lớp 3', Description: 'Chạy, nhảy, ném đúng kĩ thuật; trò chơi vận động có luật; giới thiệu bơi lội an toàn', EstimatedHours: 70, ParentCode: null },
    { Code: 'GDTC.L04', Subject: 'GDTC', Grade: 'L04', GradeBand: 'TH', Level: 1, TitleVi: 'Thể dục lớp 4', Description: 'Phát triển thể lực; bài tập kết hợp; tập luyện thể dục an toàn và hiệu quả', EstimatedHours: 70, ParentCode: null },
    { Code: 'GDTC.L05', Subject: 'GDTC', Grade: 'L05', GradeBand: 'TH', Level: 1, TitleVi: 'Thể dục lớp 5', Description: 'Vận dụng kĩ năng vận động vào môn thể thao tự chọn; ý thức tập luyện thường xuyên', EstimatedHours: 70, ParentCode: null },
    { Code: 'GDTC.L06', Subject: 'GDTC', Grade: 'L06', GradeBand: 'THCS', Level: 1, TitleVi: 'Thể dục lớp 6', Description: 'Kĩ thuật cơ bản: điền kinh, bóng đá, cầu lông, bơi lội; phát triển tố chất thể lực toàn diện', EstimatedHours: 70, ParentCode: null },
    { Code: 'GDTC.L07', Subject: 'GDTC', Grade: 'L07', GradeBand: 'THCS', Level: 1, TitleVi: 'Thể dục lớp 7', Description: 'Hoàn thiện kĩ thuật các môn thể thao; nâng cao sức bền; hiểu biết về sinh lí luyện tập', EstimatedHours: 70, ParentCode: null },
    { Code: 'GDTC.L08', Subject: 'GDTC', Grade: 'L08', GradeBand: 'THCS', Level: 1, TitleVi: 'Thể dục lớp 8', Description: 'Vận dụng kiến thức vào luyện tập; tổ chức trò chơi và thi đấu thể thao; tự đánh giá thể lực', EstimatedHours: 70, ParentCode: null },
    { Code: 'GDTC.L09', Subject: 'GDTC', Grade: 'L09', GradeBand: 'THCS', Level: 1, TitleVi: 'Thể dục lớp 9', Description: 'Thành thạo kĩ thuật môn lựa chọn; lập kế hoạch tập luyện cá nhân; kiểm tra và đánh giá thể lực', EstimatedHours: 70, ParentCode: null },
    { Code: 'GDTC.L10', Subject: 'GDTC', Grade: 'L10', GradeBand: 'THPT', Level: 1, TitleVi: 'Thể dục lớp 10', Description: 'Kĩ thuật và chiến thuật cơ bản môn thể thao lựa chọn; khoa học luyện tập; y học thể thao sơ bộ', EstimatedHours: 70, ParentCode: null },
    { Code: 'GDTC.L11', Subject: 'GDTC', Grade: 'L11', GradeBand: 'THPT', Level: 1, TitleVi: 'Thể dục lớp 11', Description: 'Nâng cao thành tích môn thể thao; sinh lí luyện tập nâng cao; tập luyện phòng tránh chấn thương', EstimatedHours: 70, ParentCode: null },
    { Code: 'GDTC.L12', Subject: 'GDTC', Grade: 'L12', GradeBand: 'THPT', Level: 1, TitleVi: 'Thể dục lớp 12', Description: 'Hoàn thiện kĩ năng; tự tổ chức và thi đấu; định hướng tập luyện sức khoẻ suốt đời', EstimatedHours: 70, ParentCode: null },
    // ── Hoạt động trải nghiệm, hướng nghiệp ──────────────────────────────
    { Code: 'HDTN.L01', Subject: 'HDTN', Grade: 'L01', GradeBand: 'TH', Level: 1, TitleVi: 'Hoạt động trải nghiệm lớp 1', Description: 'Hình thành ý thức về bản thân, gia đình, trường lớp; tham gia hoạt động tập thể và trải nghiệm cộng đồng', EstimatedHours: 105, ParentCode: null },
    { Code: 'HDTN.L02', Subject: 'HDTN', Grade: 'L02', GradeBand: 'TH', Level: 1, TitleVi: 'Hoạt động trải nghiệm lớp 2', Description: 'Phát triển quan hệ với môi trường; tham gia hoạt động phục vụ cộng đồng và bảo vệ môi trường', EstimatedHours: 105, ParentCode: null },
    { Code: 'HDTN.L03', Subject: 'HDTN', Grade: 'L03', GradeBand: 'TH', Level: 1, TitleVi: 'Hoạt động trải nghiệm lớp 3', Description: 'Rèn kĩ năng sống cơ bản; hoạt động văn hoá xã hội và trải nghiệm nghề nghiệp ban đầu', EstimatedHours: 105, ParentCode: null },
    { Code: 'HDTN.L04', Subject: 'HDTN', Grade: 'L04', GradeBand: 'TH', Level: 1, TitleVi: 'Hoạt động trải nghiệm lớp 4', Description: 'Phát triển kĩ năng hợp tác; hoạt động xã hội, thiện nguyện và tìm hiểu nghề nghiệp', EstimatedHours: 105, ParentCode: null },
    { Code: 'HDTN.L05', Subject: 'HDTN', Grade: 'L05', GradeBand: 'TH', Level: 1, TitleVi: 'Hoạt động trải nghiệm lớp 5', Description: 'Tổng kết kĩ năng sống TH; dự án cộng đồng; định hướng học tập THCS', EstimatedHours: 105, ParentCode: null },
    { Code: 'HDTN.L06', Subject: 'HDTN', Grade: 'L06', GradeBand: 'THCS', Level: 1, TitleVi: 'Hoạt động trải nghiệm, hướng nghiệp lớp 6', Description: 'Khám phá và phát triển bản thân; hoạt động xã hội; tìm hiểu thế giới nghề nghiệp ban đầu', EstimatedHours: 105, ParentCode: null },
    { Code: 'HDTN.L07', Subject: 'HDTN', Grade: 'L07', GradeBand: 'THCS', Level: 1, TitleVi: 'Hoạt động trải nghiệm, hướng nghiệp lớp 7', Description: 'Năng lực thích ứng xã hội; thiện nguyện; tìm hiểu nghề nghiệp phổ biến trong cộng đồng', EstimatedHours: 105, ParentCode: null },
    { Code: 'HDTN.L08', Subject: 'HDTN', Grade: 'L08', GradeBand: 'THCS', Level: 1, TitleVi: 'Hoạt động trải nghiệm, hướng nghiệp lớp 8', Description: 'Kĩ năng lãnh đạo và làm việc nhóm; khám phá sở trường; định hướng lựa chọn nghề nghiệp', EstimatedHours: 105, ParentCode: null },
    { Code: 'HDTN.L09', Subject: 'HDTN', Grade: 'L09', GradeBand: 'THCS', Level: 1, TitleVi: 'Hoạt động trải nghiệm, hướng nghiệp lớp 9', Description: 'Tổng kết THCS; kế hoạch cá nhân; định hướng lựa chọn ban/ngành THPT', EstimatedHours: 105, ParentCode: null },
    { Code: 'HDTN.L10', Subject: 'HDTN', Grade: 'L10', GradeBand: 'THPT', Level: 1, TitleVi: 'Hoạt động trải nghiệm, hướng nghiệp lớp 10', Description: 'Xác định và phát triển phẩm chất, năng lực; hoạt động cộng đồng; tìm hiểu thị trường lao động', EstimatedHours: 105, ParentCode: null },
    { Code: 'HDTN.L11', Subject: 'HDTN', Grade: 'L11', GradeBand: 'THPT', Level: 1, TitleVi: 'Hoạt động trải nghiệm, hướng nghiệp lớp 11', Description: 'Lập kế hoạch và thực hiện dự án; khám phá chuyên sâu lĩnh vực định hướng nghề nghiệp', EstimatedHours: 105, ParentCode: null },
    { Code: 'HDTN.L12', Subject: 'HDTN', Grade: 'L12', GradeBand: 'THPT', Level: 1, TitleVi: 'Hoạt động trải nghiệm, hướng nghiệp lớp 12', Description: 'Hoàn thiện kế hoạch nghề nghiệp; dự án cộng đồng; chuẩn bị bước vào cuộc sống sau THPT', EstimatedHours: 105, ParentCode: null },
  ];

  let created = 0, errors = 0;
  const errorList = [];

  for (const item of seedData) {
    // Remove helper fields not in schema
    const { ParentCode, GradeBand, ...record } = item;
    const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_OUTCOMES}/records`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(record),
    });
    if (r.ok) { created++; }
    else { errors++; errorList.push({ code: item.Code, status: r.status }); }
  }

  return json({
    message: `Seed complete: ${created} outcomes created, ${errors} errors.`,
    total_seeded: created,
    errors: errorList.slice(0, 10),
    note: 'ParentId links not auto-resolved — use NocoDB UI or run a second pass to set ParentId from ParentCode.',
    next_steps: [
      'Use NocoDB UI to add detailed YCCD (yêu cầu cần đạt) per grade from TT17/2025.',
      'Use POST /api/alignments to link course Items to Outcomes.',
      'After Student_Mastery is populated, run POST /ai/research-agent with mode="risk".',
    ],
  });
}

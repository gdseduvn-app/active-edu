import { verifyAdminAuth, hashUserPayload } from '../auth.js';
import { nocoFetch } from '../db.js';
import { checkRateLimit, idempotencyCheck, idempotencyStore } from '../middleware.js';
import { _assertExists, _countChildren, _getChildIds, _cascadeDelete, _audit, _softDelete } from '../integrity.js';

// ── Admin: Users (with server-side password hashing) ──────────
export async function handleAdminUsers(request, env, { path, url, cors, secHeaders, json, clientIP }) {
  const country = request.headers.get('CF-IPCountry') || '';
  const allowed = (env.ALLOWED_COUNTRIES || 'VN').split(',').map(c => c.trim());
  if (country && !allowed.includes('*') && !allowed.includes(country))
    return json({ error: 'Access denied from your region' }, 403);

  if (!await verifyAdminAuth(request, env)) {
    const adminRl = await checkRateLimit(clientIP, env, 'admin');
    if (!adminRl.allowed) return json({ error: 'Quá nhiều yêu cầu. Thử lại sau 15 phút.' }, 429);
    return json({ error: 'Unauthorized' }, 401);
  }

  const nocoBase = `/api/v2/tables/${env.NOCO_USERS}/records`;
  const suffix = path.slice('/admin/users'.length); // e.g. '' or '/<id>'

  // GET: list or single — pass through, strip passwords
  if (request.method === 'GET') {
    const r = await nocoFetch(env, `${nocoBase}${suffix}${url.search}`);
    const text = await r.text();
    try {
      const parsed = JSON.parse(text);
      const strip = u => { if (u && typeof u === 'object') { delete u.Password; delete u.MatKhau; } return u; };
      if (parsed.list) parsed.list = parsed.list.map(strip);
      else strip(parsed);
      return json(parsed, r.status);
    } catch {
      return new Response(text, { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
    }
  }

  // DELETE: pass through
  if (request.method === 'DELETE') {
    const body = await request.text();
    const r = await nocoFetch(env, `${nocoBase}${suffix}${url.search}`, 'DELETE',
      body ? JSON.parse(body) : undefined);
    return new Response(await r.text(), { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  // POST (create) / PATCH (update): hash password before saving
  if (request.method === 'POST' || request.method === 'PATCH') {
    let rawBody;
    try { rawBody = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

    let hashedBody;
    if (Array.isArray(rawBody)) {
      hashedBody = await Promise.all(rawBody.map(item => hashUserPayload(item, env)));
    } else {
      hashedBody = await hashUserPayload(rawBody, env);
    }

    const r = await nocoFetch(env, `${nocoBase}${suffix}${url.search}`, request.method, hashedBody);
    return new Response(await r.text(), { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  return json({ error: 'Method not allowed' }, 405);
}

// ── Admin: toggle module item Published state ─────────────────
export async function handleModuleItemToggle(request, env, { path, cors, json }) {
  if (!await verifyAdminAuth(request, env))
    return json({ error: 'Unauthorized' }, 401);

  const articleId = path.slice('/admin/module-item/'.length);
  if (!articleId || !env.NOCO_ARTICLE) return json({ error: 'Thiếu articleId' }, 400);

  const body = await request.json().catch(() => ({}));
  const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_ARTICLE}/records`, 'PATCH',
    [{ Id: parseInt(articleId), Published: body.published }]);
  return new Response(await r.text(), { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

// ── Admin: tạo Module (validate CourseId tồn tại) ─────────────
export async function handleSafeModuleCreate(request, env, { cors, json }) {
  if (!await verifyAdminAuth(request, env)) return json({ error: 'Unauthorized' }, 401);

  const modIdemKey = request.headers.get('Idempotency-Key');
  if (modIdemKey) {
    const cached = await idempotencyCheck(env, modIdemKey);
    if (cached) return new Response(cached.body, {
      status: cached.status,
      headers: { ...cors, 'Content-Type': 'application/json', 'X-Idempotent-Replayed': 'true' },
    });
  }

  const body = await request.json().catch(() => ({}));

  // FK check: CourseId
  if (body.CourseId) {
    const check = await _assertExists(env, 'NOCO_COURSES', body.CourseId, 'Khoá học');
    if (!check.ok) return json({ error: check.error }, 422);
  } else {
    return json({ error: 'CourseId bắt buộc' }, 422);
  }

  // Unique check: không trùng Position trong cùng Course
  if (body.Position && env.NOCO_MODULES) {
    const dup = await nocoFetch(env,
      `/api/v2/tables/${env.NOCO_MODULES}/records?where=(CourseId,eq,${body.CourseId})~and(Position,eq,${body.Position})&limit=1&fields=Id`
    );
    const dupData = await dup.json();
    if ((dupData.list || []).length) {
      return json({ error: `Vị trí ${body.Position} đã có module khác trong khoá học này` }, 422);
    }
  }

  const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_MODULES}/records`, 'POST', body);
  const rText = await r.text();
  if (r.ok && modIdemKey) idempotencyStore(env, modIdemKey, r.status, rText);
  return new Response(rText, { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

// ── Admin: xoá Course → cascade delete Modules + Articles unlink ──
export async function handleSafeCourseDelete(request, env, { cors, json }) {
  if (!await verifyAdminAuth(request, env)) return json({ error: 'Unauthorized' }, 401);

  const body = await request.json().catch(() => ([]));
  const ids = Array.isArray(body) ? body.map(r => r.Id) : [body.Id];
  if (!ids.length) return json({ error: 'Thiếu Id' }, 400);

  const _adminActor = { userId: 0, email: 'admin' };
  let cascadeCount = 0;

  try {
    for (const courseId of ids) {
      // 1. Lấy tất cả modules thuộc course
      const moduleIds = await _getChildIds(env, 'NOCO_MODULES', 'CourseId', courseId);
      for (const mod of moduleIds) {
        // 2. Unlink articles khỏi module (set ModuleId = null)
        const artIds = await _getChildIds(env, 'NOCO_ARTICLE', 'ModuleId', mod.Id);
        if (artIds.length) {
          const unlinkPayload = artIds.map(a => ({ Id: a.Id, ModuleId: null, ItemType: null, Position: null }));
          await nocoFetch(env, `/api/v2/tables/${env.NOCO_ARTICLE}/records`, 'PATCH', unlinkPayload);
        }
        // 3. Hard-delete module
        await nocoFetch(env, `/api/v2/tables/${env.NOCO_MODULES}/records`, 'DELETE', [{ Id: mod.Id }]);
        cascadeCount++;
      }
      // 4. Hard-delete course
      const dr = await nocoFetch(env, `/api/v2/tables/${env.NOCO_COURSES}/records`, 'DELETE', [{ Id: courseId }]);
      if (!dr.ok) {
        const errText = await dr.text().catch(() => '');
        throw new Error(`NocoDB delete course failed (${dr.status}): ${errText}`);
      }
    }
  } catch (e) {
    return json({ error: e.message || 'Delete failed' }, 500);
  }
  return json({ ok: true, cascadeModulesDeleted: cascadeCount });
}

// ── Admin: xoá Module → cascade unlink Articles + xoá Exams liên quan ──
export async function handleSafeModuleDelete(request, env, { cors, json }) {
  if (!await verifyAdminAuth(request, env)) return json({ error: 'Unauthorized' }, 401);

  const body = await request.json().catch(() => ([]));
  const ids = Array.isArray(body) ? body.map(r => r.Id) : [body.Id];

  const _modActor = { userId: 0, email: 'admin' };
  try {
    for (const modId of ids) {
      // Unlink articles (set ModuleId = null)
      const artIds = await _getChildIds(env, 'NOCO_ARTICLE', 'ModuleId', modId);
      if (artIds.length) {
        const unlinkPayload = artIds.map(a => ({ Id: a.Id, ModuleId: null, Position: null }));
        await nocoFetch(env, `/api/v2/tables/${env.NOCO_ARTICLE}/records`, 'PATCH', unlinkPayload);
      }
      // Unlink exams (set ModuleId = null, không xoá exam)
      if (env.NOCO_EXAMS) {
        const examIds = await _getChildIds(env, 'NOCO_EXAMS', 'ModuleId', modId);
        if (examIds.length) {
          const unlinkExams = examIds.map(e => ({ Id: e.Id, ModuleId: null }));
          await nocoFetch(env, `/api/v2/tables/${env.NOCO_EXAMS}/records`, 'PATCH', unlinkExams);
        }
      }
      // Hard-delete module
      const dr = await nocoFetch(env, `/api/v2/tables/${env.NOCO_MODULES}/records`, 'DELETE', [{ Id: modId }]);
      if (!dr.ok) {
        const errText = await dr.text().catch(() => '');
        throw new Error(`NocoDB delete module failed (${dr.status}): ${errText}`);
      }
    }
  } catch (e) {
    return json({ error: e.message || 'Delete failed' }, 500);
  }
  return json({ ok: true });
}

// ── Admin: tạo ExamSection (validate ExamId + BankId, count ≤ bank size) ──
export async function handleSafeExamSectionCreate(request, env, { cors, json }) {
  if (!await verifyAdminAuth(request, env)) return json({ error: 'Unauthorized' }, 401);

  const body = await request.json().catch(() => ({}));

  // FK check: ExamId
  const examCheck = await _assertExists(env, 'NOCO_EXAMS', body.ExamId, 'Đề thi');
  if (!examCheck.ok) return json({ error: examCheck.error }, 422);

  // FK check: BankId
  const bankCheck = await _assertExists(env, 'NOCO_QBANK', body.BankId, 'Ngân hàng câu hỏi');
  if (!bankCheck.ok) return json({ error: bankCheck.error }, 422);

  // Business rule: QuestionCount ≤ số câu trong ngân hàng
  let bankSize = 0;
  try { bankSize = JSON.parse(bankCheck.record.Questions || '[]').length; } catch {}
  if (bankSize > 0 && (body.QuestionCount || 0) > bankSize) {
    return json({ error: `Ngân hàng chỉ có ${bankSize} câu, không thể lấy ${body.QuestionCount}` }, 422);
  }
  if ((body.QuestionCount || 0) < 1) return json({ error: 'Số câu phải ≥ 1' }, 422);
  if ((body.PointsPerQuestion || 0) <= 0) return json({ error: 'Điểm/câu phải > 0' }, 422);

  // Duplicate check: cùng exam không lấy cùng 1 bank 2 lần
  try {
    const dupCheck = await nocoFetch(env,
      `/api/v2/tables/${env.NOCO_EXAM_SECTIONS}/records?where=(ExamId,eq,${body.ExamId})~and(BankId,eq,${body.BankId})&limit=1&fields=Id`
    );
    if (dupCheck.ok) {
      const dupData = await dupCheck.json();
      if ((dupData.list || []).length) {
        return json({ error: 'Ngân hàng này đã có trong đề. Mỗi ngân hàng chỉ dùng 1 lần/đề.' }, 422);
      }
    }
  } catch {}

  const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_EXAM_SECTIONS}/records`, 'POST', body);
  return new Response(await r.text(), { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

// ── Admin: xoá Exam → cascade delete ExamSections ─────────────
export async function handleSafeExamDelete(request, env, { cors, json }) {
  if (!await verifyAdminAuth(request, env)) return json({ error: 'Unauthorized' }, 401);

  const body = await request.json().catch(() => ([]));
  const ids = Array.isArray(body) ? body.map(r => r.Id) : [body.Id];

  const _examActor = { userId: 0, email: 'admin' };
  let sectionCount = 0;
  try {
    for (const examId of ids) {
      // Hard-delete sections trước
      const deleted = await _cascadeDelete(env, 'NOCO_EXAM_SECTIONS', 'ExamId', examId);
      sectionCount += deleted;
      // Hard-delete exam
      const dr = await nocoFetch(env, `/api/v2/tables/${env.NOCO_EXAMS}/records`, 'DELETE', [{ Id: examId }]);
      if (!dr.ok) {
        const errText = await dr.text().catch(() => '');
        throw new Error(`NocoDB delete exam failed (${dr.status}): ${errText}`);
      }
    }
  } catch (e) {
    return json({ error: e.message || 'Delete failed' }, 500);
  }
  return json({ ok: true, sectionsDeleted: sectionCount });
}

// ── Admin: xoá QuestionBank → chặn nếu đang dùng trong ExamSection ──
export async function handleSafeQuestionBankDelete(request, env, { cors, json }) {
  if (!await verifyAdminAuth(request, env)) return json({ error: 'Unauthorized' }, 401);

  const body = await request.json().catch(() => ([]));
  const ids = Array.isArray(body) ? body.map(r => r.Id) : [body.Id];

  try {
    for (const bankId of ids) {
      const usedCount = await _countChildren(env, 'NOCO_EXAM_SECTIONS', 'BankId', bankId);
      if (usedCount > 0) {
        return json({
          error: `Không thể xoá: Ngân hàng #${bankId} đang được dùng trong ${usedCount} đề thi. Xoá phần thi liên quan trước.`
        }, 409);
      }
    }
    // Hard-delete ngân hàng
    const dr = await nocoFetch(env, `/api/v2/tables/${env.NOCO_QBANK}/records`, 'DELETE', ids.map(id => ({ Id: id })));
    if (!dr.ok) {
      const errText = await dr.text().catch(() => '');
      throw new Error(`NocoDB delete qbank failed (${dr.status}): ${errText}`);
    }
  } catch (e) {
    return json({ error: e.message || 'Delete failed' }, 500);
  }
  return json({ ok: true, deleted: ids.length });
}

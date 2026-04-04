/**
 * Enrollment Handler — Course Management Module
 * Implements spec: ĐẶC TẢ YÊU CẦU & THIẾT KẾ HỆ THỐNG: MODULE KHÓA HỌC
 *
 * Covers: FR-C09 (Enroll), FR-C10 (Enrollment states), FR-C11 (RBAC),
 *         FR-C03 (Publish/Unpublish validation), FR-C04 (Conclude)
 *
 * Tables: NOCO_ENROLLMENTS, NOCO_COURSES, NOCO_MODULES
 */

import { getTokenSecret, verifyToken, verifyAdminAuth } from '../auth.js';
import { nocoFetch, fetchAll } from '../db.js';

// ── Enrollment roles & states ────────────────────────────────────
const VALID_ROLES = ['StudentEnrollment', 'TeacherEnrollment', 'TaEnrollment', 'ObserverEnrollment'];
const VALID_STATES = ['active', 'invited', 'inactive', 'completed', 'rejected'];

// ── Course workflow states ───────────────────────────────────────
// created → claimed → available(published) → completed(concluded) → deleted
const VALID_WORKFLOW = ['created', 'claimed', 'available', 'completed', 'deleted'];

// ── Helpers ──────────────────────────────────────────────────────
async function getSession(request, env) {
  const token = (request.headers.get('Authorization') || '').replace('Bearer ', '');
  if (!token) return null;
  return verifyToken(token, getTokenSecret(env));
}

// Check 3-tier RBAC per spec §5.1
export async function checkContentAccess(env, userId, courseId, moduleId) {
  // Tier 1: enrollment check
  if (env.NOCO_ENROLLMENTS && courseId) {
    const er = await nocoFetch(env,
      `/api/v2/tables/${env.NOCO_ENROLLMENTS}/records?where=(UserId,eq,${userId})~and(CourseId,eq,${courseId})~and(WorkflowState,eq,active)&limit=1&fields=Id`
    );
    if (er.ok) {
      const ed = await er.json();
      if (!(ed.list || []).length) return { ok: false, code: 403, reason: 'Bạn chưa ghi danh vào khoá học này' };
    }
  }

  // Tier 2: module workflow_state check
  if (env.NOCO_MODULES && moduleId) {
    const mr = await nocoFetch(env, `/api/v2/tables/${env.NOCO_MODULES}/records/${moduleId}?fields=Id,WorkflowState,UnlockCondition,CourseId`);
    if (mr.ok) {
      const mod = await mr.json();
      if (mod?.WorkflowState && mod.WorkflowState !== 'active') {
        return { ok: false, code: 403, reason: 'Nội dung chưa được mở' };
      }
    }
  }

  // Tier 3: prerequisites check is handled by existing prerequisites.js logic
  return { ok: true };
}

// ══════════════════════════════════════════════════════════════════
// ENROLLMENT API
// ══════════════════════════════════════════════════════════════════

// GET /api/courses/:id/enrollments — student/teacher: list own course members
export async function handleEnrollmentList(request, env, { json, path, url }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Chưa đăng nhập' }, 401);

  const courseId = path.match(/\/api\/courses\/(\d+)\/enrollments/)?.[1];
  if (!courseId || !env.NOCO_ENROLLMENTS) return json({ list: [] });

  // Teacher/admin can see all; student can only see their own
  const isAdmin = session.role === 'admin' || session.role === 'teacher';
  const where = isAdmin
    ? `(CourseId,eq,${courseId})`
    : `(CourseId,eq,${courseId})~and(UserId,eq,${session.userId})`;

  const r = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_ENROLLMENTS}/records?where=${where}&limit=${url.searchParams.get('limit')||100}&fields=Id,UserId,CourseId,Role,WorkflowState`
  );
  if (!r.ok) return json({ list: [] });
  return json(await r.json());
}

// POST /api/courses/:id/enroll — self-enroll (student)
export async function handleSelfEnroll(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Chưa đăng nhập' }, 401);

  const courseId = parseInt(path.match(/\/api\/courses\/(\d+)\/enroll/)?.[1]);
  if (!courseId || !env.NOCO_ENROLLMENTS) return json({ error: 'Không tìm thấy khoá học' }, 404);

  // Check course is published
  if (env.NOCO_COURSES) {
    const cr = await nocoFetch(env, `/api/v2/tables/${env.NOCO_COURSES}/records/${courseId}?fields=Id,WorkflowState`);
    if (cr.ok) {
      const course = await cr.json();
      if (course?.WorkflowState && course.WorkflowState !== 'available')
        return json({ error: 'Khoá học chưa được mở ghi danh' }, 403);
    }
  }

  // Check not already enrolled
  const dupR = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_ENROLLMENTS}/records?where=(CourseId,eq,${courseId})~and(UserId,eq,${session.userId})&limit=1&fields=Id,WorkflowState`
  );
  if (dupR.ok) {
    const dup = await dupR.json();
    if ((dup.list || []).length) {
      const existing = dup.list[0];
      if (existing.WorkflowState === 'active') return json({ error: 'Bạn đã ghi danh khoá học này' }, 409);
      // Re-activate if previously inactive
      const reAct = await nocoFetch(env, `/api/v2/tables/${env.NOCO_ENROLLMENTS}/records`, 'PATCH',
        [{ Id: existing.Id, WorkflowState: 'active' }]);
      return json({ ok: true, reactivated: true });
    }
  }

  const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_ENROLLMENTS}/records`, 'POST', {
    UserId: session.userId,
    CourseId: courseId,
    Role: 'StudentEnrollment',
    WorkflowState: 'active',
  });
  const text = await r.text();
  return new Response(text, { status: r.ok ? 201 : r.status, headers: { 'Content-Type': 'application/json' } });
}

// ══════════════════════════════════════════════════════════════════
// ADMIN ENROLLMENT API
// ══════════════════════════════════════════════════════════════════

// GET /admin/courses/:id/enrollments — admin view all enrollments for a course
export async function handleAdminEnrollmentList(request, env, { json, path, url }) {
  if (!await verifyAdminAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
  if (!env.NOCO_ENROLLMENTS) return json({ list: [] });

  const courseId = path.match(/\/admin\/courses\/(\d+)\/enrollments/)?.[1];
  if (!courseId) return json({ error: 'CourseId không hợp lệ' }, 400);

  const limit = url.searchParams.get('limit') || '100';
  const r = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_ENROLLMENTS}/records?where=(CourseId,eq,${courseId})&limit=${limit}&sort=-Id`
  );
  if (!r.ok) return json({ list: [] });
  return json(await r.json());
}

// POST /admin/courses/:id/enrollments — enroll a user (admin/instructor)
export async function handleAdminEnroll(request, env, { json, path, cors }) {
  if (!await verifyAdminAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
  if (!env.NOCO_ENROLLMENTS) return json({ error: 'NOCO_ENROLLMENTS chưa cấu hình' }, 500);

  const courseId = parseInt(path.match(/\/admin\/courses\/(\d+)\/enrollments/)?.[1]);
  if (!courseId) return json({ error: 'CourseId không hợp lệ' }, 400);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  if (!body.UserId) return json({ error: 'UserId bắt buộc' }, 422);
  const role = body.Role || 'StudentEnrollment';
  if (!VALID_ROLES.includes(role)) return json({ error: `Role không hợp lệ. Phải là: ${VALID_ROLES.join(', ')}` }, 422);

  // Check not already enrolled (same role)
  const dupR = await nocoFetch(env,
    `/api/v2/tables/${env.NOCO_ENROLLMENTS}/records?where=(CourseId,eq,${courseId})~and(UserId,eq,${body.UserId})~and(Role,eq,${role})&limit=1&fields=Id,WorkflowState`
  );
  if (dupR.ok) {
    const dup = await dupR.json();
    if ((dup.list || []).length) {
      const e = dup.list[0];
      if (e.WorkflowState === 'active') return json({ error: `Người dùng #${body.UserId} đã được ghi danh với vai trò ${role}` }, 409);
      // Re-activate
      await nocoFetch(env, `/api/v2/tables/${env.NOCO_ENROLLMENTS}/records`, 'PATCH',
        [{ Id: e.Id, WorkflowState: 'active' }]);
      return json({ ok: true, reactivated: true, enrollmentId: e.Id });
    }
  }

  const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_ENROLLMENTS}/records`, 'POST', {
    UserId: parseInt(body.UserId),
    CourseId: courseId,
    Role: role,
    WorkflowState: body.WorkflowState || 'active',
  });
  const text = await r.text();
  return new Response(text, { status: r.ok ? 201 : r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

// PATCH /admin/enrollments/:id — change enrollment state or role
export async function handleAdminEnrollmentUpdate(request, env, { json, path, cors }) {
  if (!await verifyAdminAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
  if (!env.NOCO_ENROLLMENTS) return json({ error: 'NOCO_ENROLLMENTS chưa cấu hình' }, 500);

  const enrollId = parseInt(path.match(/\/admin\/enrollments\/(\d+)/)?.[1]);
  if (!enrollId) return json({ error: 'ID không hợp lệ' }, 400);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  if (body.WorkflowState && !VALID_STATES.includes(body.WorkflowState))
    return json({ error: `WorkflowState không hợp lệ. Phải là: ${VALID_STATES.join(', ')}` }, 422);
  if (body.Role && !VALID_ROLES.includes(body.Role))
    return json({ error: `Role không hợp lệ. Phải là: ${VALID_ROLES.join(', ')}` }, 422);

  delete body.CreatedAt; delete body.UpdatedAt;
  body.Id = enrollId;

  const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_ENROLLMENTS}/records`, 'PATCH', [body]);
  const text = await r.text();
  return new Response(text, { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

// DELETE /admin/enrollments/:id — unenroll
export async function handleAdminUnenroll(request, env, { json, path, cors }) {
  if (!await verifyAdminAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
  if (!env.NOCO_ENROLLMENTS) return json({ error: 'NOCO_ENROLLMENTS chưa cấu hình' }, 500);

  const enrollId = parseInt(path.match(/\/admin\/enrollments\/(\d+)/)?.[1]);
  if (!enrollId) return json({ error: 'ID không hợp lệ' }, 400);

  const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_ENROLLMENTS}/records`, 'DELETE', [{ Id: enrollId }]);
  const text = await r.text();
  return new Response(text, { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

// ══════════════════════════════════════════════════════════════════
// COURSE WORKFLOW STATE API (FR-C03, FR-C04)
// ══════════════════════════════════════════════════════════════════

// POST /admin/courses/:id/publish — FR-C03: publish with validation
export async function handleCoursePublish(request, env, { json, cors }) {
  if (!await verifyAdminAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
  if (!env.NOCO_COURSES) return json({ error: 'NOCO_COURSES chưa cấu hình' }, 500);

  const body = await request.json().catch(() => ({}));
  const courseId = body.courseId || body.id;
  if (!courseId) return json({ error: 'courseId bắt buộc' }, 400);

  // FR-C03: must have ≥1 module to publish
  if (env.NOCO_MODULES) {
    const modsR = await nocoFetch(env,
      `/api/v2/tables/${env.NOCO_MODULES}/records?where=(CourseId,eq,${courseId})~and(WorkflowState,neq,deleted)&limit=1&fields=Id`
    );
    if (modsR.ok) {
      const modsData = await modsR.json();
      if (!(modsData.list || []).length && !(modsData.pageInfo?.totalRows))
        return json({ error: 'Khoá học cần ít nhất 1 Module trước khi xuất bản (FR-C03)' }, 422);
    }
  }

  const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_COURSES}/records`, 'PATCH',
    [{ Id: courseId, WorkflowState: 'available', Published: true }]);
  const text = await r.text();
  return new Response(text, { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

// POST /admin/courses/:id/unpublish — FR-C03: unpublish with submission check
export async function handleCourseUnpublish(request, env, { json, cors }) {
  if (!await verifyAdminAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
  if (!env.NOCO_COURSES) return json({ error: 'NOCO_COURSES chưa cấu hình' }, 500);

  const body = await request.json().catch(() => ({}));
  const courseId = body.courseId || body.id;
  if (!courseId) return json({ error: 'courseId bắt buộc' }, 400);

  // FR-C03: check for existing submissions
  if (env.NOCO_SUBMISSIONS) {
    const subR = await nocoFetch(env,
      `/api/v2/tables/${env.NOCO_SUBMISSIONS}/records?where=(CourseId,eq,${courseId})~and(Status,eq,submitted)&limit=1&fields=Id`
    );
    if (subR.ok) {
      const subData = await subR.json();
      if ((subData.list || []).length)
        return json({ error: 'Không thể huỷ xuất bản: đã có sinh viên nộp bài trong khoá học này (FR-C03)' }, 409);
    }
  }

  const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_COURSES}/records`, 'PATCH',
    [{ Id: courseId, WorkflowState: 'claimed', Published: false }]);
  const text = await r.text();
  return new Response(text, { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

// POST /admin/courses/:id/conclude — FR-C04: conclude → Read-only
export async function handleCourseConclude(request, env, { json, cors }) {
  if (!await verifyAdminAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
  if (!env.NOCO_COURSES) return json({ error: 'NOCO_COURSES chưa cấu hình' }, 500);

  const body = await request.json().catch(() => ({}));
  const courseId = body.courseId || body.id;
  if (!courseId) return json({ error: 'courseId bắt buộc' }, 400);

  const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_COURSES}/records`, 'PATCH',
    [{ Id: courseId, WorkflowState: 'completed', Published: false }]);
  const text = await r.text();
  return new Response(text, { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

// GET /api/courses/:id/access — 3-tier RBAC check for a student (FR-C11)
export async function handleCourseAccessCheck(request, env, { json, path }) {
  const session = await getSession(request, env);
  if (!session) return json({ ok: false, reason: 'Chưa đăng nhập', requireLogin: true }, 401);

  const courseId = path.match(/\/api\/courses\/(\d+)\/access/)?.[1];
  if (!courseId) return json({ ok: false, reason: 'Không tìm thấy khoá học' }, 404);

  const result = await checkContentAccess(env, session.userId, courseId, null);
  return json(result, result.code || 200);
}

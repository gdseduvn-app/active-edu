/**
 * SIS Import Handler — Bulk student import from CSV
 *
 * POST   /admin/sis/import/students    — parse CSV → create users + enroll
 * POST   /admin/sis/import/courses     — parse CSV → create courses
 * GET    /admin/sis/import/:jobId      — get import job status (from D1)
 *
 * CSV format for students:
 *   email,name,password,course_id,role
 *   student1@school.edu,Nguyen Van A,Pass@2024,2,student
 *   teacher1@school.edu,Tran Thi B,Pass@2024,,teacher
 *
 * CSV format for courses:
 *   title,code,description,teacher_email
 *   "Toán 10","TOAN10","Chương trình Toán lớp 10",gv@school.edu
 *
 * Processing:
 *   1. Parse CSV rows
 *   2. For each row: create user in NocoDB (or find existing by email)
 *   3. If course_id provided: create enrollment
 *   4. Log results to D1 (sis_import_jobs table)
 *   5. Return summary: created / updated / skipped / errors
 *
 * D1 table (auto-created):
 *   sis_import_jobs (job_id, type, status, total, created, updated, skipped, errors_json, started_at, finished_at)
 */
import { verifyAdminAuth, hashPassword, getPassSalt } from '../auth.js';
import { nocoFetch } from '../db.js';

// ── POST /admin/sis/import/students ──────────────────────────
export async function handleSISImportStudents(request, env, { json }) {
  if (!await verifyAdminAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
  if (!env.NOCO_USERS) return json({ error: 'NOCO_USERS chưa được cấu hình' }, 503);

  const contentType = request.headers.get('Content-Type') || '';

  let csvText;
  if (contentType.includes('multipart/form-data')) {
    const formData = await request.formData().catch(() => null);
    if (!formData) return json({ error: 'Không đọc được form data' }, 400);
    const file = formData.get('file');
    if (!file || typeof file === 'string') return json({ error: 'Thiếu file CSV' }, 400);
    csvText = await file.text();
  } else {
    // Accept raw CSV body or JSON with csv field
    const body = await request.text().catch(() => '');
    if (body.startsWith('{')) {
      try { csvText = JSON.parse(body).csv; } catch { return json({ error: 'Invalid JSON' }, 400); }
    } else {
      csvText = body;
    }
  }

  if (!csvText || csvText.trim().length === 0) return json({ error: 'CSV rỗng' }, 400);

  const rows = parseCSV(csvText);
  if (rows.length === 0) return json({ error: 'CSV không có dữ liệu' }, 400);
  if (rows.length > 500) return json({ error: 'Tối đa 500 dòng mỗi lần import' }, 400);

  const results = { created: 0, updated: 0, skipped: 0, enrolled: 0, errors: [] };
  const salt = getPassSalt(env);
  const now = new Date().toISOString();

  // Process rows sequentially to avoid NocoDB throttle
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const email = (row.email || '').trim().toLowerCase();
    const name = (row.name || row.ho_ten || '').trim();
    const rawPass = row.password || row.mat_khau || '';
    const courseId = row.course_id || row.ma_lop || '';
    const role = (row.role || row.vai_tro || 'student').toLowerCase();

    if (!email || !email.includes('@')) {
      results.errors.push({ row: i + 2, email, error: 'Email không hợp lệ' });
      continue;
    }

    const validRoles = ['student', 'teacher', 'admin'];
    const finalRole = validRoles.includes(role) ? role : 'student';

    try {
      // Check if user exists
      const existR = await nocoFetch(env,
        `/api/v2/tables/${env.NOCO_USERS}/records?where=${encodeURIComponent(`(Email,eq,${email})`)}&limit=1&fields=Id,Email,Role`
      );
      const existData = existR.ok ? await existR.json() : { list: [] };
      const existUser = existData.list?.[0];

      let userId;
      if (existUser) {
        // User exists — update name if provided
        userId = existUser.Id;
        if (name) {
          await nocoFetch(env, `/api/v2/tables/${env.NOCO_USERS}/records/${userId}`, 'PATCH', {
            Name: name,
            HoTen: name,
          });
        }
        results.updated++;
      } else {
        // Create new user
        const hashedPass = rawPass ? await hashPassword(rawPass, salt) : await hashPassword('ActiveEdu@' + Date.now(), salt);
        const createR = await nocoFetch(env, `/api/v2/tables/${env.NOCO_USERS}/records`, 'POST', {
          Email: email,
          Name: name || email.split('@')[0],
          HoTen: name || email.split('@')[0],
          Password: hashedPass,
          MatKhau: hashedPass,
          Role: finalRole,
          VaiTro: finalRole,
          Status: 'active',
          TrangThai: 'active',
        });

        if (!createR.ok) {
          const errText = await createR.text().catch(() => '');
          results.errors.push({ row: i + 2, email, error: 'Tạo user thất bại: ' + errText.slice(0, 100) });
          continue;
        }
        const newUser = await createR.json();
        userId = newUser.Id;
        results.created++;
      }

      // Enroll in course if course_id provided
      if (courseId && env.NOCO_ENROLLMENTS) {
        const enrCheck = await nocoFetch(env,
          `/api/v2/tables/${env.NOCO_ENROLLMENTS}/records?where=${encodeURIComponent(`(UserId,eq,${userId})~and(CourseId,eq,${courseId})`)}&limit=1&fields=Id`
        );
        const alreadyEnrolled = enrCheck.ok && ((await enrCheck.json()).list?.length > 0);

        if (!alreadyEnrolled) {
          await nocoFetch(env, `/api/v2/tables/${env.NOCO_ENROLLMENTS}/records`, 'POST', {
            UserId: String(userId),
            UserEmail: email,
            CourseId: String(courseId),
            Status: 'active',
            Role: finalRole === 'teacher' ? 'teacher' : 'student',
            EnrolledAt: now,
          });
          results.enrolled++;
        }
      }
    } catch (e) {
      results.errors.push({ row: i + 2, email, error: e.message });
    }

    // Small delay every 10 rows to avoid NocoDB throttle
    if (i > 0 && i % 10 === 0) {
      await new Promise(res => setTimeout(res, 200));
    }
  }

  // Log job to D1
  if (env.D1) {
    try {
      await env.D1.prepare(`
        CREATE TABLE IF NOT EXISTS sis_import_jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT,
          total INTEGER,
          created INTEGER,
          updated INTEGER,
          skipped INTEGER,
          enrolled INTEGER,
          errors_json TEXT,
          finished_at TEXT
        )
      `).run();
      await env.D1.prepare(`
        INSERT INTO sis_import_jobs (type, total, created, updated, skipped, enrolled, errors_json, finished_at)
        VALUES (?,?,?,?,?,?,?,?)
      `).bind(
        'students',
        rows.length,
        results.created,
        results.updated,
        results.skipped,
        results.enrolled,
        JSON.stringify(results.errors),
        new Date().toISOString()
      ).run();
    } catch { /* ignore D1 errors */ }
  }

  return json({
    ok: true,
    summary: {
      total_rows: rows.length,
      created: results.created,
      updated: results.updated,
      enrolled: results.enrolled,
      errors: results.errors.length,
    },
    errors: results.errors,
  });
}

// ── POST /admin/sis/import/courses ────────────────────────────
export async function handleSISImportCourses(request, env, { json }) {
  if (!await verifyAdminAuth(request, env)) return json({ error: 'Unauthorized' }, 401);
  if (!env.NOCO_COURSES) return json({ error: 'NOCO_COURSES chưa được cấu hình' }, 503);

  const body = await request.text().catch(() => '');
  let csvText = body;
  if (body.startsWith('{')) {
    try { csvText = JSON.parse(body).csv; } catch { return json({ error: 'Invalid JSON' }, 400); }
  }

  if (!csvText || csvText.trim().length === 0) return json({ error: 'CSV rỗng' }, 400);

  const rows = parseCSV(csvText);
  if (rows.length === 0) return json({ error: 'CSV không có dữ liệu' }, 400);
  if (rows.length > 100) return json({ error: 'Tối đa 100 khóa học mỗi lần import' }, 400);

  const results = { created: 0, errors: [] };
  const now = new Date().toISOString();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const title = (row.title || row.ten_khoa || '').trim();
    const code = (row.code || row.ma_khoa || '').trim();
    const description = (row.description || row.mo_ta || '').trim();

    if (!title) {
      results.errors.push({ row: i + 2, error: 'Thiếu tiêu đề khóa học' });
      continue;
    }

    try {
      const r = await nocoFetch(env, `/api/v2/tables/${env.NOCO_COURSES}/records`, 'POST', {
        Title: title.slice(0, 255),
        Code: code.slice(0, 50) || null,
        Description: description.slice(0, 2000) || null,
        Status: 'draft',
        CreatedAt: now,
      });

      if (!r.ok) {
        results.errors.push({ row: i + 2, title, error: 'Tạo khóa học thất bại' });
      } else {
        results.created++;
      }
    } catch (e) {
      results.errors.push({ row: i + 2, title, error: e.message });
    }

    if (i > 0 && i % 5 === 0) await new Promise(res => setTimeout(res, 200));
  }

  return json({
    ok: true,
    summary: { total_rows: rows.length, created: results.created, errors: results.errors.length },
    errors: results.errors,
  });
}

// ── CSV Parser (RFC 4180 compliant, handles quoted fields) ────
function parseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split('\n');
  if (lines.length < 2) return [];

  const headers = splitCSVRow(lines[0]).map(h => h.toLowerCase().trim().replace(/\s+/g, '_'));
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = splitCSVRow(line);
    const row = {};
    headers.forEach((h, idx) => { row[h] = (values[idx] || '').trim(); });
    rows.push(row);
  }
  return rows;
}

function splitCSVRow(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  result.push(current);
  return result;
}

/**
 * ActiveEdu — Teacher Dashboard Logic
 * API: https://api.gds.edu.vn
 */

const API = 'https://api.gds.edu.vn';

// ── AUTH ──────────────────────────────────────────────────────────────────────
export function getToken() { return localStorage.getItem('ae_token'); }
export function getUser()  { return JSON.parse(localStorage.getItem('ae_user') || '{}'); }

export function checkAuth() {
  if (!getToken()) { window.location.href = '../login.html'; return false; }
  const u = getUser();
  if (u.role && u.role !== 'teacher' && u.role !== 'admin') { window.location.href = '../login.html'; return false; }
  return true;
}

export function doLogout() {
  localStorage.removeItem('ae_token');
  localStorage.removeItem('ae_user');
  window.location.href = '../login.html';
}

// ── API FETCH ─────────────────────────────────────────────────────────────────
export async function apiFetch(path, opts = {}) {
  const token = getToken();
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  try {
    const r = await fetch(API + path, { ...opts, headers });
    if (r.status === 401) { doLogout(); return null; }
    return r;
  } catch (e) {
    console.warn('API fetch failed:', path, e);
    return null;
  }
}

// ── FORMATTERS ────────────────────────────────────────────────────────────────
export function fmtDate(d) {
  return new Intl.DateTimeFormat('vi-VN', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  }).format(d || new Date());
}

export function fmtDateTime(s) {
  if (!s) return '—';
  return new Intl.DateTimeFormat('vi-VN', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  }).format(new Date(s));
}

export function fmtNum(n) {
  return new Intl.NumberFormat('vi-VN').format(Number(n) || 0);
}

export function fmtPct(n) {
  return (Number(n) || 0).toFixed(1) + '%';
}

// ── TOAST ─────────────────────────────────────────────────────────────────────
export function toast(msg, type = 'info', duration = 3500) {
  let c = document.getElementById('toast-container');
  if (!c) {
    c = document.createElement('div');
    c.id = 'toast-container';
    c.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:9999;display:flex;flex-direction:column;gap:8px';
    document.body.appendChild(c);
  }
  const icon = { success: 'fa-circle-check', error: 'fa-circle-xmark', info: 'fa-circle-info', warn: 'fa-triangle-exclamation' }[type] || 'fa-circle-info';
  const color = { success: '#22C55E', error: '#EF4444', info: '#E66000', warn: '#F59E0B' }[type] || '#E66000';
  const t = document.createElement('div');
  t.style.cssText = `background:#1E293B;color:#fff;padding:11px 16px;border-radius:6px;font-size:13px;display:flex;align-items:center;gap:8px;box-shadow:0 4px 12px rgba(0,0,0,.15);min-width:240px;max-width:360px;border-left:3px solid ${color};animation:slideIn .2s ease;font-family:'Be Vietnam Pro',sans-serif`;
  t.innerHTML = `<i class="fas ${icon}" style="color:${color}"></i> ${msg}`;
  c.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, duration);
}

// ── COURSES ───────────────────────────────────────────────────────────────────
export async function loadTeacherCourses() {
  const r = await apiFetch('/api/teacher/courses');
  if (r && r.ok) {
    const d = await r.json();
    return d.list || d.courses || [];
  }
  // Fallback mock data
  return [
    { id: 1, name: 'Toán 10 — Học kỳ 1', subject: 'Toán học', term: 'HK1 2024-2025', students: 32, assignments: 8, published: true, color: '#E66000', completion: 72, pending_grade: 5 },
    { id: 2, name: 'Toán 11 — Học kỳ 2', subject: 'Toán học', term: 'HK2 2024-2025', students: 28, assignments: 6, published: true, color: '#2563EB', completion: 45, pending_grade: 3 },
    { id: 3, name: 'Toán Nâng cao 12', subject: 'Toán học', term: 'HK1 2024-2025', students: 18, assignments: 10, published: false, color: '#7C3AED', completion: 88, pending_grade: 0 },
    { id: 4, name: 'Luyện thi THPT Quốc gia', subject: 'Tổng hợp', term: 'HK2 2024-2025', students: 45, assignments: 12, published: true, color: '#0D9488', completion: 33, pending_grade: 8 },
  ];
}

// ── STUDENTS ──────────────────────────────────────────────────────────────────
export async function loadStudents(courseId) {
  const path = courseId ? `/api/teacher/students?course_id=${courseId}` : '/api/teacher/students';
  const r = await apiFetch(path);
  if (r && r.ok) {
    const d = await r.json();
    return d.list || d.students || [];
  }
  return generateMockStudents(20);
}

export function generateMockStudents(n) {
  const names = ['Nguyễn Văn An', 'Trần Thị Bích', 'Lê Minh Cường', 'Phạm Thu Dung', 'Hoàng Văn Em',
    'Đặng Thị Fang', 'Bùi Minh Giang', 'Võ Thị Hà', 'Đinh Văn Khánh', 'Lý Thị Lan',
    'Phan Minh Long', 'Ngô Thị Mai', 'Đỗ Văn Nam', 'Lưu Thị Oanh', 'Tô Minh Phúc',
    'Trương Thị Quỳnh', 'Hà Văn Sơn', 'Cao Thị Tâm', 'Trịnh Minh Uy', 'Vũ Thị Vân'];
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    name: names[i % names.length],
    email: `sv${i + 1}@gds.edu.vn`,
    avg_score: Math.round((5 + Math.random() * 5) * 10) / 10,
    submissions: Math.floor(Math.random() * 8) + 1,
    mastery: Math.round(Math.random() * 100),
    status: Math.random() > 0.15 ? 'active' : 'inactive',
    last_active: new Date(Date.now() - Math.random() * 7 * 86400000).toISOString(),
  }));
}

// ── ASSIGNMENTS ───────────────────────────────────────────────────────────────
export async function loadAssignments(courseId) {
  const path = courseId ? `/api/assessments?course_id=${courseId}` : '/api/assessments';
  const r = await apiFetch(path);
  if (r && r.ok) {
    const d = await r.json();
    return d.list || d.assignments || [];
  }
  return [
    { id: 1, title: 'Bài tập Giới hạn — Chương 1', course: 'Toán 10', due: '2025-01-10T23:59:00', submitted: 28, total: 32, avg_score: 7.8, status: 'graded' },
    { id: 2, title: 'Kiểm tra 1 tiết — Hàm số', course: 'Toán 10', due: '2025-01-15T23:59:00', submitted: 30, total: 32, avg_score: null, status: 'pending' },
    { id: 3, title: 'Bài tập Đạo hàm', course: 'Toán 11', due: '2025-01-12T23:59:00', submitted: 25, total: 28, avg_score: 8.2, status: 'graded' },
    { id: 4, title: 'Thực hành Tích phân', course: 'Toán 11', due: '2025-01-20T23:59:00', submitted: 10, total: 28, avg_score: null, status: 'open' },
    { id: 5, title: 'Đề thi thử THPT — Lần 1', course: 'Luyện thi THPT', due: '2025-01-08T23:59:00', submitted: 45, total: 45, avg_score: 6.9, status: 'graded' },
  ];
}

// ── GRADEBOOK ─────────────────────────────────────────────────────────────────
export async function loadGradebook(courseId) {
  if (!courseId) return { students: [], assignments: [], grades: [] };
  const r = await apiFetch(`/api/teacher/gradebook?course_id=${courseId}`);
  if (r && r.ok) return await r.json();
  // Mock gradebook
  const students = generateMockStudents(12);
  const assignments = [
    { id: 1, title: 'BT Chương 1', points: 10 },
    { id: 2, title: 'Kiểm tra 15\'', points: 10 },
    { id: 3, title: 'BT Chương 2', points: 10 },
    { id: 4, title: 'Kiểm tra 1 tiết', points: 10 },
    { id: 5, title: 'BT Chương 3', points: 10 },
  ];
  const grades = students.map(s => ({
    student_id: s.id,
    scores: assignments.map(a => ({
      assignment_id: a.id,
      score: Math.random() > 0.1 ? Math.round((4 + Math.random() * 6) * 10) / 10 : null,
    })),
  }));
  return { students, assignments, grades };
}

// ── OUTCOMES / MASTERY ────────────────────────────────────────────────────────
// Gọi API thực: GET /api/teacher/outcomes?course_id=X
// Trả về { outcomes, students, outcome_codes } từ D1 student_mastery
export async function loadMastery(courseId) {
  if (!courseId) return { outcomes: [], students: [], outcome_codes: [] };
  const r = await apiFetch(`/api/teacher/outcomes?course_id=${courseId}`);
  if (r && r.ok) {
    return await r.json();
  }
  return { outcomes: [], students: [], outcome_codes: [] };
}

// ── AI RESEARCH ───────────────────────────────────────────────────────────────
export async function runResearch({ mode, task, courseId, period }) {
  const r = await apiFetch('/ai/research-agent', {
    method: 'POST',
    body: JSON.stringify({ mode, task, course_id: courseId, period }),
  });
  if (r && r.ok) {
    const d = await r.json();
    return { ok: true, result: d.result || d.content || JSON.stringify(d, null, 2) };
  }
  return {
    ok: false,
    result: `[Chế độ demo — API chưa kết nối]\n\nPhân tích yêu cầu: "${task}"\n\nKết quả phân tích:\n• Dữ liệu học tập cho thấy 68% học sinh đạt chuẩn yêu cầu\n• 8 học sinh cần can thiệp hỗ trợ thêm ở phần ứng dụng\n• Đề xuất: Bổ sung 2 buổi ôn luyện tập trung vào kỹ năng yếu`,
  };
}

// ── HEATMAP HELPERS ───────────────────────────────────────────────────────────
export function masteryColor(score) {
  if (score === null || score === undefined) return '#F1F5F9';
  if (score >= 8.5) return '#16A34A';
  if (score >= 7.0) return '#65A30D';
  if (score >= 5.5) return '#EAB308';
  if (score >= 4.0) return '#F97316';
  return '#EF4444';
}

export function masteryLabel(score) {
  if (score === null || score === undefined) return 'Chưa nộp';
  if (score >= 8.5) return 'Xuất sắc';
  if (score >= 7.0) return 'Giỏi';
  if (score >= 5.5) return 'Trung bình';
  if (score >= 4.0) return 'Yếu';
  return 'Kém';
}

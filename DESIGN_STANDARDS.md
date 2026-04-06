# HỆ QUY CHUẨN THIẾT KẾ DỰ ÁN — AURA LMS
## Design Standards & Principles (Tài liệu gốc · Lưu trữ vĩnh viễn)

> **Nguồn tổng hợp:**
> - Thiết kế API Canvas LMS
> - Thiết kế ERD Canvas LMS (Nâng cao)
> - Thiết kế Giao diện Phân luồng
> - Đặc tả chức năng Canvas LMS
> - Pressman & Maxim — *Software Engineering: A Practitioner's Approach* (9th ed, McGraw-Hill 2020)

---

## I. TRIẾT LÝ NỀN TẢNG (Core Philosophy)

> *"Software engineering practice has a single overriding goal: to deliver on-time, high-quality, operational software that contains functions and features that meet the needs of all stakeholders."*
> — Pressman & Maxim

### 1.1 Tám nguyên tắc quy trình (Process Principles — Pressman Ch.6)

| # | Nguyên tắc | Áp dụng trong AURA |
|---|-----------|-------------------|
| 1 | **Be Agile** | Giữ cách tiếp cận đơn giản nhất; quyết định cục bộ khi được phép |
| 2 | **Focus on Quality at Every Step** | Exit condition của mọi task là chất lượng work product |
| 3 | **Be Ready to Adapt** | Process không phải tôn giáo; điều chỉnh khi constraints thay đổi |
| 4 | **Build an Effective Team** | Self-organizing team với mutual trust và respect |
| 5 | **Establish Communication Mechanisms** | Dự án thất bại khi thông tin rơi vào "kẽ hở" |
| 6 | **Manage Change** | Cơ chế rõ ràng cho request → assess → approve → implement |
| 7 | **Assess Risk** | Luôn có contingency plan; rủi ro bảo mật = rủi ro kỹ thuật |
| 8 | **Create Valuable Work Products** | Chỉ tạo ra work product có giá trị cho bước tiếp theo |

### 1.2 Nguyên tắc thực hành kỹ thuật (Technical Practice — Pressman Ch.9)

- **Separation of Concerns** — Chia vấn đề phức tạp thành các phần giải quyết độc lập
- **Modularity** — Mỗi component được đặt tên, địa chỉ hóa, và tích hợp rõ ràng
- **Information Hiding** — Module chỉ expose những gì cần thiết; ẩn algorithms + data nội bộ
- **Functional Independence** — Mỗi module có "single-minded" function, minimal interaction
- **High Cohesion / Low Coupling** — Cohesion cao (làm 1 việc tốt), coupling thấp (ít phụ thuộc)
- **Refactoring** — Trả "technical debt" đều đặn; không tích lũy debt
- **Abstraction** — Làm việc ở mức abstraction phù hợp với task hiện tại
- **Stepwise Refinement** — Từ high-level design → detailed design, không nhảy vào code ngay

---

## II. TIÊU CHUẨN KIẾN TRÚC (Architecture Standards)

### 2.1 Stack Architecture AURA LMS

```
┌─────────────────────────────────────────────────────────┐
│  Cloudflare Pages (Static Frontend)                     │
│  HTML + CSS + Vanilla JS (no framework)                 │
│  Be Vietnam Pro · #E66000 primary · #2D3B45 sidebar     │
└──────────────────┬──────────────────────────────────────┘
                   │ HTTPS / REST API
                   │ Authorization: Bearer <jwt>
┌──────────────────▼──────────────────────────────────────┐
│  Cloudflare Workers (Edge API — api.gds.edu.vn)         │
│  < 50ms globally · Rate limit: 3000 req/5min/IP         │
│  JWT auth · verifyToken() · CORS headers                │
└──────────────────┬──────────────────────────────────────┘
                   │ HTTP (NocoDB REST API)
┌──────────────────▼──────────────────────────────────────┐
│  NocoDB (Headless DB)                                   │
│  Table IDs stored as Cloudflare Secrets                 │
│  JSONB cho flexible data (quiz_data, settings...)       │
└─────────────────────────────────────────────────────────┘
  + Google Drive (file storage via drive.js)
  + Cloudflare D1 (xAPI LRS, likes, audit logs)
```

### 2.2 Quy tắc phân tầng bắt buộc (Layering Rules)

| Tầng | Được phép | Không được phép |
|------|-----------|-----------------|
| Frontend | Gọi API qua `apiFetch()` | Gọi NocoDB trực tiếp |
| Frontend | Đọc `ae_token` từ localStorage | Expose token trong URL |
| Worker | Xử lý auth, validation, business logic | Chứa hardcoded secrets |
| Worker | Gọi NocoDB REST | Gọi trực tiếp DB internals |
| NocoDB | Lưu trữ dữ liệu | Chứa business logic |
| Drive | Qua `drive.js` wrapper | Gọi Drive API từ frontend |

### 2.3 Multi-tenant & RBAC

**Hierarchy:** `Account (Trường) → Course → Section → Module → Item`

| Role | Scope | Quyền |
|------|-------|-------|
| `admin` | Account-level | Full CRUD mọi thứ |
| `teacher` | Course-level | Full CRUD trong course của mình |
| `student` | Enrolled courses | Read + Submit (bài tập, quiz) |
| `observer` | Linked student | Read-only data của student được link |
| `designer` | Course-level | Content CRUD, không xem grades |

**Quy tắc bắt buộc:** Mọi Worker route phải `verifyToken()` → check `session.role` → execute. Observer chỉ được phép `GET` endpoints.

---

## III. TIÊU CHUẨN API (API Design Standards)

### 3.1 Global Headers & Format

```http
Request:   Authorization: Bearer <jwt_token>
           Content-Type: application/json

Response:  { "list": [...], "total": N }     (list responses)
           { "item": {...} }                  (single item)
           { "error": "message" }             (errors)

HTTP codes: 200 OK · 201 Created · 400 Bad Request
            401 Unauthorized · 403 Forbidden · 404 Not Found
            422 Unprocessable Entity · 500 Internal Error
```

### 3.2 URL Naming Conventions

```
GET    /api/{resource}               → list (có pagination)
GET    /api/{resource}/{id}          → detail
POST   /api/{resource}               → create
PATCH  /api/{resource}/{id}          → partial update (preferred over PUT)
DELETE /api/{resource}/{id}          → soft delete
POST   /api/{resource}/{id}/{action} → domain action

Ví dụ AURA:
GET    /api/courses
GET    /api/courses/{id}
POST   /api/assessments
PATCH  /api/submissions/{id}         (grade, update)
POST   /api/discussions/{id}/like    (domain action)
POST   /api/quiz_submissions/{id}/complete
```

### 3.3 Patterns bắt buộc

**Soft Delete (KHÔNG BAO GIỜ hard delete dữ liệu giáo dục)**
```javascript
// Sai ✗
await deleteRecord(id);

// Đúng ✓
await patchRecord(id, { workflow_state: 'deleted' });
// hoặc
await patchRecord(id, { IsDeleted: true });
```

**Optimistic UI**
```javascript
// 1. Cập nhật DOM ngay lập tức
updateLocalState(newData);
// 2. Gọi API ngầm
const r = await apiFetch('/api/resource', { method: 'PATCH', body: ... });
// 3. Rollback nếu lỗi
if (!r?.ok) { rollbackLocalState(oldData); showToast('Lỗi', 'error'); }
```

**Debounce cho Auto-save**
```javascript
let saveTimer;
function onGradeInput(value) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveGrade(value), 500); // 500ms debounce
}
```

**Pre-signed URL Upload (file > 1MB)**
```javascript
// 1. Lấy upload URL từ server
const { upload_url } = await apiFetch('/api/files/upload-url', { method: 'POST', ... });
// 2. Upload trực tiếp lên Drive (bypass Worker)
await fetch(upload_url, { method: 'PUT', body: file });
// 3. Xác nhận với server
await apiFetch('/api/files', { method: 'POST', body: { drive_id, course_id, ... } });
```

**Versioning / Audit Trail**
```javascript
// Mỗi lần grade change → tạo SubmissionVersion snapshot
const snapshot = { score, comment, gradedBy, gradedAt, submissionData };
await createRecord('SubmissionVersions', { SubmissionId: id, Data: JSON.stringify(snapshot) });
```

### 3.4 Anti-cheating Events (Quiz)
```javascript
// Ghi log mọi hành động đáng ngờ
document.addEventListener('visibilitychange', () => {
  if (document.hidden) logEvent('page_blurred');
  else logEvent('page_focused');
});
// POST /api/quiz_submissions/{id}/events
// Body: { events: [{ event_type, timestamp }] }
```

### 3.5 GraphQL (cho nested data phức tạp)

Endpoint: `POST /api/graphql`

Dùng khi cần lấy data lồng sâu qua nhiều bảng:
- Observer Dashboard: `user → observees → enrollments → course + grades + upcoming`
- Gradebook: `course → assignments + students → submissions`

Không dùng GraphQL cho mutations — dùng REST.

---

## IV. TIÊU CHUẨN CƠ SỞ DỮ LIỆU (Database Standards)

### 4.1 Nguyên tắc thiết kế bảng

**workflow_state — Bắt buộc với mọi entity chính**
```
Courses:     available | completed | claimed | deleted
Users:       registered | pre_registered | deleted
Modules:     active | unpublished | deleted
Assessments: published | unpublished | deleted
Submissions: unsubmitted | submitted | graded | pending_review
Quizzes:     untaken | in_progress | complete
```

**Polymorphic Associations** (thay vì nhiều FK nullable)
```sql
-- Thay vì:
content_tag.assignment_id FK
content_tag.quiz_id FK
content_tag.file_id FK
content_tag.page_id FK

-- Dùng polymorphic:
content_tag.content_id    (BigInt — FK đến bất kỳ entity nào)
content_tag.content_type  (Varchar — 'Assignment' | 'Quiz' | 'File' | 'Page')
```

**JSONB cho Flexible Data** (không tạo hàng tá NULL columns)
```javascript
// question_data: cấu trúc khác nhau cho từng loại câu hỏi
{ type: 'multiple_choice', options: ['A','B','C','D'], correct: 0, explanation: '...' }
{ type: 'essay', max_words: 500 }
{ type: 'file_upload', allowed_types: ['pdf','docx'] }

// completion_requirements trong Module
{ item_1: 'must_view', item_2: { type: 'min_score', score: 80 } }

// settings trong Course/Account
{ allow_sis_import: true, feature_flags: { discussions_v2: true } }
```

### 4.2 Naming Conventions

```
Tables:   PascalCase           → Courses, Users, Enrollments, Assessments
Columns:  PascalCase           → CourseId, UserId, WorkflowState, CreatedAt
FK:       {Entity}Id           → CourseId, TeacherId, ModuleId
Boolean:  Is{State}            → IsPublished, IsDeleted, IsPinned, IsAnonymous
Enum:     lowercase values     → 'active', 'deleted', 'published'
JSON:     camelCase trong JSON → { maxAttempts, timeLimit, shuffleAnswers }
```

### 4.3 Bảng cốt lõi đã thiết kế

| Nhóm | Tables |
|------|--------|
| **Core** | Accounts, Courses, Users, Enrollments, Sections |
| **Content** | Modules, ContentTags, Pages, Files, Announcements |
| **Assessment** | Assessments, Submissions, SubmissionVersions, Rubrics, RubricCriteria |
| **Quiz** | QuizQuestions, QuizSubmissions, QuizSubmissionEvents |
| **Communication** | Discussions, DiscussionReplies, Messages, Conversations, ConversationParticipants |
| **Calendar** | CalendarEvents |
| **Social** | PortfolioEntries, Groups, GroupMembers, PeerReviews |
| **LTI** | ExternalTools |
| **D1 (edge)** | xapi_statements, discussion_likes, announcement_reads, audit_logs |

### 4.4 Concurrency & Performance

```javascript
// Submission nộp bài đúng giây cuối → Message Queue
// Không xử lý sync vì race condition

// Quiz auto-save → LocalStorage backup khi offline
localStorage.setItem(`quiz_${quizId}_answers`, JSON.stringify(answers));
// Sync lên server khi `window.addEventListener('online', syncAnswers)`

// Grade updates → debounce 500ms, PATCH idempotent
// Gọi nhiều lần cùng data → cùng kết quả
```

---

## V. TIÊU CHUẨN GIAO DIỆN (UI/UX Standards)

### 5.1 Design Tokens (CSS Variables — Bắt buộc tuyệt đối)

```css
:root {
  /* === COLORS === */
  --primary:        #E66000;   /* AURA orange — brand color */
  --primary-dark:   #C45200;   /* hover state */
  --primary-light:  #FFF3EC;   /* light bg, tags */
  --success:        #10B981;
  --warning:        #F59E0B;
  --danger:         #EF4444;
  --info:           #3B82F6;

  --sidebar-bg:     #2D3B45;   /* dark sidebar */
  --sidebar-text:   #CBD5E1;
  --sidebar-hover:  rgba(255,255,255,.08);
  --sidebar-active: rgba(230,96,0,.18);

  --text:           #1A202C;   /* body text */
  --text-muted:     #64748B;   /* secondary text */
  --text-light:     #94A3B8;   /* placeholder */
  --border:         #E2E8F0;
  --bg:             #F8FAFC;   /* page background */
  --card-bg:        #FFFFFF;

  /* === TYPOGRAPHY === */
  --font:           'Be Vietnam Pro', sans-serif;
  --font-size-xs:   11px;
  --font-size-sm:   12px;
  --font-size-base: 14px;
  --font-size-md:   15px;
  --font-size-lg:   18px;
  --font-size-xl:   22px;
  --font-size-2xl:  28px;

  /* === SPACING (4px base) === */
  --sp-1: 4px;  --sp-2: 8px;  --sp-3: 12px; --sp-4: 16px;
  --sp-5: 20px; --sp-6: 24px; --sp-8: 32px; --sp-12: 48px;

  /* === BORDER RADIUS === */
  --radius-sm:   6px;
  --radius:      10px;
  --radius-lg:   16px;
  --radius-xl:   24px;
  --radius-full: 100px;

  /* === SHADOWS === */
  --shadow-sm: 0 1px 3px rgba(0,0,0,.08);
  --shadow:    0 4px 16px rgba(0,0,0,.10);
  --shadow-lg: 0 8px 32px rgba(0,0,0,.14);

  /* === TRANSITIONS === */
  --transition: 0.18s ease;
  --transition-slow: 0.3s ease;
}
```

### 5.2 Ba Nguyên tắc Vàng UI (Mandel's Golden Rules — Pressman Ch.12)

#### Rule 1: Place the User in Control
- Người dùng kiểm soát phần mềm, không phải ngược lại
- Cho phép **interrupt và undo** mọi action (không lock user vào sequence)
- Hỗ trợ **keyboard shortcuts** cho power users (đặc biệt trong quiz, SpeedGrader)
- Không force user vào mode không mong muốn (autocorrect, auto-redirect)
- **Direct manipulation**: kéo, thả, click trực tiếp vào object

#### Rule 2: Reduce the User's Memory Load
- Hệ thống "nhớ" thay cho người dùng; hiện lại context khi cần
- **Skeleton loader** cho lần load đầu; spinner nhỏ cho lần sau
- **Default values** có ý nghĩa; luôn có nút Reset
- **Progressive disclosure**: hiện high-level trước, detail khi user yêu cầu
- Visual cues thay vì yêu cầu người dùng ghi nhớ menu/commands
- Breadcrumb luôn hiển thị "bạn đang ở đâu"

#### Rule 3: Make the Interface Consistent
- Mọi màn hình dùng cùng design tokens (màu, font, spacing)
- Navigation pattern giống nhau: sidebar + breadcrumb + topbar
- Cùng action → cùng visual feedback (xanh = success, đỏ = error, cam = warning)
- Keyboard shortcuts không thay đổi giữa các trang
- Ngôn ngữ nhất quán: "Lưu" không đổi thành "Submit" hay "Xác nhận"

### 5.3 Layout Chuẩn

**Desktop (3 cột):**
```
┌──────────────┬──────────────────────────────┬──────────┐
│ SIDEBAR      │ MAIN CONTENT                 │ CONTEXT  │
│ 230px fixed  │ Flex: 1 (min 600px)          │ 280px    │
│ #2D3B45 bg   │ #F8FAFC bg                   │ hidden   │
│ Logo top     │ Topbar (breadcrumb + actions)│ on <1024 │
│ Nav items    │ Page content (card-based)    │          │
│ ─────────── │                              │          │
│ Course list  │                              │          │
└──────────────┴──────────────────────────────┴──────────┘
```

**Responsive breakpoints:**
- `>1024px`: 3 cột đầy đủ
- `768-1024px`: Context sidebar collapse thành Drawer (vuốt từ phải)
- `<768px`: Sidebar thành Hamburger (off-canvas); Main = 100vw

**Topbar chuẩn:**
```html
<div class="topbar">
  <button class="hamburger" onclick="toggleSidebar()">☰</button>
  <div class="breadcrumb">
    <a href="dashboard.html">Dashboard</a>
    <span>›</span>
    <span id="breadcrumb-current">Tên trang</span>
  </div>
  <div class="topbar-actions"><!-- actions --></div>
</div>
```

### 5.4 Component Patterns (Chuẩn hóa)

| Component | Khi nào dùng | Pattern |
|-----------|-------------|---------|
| **Skeleton** | Initial data load | `<div class="skeleton-line">` animated |
| **Spinner** | Submit/save đang xử lý | `.spinner` trong button, disable button |
| **Toast** | Success/error feedback | 4 loại: success/error/warning/info; 3s tự tắt |
| **Modal** | Destructive actions, forms phức tạp | `.modal.active`, click outside = close |
| **Drawer** | Detail view, không rời trang | Slide từ phải, 400px, overlay |
| **Empty State** | List/content rỗng | Icon + mô tả + CTA button |
| **Chip/Badge** | Count, status, tag | `border-radius: 100px`, compact |
| **Progress Bar** | Upload, quiz timer, module completion | height 6px, `--primary` fill |

### 5.5 Quản lý Network States

```
Trạng thái        Hiển thị                      Action
─────────────────────────────────────────────────────────
isFetching        Skeleton loader               —
isSubmitting      Overlay mờ + disabled btns    —
API Success       Toast green "Thành công"       Cập nhật UI
API Error         Toast red + error message      Rollback optimistic UI
Network Offline   Banner vàng "Mất kết nối"     Lưu vào LocalStorage
Network Restored  Auto-sync + dismiss banner     Sync lên server
401               Redirect → login.html          Clear localStorage
403               Toast "Không có quyền"        —
404               Empty state                    —
500               Toast "Lỗi server" + retry     —
```

### 5.6 Accessibility (a11y) — Bắt buộc

```html
<!-- Icon buttons: bắt buộc aria-label -->
<button aria-label="Thêm câu hỏi"><i class="fas fa-plus"></i></button>

<!-- Images: alt text mô tả -->
<img src="..." alt="Biểu đồ điểm số theo tuần">

<!-- Form inputs: label hoặc aria-label -->
<label for="score-input">Điểm số</label>
<input id="score-input" type="number" min="0" max="10">

<!-- Focus styles: KHÔNG được xóa -->
:focus { outline: 2px solid var(--primary); outline-offset: 2px; }
```

**WCAG AA Requirements:**
- Contrast ratio ≥ 4.5:1 cho text thường
- Contrast ratio ≥ 3:1 cho large text (≥18px hoặc ≥14px bold)
- Quiz phải navigable hoàn toàn bằng keyboard
- Mọi interactive element accessible bằng Tab key

---

## VI. TIÊU CHUẨN PHÂN LUỒNG (User Flow Standards)

### 6.1 Flow 1: Module Management (Teacher)

**Thách thức:** Drag & Drop mượt mà, Optimistic UI

```
1. Load     → GET /api/modules?course_id=X → Skeleton → Render accordion
2. Add Item → Modal → chọn loại (Assignment/Quiz/File) → POST /api/modules/{id}/items
3. Reorder  → Drag end → NGAY LẬP TỨC swap vị trí trong DOM
             → API call: PUT /api/modules/items/reorder { item_ids: [45,42,47] }
             → Nếu API lỗi: rollback DOM + toast error
4. Publish  → Click icon → NGAY LẬP TỨC đổi icon xám → xanh
             → PATCH /api/modules/{id} { published: true }
```

### 6.2 Flow 2: Assignment Submission (Student)

**Thách thức:** Upload file lớn, offline resilience

```
1. View     → Render assignment detail + Rubric table (nếu có)
2. Validate → Client-side: max 50MB, đúng file types từ assignment config
3. Upload   → POST /api/files/upload-url → lấy pre-signed URL
             → Upload trực tiếp lên Drive (progress bar onUploadProgress)
4. Submit   → POST /api/submissions { file_ids, text, url }
5. Success  → Confetti animation → button đổi "Nộp lại" → state = 'submitted'
```

### 6.3 Flow 3: SpeedGrader (Teacher)

**Thách thức:** Performance, auto-save, media

```
Layout: Split-pane — Document Viewer (trái) | Grading Panel (phải)

Document Viewer:
- PDF/Word: render qua Google Docs Viewer iframe
- Annotation layer: tọa độ nét vẽ lưu JSON [{type, x, y}]

Grading Panel:
- Auto-save debounce 500ms → PATCH /api/submissions/{id}
- Comments: text | audio (WebRTC) | video | stickers
- Navigation: Pre-fetch student trước/sau → no page reload khi Next/Prev
```

### 6.4 Flow 4: Quiz Engine (Student)

**Thách thức:** Anti-cheating, offline, auto-submit

```
1. Start     → POST /api/quiz_submissions → begin timer
2. Load Qs   → GET /api/quiz_submissions/{id}/questions (shuffled server-side)
3. Answer    → Chọn → LocalStorage save NGAY → PATCH /api/.../questions/{q_id}
4. Offline   → Chỉ lưu LocalStorage → banner "Mất kết nối"
             → window.online → sync từ LocalStorage lên server
5. Anti-cheat→ visibilitychange/blur → log event → POST /api/.../events
6. Timer     → setInterval 1s + sync với server mỗi 60s (không tin client clock)
7. Submit    → timer=0: disable inputs → POST /api/.../complete
             → manual: confirm dialog → POST /api/.../complete
8. Result    → Grade letter (A+/A/A-/B+/B/B-/C/D/F) + score + review mode
```

### 6.5 Flow 5: Observer/Parent View

```
Context: observedStudentId stored in session/localStorage
Toggle: Dropdown "Đang xem: [Tên Con] ▼" trong top nav

Read-only enforcement:
  - Mọi submit button, form textarea, quiz start button
  - Bọc bằng role check: if (session.role === 'observer') return null
  - Observer thấy: grades, assignments, calendar, announcements
  - Observer không thấy: submit buttons, discussion reply form, quiz attempt
```

---

## VII. TIÊU CHUẨN CODE (Code Standards)

### 7.1 JavaScript — Vanilla JS (Frontend)

**Naming Conventions:**
```javascript
// Variables & functions → camelCase
const courseId = new URLSearchParams(location.search).get('course_id');
async function loadModules() { ... }

// Constants → SCREAMING_SNAKE_CASE
const API = 'https://api.gds.edu.vn';
const FILE_ICONS = { pdf: { cls: 'pdf', icon: '📄' }, ... };
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

// Private/internal → _prefix
let _filesLoaded = false;
let _cachedCourses = null;

// DOM element IDs → kebab-case
// <div id="files-list">, <button id="upload-btn">
```

**Patterns bắt buộc:**
```javascript
// Auth helpers
const session = JSON.parse(localStorage.getItem('ae_user') || '{}');
const getToken = () => localStorage.getItem('ae_token');

// apiFetch — LUÔN dùng, không gọi fetch() trực tiếp
async function apiFetch(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const token = getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const r = await fetch(API + path, { ...opts, headers });
  if (r.status === 401) { doLogout(); return null; }
  return r;  // Caller phải check r.ok trước r.json()
}

// Error handling pattern chuẩn
try {
  const r = await apiFetch('/api/resource', { method: 'POST', body: JSON.stringify(data) });
  if (!r || !r.ok) throw new Error(await r?.text() || 'Lỗi không xác định');
  const d = await r.json();
  // success → update UI
  showToast('Thành công!', 'success');
} catch(e) {
  showToast(e.message || 'Có lỗi xảy ra', 'error');
}

// XSS Prevention — LUÔN escHtml khi inject user content vào DOM
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
                  .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Lazy loading panels
let _panelLoaded = false;
function initPanel() {
  if (_panelLoaded) return;
  _panelLoaded = true;
  loadPanelData();
}
```

### 7.2 Cloudflare Worker (Backend)

**Route naming:**
```javascript
// URL paths: lowercase, hyphens, plural nouns
/api/courses          ✓
/api/courseList       ✗ (không camelCase)
/api/course_list      ✗ (không snake_case)

/api/courses/{id}/enrollments   ✓ (nested resource)
/api/discussions/{id}/like      ✓ (domain action)
```

**Handler pattern:**
```javascript
export async function handleCourses(request, env) {
  const { method } = request;
  const session = await verifyToken(request, env);
  if (!session) return err('Unauthorized', 401);

  const url = new URL(request.url);
  const id = url.pathname.split('/')[3]; // /api/courses/{id}

  if (method === 'GET' && !id) return listCourses(env, session);
  if (method === 'GET' && id)  return getCourse(env, session, id);
  if (method === 'POST')       return createCourse(request, env, session);
  if (method === 'PATCH' && id) return updateCourse(request, env, session, id);
  if (method === 'DELETE' && id) return softDeleteCourse(env, session, id);

  return err('Method not allowed', 405);
}

// Response helpers chuẩn
const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
const ok  = (data)        => new Response(JSON.stringify(data), { headers: CORS });
const err = (msg, status) => new Response(JSON.stringify({ error: msg }), { status, headers: CORS });
```

### 7.3 HTML/CSS

```html
<!-- Semantic HTML: bắt buộc dùng đúng tags -->
<main>, <nav>, <aside>, <section>, <article>, <header>, <footer>

<!-- CSS Class Naming: BEM-inspired, consistent -->
.card, .card-header, .card-body, .card-footer
.btn, .btn-primary, .btn-secondary, .btn-outline, .btn-danger
.btn-sm, .btn-lg
.panel, .panel.active
.sb-item, .sb-item.active          (sidebar items)
.modal, .modal.active
.drawer, .drawer.active
.toast, .toast.success, .toast.error, .toast.warning, .toast.info
.chip, .badge, .tag
.skeleton-line, .skeleton-card      (loading states)
.empty-state                        (no data)
.spinner                            (loading indicator)

<!-- Không hardcode inline styles ngoại trừ dynamic values -->
<!-- Luôn dùng CSS variables từ :root -->
style="color: var(--primary)"       ✓ (dynamic)
style="color: #E66000"              ✗ (hardcode)
```

---

## VIII. TIÊU CHUẨN KIỂM THỬ (Testing Standards)

> *"Testing is a process of executing a program with the intent of finding an error."*
> — Pressman & Maxim

### 8.1 Verification Checklist (mỗi feature hoàn thành)

**Functional:**
- [ ] Load không có lỗi console khi data = [] (empty state hiện đẹp)
- [ ] Load không có lỗi console khi có data (hiển thị đúng)
- [ ] Submit form thành công → UI cập nhật đúng
- [ ] Submit form lỗi → toast error, không crash
- [ ] 401 response → redirect login.html

**Role-based:**
- [ ] Admin thấy đúng gì (full access)
- [ ] Teacher thấy đúng gì (course-scoped)
- [ ] Student thấy đúng gì (read + submit)
- [ ] Observer thấy đúng gì (read-only)

**Responsive:**
- [ ] Mobile 375px — layout không vỡ
- [ ] Tablet 768px — layout đúng
- [ ] Desktop 1280px — layout đầy đủ

**Edge cases:**
- [ ] Tên rất dài không làm vỡ layout
- [ ] Unicode/emoji trong content hiển thị đúng
- [ ] Reload trang không mất state quan trọng

### 8.2 Error Boundary Pattern
```javascript
// Mỗi widget/panel phải có try/catch riêng
// Lỗi một panel không làm crash cả trang
async function loadWidget() {
  try {
    const data = await apiFetch('/api/data');
    renderWidget(data);
  } catch(e) {
    document.getElementById('widget').innerHTML =
      '<div class="empty-state"><p>Không thể tải dữ liệu</p></div>';
    // Không throw — chỉ log
    console.warn('[Widget]', e.message);
  }
}
```

---

## IX. TIÊU CHUẨN TÍCH HỢP (Integration Standards)

### 9.1 LTI (Learning Tools Interoperability)

```
Bảng ExternalTools: id, context_id, context_type, name,
                    consumer_key, shared_secret (encrypted), domain, url, settings

Flow:
Student click LTI assignment
  → LMS đóng gói: { student_id, role, course_id, resource_id }
  → Ký JWT bằng shared_secret
  → POST sang tool's launch_url
  → Student SSO vào tool trong iframe — không rời LMS
```

### 9.2 SIS Import (CSV)

```
CSV format: student_id, name, email, course_id, section
Endpoint:   POST /admin/sis/import/students

Flow:
1. Teacher upload CSV
2. Client-side parse → preview bảng 5 dòng đầu
3. Confirm → POST với toàn bộ CSV
4. Server: bulk create users → enroll → return { success: N, errors: [...] }
5. UI hiện kết quả: "X thành công, Y lỗi"
```

### 9.3 Google Drive Integration

```javascript
// Luôn qua drive.js wrapper
import { uploadToDrive, getDriveUrl, deleteFromDrive } from './drive.js';

// Không gọi Drive API trực tiếp từ frontend
// Files metadata lưu trong NocoDB (Files table)
// Drive chỉ là storage layer
```

**File constraints:**
```
Max size:      50 MB per file
Allowed types: pdf, docx, xlsx, pptx, jpg, jpeg, png, gif, mp4, mov, zip, rar
Denied types:  exe, bat, sh, js (security)
```

### 9.4 xAPI / LRS (Learning Record Store)

```javascript
// Mọi learning event → xAPI statement → D1
const statement = {
  actor:  { name: session.name, mbox: `mailto:${session.email}` },
  verb:   { id: 'http://adlnet.gov/expapi/verbs/completed', display: { 'vi-VN': 'hoàn thành' } },
  object: { id: `https://aura.edu.vn/activities/quiz/${quizId}`, definition: { name: { 'vi-VN': quizTitle } } },
  result: { score: { scaled: score/maxScore, raw: score, max: maxScore } }
};
```

**Event verbs dùng trong AURA:**
`attempted · completed · passed · failed · answered · viewed · commented · liked · submitted`

---

## X. TIÊU CHUẨN BẢO MẬT (Security Standards)

### 10.1 Authentication & Authorization

```javascript
// JWT trong localStorage (không dùng cookies)
localStorage.setItem('ae_token', token);
localStorage.setItem('ae_user', JSON.stringify({ id, name, role, email }));

// Mọi Worker route: verify TRƯỚC khi thực thi
const session = await verifyToken(request, env);
if (!session) return err('Unauthorized', 401);
if (session.role !== 'admin') return err('Forbidden', 403);

// Admin routes tách riêng prefix /admin/...
// Teacher routes check ownership: session.userId === course.teacherId || role === 'admin'
// Student routes check enrollment: isEnrolled(session.userId, courseId)
```

### 10.2 Input Sanitization

```javascript
// XSS: escHtml() MỌI LÚC khi inject user content vào innerHTML
element.innerHTML = `<div>${escHtml(userContent)}</div>`;

// Không dùng innerHTML với user content chưa escape:
element.innerHTML = userContent; // ✗ XSS RISK

// Dùng textContent khi chỉ cần text:
element.textContent = userContent; // ✓ Tự escape

// API validation tại Worker:
if (!title || title.length > 255) return err('Title invalid', 422);
if (!['teacher','student'].includes(role)) return err('Invalid role', 422);
```

### 10.3 File Upload Security

```javascript
// Validate MIME type tại Worker (không tin client)
const mimeType = request.headers.get('Content-Type');
const ALLOWED_MIMES = ['application/pdf', 'image/jpeg', 'image/png', ...];
if (!ALLOWED_MIMES.includes(mimeType)) return err('File type not allowed', 422);

// Validate size tại Worker
if (contentLength > 50 * 1024 * 1024) return err('File too large', 413);
```

### 10.4 Data Privacy

```javascript
// Grade data: student chỉ xem của mình; teacher xem toàn course
// Không bao giờ trả về password hash trong response
// Audit log mọi grade change
const auditEntry = { action: 'grade_change', userId: session.userId,
                     submissionId, oldScore, newScore, timestamp: new Date().toISOString() };
await env.D1.prepare('INSERT INTO audit_logs VALUES (?,?,?,?,?,?,?)')
           .bind(...Object.values(auditEntry)).run();

// Observer: chỉ được GET, chỉ xem data của linked student
if (session.role === 'observer') {
  if (method !== 'GET') return err('Forbidden', 403);
  if (studentId !== session.observeeId) return err('Forbidden', 403);
}
```

---

## XI. TIÊU CHUẨN DEPLOY (Deployment Standards)

### 11.1 Git Workflow

```bash
# Commit message format (Conventional Commits)
feat:     thêm SpeedGrader panel vào teacher dashboard
fix:      sửa điều kiện bất khả thi trong quiz review button
refactor: tách loadFiles() thành helper riêng
style:    cập nhật CSS theo design system mới
docs:     thêm API endpoint docs cho file upload
perf:     lazy load files tab chỉ khi mở lần đầu
test:     thêm verification checklist cho quiz flow

# Deploy frontend (tự động qua Cloudflare Pages)
git add {files}
git commit -m "feat: ..."
git push origin main   # → auto deploy

# Deploy Worker (khi có thay đổi backend)
cd worker
wrangler deploy
```

### 11.2 Secrets Management

```bash
# Cloudflare Workers Secrets (không trong code)
wrangler secret put JWT_SECRET
wrangler secret put NOCO_TOKEN
wrangler secret put GOOGLE_DRIVE_KEY
wrangler secret put NOCO_COURSES_TABLE_ID
# v.v.

# Local development: .dev.vars (trong .gitignore)
JWT_SECRET=dev_secret_here
NOCO_TOKEN=dev_token_here
```

### 11.3 Performance Targets

| Metric | Target |
|--------|--------|
| Time to First Byte | < 50ms (edge) |
| First Contentful Paint | < 1.5s |
| API simple queries | < 200ms |
| API complex queries | < 1s |
| File upload feedback | Progress bar khi > 2s |
| Quiz auto-save | < 300ms (debounced 500ms) |

### 11.4 Error Monitoring

```javascript
// Không bao giờ để unhandled promise rejection
window.addEventListener('unhandledrejection', event => {
  console.error('[Unhandled]', event.reason);
  // Optional: gửi về error tracking service
});

// Mọi async function trong Worker phải có try/catch
try {
  return await handleRequest(request, env);
} catch(e) {
  console.error('[Worker Error]', e);
  return err('Internal server error', 500);
}
```

---

## XII. ROADMAP & ƯU TIÊN (Feature Priority)

### 12.1 Trạng thái hiện tại (2026-04-06)

**✅ Hoàn thành:**
- Discussions (Padlet style), Announcements, Messages/Inbox, Calendar, Portfolio
- Quiz nâng cao (grade letters, keyboard shortcuts, attempt counter, review mode)
- Teacher Dashboard++ (create course, create assessment, quiz builder, SpeedGrader)
- File uploads (Tài liệu tab trong course.html)
- Admin Dashboard++ (real-time stats từ /admin/stats)
- Student Dashboard (link đúng sang course.html)
- Backend: 18+ NocoDB tables, 80+ routes

**⬜ Chưa có (ưu tiên cao):**
- Rubrics (tiêu chí chấm điểm — rất cần cho SpeedGrader)
- Groups (nhóm học viên trong khoá học)
- Observer role đầy đủ

**⬜ Chưa có (ưu tiên trung bình):**
- Peer Review (chấm chéo)
- Mastery Paths (adaptive learning paths)
- Video Conference (Jitsi integration)
- Analytics charts (Chart.js)

### 12.2 AURA vs Canvas — Lợi thế cần khai thác

| Canvas nhược điểm | AURA giải pháp |
|---|---|
| UI phức tạp, nhiều click | Tối giản, luồng rõ ràng, mobile-first |
| Không có AI built-in | 6 AI agents + Socratic tutor tích hợp |
| Không có adaptive learning | BKT mastery tracking + SM-2 spaced repetition |
| Hiệu năng chậm (Rails) | Cloudflare Workers edge — <50ms globally |
| Không theo chuẩn VN | GDPT 2018 outcomes/alignments built-in |
| Gradebook phức tạp | Weighted groups + AI speed grader |
| Thông báo rời rạc | Unified notification + achievement system |
| Không có xAPI built-in | xAPI LRS trong D1 |

---

## XIII. QUYẾT ĐỊNH KIẾN TRÚC (Architecture Decision Records)

### ADR-001: Vanilla JS thay vì React/Vue
**Quyết định:** Dùng Vanilla JS thuần cho toàn bộ frontend
**Lý do:** Cloudflare Pages deploy tĩnh; không cần build step; performance tốt hơn; dễ debug
**Trade-off:** Không có component reuse tự động → cần discipline trong naming + patterns

### ADR-002: NocoDB thay vì SQL trực tiếp
**Quyết định:** Dùng NocoDB làm headless CMS/DB layer
**Lý do:** Rapid prototyping; GUI cho admin; REST API tự động; không cần viết SQL
**Trade-off:** Ít control hơn về optimization; phụ thuộc vào NocoDB service

### ADR-003: Soft Delete bắt buộc
**Quyết định:** Không bao giờ hard delete educational data
**Lý do:** Audit requirements; khả năng restore; compliance giáo dục
**Implementation:** `workflow_state = 'deleted'` hoặc `IsDeleted = true`

### ADR-004: JWT trong localStorage
**Quyết định:** Lưu JWT trong localStorage, không dùng httpOnly cookies
**Lý do:** Cloudflare Pages là static hosting, không hỗ trợ server-side cookies
**Mitigation:** Short token expiry; verify mọi request tại Worker

### ADR-005: JSONB cho Quiz Question Data
**Quyết định:** Lưu toàn bộ câu hỏi trong 1 JSONB field thay vì normalize
**Lý do:** Mỗi loại câu hỏi có structure khác nhau; flexible extension
**Trade-off:** Không thể query sâu vào question content từ DB

---

*Tài liệu này là **Living Document** — cập nhật khi có quyết định kiến trúc mới hoặc thay đổi công nghệ*
*Version: 1.0 · Tạo ngày: 2026-04-06*
*Nguồn: Thiết kế API · Thiết kế ERD · Thiết kế Giao diện · Đặc tả chức năng · Pressman & Maxim (2020)*

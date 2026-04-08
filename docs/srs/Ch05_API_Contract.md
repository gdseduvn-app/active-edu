# CHƯƠNG 5: API CONTRACT — Consolidated v2.1

> **Mã tài liệu:** SRS-CH05 v2.1 · Tháng 4/2025
> **Base URL:** `https://api.lms.school.edu.vn/v1`
> **Auth mặc định:** JWT Bearer Token (RS256, 15 phút TTL)
> **Rate limit:** 100 req/min/user · 429 khi vượt
> **Consolidated từ:** Ch5 Full v1.0 (908 dòng) + Ch5 v2.0 + Phụ lục B Changelog + UI_Ch5 + TEST_Ch5

---

## 5.1 Quy ước và tiêu chuẩn chung

| Hạng mục | Quy ước |
|---------|---------|
| **Protocol** | HTTPS bắt buộc. HTTP redirect 301 → HTTPS. TLS 1.2+ minimum |
| **Format** | JSON (application/json) cho tất cả request body và response |
| **Encoding** | UTF-8 bắt buộc. Mọi string tiếng Việt phải encode đúng |
| **Versioning** | Version trong URL path: /v1/, /v2/. Breaking changes → tăng version |
| **Pagination** | Cursor-based: `?cursor={opaque}&limit={int}`. Response: `{data:[], next_cursor, has_more, total_count}` |
| **Filtering** | Query params: `?subject=toan&grade=8&status=active`. AND logic |
| **Sorting** | `?sort=created_at:desc,title:asc`. Nhiều trường: dấu phẩy |
| **Date/Time** | ISO 8601 UTC: `2025-04-06T08:30:00Z`. Client hiển thị theo timezone |
| **Null vs Missing** | null = tồn tại không có giá trị. Missing = không áp dụng |
| **Idempotency** | POST/PATCH quan trọng: header `Idempotency-Key: {uuid}`. Server cache 24h |

### Response Envelope chuẩn

```json
// Thành công — single object
{"data": {...}, "meta": {"request_id": "uuid", "timestamp": "..."}}

// Thành công — danh sách
{"data": [...], "pagination": {"total_count": 784, "limit": 20, "next_cursor": "...", "has_more": true}, "meta": {...}}

// Lỗi
{"error": {"code": "LESSON_NOT_FOUND", "message": "Không tìm thấy bài học.", "details": {...}, "request_id": "uuid"}}
```

### Auth Levels

| Auth level | Header | Role được phép | Ghi chú |
|-----------|--------|---------------|---------|
| Public | (không cần) | Tất cả | Chỉ /auth/login, /auth/refresh, /health |
| Bearer | `Authorization: Bearer {access_token}` | student, teacher, admin, super_admin | JWT RS256. Verify signature + exp |
| Teacher+ | `Authorization: Bearer {access_token}` | teacher, admin, super_admin | Middleware check role |
| Admin | `Authorization: Bearer {access_token}` | admin, super_admin | Middleware check role |
| Internal | `X-Internal-Key: {shared_secret}` | Service-to-service | LMS↔Agent. Không expose public |

---

## 5.2 Authentication & Authorization APIs

Token rules: Access token JWT RS256 TTL 15 phút, `jti` để blacklist. Refresh token opaque 64 chars TTL 7 ngày rotate mỗi lần dùng. Rate limit login: 5 sai/IP/15 phút → lockout.

| Method | Endpoint | Auth | Mô tả | Request body | Response |
|--------|---------|------|-------|-------------|----------|
| POST | /auth/login | Public | Đăng nhập | `email, password` | 201 `{access_token, refresh_token, expires_in, user:{id,name,role,grade}}` |
| POST | /auth/refresh | Public | Làm mới token | `refresh_token` | 200 `{access_token, expires_in}` — rotate refresh |
| POST | /auth/logout | Bearer | Đăng xuất | `refresh_token` | 200 `{success:true}` |
| GET | /auth/me | Bearer | Thông tin user | — | 200 `{id,email,name,role,grade,class_code,last_login_at}` |
| POST | /auth/forgot-password | Public | Reset mật khẩu | `email` | 200 `{message}` — gửi OTP email |
| POST | /auth/reset-password | Public | Đặt lại MK | `email, otp, new_password` | 200 `{success:true}` |
| PATCH | /auth/me/password | Bearer | Đổi MK khi đăng nhập | `current_password, new_password` | 200 `{success:true}` |
| POST | /auth/verify-email | Public | Xác thực email | `token` | 200 `{success:true}` |

---

## 5.3 User Management APIs

| Method | Endpoint | Auth | Mô tả | Request / Query | Response |
|--------|---------|------|-------|----------------|----------|
| GET | /users | Admin | Danh sách users | `?role&class_code&is_active&limit&cursor` | 200 `{data:[user[]], pagination}` |
| POST | /users | Admin | Tạo user | `email, username, full_name, role, grade[opt]` | 201 `{data:{id, ...user}}` |
| GET | /users/:id | Teacher+ | Thông tin 1 user | — | 200 `{data:{...user}}` — student chỉ xem chính mình |
| PUT | /users/:id | Admin | Cập nhật toàn bộ | `full_name, grade, class_code, is_active, role` | 200 `{data:{...updated}}` |
| DELETE | /users/:id | Admin | Soft delete | — | 200 `{success:true}` — set deleted_at |
| POST | /users/bulk-import | Admin | Import CSV | multipart/form-data: file.csv | 202 `{job_id}` — async |
| GET | /classes | Teacher+ | Danh sách lớp | `?grade&subject` | 200 `{data:[{class_code, student_count}]}` |
| GET | /classes/:code/students | Teacher+ | HS trong lớp | `?sort&limit&cursor` | 200 `{data:[{user_id, name, current_level}]}` |

---

## 5.4 Lesson & Content APIs

| Method | Endpoint | Auth | Mô tả | Request / Query | Response |
|--------|---------|------|-------|----------------|----------|
| GET | /lessons | Bearer | Danh sách lessons | `?subject&grade&status&bloom_level&limit&cursor&sort` | 200 `{data:[lesson[]], pagination}` |
| GET | /lessons/search | Bearer | Full-text search | `?q=str&subject&grade&limit` | 200 `{data:[{lesson_id,score,snippet}]}` |
| GET | /lessons/:id | Bearer | Chi tiết 1 lesson | — | 200 `{data:{...lesson, media_url_signed}}` |
| POST | /lessons | Teacher+ | Tạo lesson | `lesson_id(PK), subject, grade_num, requirement, bloom_level` | 201 `{data:{lesson_id}}` status=draft |
| PUT | /lessons/:id | Teacher+ | Cập nhật toàn bộ | Full lesson object | 200 `{data:{updated_at}}` |
| DELETE | /lessons/:id | Admin | Archive | — | 200 — set status=archived |
| GET | /lessons/:id/preview | Teacher+ | Preview góc HS | — | 200 `{data:{...lesson}}` role=student context |
| GET | /lessons/:id/analytics | Teacher+ | Thống kê bài | `?from&to` | 200 `{avg_score, completion_rate, avg_duration}` |
| POST | /lessons/:id/duplicate | Teacher+ | Nhân bản | `new_lesson_id[opt]` | 201 `{data:{new_lesson_id}}` |
| GET | /lessons/:id/next | Bearer | Agent bài tiếp | `?learner_id&subject` | 200 `{lesson_id, reason, rule_triggered, confidence, alternatives[]}` |
| POST | /lessons/:id/complete | Bearer | HS hoàn thành | `final_score, time_spent_sec, model_used, idempotency_key` | 202 `{accepted:true}` async |
| GET | /lessons/:id/questions | Bearer | Câu hỏi quiz | `?phase=2|5&shuffle` | 200 `{data:[{q_id,text,type,options}]}` — không trả đáp án |
| POST | /lessons/:id/quiz/submit | Bearer | Nộp quiz | `answers:[{question_id,answer}], duration_sec, idempotency_key` | 202 → event → 200 `{score,results[],feedback}` |

### File & Media APIs

| Method | Endpoint | Auth | Mô tả | Request | Response |
|--------|---------|------|-------|---------|----------|
| POST | /files/presign | Teacher+ | Presigned upload URL | `filename, content_type, file_size_bytes` | 200 `{upload_url(PUT), file_key, expires_at}` |
| POST | /files/confirm | Teacher+ | Confirm upload | `file_key, lesson_id, media_type` | 200 `{data:{media_url_signed}}` |
| GET | /files/:key/url | Bearer | Get URL để xem | — | 200 `{url, expires_at}` TTL 1h |
| DELETE | /files/:key | Teacher+ | Xóa file | — | 200 `{success:true}` |

> Upload flow: (1) POST /files/presign → (2) Client PUT trực tiếp MinIO → (3) POST /files/confirm. Không upload qua LMS API.

---

## 5.5 Assignment, Peer Review & Discussion APIs

| Method | Endpoint | Auth | Mô tả |
|--------|---------|------|-------|
| GET | /lessons/:id/assignment | Bearer | Đề bài assignment |
| PUT | /lessons/:id/assignment | Teacher+ | Tạo/cập nhật đề |
| POST | /assignments/:lesson_id/submit | Bearer | Nộp bài (idempotency_key) |
| PATCH | /submissions/:id/grade | Teacher+ | GV chấm thủ công |
| GET | /peer-reviews/assigned | Bearer | Bài cần nhận xét |
| POST | /peer-reviews/:submission_id | Bearer | Gửi nhận xét (min 50 chars) |
| GET | /peer-reviews/received | Bearer | Nhận xét mình nhận |
| POST | /discussions/:lesson_id/post | Bearer | Đăng discussion |
| POST | /journals/:lesson_id | Bearer | Gửi journal entry |
| GET | /journals/:lesson_id/all | Teacher+ | Xem journals lớp — **không xem nội dung** (privacy) |

---

## 5.6 AI Agent APIs

### Learner Model

| Method | Endpoint | Auth | Mô tả |
|--------|---------|------|-------|
| GET | /agent/learner/:id/model | Teacher+ | Toàn bộ LM 17 fields |
| GET | /agent/learner/:id/model/summary | Bearer | Tóm tắt cho HS xem |
| GET | /agent/learner/:id/next | Bearer | Gọi Planner lấy bài tiếp |
| POST | /agent/learner/:id/next/feedback | Bearer | HS feedback recommendation (1-5) |
| POST | /agent/learner/:id/reset | Admin | Reset LM (giữ event log) |
| GET | /agent/learner/:id/snapshots | Teacher+ | Lịch sử snapshot |
| POST | /agent/learner/:id/restore/:snap_id | Teacher+ | Khôi phục snapshot |

### Decision & Override

| Method | Endpoint | Auth | Mô tả |
|--------|---------|------|-------|
| GET | /agent/decisions | Teacher+ | Lịch sử quyết định |
| POST | /agent/decisions/:id/override | Teacher+ | GV override (403 nếu R01/R02) |
| GET | /agent/decisions/stats | Teacher+ | Thống kê phân phối luật |

### Rules & Internal

| Method | Endpoint | Auth | Mô tả |
|--------|---------|------|-------|
| GET | /agent/rules | Admin | Danh sách R01-R10 + config |
| PATCH | /agent/rules/:id | Admin | Bật/tắt/thay threshold |
| POST | /internal/events | Internal | Batch events → Redis Streams |

---

## 5.7 Analytics & Notification APIs

| Method | Endpoint | Auth | Mô tả |
|--------|---------|------|-------|
| GET | /analytics/class/:code/overview | Teacher+ | Tổng quan lớp |
| GET | /analytics/class/:code/mastery-heatmap | Teacher+ | Heatmap YCCĐ |
| GET | /analytics/class/:code/at-risk | Teacher+ | HS cần hỗ trợ |
| GET | /analytics/lesson/:id/effectiveness | Teacher+ | Hiệu quả bài học |
| GET | /analytics/agent/performance | Admin | Hiệu quả Agent |
| POST | /analytics/reports/generate | Teacher+ | Tạo báo cáo PDF/Excel (async) |
| GET | /notifications | Bearer | Thông báo user |
| PATCH | /notifications/:id/read | Bearer | Đánh dấu đã đọc |
| PUT | /notifications/preferences | Bearer | Cài đặt thông báo |

---

## 5.8 WebSocket & Python Grader

### WebSocket — Socket.io

```javascript
const socket = io('wss://api.lms.school.edu.vn', {
  auth: { token: accessToken },
  transports: ['websocket', 'polling'],
});

// Events server → client:
socket.on('grader:result', (data) => { /* submission_id, score, test_results[] */ });
socket.on('agent:recommendation', (data) => { /* lesson_id, reason, rule_triggered */ });
socket.on('agent:feedback', (data) => { /* feedback_text, type: pass|fail|repair */ });
socket.on('notification:new', (data) => { /* id, title, content, type */ });
socket.on('peer_review:received', (data) => { /* submission_id, lesson_title */ });

// Client → server:
socket.emit('session:heartbeat', { session_id: '...' }); // mỗi 30s
```

### Python Grader Contract

```json
// POST /grader/submit (Internal)
// Request:
{
  "submission_id": "uuid", "learner_id": "uuid", "lesson_id": "020108.0202a6",
  "code": "def table_values(a, b, x_values):\n    ...",
  "language": "python", "hint_mode": "per_test",
  "timeout_sec": 10, "memory_mb": 128
}
// Response 200:
{
  "data": {
    "passed": false, "score": 0.6,
    "test_results": [
      {"test_id": 1, "passed": true, "input": "a=2, b=1, x=[0,1,2]", "expected": "[1,3,5]", "actual": "[1,3,5]"},
      {"test_id": 2, "passed": false, "input": "a=-1, b=3, x=[-2,-1,0]", "expected": "[5,4,3]", "actual": "[1,2,3]",
       "hint": "Khi a âm, y giảm khi x tăng."}
    ],
    "error_types": ["negative_slope_error"], "bloom_evidence": 3
  }
}
// Errors: 408 EXECUTION_TIMEOUT | 422 CODE_SYNTAX_ERROR | 507 MEMORY_LIMIT_EXCEEDED
```

---

## 5.9 [v2.0] AURA APIs — 12 endpoints

| Method | Endpoint | Auth | Mô tả |
|--------|---------|------|-------|
| POST | /aura/upload | Teacher+ | Upload file → AURA pipeline |
| GET | /aura/lessons | Teacher+ | Danh sách AURA lessons |
| GET | /aura/lessons/:id | Teacher+ | Chi tiết aura_lesson |
| GET | /aura/lessons/:id/qa | Teacher+ | QA checklist status |
| POST | /aura/lessons/:id/activate | Teacher+ | Activate (sau QA pass) |
| GET | /aura/lessons/:id/versions | Teacher+ | Lịch sử versions |
| POST | /aura/lessons/:id/rollback/:version | Teacher+ | Rollback version |
| GET | /aura/serve/:id | Bearer | Serve học liệu (iframe proxy) |
| GET | /aura/gap-analysis | Teacher+ | Bloom gap analysis |
| POST | /aura/import/questions | Teacher+ | Import OCR → questions |
| GET | /aura/lessons/:id/events | Teacher+ | Events từ AURA Bridge |
| DELETE | /aura/lessons/:id | Teacher+ | Archive AURA lesson |

## 5.10 [v2.0] Question Bank APIs — 10 endpoints

| Method | Endpoint | Auth | Mô tả |
|--------|---------|------|-------|
| GET | /qbank/questions | Teacher+ | Danh sách (filter bloom, lesson_id, status) |
| POST | /qbank/questions | Teacher+ | Tạo câu hỏi |
| PUT | /qbank/questions/:id | Teacher+ | Cập nhật |
| PATCH | /qbank/questions/:id/review | Teacher+ | Thay đổi review_status |
| POST | /qbank/questions/batch | Teacher+ | Batch import |
| POST | /qbank/generate | Teacher+ | AI generate từ YCCĐ [P2] |
| GET | /qbank/item-analysis/:exam_id | Teacher+ | Item Analysis sau thi |
| POST | /qbank/blueprint | Teacher+ | Tạo exam blueprint |
| POST | /qbank/blueprint/:id/generate | Teacher+ | Sinh đề từ blueprint |
| GET | /qbank/stats | Teacher+ | Thống kê ngân hàng |

## 5.11 [v2.0] Exam APIs — 12 endpoints

| Method | Endpoint | Auth | Mô tả |
|--------|---------|------|-------|
| POST | /exams | Teacher+ | Tạo đề mới (status=draft) |
| GET | /exams/:id | Bearer | Chi tiết đề (answers hidden khi active) |
| PATCH | /exams/:id/status | Teacher+ | Chuyển trạng thái (8 states) |
| POST | /exams/:id/publish | Teacher+ | Publish đề |
| GET | /exams/:id/submissions | Teacher+ | Tất cả bài nộp |
| POST | /exams/:id/submit | Bearer | HS nộp bài (idempotency_key) |
| GET | /exams/:id/results | Bearer | Kết quả (chỉ khi graded) |
| PATCH | /exams/:id/grade | Teacher+ | GV chấm tay |
| GET | /exams/:id/analytics | Teacher+ | Post-exam analytics |
| POST | /exams/auto-generate | Teacher+ | Sinh đề từ blueprint |
| GET | /exams/:id/item-analysis | Teacher+ | p-value, D-index, α |
| DELETE | /exams/:id | Teacher+ | Archive |

## 5.12 [v2.0] Flashcard APIs — 8 endpoints

| Method | Endpoint | Auth | Mô tả |
|--------|---------|------|-------|
| GET | /flashcards/decks | Bearer | Danh sách decks |
| POST | /flashcards/decks | Bearer | Tạo deck mới |
| GET | /flashcards/due | Bearer | Cards cần review hôm nay (SM-2) |
| POST | /flashcards/review | Bearer | Submit review (rating 1-5) |
| GET | /flashcards/stats | Bearer | Thống kê SM-2 |
| POST | /flashcards/decks/:id/cards | Bearer | Thêm card vào deck |
| DELETE | /flashcards/cards/:id | Bearer | Xóa card |
| GET | /flashcards/decks/:id | Bearer | Chi tiết deck + cards |

## 5.13 [v2.0] Gamification APIs — 7 endpoints

| Method | Endpoint | Auth | Mô tả |
|--------|---------|------|-------|
| GET | /gamification/profile | Bearer | XP, level, badges, streak |
| GET | /gamification/leaderboard/:class | Bearer | Bảng xếp hạng (opt-in) |
| GET | /gamification/xp-history | Bearer | Lịch sử XP transactions |
| POST | /gamification/xp/award | Teacher+ | GV trao XP thủ công |
| GET | /gamification/badges | Bearer | Tất cả badges + status |
| GET | /gamification/challenges | Bearer | Challenges tự nguyện |
| PATCH | /gamification/preferences | Bearer | Bật/tắt leaderboard |

---

## 5.14 Privacy & Consent APIs

> **[BỔ SUNG v2.1]** — 7 endpoints mới, bắt buộc NĐ 13/2023.

| Method | Endpoint | Auth | Mô tả | Request | Response |
|--------|---------|------|-------|---------|----------|
| GET | /auth/consent/status | Bearer | Kiểm tra consent hiện tại | — | 200 `{student_assent, parent_consent, purposes[], version}` |
| POST | /auth/consent | Bearer | Ghi nhận consent | `{consent_type, purposes[], evidence?}` | 201 `{consent_id}` |
| POST | /auth/consent/withdraw | Bearer | Rút consent | `{reason}` | 200 `{withdrawn_at}` — thông báo hậu quả trước |
| GET | /privacy/notice | Public | Privacy notice (tiếng Việt) | `?version` | 200 `{content_html, version, effective_date}` |
| POST | /users/:id/request-deletion | Bearer | Yêu cầu xóa DLCN | `{reason, requested_by}` | 202 `{request_id, sla_hours: 72}` |
| GET | /users/:id/deletion-status | Bearer | Trạng thái yêu cầu xóa | — | 200 `{status, estimated_completion}` |
| PATCH | /admin/deletion-requests/:id | Admin | Approve/reject xóa | `{action, reason}` | 200 `{updated}` |

## 5.15 Parent Portal APIs (Phase 2 stubs)

> **[BỔ SUNG v2.1]**

| Method | Endpoint | Auth | Mô tả |
|--------|---------|------|-------|
| GET | /parent/children | Parent | Danh sách con đã link |
| GET | /parent/children/:id/progress | Parent | Tiến trình học (LM summary) |
| POST | /parent/consent/:child_id | Parent | Consent cho con dùng LMS |
| POST | /parent/consent/:child_id/withdraw | Parent | Rút consent |

---

## 5.16 Error Codes — 32 codes

### HTTP 4xx — Client Errors

| HTTP | Code | Trường hợp | Client action |
|------|------|-----------|--------------|
| 400 | VALIDATION_ERROR | Request body sai schema | Đọc details, hiển thị field sai |
| 400 | INVALID_LESSON_ID | lesson_id sai format QĐ 791 | Kiểm tra format |
| 400 | DUPLICATE_SUBMISSION | Idempotency_key đã dùng | Dùng kết quả cũ |
| 400 | MAX_ATTEMPTS_EXCEEDED | Nộp quá số lần tối đa | Hiển thị thông báo |
| 400 | PEER_REVIEW_TOO_SHORT | Nhận xét < min_word_count | Yêu cầu viết thêm |
| 401 | INVALID_TOKEN | JWT không hợp lệ | Redirect login |
| 401 | TOKEN_EXPIRED | Access token hết hạn | Auto refresh token |
| 401 | REFRESH_TOKEN_INVALID | Refresh token hết hạn | Redirect login bắt buộc |
| 403 | FORBIDDEN | Không có quyền | Hiển thị lỗi quyền |
| 403 | STUDENT_ACCESS_DENIED | HS cố xem LM người khác | Log attempt |
| 403 | LESSON_NOT_ACTIVE | Bài chưa active | Thông báo chờ GV publish |
| 403 | PREREQUISITE_NOT_MET | Chưa hoàn thành bài tiên quyết | Hiển thị bài cần làm trước |
| 403 | **CONSENT_REQUIRED** | **HS chưa consent** | **Redirect /consent** |
| 403 | **PARENT_CONSENT_REQUIRED** | **HS <18 chưa có PH consent** | **Redirect /consent/waiting** |
| 404 | LESSON_NOT_FOUND | lesson_id không tồn tại | Kiểm tra ID |
| 404 | USER_NOT_FOUND | learner_id không tồn tại | Kiểm tra ID |
| 408 | EXECUTION_TIMEOUT | Code Python chạy quá timeout | Gợi ý kiểm tra vòng lặp |
| 409 | DUPLICATE_LESSON_ID | Tạo lesson trùng ID | Dùng ID khác |
| 409 | CONCURRENT_UPDATE | 2 GV edit cùng lúc | Refresh lấy version mới |
| 409 | **DELETION_ALREADY_REQUESTED** | **Đã có request pending** | **Chờ xử lý** |
| 422 | CODE_SYNTAX_ERROR | Code Python syntax error | Hiển thị syntax error |
| 429 | RATE_LIMIT_EXCEEDED | Vượt 100 req/min | Retry sau Retry-After header |

### HTTP 2xx — Success đặc biệt

| HTTP | Code | Trường hợp |
|------|------|-----------|
| 202 | ACCEPTED | Async processing (grader, deletion, report) |
| 202 | **DELETION_QUEUED** | **Yêu cầu xóa đã nhận, đang xử lý** |

### HTTP 5xx — Server Errors

| HTTP | Code | Trường hợp | Client action |
|------|------|-----------|--------------|
| 500 | INTERNAL_ERROR | Bug server | Log request_id, báo admin |
| 502 | AGENT_UNAVAILABLE | Agent down | Auto fallback next_if_pass |
| 503 | GRADER_UNAVAILABLE | Grader down | Thông báo GV sẽ chấm thủ công |
| 507 | MEMORY_LIMIT_EXCEEDED | Code Python vượt memory | Gợi ý tối ưu memory |

---

## 5.17 OpenAPI, Testing & Versioning

### OpenAPI 3.0

OpenAPI spec tự động sinh từ Fastify route definitions + Zod schemas. Swagger UI tại `/docs`.

### API Testing Strategy

| Loại test | Tool | Coverage | Ví dụ |
|-----------|------|---------|-------|
| Unit — Schema | Zod schema test (Jest) | 100% schemas | Valid/invalid input, edge cases |
| Integration — Endpoint | Supertest + Testcontainers | 80% endpoints | Auth flow, happy path, error cases |
| Contract — Agent API | Pact.js consumer-driven | 100% LMS→Agent | Mọi endpoint LMS gọi Agent |
| E2E — Full flow | Playwright | Critical journeys | Login → quiz → recommendation → override |
| Load — Performance | k6 | P95 < 1s | 200 VUs, 10 phút |
| Security — OWASP | OWASP ZAP | Top 10 | SQL injection, XSS, IDOR, broken auth |

### API Versioning & Deprecation

- **Breaking changes** → tăng MAJOR: /v1/ → /v2/
- **Non-breaking** (thêm field optional) → không tăng version
- **Deprecation:** Header `Deprecation: true, Sunset: {date}`. Thông báo ≥ 3 tháng
- **Support window:** Mỗi version support tối thiểu 12 tháng sau MAJOR tiếp theo

---

## 5.18 API Changelog

### v1.0.0 — Baseline Go-Live (04/2025)

12 nhóm API baseline: Auth (8), Users (11), Lessons (12), Quiz (7), Files (5), Assignment (9), PeerReview (5), Discussion (8), Agent (17), Analytics (9), Notification (7), Grader (5), WebSocket (5 events).

### v1.0.1 — Hotfix (04/2025)

- Fixed: Event idempotency_key TTL 1d → 7d
- Fixed: `?bloom_level=6` filter type casting
- Fixed: Presigned URL expire 1h → 2h cho file > 100MB

### v1.1.0 — Minor (06/2025)

- Fixed: Grader timeout edge case (10.0s threshold → 10.05s)
- Fixed: `calculate_mastery()` với 0 attempts → NaN → 0.0
- Fixed: Refresh token rotation race condition (distributed lock)
- Security: Rate limit login 10 → 5 lần sai
- Changed: Error response thêm `request_id` field
- Added: GET /files/:key/metadata

### v2.0.0 — Phase 2 (Q4/2025 kế hoạch)

- Added: SSO Google (POST /auth/sso/google)
- Added: /agent/learner/:id/model/summary
- Added: /analytics/agent/performance
- Added: POST /notifications/send/class
- Added: Claude LLM feedback (feedback_source: 'template'|'llm')
- Changed: /lessons/:id/next thêm `alternatives[]`
- Deprecated: GET /auth/me/token-info → Sunset 2026-Q2

### Deprecation Timeline

| API | Deprecated từ | Sunset | Thay thế |
|-----|--------------|--------|----------|
| GET /auth/me/token-info | v1.1.0 (06/2025) | v3.0.0 / 2026-Q2 | GET /auth/me |

---

## 5.19 UI Screens — API Admin/Dev

| Screen | Route | Mô tả |
|--------|-------|-------|
| **API Explorer** (SCR-5-01) | /admin/api | Interactive Postman-like. 50+ endpoints searchable. Auth auto-fill. Response panel |
| **Error Code Reference** (SCR-5-02) | /admin/api/errors | Search by code. Filter 4xx/5xx. Example response |
| **WebSocket Monitor** (SCR-5-03) | /admin/api/ws | Connect/disconnect. Event log 50 newest. Emit panel |
| **Grader Config** (SCR-5-04) | /admin/grader | Test cases CRUD. Dry-run code. View results |

---

## 5.20 Test Cases — Ch5 (30 TCs)

### P0 Critical (8 TCs)

| TC | Scenario | Expected |
|----|----------|----------|
| TC-5-001 | JWT RS256 verify 100× | < 500ms. Public key only |
| TC-5-002 | Refresh token rotate, no reuse | 2× refresh → 401 on 2nd |
| TC-5-003 | Student cannot see other's LM | 403 STUDENT_ACCESS_DENIED |
| TC-5-004 | Exam answers hidden khi active | No correct_answer field |
| TC-5-005 | Rate limit 429 + Retry-After | Under load test |
| TC-5-006 | Idempotency quiz/submit 2× | Score counted once |
| TC-5-007 | Internal API reject missing key | 401 without X-Internal-Key |
| TC-5-008 | Response envelope standard | All endpoints have {data, pagination?, meta?} |

### P1 Important (12 TCs)

| TC | Scenario | Expected |
|----|----------|----------|
| TC-5-009 | Login brute-force 5 fails | 6th → 429. Audit logged |
| TC-5-010 | Cursor pagination no drift | 20/page. Total = DB count |
| TC-5-011 | Forgot-password no user leak | 200 always. ±50ms latency |
| TC-5-012 | Presign URL expires at TTL | 15 min TTL |
| TC-5-013 | Peer review min 50 chars | 400 if shorter |
| TC-5-014 | Discussion Phase 4 visibility | Posts invisible until self-post |
| TC-5-015 | Journal: Teacher no content | Privacy — word_count only |
| TC-5-016 | Override R01/R02 rejected | 403 RULE_CANNOT_OVERRIDE |
| TC-5-017 | Rule reload graceful | No request drops |
| TC-5-018 | Consent required block | 403 CONSENT_REQUIRED without consent |
| TC-5-019 | Deletion request 72h SLA | Request → complete within 72h |
| TC-5-020 | Parent consent required <18 | 403 PARENT_CONSENT_REQUIRED |

# CHƯƠNG 0: TỔNG QUAN HỆ THỐNG — Consolidated v1.0

> **Mã tài liệu:** SRS-CH00 v1.0 · Tháng 4/2025
> **Vai trò:** Tài liệu đọc đầu tiên — mọi thành viên team phải nắm trước khi đọc bất kỳ chương nào khác.
> **Consolidated từ:** SRS_Ch0_TongQuan + UI_Ch0_DesignSystem + TEST_Ch0_Strategy

---

## 0.1 Vision & Mục tiêu

### Vision Statement

> **AdaptLearn: LMS học tập thích nghi thế hệ mới.** AI Agent cá nhân hoá lộ trình học sinh theo năng lực thực tế, chuẩn QĐ 791.

**Khác biệt cốt lõi:** Không chỉ quản lý học liệu. Agent **hiểu từng học sinh** qua Learner Model 17 fields, Bloom 6 cấp, error patterns — rồi tự quyết định bài học tiếp theo.

### Lộ trình Phase

| Phase | Phạm vi | Quy mô |
|-------|---------|--------|
| **Phase 1** | THPT Thủ Thiêm · 1 trường · 800 HS · 5 môn · Rule-based Agent R01-R10 | MVP |
| **Phase 2** | Tích hợp LLM Claude · Socratic Engine · Item Analysis · SSO · Flashcard | Mở rộng |
| **Phase 3** | Cụm 5 trường · Learning Agent · Parent Portal · NCS research platform | Nhân rộng |

---

## 0.2 Stakeholders

| Role | Số lượng | Tương tác chính | Nhu cầu cốt lõi |
|------|---------|-----------------|-----------------|
| **Học sinh (HS)** | ~800/trường | LessonPage, Quiz, Grader, Dashboard | Bài học phù hợp năng lực, feedback tức thì, gamification |
| **Giáo viên (GV)** | ~40/trường | Lesson Studio, Analytics, Override | Tạo bài nhanh, hiểu lớp qua data, kiểm soát Agent |
| **Admin trường** | 2-3/trường | User management, Config, Audit log | Quản lý user, threshold, hệ thống ổn định |
| **DevOps** | 1-2 | Docker, CI/CD, Monitoring, Backup | Uptime 99.9%, deploy an toàn, rollback < 30 phút |
| **NCS/Researcher** | 1-5 | AI Agent Lab, EDM, Export data | Data sạch, experiment engine, publication pipeline |
| **Phụ huynh [P3]** | ~800 | Parent Portal (read-only) | Xem tiến trình con, weekly digest |

---

## 0.3 Kiến trúc tổng thể — 10 Microservices

```
[Browser/Mobile PWA]
        │ HTTPS TLS 1.3
        ▼
[Nginx API Gateway :443]
        │
        ├── lms-api :3000        (Node.js Fastify)    — API gateway, auth, lesson CRUD
        ├── auth-service :3001   (Node.js JWT RS256)   — JWT, refresh rotate, consent, SSO
        ├── agent-service :8000  (Python FastAPI)      — Rule Engine R01-R10, Learner Model
        ├── aura-service :8001   (Python BeautifulSoup)— AURA pipeline: HTML/PDF/Video/Quiz/Python
        ├── grader-service :8002 (Python Pyodide)      — Python code grading, sandbox
        ├── qbank-service :3002  (Node.js Fastify)     — Question Bank, Exam blueprint [P2]
        ├── flashcard-svc :8003  (Python FastAPI)      — SM-2 spaced repetition
        ├── gamification-svc :3003 (Node.js)           — XP, badges, streak [P2]
        ├── notification-svc :3004 (Node.js Socket.io) — WebSocket push, email, Telegram
        └── analytics-svc :8004  (Python pandas)       — Class analytics, Bloom radar, at-risk
```

| Service | Stack | RAM | Port | Phase | Chức năng |
|---------|-------|-----|------|-------|-----------|
| lms-api | Node.js 22 + Fastify | 512MB | 3000 | P1 | API gateway chính, auth, lesson CRUD, file proxy |
| auth-service | Node.js + JWT RS256 | 256MB | 3001 | P1 | JWT issue/verify, refresh rotate, consent, SSO Google |
| agent-service | Python 3.12 + FastAPI | 512MB | 8000 | P1 | Rule Engine R01-R10, Learner Model, Curriculum Planner |
| aura-service | Python + BeautifulSoup | 512MB | 8001 | P1 | AURA pipeline: parse HTML/PDF/Video/Quiz/Python |
| grader-service | Python + Pyodide | 256MB | 8002 | P1 | Python code grading, test runner, memory/time limit |
| qbank-service | Node.js + Fastify | 256MB | 3002 | P2 | Question Bank, Exam blueprint, Item Analysis |
| flashcard-svc | Python + FastAPI | 128MB | 8003 | P1 | SM-2 algorithm, spaced repetition scheduling |
| gamification-svc | Node.js | 128MB | 3003 | P2 | XP, badges, streak, leaderboard |
| notification-svc | Node.js + Socket.io | 128MB | 3004 | P1 | SSE/WebSocket push, email digest, Telegram alert |
| analytics-svc | Python + pandas | 256MB | 8004 | P1 | Class analytics, Bloom radar, at-risk detection |

---

## 0.4 Bản đồ 19 Chương — Toàn bộ phạm vi SRS

| Ch | Tên | Nội dung cốt lõi | Phase | Dependency |
|----|-----|------------------|-------|-----------|
| **Ch1** | Auth & Dashboard | JWT RS256, SSO, RBAC 4 roles, Consent BVDLCN, Dashboard | P1 | — |
| **Ch2A** | Kiến trúc & Event Bus | C4 Model, 10 services, Redis Streams 18 events | P1 | — |
| **Ch2B** | DB Schema Core | users, lessons, sessions, learner_models, agent_decisions | P1 | Ch2A |
| **Ch2C** | DB Schema Services | AURA, Questions, Exam, Flashcard, Gamification | P1 | Ch2B |
| **Ch2D** | Hạ tầng & DevOps | CI/CD, Monitoring Grafana, Backup, Alerting | P1 | Ch2A |
| **Ch3A** | Lesson Studio | 4-panel editor, AI Assist, Auto-save, QA gate 10 điểm | P1 | Ch2B |
| **Ch3B** | Learning Experience | 5 GĐ single-page, WCAG 2.1 AA, Pause/Resume 24h | P1 | Ch2B |
| **Ch3C** | Adaptive Engine | 8 Models, ZPD ranking, Override API, Circuit breaker | P1 | Ch2C |
| **Ch3D** | Repair & Error | ML classify 4 rules, LLM fallback, Resolution 3 ĐK | P1 | Ch3C |
| **Ch3E** | Lesson Analytics | 6 metrics, Export CSV/PDF, Scheduled reports | P1 | Ch3A |
| **Ch4A** | Core AI Agent | Learner Model 17 fields, Rule Engine R01-R10, mastery algorithm | P1 | Ch2B, Ch3C |
| **Ch4B** | Agent Pipeline | Event processor 13 handlers, Feedback Engine 3 mode, PII filter | P1 | Ch4A |
| **Ch5** | API Contract | 50+ endpoints, WebSocket, Grader API, 28 error codes | P1 | Ch1-Ch4 |
| **Ch6A** | Triển khai | 3 Phase plan, Sprint, Go-Live T-7→T+48h, Rollback 30 phút | P1 | Ch1-Ch5 |
| **Ch6B** | Vận hành & KPIs | 44 TCs, Monitoring 12 metrics, Backup 6 loại, KPIs | P1 | Ch6A |
| **Ch7** | AURA v3.0 | 4 mục tiêu × 5 loại học liệu, Event Bridge, QA Checklist | P1 | Ch2C |
| **Ch8A** | Quiz & QBank & Exam | 9 dạng câu, SM-2 Flashcard, QBank, Sinh đề tự động | P1 | Ch2C, Ch7 |
| **Ch8B** | Đánh giá & SRL | 5D assessment, Gamification XP/Badge, Socratic, SRL | P2 | Ch8A |
| **Ch9** | AI Agent Lab | EDM/pyKT, Quasi-experiment, SHAP, IRB, Publication | P3 | Ch4, Ch8 |

---

## 0.5 Mười nguyên tắc thiết kế bất biến

Mười nguyên tắc này áp dụng cho **mọi dòng code**, mọi API, mọi component. Không có ngoại lệ.

| # | Nguyên tắc | Chi tiết kỹ thuật |
|---|-----------|------------------|
| **P1** | **Privacy by Design** | Journal content KHÔNG BAO GIỜ trả về qua API. Exam answers ẩn khi active. CSV export không có PII. NĐ 13/2023 compliance. |
| **P2** | **Server-side truth** | XP, mastery_score, rule decisions tính server-side. Client không gửi computed values. |
| **P3** | **Deterministic Agent** | Rule Engine: cùng input → cùng output. Không random. Audit trail đầy đủ. |
| **P4** | **Idempotency** | Mọi POST/PATCH quan trọng có `Idempotency-Key`. Server cache 24h. Duplicate bị drop. |
| **P5** | **Graceful degradation** | Agent down → fallback `next_if_pass`. Grader down → GV chấm thủ công. Không bao giờ 502 ra user. |
| **P6** | **WCAG 2.1 AA** | Focus ring bắt buộc. Touch target 44px. `prefers-reduced-motion`. Contrast 4.5:1. `axe-core` 0 violations. |
| **P7** | **Soft delete only** | Không bao giờ hard delete user data. `deleted_at` timestamp. Event log bất biến. |
| **P8** | **Cursor pagination** | Không dùng offset. Stable khi có data mới. `next_cursor` opaque string. |
| **P9** | **Vietnamese first** | Full-text search hỗ trợ tiếng Việt có dấu. Timezone UTC trong DB, Asia/Ho_Chi_Minh ở UI. `lesson_id` theo QĐ 791. |
| **P10** | **Coverage gates** | Unit ≥ 80%, Integration ≥ 70%, Contract 100% LMS→Agent. Fail → block merge. |

---

## 0.6 Design System — Bộ token & component chuẩn

### 0.6.1 Sáu nguyên tắc UX bất biến

| # | Nguyên tắc | Áp dụng |
|---|-----------|---------|
| 1 | **Clarity first** | Học sinh THPT — không dùng jargon kỹ thuật. Mọi action rõ mục đích trong 3 giây |
| 2 | **Tone không phán xét** | Tuyệt đối không dùng: sai/lỗi/thất bại/kém. Thay: chưa đạt/cần ôn thêm/đang phát triển. Màu đỏ chỉ P0 critical |
| 3 | **Mobile-first** | Breakpoints: 375px (mobile), 768px (tablet), 1280px (desktop). Touch target min 44px. Font-size 16px (tránh iOS zoom) |
| 4 | **Performance** | Hero card hiển thị < 1s. Progressive loading React Suspense. Skeleton loader từng section |
| 5 | **Accessibility WCAG 2.1 AA** | Focus ring bắt buộc. `aria-label`. Contrast 4.5:1. `prefers-reduced-motion`. Screen reader support |
| 6 | **Dark mode** | Server-side preference `users.preferences` JSONB. Hỗ trợ system/light/dark. Không dùng localStorage |

### 0.6.2 Design Tokens

| Token | Light mode | Dark mode | Dùng khi |
|-------|-----------|-----------|---------|
| `--color-primary` | #185EA5 | #378ADD | Link, CTA, focus ring |
| `--color-success` | #1D9E75 | #5DCAA5 | Đúng, hoàn thành, đạt |
| `--color-warning` | #B8860B | #EF9F27 | Cảnh báo, P1, at-risk |
| `--color-danger` | #C0392B | #E24B4A | Lỗi P0, critical, block |
| `--color-neutral` | #5F5E5A | #B4B2A9 | Secondary text, icons |
| `--color-surface` | #FFFFFF | #1E2030 | Card background |
| `--color-bg` | #F5F5F2 | #252840 | Page background |
| `--focus-ring` | `0 0 0 3px rgba(29,92,166,.25)` | `0 0 0 3px rgba(55,138,221,.35)` | Tất cả interactive khi focus-visible |
| `--z-topbar` | 300 | 300 | Topbar sticky |
| `--z-modal` | 600 | 600 | Modal/Dialog |
| `--z-toast` | 700 | 700 | Toast notification |
| `--transition-fast` | 150ms ease | 150ms ease | Hover states |
| `--transition-base` | 200ms ease | 200ms ease | UI state changes |
| `--transition-slow` | 300ms ease | 300ms ease | Modal open/close |

### 0.6.3 Component Library — 8 components + states

| Component | States | Spec chi tiết |
|-----------|--------|--------------|
| **Button** | default/hover/active/focus/loading/disabled | `focus-visible:ring-2`. Loading: spinner replace text. Size: sm(32px)/md(40px)/lg(48px) |
| **Input** | default/focus/error/success/disabled/with-icon | Error: border đỏ + helper text. font-size 16px (iOS). Autocomplete off cho password |
| **Card** | default/elevated/interactive/skeleton/selected | Selected: border 2px primary + shadow ring. Skeleton: shimmer animation |
| **Badge** | success/warning/danger/info/neutral | px-2 py-0.5 rounded-full. Font 12px bold. Không dùng color-only — luôn có text |
| **Toast** | success/warning/error/info | Stack top-right. Duration 4s auto-dismiss. `prefers-reduced-motion`: no animation |
| **Modal** | sm(480)/md(640)/lg(800)/fullscreen | Loading state: overlay spinner + disable buttons. Trap focus. Escape to close |
| **ProgressBar** | linear/circular/step | Linear: h-2 rounded. Circular: svg stroke-dasharray. Step: dots ●●○○○ |
| **Avatar** | xs(24)/sm(32)/md(44)/lg(64) + fallback | Fallback: initials từ full_name. Online indicator dot: 8px green |

### 0.6.4 Mobile Responsive — 375px breakpoint

| Element | Desktop | Mobile 375px |
|---------|---------|-------------|
| Navigation | Sidebar 240px left | Bottom tab bar 5 items |
| Modal | Center overlay | Bottom sheet slide-up |
| Toast | Top-right corner | Top center full-width |
| Hero card | Fixed height 200px | Full-width, height 140px |
| Metric cards | 2×2 grid | Horizontal scroll |
| H1 font size | 32px | 24px |
| Card padding | 24px | 16px |
| Table overflow | Full width | Horizontal scroll wrapper |

---

## 0.7 Navigation Map — Toàn bộ màn hình hệ thống

| Screen ID | Tên màn hình | Role | Route | Nội dung chính |
|-----------|-------------|------|-------|---------------|
| SCR-1-01 | Login Page | Public | `/login` | Email/password + Google SSO + Forgot password |
| SCR-1-02 | Consent Page | Student | `/consent` | BVDLCN consent form. Block đến khi ký |
| SCR-1-03 | Consent Waiting | Student <18 | `/consent/waiting` | Chờ phụ huynh. Resend email. Contact admin |
| SCR-1-04 | Student Dashboard | Student | `/dashboard` | Hero card bài tiếp theo, 3 MetricCards, streak, at-risk banner |
| SCR-1-05 | Teacher Dashboard | Teacher | `/teacher` | Class overview, at-risk list, quick actions, analytics |
| SCR-1-06 | Admin Dashboard | Admin | `/admin` | User management, system config, audit log |
| SCR-1-07 | User Profile | All | `/profile` | Display name, avatar crop, password, notification prefs |
| SCR-3A-01 | Lesson Studio | Teacher | `/studio/:id` | 4-panel: Tree/Editor/Settings/BottomBar |
| SCR-3B-01 | Lesson Page | Student | `/lesson/:id` | 5 GĐ single-page, quiz player, journal, complete animation |
| SCR-3C-01 | Curriculum Planner | Teacher | `/planner/:id` | Timeline, ZPD chart, override modal |
| SCR-5-01 | API Explorer | Admin/Dev | `/admin/api` | Interactive endpoint browser |
| SCR-6-01 | Go-Live Dashboard | DevOps | `/admin/golive` | Checklist T-7→T+48h, rollback controls |
| SCR-6-02 | Monitoring Dashboard | Admin/DevOps | `/admin/monitoring` | 12 metrics, alert rules, incident log |
| SCR-7-01 | AURA Studio | Teacher | `/aura` | Upload, pipeline status, 15-point checklist |
| SCR-8-01 | QBank Manager | Teacher | `/qbank` | Question list, Bloom filter, import OCR |
| SCR-8-02 | Exam Builder | Teacher | `/exam/new` | Blueprint, auto-generate, preview |
| SCR-8-03 | Gamification Hub | Student | `/achievements` | XP bar, badges, streak calendar, leaderboard |
| SCR-9-01 | Research Dashboard | NCS | `/lab` | Experiment status, data quality, publication pipeline |

---

## 0.8 Test Strategy tổng thể

### 0.8.1 Test Philosophy — 5 nguyên tắc

| # | Nguyên tắc | Chi tiết |
|---|-----------|---------|
| 1 | **Shift-left testing** | Viết test TRƯỚC khi viết code (TDD). Unit test là tài liệu sống |
| 2 | **Test pyramid** | Unit 60% · Integration 25% · E2E 10% · Manual 5%. Không được invert |
| 3 | **P0 gate** | Bất kỳ P0 fail → block build/merge ngay. Không ngoại lệ. Fix trong 4h |
| 4 | **Real data integration** | Testcontainers: PostgreSQL 16 + Redis 7 thật. Không mock DB trong integration test |
| 5 | **Security first** | OWASP Top 10 scan trước mỗi major release. IDOR và broken auth là P0 bắt buộc |

### 0.8.2 Tool Stack — 9 loại test

| Loại test | Tool | Coverage target | Khi chạy |
|-----------|------|----------------|---------|
| Unit — TypeScript | Jest + ts-jest | ≥ 80% | Mỗi PR. Schema validation, business logic, mastery calc |
| Unit — Python | pytest + pytest-cov | ≥ 80% | Mỗi PR. Rule Engine, AURA parser, SM-2, EDM models |
| Integration | Supertest + Testcontainers | ≥ 70% endpoints | Mỗi PR. PostgreSQL 16 + Redis 7 thật. < 5 phút |
| Contract | Pact.js consumer-driven | 100% LMS→Agent | Khi Agent API thay đổi |
| E2E | Playwright | 10 critical journeys | Trước mỗi deploy staging |
| Load | k6 | P95 < 1s, P99 < 2s | Hàng tuần staging. 200 VUs 10 phút |
| Security | OWASP ZAP + manual | OWASP Top 10 | Trước mỗi major release |
| Accessibility | jest-axe + Playwright | 0 WCAG violations | Mỗi component mới |
| Performance | Lighthouse CI | Score ≥ 90 | Mỗi PR frontend |

### 0.8.3 CI/CD Pipeline — Gates từng stage

| Stage | Tests chạy | Thời gian max | Fail action |
|-------|-----------|--------------|------------|
| Pre-commit (local) | Unit + lint + type-check | < 60s | Block commit |
| CI — Pull Request | Unit + Integration + Contract | < 8 phút | Block merge. P0 → notify Slack |
| CI — Merge main | Full suite + load nhẹ 50 VUs | < 15 phút | Block deploy auto |
| Staging weekly | Full load 200 VUs + ZAP scan | < 2 giờ | Issue ticket P1 |
| Pre go-live | Full OWASP + manual pentest + UAT | 1 ngày | Fail → postpone go-live 1 tuần |
| Post go-live T+2h | Smoke test 10 critical paths | < 10 phút | Error rate > 5% trong 5 phút → rollback |

### 0.8.4 Severity Matrix

| Severity | Ký hiệu | Định nghĩa | Fail action | Ví dụ |
|----------|---------|-----------|------------|-------|
| Critical | **P0** | Security, data loss, toàn bộ hệ thống down | Block build/merge. Fix trong 4h | Exam answers bị lộ, JWT bypass, mastery double-count |
| High | **P1** | Tính năng chính bị hỏng, UX nghiêm trọng | Fix trước release | Agent không ra quyết định, Quiz không submit |
| Medium | **P2** | Tính năng phụ bị hỏng, workaround có | Fix sprint tiếp theo | Export Excel lỗi encoding, notification delay |
| Low | **P3** | Cosmetic, text sai, minor UX | Backlog | Icon sai màu, tooltip missing |

### 0.8.5 Cross-cutting P0 Tests — Áp dụng mọi chương

| TC | Sev | Module | Scenario | Expected |
|----|-----|--------|----------|----------|
| TC-X-SEC-001 | P0 | RBAC Security | Student A truy cập resource của Student B bằng token A | HTTP 403. Không trả data B. Audit log ghi attempt |
| TC-X-SEC-002 | P0 | Response Envelope | 10 endpoints trả response với mọi dạng data | Mọi response có `{data}` hoặc `{error}`. List có `{pagination}` |
| TC-X-PERF-001 | P0 | Load Test | 200 users concurrent, 10 phút, mix GET 60% / POST 40% | P95 < 1s. P99 < 2s. 5xx < 0.1%. Agent < 500ms |
| TC-X-DATA-001 | P0 | Idempotency | POST 2 lần cùng Idempotency-Key concurrent trong 500ms | Lần 2: 200 với kết quả lần 1. DB: COUNT=1 |
| TC-X-PRIV-001 | P0 | Privacy | GET journal content của HS qua bất kỳ API nào, mọi role | 403 hoặc response chỉ có word_count. Tuyệt đối không có text |
| TC-X-SOFT-001 | P0 | Soft Delete | Hard DELETE bất kỳ user data qua API | 405 Method Not Allowed. Chỉ soft delete |
| TC-X-WCAG-001 | P1 | Accessibility | Tất cả interactive elements phải có focus-visible ring | axe-core 0 violations. Tab order hợp lý |
| TC-X-TZ-001 | P1 | Timezone | Mọi timestamp lưu và trả về theo UTC | `created_at`, `due_at`, `next_review_at` đúng UTC |

### 0.8.6 Test Data Strategy

| # | Nguyên tắc | Chi tiết |
|---|-----------|---------|
| 1 | **Isolated DB** | Mỗi test suite dùng DB riêng (Testcontainers). Không share state |
| 2 | **Factory pattern** | `conftest.py` / `jest-setup.ts`: createUser(), createLesson(), createSession(). Không hardcode ID |
| 3 | **Seed data chuẩn** | `seed.sql`: 10 users (2 admin / 3 teacher / 5 student), 20 lessons Toán 8, 5 sessions active |
| 4 | **Cleanup** | afterEach: DELETE cascade. afterAll: DROP schema. Không để state leak |
| 5 | **Time mocking** | `freezegun` (Python) / `jest.useFakeTimers()` (JS) cho streak, TTL, mastery decay |
| 6 | **PII policy** | Không dùng tên/email thật. Dùng faker.js / Faker (Python). Không commit PII vào repo |

### 0.8.7 Pre-Release Checklist

| # | Hạng mục | Người ký | Deadline |
|---|---------|---------|---------|
| 1 | Unit + Integration test suite: 100% pass, coverage đạt ngưỡng | Dev Lead | T-5 ngày |
| 2 | Contract test LMS→Agent: 100% pass | Dev Lead | T-5 ngày |
| 3 | E2E Playwright: 10 critical journeys pass trên staging | QA Lead | T-3 ngày |
| 4 | OWASP ZAP scan: 0 High/Critical finding | Security | T-5 ngày |
| 5 | Performance k6: P95 < 1s với 200 VUs trong 10 phút | DevOps | T-3 ngày |
| 6 | Accessibility axe-core: 0 violations trên 5 màn hình chính | Frontend | T-3 ngày |
| 7 | GV UAT sign-off: ít nhất 3 GV ký biên bản nghiệm thu | PM | T-2 ngày |
| 8 | BGH approval: Hiệu trưởng hoặc Phó Hiệu trưởng ký | PM | T-1 ngày |

---

## 0.9 Glossary — 12 thuật ngữ cốt lõi

| Thuật ngữ | Định nghĩa |
|-----------|-----------|
| **Learner Model** | 17 fields: mastery_map, bloom_profile, error_patterns, preferred_model, streak_days, engagement heatmap. Input duy nhất của Agent |
| **AURA** | Active-learning Unit Repository & Adapter. Layer trung gian xử lý mọi định dạng học liệu (HTML/PDF/Video/Quiz/Python) → Event Log chuẩn |
| **Rule Engine** | 10 luật R01-R10 theo thứ tự ưu tiên. Deterministic: cùng Learner Model → cùng rule triggered. R01/R02 không thể tắt |
| **ZPD** | Zone of Proximal Development. Công thức: `zpd_distance = abs(estimated_p - 0.68)`. Bài gần 0.68 là vừa sức nhất |
| **QĐ 791** | Quyết định 791/QĐ-SGDĐT ngày 28/3/2025 Sở GD&ĐT TP.HCM. 784 YCCĐ môn Toán. `lesson_id: 020108.0202d3` |
| **Event Log** | Append-only stream. 18+ event types. Redis Streams → PostgreSQL. Bất biến — không xóa, chỉ anonymize |
| **Bloom Taxonomy** | 6 cấp tư duy: 1-Nhận biết, 2-Thông hiểu, 3-Vận dụng, 4-Phân tích, 5-Đánh giá, 6-Sáng tạo |
| **SM-2** | SuperMemo 2 algorithm. EF (Easiness Factor) clamp [1.3, 2.5]. `next_review_at = NOW() + interval DAYS` |
| **Circuit Breaker** | Bảo vệ Agent: P95 > 1s → open (cache Redis 15m). Sau 30s → half-open. Closed khi P95 ổn định |
| **NCS** | Nghiên cứu sinh. Dùng Ch9 AI Agent Lab: EDM experiments, KT models, quasi-experiment, papers |
| **BVDLCN** | Luật Bảo vệ Dữ liệu Cá nhân (NĐ 13/2023). Điều 11: HS < 18 cần consent PH. Data localization: server tại VN |
| **IRB** | Institutional Review Board. Bắt buộc cho Ch9. DPIA nộp kèm hồ sơ. Không thu thập data trước khi có approval |

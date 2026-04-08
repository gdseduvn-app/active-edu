# EXECUTION PLAN — AdaptLearn v2.0

> **Mục tiêu:** Triển khai 10 chương SRS (Ch00–Ch09) qua 6 giai đoạn
> **Đội ngũ:** 1 Tech Lead + 2 Backend + 1 Frontend + 1 DevOps + 1 QA
> **Cơ sở:** Gap analysis giữa SRS consolidated (4,465 dòng) và codebase hiện tại (26 endpoints, 27 tables, 6 pages)

---

## TỔNG QUAN — 6 GIAI ĐOẠN

| # | Giai đoạn | Sprint | Mô tả | Output chính |
|---|----------|--------|-------|-------------|
| **GĐ1** | Thiết kế hệ thống | S0 (1 tuần) | C4, service map, event flow, ADR | Architecture Decision Records |
| **GĐ2** | Thiết kế giao diện | S0-S1 (1.5 tuần) | Wireframe, Design System, Navigation Map | Figma/Markdown UI specs |
| **GĐ3** | Thiết kế CSDL | S1 (1 tuần) | ERD, DDL, migrations, indexes, partitions | 004-007 migration files |
| **GĐ4** | Code Backend | S2-S7 (6 tuần) | API endpoints, Agent, AURA, Event Bus | 95+ endpoints, 13 handlers |
| **GĐ5** | Code Frontend | S3-S8 (6 tuần) | Pages, components, real-time | 18+ screens |
| **GĐ6** | Kiểm thử | S6-S9 (4 tuần) | Unit, Integration, E2E, Load, Security | 95 TCs pass, Go-Live |

```
Week:  W1    W2    W3    W4    W5    W6    W7    W8    W9    W10
       ├──┤
GĐ1    ████                                                    Thiết kế hệ thống
       ├────┤
GĐ2    ██████                                                  Thiết kế giao diện
            ├──┤
GĐ3         ████                                               Thiết kế CSDL
            ├──────────────────────┤
GĐ4         ████████████████████████                            Code Backend
                 ├──────────────────────┤
GĐ5              ████████████████████████                       Code Frontend
                                   ├──────────┤
GĐ6                                ████████████                 Kiểm thử
                                                          ├──┤
GO-LIVE                                                   ████  T-7 → T+48h
```

---

## GĐ1 — THIẾT KẾ HỆ THỐNG (Sprint 0 · 1 tuần)

> **Nguồn SRS:** Ch00 (Tổng quan), Ch02 (Kiến trúc), Ch04 (AI Agent)
> **Người thực hiện:** Tech Lead + Backend Lead

### 1.1 Kiến trúc C4 — Hoàn thiện từ Ch02

| Deliverable | Nội dung | File output |
|------------|---------|-------------|
| C4 Level 1 — System Context | AdaptLearn ↔ External systems (11 tích hợp) | `docs/architecture/c4-context.md` |
| C4 Level 2 — Container | 10 microservices + ports + stack + RAM | `docs/architecture/c4-container.md` |
| C4 Level 3 — Component | Mỗi service: modules nội bộ, data flow | `docs/architecture/c4-component-*.md` |

### 1.2 Service Map — 10 Services

Hiện tại codebase chỉ có **5 services** trong Docker (nginx, web-app, lms-api, agent, event-processor). Cần quyết định:

| Service | SRS yêu cầu | Hiện tại | Quyết định |
|---------|------------|---------|-----------|
| lms-api | API gateway | ✅ Có | Giữ — tích hợp auth, CRUD |
| auth-service | JWT RS256, consent | ❌ Gộp lms-api | **Tách ra** — consent cần isolation |
| agent-service | Rule Engine, LM | ✅ Có | Giữ |
| aura-service | Parse HTML/PDF/Video | ❌ Chưa có | **Tạo mới** — Python, heavy processing |
| grader-service | Python sandbox | ❌ Chưa có | **Tạo mới** — security isolation bắt buộc |
| qbank-service | Question Bank | ❌ Chưa có | **P2** — gộp vào lms-api P1 |
| flashcard-svc | SM-2 | ❌ Gộp lms-api | **P1** — giữ gộp P0 |
| gamification-svc | XP, badges | ❌ Gộp lms-api | **P2** — giữ gộp P0 |
| notification-svc | WebSocket, email | ❌ Gộp lms-api | **Tách ra** — long-running connections |
| analytics-svc | Class analytics | ❌ Chưa có | **P2** — query nặng cần tách |

**Kết luận P0:** 6 services: nginx + lms-api + auth-svc + agent + aura-svc + grader-svc + postgres + redis + minio

### 1.3 Event Flow Architecture

| Task | Chi tiết | Output |
|------|---------|--------|
| Define 18 event types | Whitelist từ Ch02 §2.2.1 | `docs/architecture/events.md` |
| NormalizedEvent interface | TypeScript + Python Pydantic | `packages/shared/types/events.ts` |
| Consumer groups | 5 groups: agent, aura, exam, gamification, analytics | Redis Streams config |
| DLQ & Retry policy | 6 scenarios từ Ch02 §2.2.3 | `docs/architecture/dlq.md` |

### 1.4 ADR — 9 Architecture Decision Records

| ADR | Quyết định | Lý do |
|-----|-----------|-------|
| ADR-001 | Event-Driven Microservices | Loose coupling, scale independently |
| ADR-002 | PostgreSQL + JSONB | learner_model phức tạp, FTS tiếng Việt |
| ADR-003 | Redis Streams (not Kafka) | P1 simplicity, migrate P2+ |
| ADR-004 | JWT RS256 (not HS256) | **Cần fix** — hiện code dùng HS256 |
| ADR-005 | Cursor pagination (not offset) | Stable khi data mới |
| ADR-006 | Soft delete only | NĐ 13/2023 compliance |
| ADR-007 | Vietnamese-first FTS | `tsvector` + dictionary config |
| ADR-008 | **K8s migration P2** | Docker Compose P1, k3s P2 |
| ADR-009 | **Kafka migration P2+** | Redis Streams P1, Kafka khi throughput > 1000 events/s |

### 1.5 Checklist hoàn thành GĐ1

- [ ] C4 diagrams 3 levels
- [ ] Service map final (6 services P0)
- [ ] Event types whitelist + interfaces
- [ ] 9 ADR documented
- [ ] 10 nguyên tắc bất biến (P1-P10 từ Ch00) posted trong CLAUDE.md
- [ ] **Review: Tech Lead + PO sign-off**

---

## GĐ2 — THIẾT KẾ GIAO DIỆN (Sprint 0-1 · 1.5 tuần)

> **Nguồn SRS:** Ch00 §0.6 (Design System), UI_Ch1-Ch9 (41 files)
> **Người thực hiện:** Frontend Lead + UX (nếu có)

### 2.1 Design System — Token Library

Từ Ch00 §0.6.2, implement:

| Token group | Task | Output |
|------------|------|--------|
| Colors | 7 semantic colors + light/dark mode | `tailwind.config.ts` extend |
| Typography | Font sizes, weights, line heights | CSS variables |
| Spacing | 4px grid system | Tailwind spacing scale |
| z-index | 3 levels: topbar(300), modal(600), toast(700) | CSS variables |
| Transitions | fast(150ms), base(200ms), slow(300ms) | CSS variables |
| Focus ring | `0 0 0 3px rgba(...)` per mode | `focus-visible` utility |

### 2.2 Component Library — 8 Master Components

Từ Ch00 §0.6.3:

| Component | Variants | Priority | Dependency |
|-----------|---------|----------|-----------|
| **Button** | default/hover/active/focus/loading/disabled × sm/md/lg | P0 | — |
| **Input** | default/focus/error/success/disabled/with-icon | P0 | — |
| **Card** | default/elevated/interactive/skeleton/selected | P0 | — |
| **Badge** | success/warning/danger/info/neutral | P0 | — |
| **Toast** | success/warning/error/info | P0 | — |
| **Modal** | sm/md/lg/fullscreen + loading state | P0 | Button |
| **ProgressBar** | linear/circular/step | P1 | — |
| **Avatar** | xs/sm/md/lg + fallback initials | P1 | — |

### 2.3 Navigation Map — 18 Screens

Từ Ch00 §0.7, wireframe cho mỗi screen:

| Phase | Screens | Route | Wireframe |
|-------|---------|-------|-----------|
| **P0** | Login | /login | Email/password + SSO + forgot |
| **P0** | Consent | /consent | BVDLCN form, block until signed |
| **P0** | Consent Waiting | /consent/waiting | Chờ PH, resend email |
| **P0** | Student Dashboard | /dashboard | Hero card, 3 metrics, streak |
| **P0** | Teacher Dashboard | /teacher | Class overview, at-risk, actions |
| **P0** | Lesson Page | /lesson/:id | 5 GĐ single-page, quiz, journal |
| **P0** | Lesson Studio | /studio/:id | 4-panel editor, AI Assist |
| **P0** | Admin Dashboard | /admin | User mgmt, config, audit |
| **P1** | AURA Studio | /aura | Upload, pipeline, QA checklist |
| **P1** | QBank Manager | /qbank | Questions, Bloom filter, OCR |
| **P1** | Exam Builder | /exam/new | Blueprint, auto-generate |
| **P1** | Flashcard Review | /flashcards | Swipe, SM-2 rating |
| **P1** | Gamification Hub | /achievements | XP, badges, streak calendar |
| **P1** | Curriculum Planner | /planner/:id | Timeline, ZPD, override |
| **P2** | SRL Dashboard | /srl | 6 widgets |
| **P2** | Monitoring | /admin/monitoring | 12 metrics, alerts |
| **P2** | API Explorer | /admin/api | Postman-like |
| **P3** | Research Lab | /lab | Experiment, data quality |

### 2.4 Mobile Responsive Rules (375px)

Từ Ch00 §0.5 — áp dụng cho mọi screen:

| Element | Desktop | Mobile 375px |
|---------|---------|-------------|
| Navigation | Sidebar 240px | Bottom tab 5 items |
| Modal | Center overlay | Bottom sheet |
| Toast | Top-right | Top center full-width |
| Card padding | 24px | 16px |

### 2.5 Checklist hoàn thành GĐ2

- [ ] Design tokens trong tailwind.config.ts
- [ ] 8 components Storybook/demo page
- [ ] Wireframe 18 screens (Markdown hoặc Figma)
- [ ] Mobile responsive rules documented
- [ ] Dark mode toggle working
- [ ] WCAG 2.1 AA: axe-core 0 violations trên Button+Input+Card
- [ ] **Review: Frontend Lead + PO sign-off**

---

## GĐ3 — THIẾT KẾ CSDL (Sprint 1 · 1 tuần)

> **Nguồn SRS:** Ch02 (ERD, DDL), Ch02B-C (Core + Service tables)
> **Người thực hiện:** Backend Lead + Tech Lead

### 3.1 Migration Plan

Hiện có 3 migrations (001-003). Cần thêm:

| Migration | Tables/Changes | Lines ước tính | SRS Section |
|-----------|---------------|---------------|-------------|
| **004_privacy.sql** | consent_records, data_deletion_requests, privacy_audit_log | ~80 | Ch02 §2.3.4 |
| **005_aura_tables.sql** | aura_lessons, aura_versions (nếu chưa có) | ~60 | Ch02 §2.3.3 |
| **006_exam_tables.sql** | exam_blueprints, exams, exam_submissions | ~100 | Ch08 §8.3 |
| **007_gamification.sql** | gamification_profiles, badge_definitions, badge_awards, xp_transactions, srl_goals | ~80 | Ch08 §8.5 |

### 3.2 Privacy Tables DDL (P0 Critical)

```sql
-- 004_privacy.sql
CREATE TABLE consent_records (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id),
    consent_version VARCHAR(10) NOT NULL,
    consent_type    VARCHAR(20) NOT NULL
        CHECK (consent_type IN ('student_assent','parent_consent')),
    purpose         TEXT[] NOT NULL,
    granted         BOOLEAN NOT NULL,
    granted_at      TIMESTAMPTZ DEFAULT NOW(),
    withdrawn_at    TIMESTAMPTZ,
    ip_hash         VARCHAR(64),
    evidence_url    TEXT,
    legal_basis     TEXT
);
CREATE INDEX idx_consent_user ON consent_records(user_id, consent_type);

CREATE TABLE data_deletion_requests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id),
    requested_by    VARCHAR(20) NOT NULL,
    reason          TEXT,
    status          VARCHAR(20) DEFAULT 'pending'
        CHECK (status IN ('pending','approved','processing','completed','rejected')),
    approved_by     UUID REFERENCES users(id),
    completed_at    TIMESTAMPTZ,
    deletion_log    JSONB,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE privacy_audit_log (
    id              BIGSERIAL PRIMARY KEY,
    actor_id        UUID NOT NULL,
    action          VARCHAR(50) NOT NULL,
    target_user_id  UUID,
    details         JSONB,
    ip_hash         VARCHAR(64),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
-- Append-only: REVOKE DELETE ON privacy_audit_log FROM app_user;
```

### 3.3 Index Strategy

12 indexes từ Ch02 §2.3.5 (Phụ lục C ERD):

| Index | SQL | Query tối ưu |
|-------|-----|-------------|
| idx_lessons_subject_grade | `ON lessons(subject, grade_num)` | Filter môn + lớp |
| idx_lessons_fts | `USING GIN (ts_search)` | Full-text search tiếng Việt |
| idx_events_learner_time | `ON events(learner_id, created_at DESC)` | Event history 1 HS |
| idx_qa_learner_lesson | `ON quiz_attempts(learner_id, lesson_id)` | calculate_mastery() |
| idx_consent_user | `ON consent_records(user_id, consent_type)` | Consent check middleware |

### 3.4 Partition Strategy

```sql
-- Events partitioned monthly (từ Ch02 §2.3.6)
CREATE TABLE events (
    id BIGSERIAL, learner_id UUID, event_type VARCHAR(50),
    lesson_id VARCHAR(20), payload JSONB, created_at TIMESTAMPTZ
) PARTITION BY RANGE (created_at);

CREATE TABLE events_2025_04 PARTITION OF events
    FOR VALUES FROM ('2025-04-01') TO ('2025-05-01');
-- Auto-create next month partition via cron job
```

### 3.5 Checklist hoàn thành GĐ3

- [ ] Migration 004-007 viết xong + tested locally
- [ ] ERD diagram updated (22+ tables)
- [ ] 12 indexes created
- [ ] Partition strategy cho events table
- [ ] Seed data: 10 users, 20 lessons, 5 sessions
- [ ] `npm run db:migrate` pass trên fresh DB
- [ ] **Review: Tech Lead sign-off**

---

## GĐ4 — CODE BACKEND (Sprint 2-7 · 6 tuần)

> **Nguồn SRS:** Ch04 (Agent), Ch05 (API Contract), Ch07 (AURA), Ch08 (Quiz/Exam)
> **Người thực hiện:** 2 Backend devs + Tech Lead review

### 4.1 Sprint Plan

| Sprint | Tuần | Focus | Endpoints | Chương SRS |
|--------|------|-------|-----------|-----------|
| **S2** | W3-W4 | Auth + Consent + Privacy | 15 endpoints | Ch01, Ch05 §5.2, §5.14 |
| **S3** | W4-W5 | Lesson CRUD + AURA upload | 20 endpoints | Ch05 §5.4, Ch07 |
| **S4** | W5-W6 | Quiz + QBank + Grader | 15 endpoints | Ch05 §5.4.2, Ch08 §8.1-8.2 |
| **S5** | W6-W7 | AI Agent + Event Handlers | 17 endpoints + 13 handlers | Ch04, Ch05 §5.6 |
| **S6** | W7-W8 | Exam + Flashcard + Gamification | 27 endpoints | Ch05 §5.11-5.13, Ch08 |
| **S7** | W8-W9 | Analytics + Notification + WebSocket | 16 endpoints + WS | Ch05 §5.7-5.8 |

### 4.2 Sprint 2 — Auth + Consent + Privacy (P0 CRITICAL)

**Files mới:**

| File | Nội dung |
|------|---------|
| `src/routes/privacy.ts` | 7 endpoints: consent status/grant/withdraw, privacy notice, deletion request/status, admin approve |
| `src/middleware/consent-guard.ts` | Middleware block API nếu chưa consent (403 CONSENT_REQUIRED) |
| `src/middleware/privacy-audit.ts` | Log mọi truy cập PII vào privacy_audit_log |
| `src/services/deletion-pipeline.ts` | 7-step deletion: anonymize users → LM → events → journals → flashcards → notify → complete |

**Endpoints cụ thể:**

```typescript
// privacy.ts
GET    /auth/consent/status          // Check consent hiện tại
POST   /auth/consent                 // Ghi consent (student_assent hoặc parent_consent)
POST   /auth/consent/withdraw        // Rút consent
GET    /privacy/notice               // Privacy notice HTML tiếng Việt
POST   /users/:id/request-deletion   // Yêu cầu xóa (72h SLA)
GET    /users/:id/deletion-status    // Trạng thái xóa
PATCH  /admin/deletion-requests/:id  // Admin approve/reject

// auth.ts - FIX
// Chuyển JWT từ HS256 → RS256 (ADR-004)
// Thêm consent check vào login flow
```

**Consent Guard Middleware:**

```typescript
// consent-guard.ts
async function consentGuard(request, reply) {
  if (request.url.startsWith('/auth/') || request.url === '/privacy/notice') return;
  const consent = await db.query(
    'SELECT granted FROM consent_records WHERE user_id=$1 AND consent_type=$2 AND withdrawn_at IS NULL',
    [request.user.id, 'student_assent']
  );
  if (!consent.rows[0]?.granted) {
    reply.code(403).send({ error: { code: 'CONSENT_REQUIRED', message: 'Cần đồng ý điều khoản trước khi sử dụng' }});
  }
}
```

### 4.3 Sprint 3 — Lesson CRUD + AURA

**Hoàn thiện routes hiện có + tạo aura-service mới:**

| Task | Files | Endpoints |
|------|-------|-----------|
| Lesson CRUD complete | `routes/lessons.ts` | PATCH, DELETE, POST /publish, GET /preview, POST /duplicate |
| AURA upload pipeline | `packages/aura-service/` (Python mới) | POST /aura/upload, GET /aura/lessons, POST /aura/activate |
| AURA SDK inject | `packages/aura-service/aura-bridge.js` | postMessage hooks (5 functions) |
| File presign flow | `routes/files.ts` (mới) | POST /presign, POST /confirm, GET /url, DELETE |

### 4.4 Sprint 4 — Quiz + QBank + Grader

| Task | Files | Key logic |
|------|-------|----------|
| Quiz submit + grade | `routes/quiz.ts` | Auto-grade single_choice/true_false/fill_blank. Event QUIZ_SUBMITTED |
| QBank CRUD | `routes/questions.ts` | Review workflow: draft→reviewed→approved. Psychometric fields |
| Python Grader | `packages/grader-service/` (Python mới) | Pyodide sandbox. Timeout 10s. Memory 128MB. Test cases |
| Import OCR | `routes/import.ts` (mới) | Tesseract + Mathpix. GV review UI |

### 4.5 Sprint 5 — AI Agent + Events

| Task | Files | Key logic |
|------|-------|----------|
| Event Processor 13 handlers | `packages/agent/app/processors/` | Mapping từ Ch04 §4.5. Idempotency Redis SET TTL 24h |
| Learner Model update | `packages/agent/app/core/learner_model.py` | 17 fields. Weighted decay mastery_score algorithm |
| Rule Engine R01-R10 | `packages/agent/app/core/curriculum_planner.py` | Priority resolution. R01/R02 non-overridable |
| Feedback Engine | `packages/agent/app/core/feedback_engine.py` | 3 mode: Correction template, Encourage, Socratic (P2 stub) |
| PII Filter | `packages/agent/app/core/pii_filter.py` | Strip learner name/email trước Claude API call |

### 4.6 Sprint 6 — Exam + Flashcard + Gamification

| Task | Endpoints | Key logic |
|------|-----------|----------|
| Exam lifecycle 8 states | 12 endpoints Ch05 §5.11 | draft→review→approved→published→active→closed→graded→archived |
| Exam blueprint auto-gen | POST /exams/auto-generate | Bloom distribution + difficulty + anti-repeat |
| Flashcard SM-2 | 8 endpoints Ch05 §5.12 | `update_sm2()` algorithm. EF clamp [1.3, 2.5] |
| Gamification XP | 7 endpoints Ch05 §5.13 | Server-side XP calc. Bloom multiplier. Client không POST XP |
| Badge system | Part of gamification | 8 badges + trigger conditions |

### 4.7 Sprint 7 — Analytics + Notification + WebSocket

| Task | Endpoints | Key logic |
|------|-----------|----------|
| Class analytics | 9 endpoints Ch05 §5.7.1 | Mastery heatmap, Bloom radar, at-risk detection |
| Notification | 7 endpoints Ch05 §5.7.2 | In-app + email digest + push (FCM stub) |
| WebSocket | Socket.io 5 events | grader:result, agent:recommendation, agent:feedback, notification:new, peer_review:received |
| Report generation | POST /analytics/reports/generate | Async PDF/Excel export (queue job) |

### 4.8 Checklist hoàn thành GĐ4

- [ ] 95+ API endpoints implemented
- [ ] 13 event handlers working
- [ ] JWT RS256 (fix từ HS256)
- [ ] Consent guard middleware active
- [ ] Privacy audit logging on all PII access
- [ ] AURA upload → parse → serve → events pipeline
- [ ] Grader sandbox isolate
- [ ] SM-2 algorithm correct (unit test)
- [ ] Rule Engine R01-R10 deterministic (unit test)
- [ ] Unit test coverage ≥ 80%
- [ ] Integration test ≥ 70% endpoints
- [ ] **Review: Tech Lead code review mỗi PR**

---

## GĐ5 — CODE FRONTEND (Sprint 3-8 · 6 tuần, song song Backend)

> **Nguồn SRS:** UI_Ch0-Ch9 (design system + wireframes)
> **Người thực hiện:** 1 Frontend dev

### 5.1 Sprint Plan

| Sprint | Tuần | Screens | Chương SRS |
|--------|------|---------|-----------|
| **S3** | W4-W5 | Login, Consent, Dashboard (HS+GV+Admin) | Ch01, UI_Ch1 |
| **S4** | W5-W6 | Lesson Page (5 GĐ), Lesson Studio (4-panel) | Ch03, UI_Ch3A-B |
| **S5** | W6-W7 | Quiz Player, Flashcard Review, AURA Studio | Ch07-08, UI_Ch3-8 |
| **S6** | W7-W8 | Exam Builder, QBank Manager, Import OCR | Ch08, UI_Ch8 |
| **S7** | W8-W9 | Gamification Hub, SRL Dashboard, Error Portfolio | Ch08 §8.5-8.6 |
| **S8** | W9-W10 | Admin pages, Monitoring, Privacy Settings | Ch06, UI_Ch6 |

### 5.2 Component Priority

| Component | Screen dùng | Sprint |
|-----------|------------|--------|
| ConsentPopup | Login → Consent flow | S3 |
| HeroCard (next lesson) | Student Dashboard | S3 |
| MetricCard (mastery, streak) | Dashboards | S3 |
| LessonPlayer (5 GĐ) | /lesson/:id — single page app | S4 |
| LessonStudio (4-panel) | /studio/:id — editor + preview + settings | S4 |
| QuizPlayer (9 dạng) | Inline trong LessonPlayer GĐ3 | S5 |
| FlashcardSwipe (SM-2) | /flashcards — swipe UI + rating 4 buttons | S5 |
| AURAUploader | /aura — drag-drop + pipeline status | S5 |
| ExamBuilder | /exam/new — blueprint + preview | S6 |
| SRLDashboard (6 widgets) | /srl — radar, clock, portfolio, goals | S7 |
| AdminConsent | /admin/consent-records | S8 |

### 5.3 Real-time Integration

```typescript
// Socket.io client setup (Ch05 §5.8.1)
const socket = io(API_WS_URL, { auth: { token: accessToken } });

socket.on('grader:result', (data) => { /* Update quiz result */ });
socket.on('agent:recommendation', (data) => { /* Show next lesson card */ });
socket.on('notification:new', (data) => { /* Toast notification */ });
```

### 5.4 Checklist hoàn thành GĐ5

- [ ] 18 screens implemented
- [ ] Design System tokens applied
- [ ] Dark mode toggle
- [ ] Mobile responsive (375px breakpoint)
- [ ] WCAG 2.1 AA: axe-core 0 violations
- [ ] Consent popup blocks dashboard
- [ ] WebSocket real-time updates
- [ ] Lighthouse score ≥ 90
- [ ] **Review: Frontend Lead + UX review**

---

## GĐ6 — KIỂM THỬ (Sprint 6-9 · 4 tuần)

> **Nguồn SRS:** Ch00 §0.8 (Test Strategy), Ch06 (TCs + Go-Live)
> **Người thực hiện:** QA Lead + toàn team

### 6.1 Test Pyramid

| Loại | Tool | Target | Sprint | Người |
|------|------|--------|--------|------|
| Unit — TS | Jest + ts-jest | ≥ 80% coverage | S2-S8 (liên tục) | Backend + Frontend |
| Unit — Python | pytest + pytest-cov | ≥ 80% coverage | S2-S7 (liên tục) | Backend |
| Integration | Supertest + Testcontainers | ≥ 70% endpoints | S6-S7 | Backend + QA |
| Contract | Pact.js | 100% LMS→Agent | S7 | Backend |
| E2E | Playwright | 10 critical journeys | S8 | QA |
| Load | k6 | P95 < 1s, 200 VUs | S8 | DevOps |
| Security | OWASP ZAP | 0 High/Critical | S8 | Security + QA |
| Accessibility | jest-axe + Playwright | 0 WCAG violations | S7-S8 | Frontend |

### 6.2 Test Cases — 95 TCs

| Nhóm | TC range | Số lượng | Focus |
|------|---------|---------|-------|
| Core LMS | TC01-TC30 | 30 | Auth, Users, Lessons, RBAC |
| AI Agent | TC31-TC50 | 20 | Rule Engine, Learner Model, Feedback |
| API Contract | TC51-TC60 | 10 | Error codes, pagination, idempotency |
| AURA | TC61-TC70 | 10 | Upload, parse, CSP, events |
| Gamification | TC71-TC75 | 5 | XP, badges, streak, leaderboard |
| Exam | TC76-TC80 | 5 | Lifecycle, blueprint, answers hidden |
| Flashcard | TC81-TC85 | 5 | SM-2, deck management |
| **Privacy** | **TC86-TC95** | **10** | **Consent, deletion, audit, PII filter** |

### 6.3 P0 Critical Tests (block Go-Live)

| TC | Scenario | Pass criteria |
|----|----------|-------------|
| TC-X-SEC-001 | Student A access Student B data | 403, audit logged |
| TC-X-DATA-001 | Idempotency 2× same key | DB COUNT=1 |
| TC-X-PRIV-001 | GET journal content any role | 403 or word_count only |
| TC86 | Consent popup first login | Popup blocks dashboard |
| TC87 | No consent → API blocked | 403 CONSENT_REQUIRED |
| TC90 | Consent withdrawal | withdrawn_at set, 403 all APIs |
| TC91 | Deletion request 72h | Request → complete ≤ 72h |
| TC94 | PII filter Claude API | No learner name/email in request |

### 6.4 Go-Live Checklist (T-7 → T+48h)

| Thời điểm | Hạng mục | Người ký |
|-----------|---------|---------|
| T-7 | Code freeze. Final staging test | Dev Lead |
| T-5 | Unit + Integration 100% pass | Dev Lead |
| T-5 | OWASP ZAP: 0 High/Critical | Security |
| T-3 | E2E Playwright: 10 journeys pass | QA Lead |
| T-3 | k6: P95 < 1s, 200 VUs | DevOps |
| T-3 | axe-core: 0 WCAG violations | Frontend |
| T-2 | **Privacy checklist PV01-PV10** | PM |
| T-2 | GV UAT: ≥ 3 GV ký nghiệm thu | PM |
| T-1 | BGH approval | PM |
| **T=0** | **Deploy production. DNS switch** | **DevOps** |
| T+2h | Smoke test 10 critical paths | QA |
| T+24h | Monitoring review. Fix P1 | Dev + DevOps |
| T+48h | Stabilization complete | PM |

### 6.5 Privacy Go-Live Checklist (NĐ 13/2023)

| # | Hạng mục | Pass criteria |
|---|---------|-------------|
| PV01 | DPIA document hoàn thành | PDF signed |
| PV02 | DPIA nộp Bộ Công an (60 ngày) | Biên nhận |
| PV03 | Privacy Notice tiếng Việt | /privacy/notice → 200 |
| PV04 | Consent UI hoạt động | Manual test pass |
| PV05 | Parent consent email flow | E2E test pass |
| PV06 | Consent blocks API | TC87 pass |
| PV07 | Deletion pipeline 72h | TC91 pass |
| PV08 | Audit log đầy đủ | TC93 pass |
| PV09 | PII not in Claude API | TC94 pass |
| PV10 | Data residency VN | Server IP verify |

### 6.6 Checklist hoàn thành GĐ6

- [ ] 95 TCs: 100% pass
- [ ] Unit coverage: TS ≥ 80%, Python ≥ 80%
- [ ] Integration: ≥ 70% endpoints
- [ ] E2E: 10 critical journeys
- [ ] Load: P95 < 1s, 200 VUs
- [ ] Security: 0 High/Critical
- [ ] WCAG: 0 violations
- [ ] Privacy: PV01-PV10 all pass
- [ ] GV UAT: ≥ 3 sign-off
- [ ] BGH approval
- [ ] **GO-LIVE APPROVED**

---

## TỔNG HỢP — DELIVERABLES THEO CHƯƠNG SRS

| SRS Chapter | GĐ1 | GĐ2 | GĐ3 | GĐ4 | GĐ5 | GĐ6 |
|------------|------|------|------|------|------|------|
| **Ch00** Tổng quan | P1-P10 nguyên tắc | Design System | — | — | — | Test Strategy |
| **Ch01** Giới thiệu | ADR, stakeholders | Consent UI | Privacy tables | Auth + Consent API | Login + Consent pages | TC86-TC95 |
| **Ch02** Kiến trúc | C4, service map | — | Migrations 004-007 | Docker services | — | Integration tests |
| **Ch03** Bài học | — | Studio wireframe | — | Lesson CRUD, AI Assist | Lesson Page, Studio | E2E journeys |
| **Ch04** AI Agent | Event flow design | Agent UI wireframe | — | Rule Engine, 13 handlers | Agent dashboard | TC31-TC50 |
| **Ch05** API Contract | — | API Explorer wireframe | — | 95+ endpoints | API Explorer page | TC51-TC60 |
| **Ch06** Triển khai | — | Go-Live UI | — | — | Monitoring page | Go-Live checklist |
| **Ch07** AURA | — | AURA Studio wireframe | aura_lessons DDL | AURA pipeline + SDK | AURA Upload UI | TC61-TC70 |
| **Ch08** Bài tập | — | Quiz + Exam wireframe | Exam + QBank DDL | Quiz + Exam + SM-2 | QBank + Gamification | TC71-TC85 |
| **Ch09** NCS Lab | — | Research UI | — | (P3) | (P3) | (P3) |

---

## RỦI RO & MITIGATION

| # | Rủi ro | XS | Mitigation |
|---|--------|-----|-----------|
| 1 | **Scope creep** — 95+ endpoints quá nhiều cho 6 tuần | Cao | Strict P0 cut: chỉ 50 endpoints P0. Còn lại P1/P2 |
| 2 | **Privacy compliance delay** — DPIA chưa xong khi Go-Live | TB | Bắt đầu DPIA từ Sprint 0. Song song với dev |
| 3 | **JWT HS256→RS256 migration** — break existing tokens | Thấp | Rotation: support cả 2 trong 1 sprint, rồi deprecate HS256 |
| 4 | **AURA service complexity** — parse 5 loại file | Cao | P0: chỉ HTML + Quiz JSON. PDF/Video/Python = P1 |
| 5 | **GV không dùng** — system ready nhưng no content | Cao | Workshop + AURA Template + demo kết quả trước Go-Live |
| 6 | **Grader sandbox escape** — security risk | TB | Pyodide WASM (browser-level isolation). Không dùng Docker exec |

# CHUONG 2: KIEN TRUC HE THONG — Consolidated v2.1

> **AdaptLearn LMS** — He thong hoc tap thich ung bac THPT
> Phien ban: 2.1 (Consolidated) | Ngay: 2026-04-08
> Hop nhat tu: Ch2 v1.0 + v2.0 + Ch2A (C4, ADR) + Ch2B (DB Core) + Ch2C (DB Services) + Ch2D (Infrastructure) + Phu luc C (ERD)
> Trang thai: **DEFINITIVE** — thay the tat ca phien ban truoc

---

## Muc luc

- [2.1 Tong quan kien truc (C4 Level 2)](#21-tong-quan-kien-truc-c4-level-2)
- [2.2 Event Flow Architecture](#22-event-flow-architecture)
- [2.3 Database Schema — PostgreSQL](#23-database-schema--postgresql)
- [2.4 Infrastructure](#24-infrastructure)
- [2.5 Privacy Architecture (BO SUNG)](#25-privacy-architecture)
- [2.6 Architecture Decision Records (ADR)](#26-architecture-decision-records-adr)

---

## 2.1 Tong quan kien truc (C4 Level 2)

AdaptLearn v2.0 theo kien truc **modular monorepo** voi 10 services giao tiep qua **Redis Streams event bus**. Tat ca services dung chung mot PostgreSQL 15 database `adaptlearn`, MinIO lam object store, va Redis 7 lam cache + event bus. Nginx lam API Gateway voi SSL termination va rate limiting.

### 2.1.1 Container Architecture — 10 Services

```
+-----------------------------------------------------------------------------------+
|  AdaptLearn v2.0 — C4 Level 2 Container Model                                    |
|                                                                                   |
|  [Browser Client / Mobile PWA]                                                    |
|          | HTTPS TLS 1.3                                                          |
|          v                                                                        |
|  +----------------------------------------------------------------------+         |
|  |  Nginx API Gateway :443  (rate limiting, SSL termination, LB)        |         |
|  +--------+---------------------------+----------------------------+----+         |
|           |                           |                            |              |
|           v :3000                     v :3001                      v :8000        |
|  +-----------------+    +----------------------+    +-------------------------+   |
|  |  lms-api        |    |  auth-service        |    |  agent-service          |   |
|  |  Node.js 22     |<---|  Node.js + JWT RS256 |    |  Python 3.12 + FastAPI  |   |
|  |  Fastify 4      |    |  RBAC, refresh token |    |  Learner Model, R01-R10|   |
|  |  Core LMS hub   |    |  Session mgmt        |    |  Curriculum Planner     |   |
|  +--------+--------+    +----------------------+    +-------------------------+   |
|           | lms-api -> 7 downstream services                                      |
|     +-----+-------+----------+-----------+----------+----------+                  |
|     v     v       v          v           v          v          v                  |
|  :8001  :8002   :3002      :3003       :3004      :3005      :3006               |
|  aura-  grader  qbank-     exam-       flash-     gamif-     notif-              |
|  svc    svc     svc        svc         card-svc   svc        svc                 |
|  Python Python  Node.js    Node.js     Node.js    Node.js    Node.js             |
|  HTML/  Pyodide Item Bank  Exam        SM-2       XP+Badge   Email               |
|  PDF/   sandbox Blueprint  8-state     Spaced     Streak     Push FCM            |
|  Video  LTI 1.3 AI gen    anti-cheat  Repeat.    Leaderbd   In-app              |
|                                                                                   |
|  --------------- EVENT BUS (Redis Streams) -------------------------------------- |
|  All services -> XADD events:main  |  5 consumer groups  |  18 event types       |
|  analytics-proc (Python worker) — consumer group analytics-proc, no HTTP port     |
|                                                                                   |
|  --------------- INFRASTRUCTURE ------------------------------------------------- |
|  +--------------+    +--------------------------+    +--------------+             |
|  |  PostgreSQL  |    |  Redis 7  :6379          |    |  MinIO       |             |
|  |  :5432       |    |  Event Bus events:main   |    |  :9000       |             |
|  |  Primary DB  |    |  Cache                   |    |  Object Store|             |
|  |  (all svc)   |    |  maxmemory 512MB allkeys-|    |  HTML/PDF/   |             |
|  |  ACID + JSONB|    |  lru, AOF+RDB persist    |    |  Video files |             |
|  +--------------+    +--------------------------+    +--------------+             |
+-----------------------------------------------------------------------------------+
```

### 2.1.2 Service Map

| # | Service | Stack | Chuc nang chinh | RAM Limit | Port | Phase |
|---|---------|-------|-----------------|-----------|------|-------|
| 1 | **lms-api** | Node.js 22 + Fastify 4 | User CRUD, content management, event log, notification routing | 512 MB | 3000 | P0 |
| 2 | **auth-service** | Node.js + JWT RS256 | JWT RS256 authentication, RBAC, refresh token rotation, session management, **consent management** | 256 MB | 3001 | P0 |
| 3 | **agent-service** | Python 3.12 + FastAPI | Learner Model (BKT), Rule Engine R01-R10, Curriculum Planner, Claude API integration | 512 MB | 8000 | P0 |
| 4 | **aura-service** | Python 3.12 + FastAPI | Parse HTML/PDF/Video content, MinIO object store, AURA Event Bridge | 512 MB | 8001 | P0 |
| 5 | **grader-service** | Python 3.12 + FastAPI | Code sandbox (Pyodide/subprocess), LTI 1.3, automated test runner | 256 MB | 8002 | P0 |
| 6 | **qbank-service** | Node.js + Fastify | Question bank, Item Analysis, Blueprint management, AI-generate questions | 256 MB | 3002 | P0 |
| 7 | **exam-service** | Node.js + Fastify | Exam 8-state workflow, submission grading, anti-cheat detection | 256 MB | 3003 | P0 |
| 8 | **flashcard-service** | Node.js + Fastify | Flashcard deck/card CRUD, SM-2 spaced repetition, review scheduling | 128 MB | 3004 | P1 |
| 9 | **gamification-svc** | Node.js + Fastify | XP server-side calculation, badge system, streak tracking, opt-in leaderboard | 128 MB | 3005 | P1 |
| 10 | **notification-svc** | Node.js | Email (SMTP), Push (FCM/APNs), in-app notifications, digest scheduler | 128 MB | 3006 | P0 |

**Workers (khong co HTTP port):**

| Service | Stack | Chuc nang | RAM |
|---------|-------|-----------|-----|
| **analytics-proc** | Python 3.12 | Consumer group `analytics-proc` — long-term event store, reporting aggregation | 256 MB |

**Tong RAM allocation:** ~3.2 GB (10 services + 1 worker + infra)

---

## 2.2 Event Flow Architecture

Tat ca services giao tiep bat dong bo qua **Redis Streams** (`events:main`). Moi event phai conform `NormalizedEvent` interface va chi duoc su dung 18 event types trong whitelist.

### 2.2.1 Event Types Whitelist — 18 types

Stream: `events:main` (Redis Streams)

**LESSON (3)**

| Event Type | Mo ta |
|-----------|-------|
| `LESSON_STARTED` | Hoc sinh bat dau bai hoc |
| `LESSON_COMPLETED` | Hoc sinh hoan thanh bai hoc |
| `LESSON_EXITED_EARLY` | Hoc sinh thoat giua chung |

**QUIZ (3)**

| Event Type | Mo ta |
|-----------|-------|
| `QUIZ_SUBMITTED` | Hoc sinh nop bai quiz |
| `QUIZ_PASSED` | Quiz dat diem pass threshold |
| `QUIZ_FAILED` | Quiz khong dat diem pass threshold |

**GRADER (1)**

| Event Type | Mo ta |
|-----------|-------|
| `GRADER_RESULT_RECEIVED` | grader-service tra ket qua cham code |

**AURA (4)**

| Event Type | Mo ta |
|-----------|-------|
| `AURA_HTML_QUIZ_ANSWER` | Hoc sinh tra loi cau hoi nhung trong HTML |
| `AURA_HTML_QUIZ_COMPLETE` | Hoc sinh hoan thanh toan bo quiz trong HTML |
| `AURA_EXIT_TICKET_SUBMITTED` | Hoc sinh nop Exit Ticket cuoi bai |
| `AURA_VIDEO_MILESTONE` | Hoc sinh dat milestone trong video (25/50/75/100%) |

**FLASHCARD (2)**

| Event Type | Mo ta |
|-----------|-------|
| `FLASHCARD_REVIEWED` | Hoc sinh on 1 flashcard (SM-2 quality 0-5) |
| `FLASHCARD_DECK_MASTERED` | Hoc sinh dat mastery toan bo deck |

**EXAM (2)**

| Event Type | Mo ta |
|-----------|-------|
| `EXAM_SUBMITTED` | Hoc sinh nop bai kiem tra |
| `EXAM_GRADED` | exam-service hoan thanh cham bai |

**GAMIFICATION (2)**

| Event Type | Mo ta |
|-----------|-------|
| `BADGE_EARNED` | Hoc sinh dat badge moi |
| `STREAK_MILESTONE` | Hoc sinh dat streak milestone (7/30/100 ngay) |

**SRL (1)**

| Event Type | Mo ta |
|-----------|-------|
| `METACOGNITION_JOURNAL_SAVED` | Hoc sinh luu nhat ky tu dieu chinh hoc tap |

**Tong: 18 event types**

### 2.2.2 Normalized Event Format (TypeScript Interface)

Contract giua tat ca 10 services tren Event Bus. Moi event publish len `events:main` **bat buoc** conform interface nay.

**File:** `packages/lms-api/src/types/events.ts`

```typescript
// ── 18 EVENT TYPES WHITELIST ─────────────────────────────────────────────────

export const LESSON_EVENTS = [
  'LESSON_STARTED',
  'LESSON_COMPLETED',
  'LESSON_EXITED_EARLY',
] as const

export const QUIZ_EVENTS = [
  'QUIZ_SUBMITTED',
  'QUIZ_PASSED',
  'QUIZ_FAILED',
] as const

export const GRADER_EVENTS = [
  'GRADER_RESULT_RECEIVED',
] as const

export const AURA_EVENTS = [
  'AURA_HTML_QUIZ_ANSWER',
  'AURA_HTML_QUIZ_COMPLETE',
  'AURA_EXIT_TICKET_SUBMITTED',
  'AURA_VIDEO_MILESTONE',
] as const

export const FLASHCARD_EVENTS = [
  'FLASHCARD_REVIEWED',
  'FLASHCARD_DECK_MASTERED',
] as const

export const EXAM_EVENTS = [
  'EXAM_SUBMITTED',
  'EXAM_GRADED',
] as const

export const GAMIFICATION_EVENTS = [
  'BADGE_EARNED',
  'STREAK_MILESTONE',
] as const

export const SRL_EVENTS = [
  'METACOGNITION_JOURNAL_SAVED',
] as const

export const ALL_EVENT_TYPES = [
  ...LESSON_EVENTS,
  ...QUIZ_EVENTS,
  ...GRADER_EVENTS,
  ...AURA_EVENTS,
  ...FLASHCARD_EVENTS,
  ...EXAM_EVENTS,
  ...GAMIFICATION_EVENTS,
  ...SRL_EVENTS,
] as const

export type EventType = typeof ALL_EVENT_TYPES[number]

// ── EVENT SOURCE ──────────────────────────────────────────────────────────────

export type EventSource = 'lms' | 'aura' | 'grader' | 'exam' | 'gamif'

// ── NORMALIZED EVENT INTERFACE ────────────────────────────────────────────────

export interface NormalizedEvent {
  /** Loai event — phai thuoc whitelist 18 types */
  event_type:      EventType

  /** UUID hoc sinh — bat buoc moi event */
  learner_id:      string

  /** '020108.0202d3' format — bat buoc voi LESSON/QUIZ/AURA events */
  lesson_id?:      string

  /** UUID — bat buoc voi EXAM_SUBMITTED, EXAM_GRADED */
  exam_id?:        string

  /** UUID — bat buoc voi FLASHCARD_REVIEWED, FLASHCARD_DECK_MASTERED */
  flashcard_id?:   string

  /** Payload tu do — validated per event_type boi consumer */
  payload:         Record<string, unknown>

  /** UUID v4 — BAT BUOC — dung cho idempotent processing tai consumer */
  idempotency_key: string

  /** Service sinh ra event */
  source:          EventSource

  /** Epoch milliseconds */
  ts:              number
}

// ── CONSUMER GROUP NAMES ──────────────────────────────────────────────────────

export const CONSUMER_GROUPS = {
  AGENT:        'agent-processors',
  AURA:         'aura-processors',
  EXAM:         'exam-processors',
  GAMIFICATION: 'gamification-proc',
  ANALYTICS:    'analytics-proc',
} as const

// ── DLQ & RETRY POLICY ────────────────────────────────────────────────────────

export interface RetryPolicy {
  scenario:    string
  maxRetries:  number
  backoff:     'exponential' | 'fixed' | 'none'
  toDlq:       boolean
  action:      string
}

export const RETRY_POLICIES: RetryPolicy[] = [
  {
    scenario:   'Agent service down',
    maxRetries: 3,
    backoff:    'exponential',
    toDlq:      true,
    action:     'Alert + manual replay',
  },
  {
    scenario:   'DB write transient fail',
    maxRetries: 5,
    backoff:    'exponential',
    toDlq:      true,
    action:     'Admin review',
  },
  {
    scenario:   'AURA parse timeout >15s',
    maxRetries: 2,
    backoff:    'fixed',         // retry after 10s
    toDlq:      true,
    action:     "qa_status='fail', alert GV",
  },
  {
    scenario:   'Claude API rate limit',
    maxRetries: 0,
    backoff:    'none',
    toDlq:      false,
    action:     'Fallback template + log warning',
  },
  {
    scenario:   'Exam grade fail',
    maxRetries: 3,
    backoff:    'exponential',
    toDlq:      true,
    action:     'Flag submission + alert',
  },
  {
    scenario:   'Gamification XP fail',
    maxRetries: 2,
    backoff:    'fixed',
    toDlq:      false,
    action:     'Log only (non-critical)',
  },
]

// ── HELPER: Validate event against whitelist ──────────────────────────────────

export function isValidEventType(type: string): type is EventType {
  return (ALL_EVENT_TYPES as readonly string[]).includes(type)
}

export function buildEvent(
  partial: Omit<NormalizedEvent, 'idempotency_key' | 'ts'> & {
    idempotency_key?: string
    ts?: number
  },
): NormalizedEvent {
  return {
    ...partial,
    idempotency_key: partial.idempotency_key ?? crypto.randomUUID(),
    ts:              partial.ts ?? Date.now(),
  }
}
```

### 2.2.3 DLQ & Retry Policy

DLQ stream: `events:dlq` (Redis Stream — tach biet tu `events:main`)

| # | Scenario | Max Retries | Backoff | To DLQ | Action |
|---|----------|-------------|---------|--------|--------|
| 1 | Agent service down | 3 | Exponential | Yes | Alert + manual replay |
| 2 | DB write transient fail | 5 | Exponential | Yes | Admin review |
| 3 | AURA parse timeout >15s | 2 | Fixed (10s) | Yes | `qa_status='fail'`, alert GV |
| 4 | Claude API rate limit | 0 | None | No | Fallback template + log warning |
| 5 | Exam grade fail | 3 | Exponential | Yes | Flag submission + alert |
| 6 | Gamification XP fail | 2 | Fixed | No | Log only (non-critical) |

**Nguyen tac:**

- **DLQ = Yes**: event duoc ghi vao `events:dlq` sau khi het retry, cho operator replay thu cong
- **DLQ = No**: event bi drop sau khi het retry (non-critical path)
- **Idempotency key** bat buoc de consumer xu ly an toan khi replay
- DLQ consumer: admin dashboard doc tu `events:dlq`, hien thi event bi fail, cho phep replay 1-click

### 2.2.4 Consumer Groups (5 groups)

Moi consumer group su dung `XGROUP CREATE events:main <group> $ MKSTREAM` de tao stream lazy khi service khoi dong.

| Group | Service(s) | Events xu ly |
|-------|-----------|-------------|
| `agent-processors` | agent-service, flashcard-service | LESSON_*, QUIZ_*, FLASHCARD_*, AURA_*, SRL |
| `aura-processors` | aura-service | AURA_* (parse + QA pipeline) |
| `exam-processors` | exam-service, grader-service | EXAM_*, GRADER_* |
| `gamification-proc` | gamification-svc | BADGE_*, STREAK_*, QUIZ_PASSED (XP trigger) |
| `analytics-proc` | analytics-proc worker | ALL 18 types (long-term store + aggregation) |

**Flow:**

```
Producer (any service) --> XADD events:main * field value
                              |
                    +---------+---------+---------+---------+
                    |         |         |         |         |
                    v         v         v         v         v
               agent-    aura-     exam-     gamif-   analytics-
               processors processors processors proc     proc
```

---

## 2.3 Database Schema — PostgreSQL

Tat ca 10 services dung chung 1 PostgreSQL 15 database `adaptlearn`. ACID transactions can thiet cho diem so, enrollment, exam submission. JSONB cho payload linh hoat (quiz_data, learner_model state).

### 2.3.1 ERD Tong the

```
+-------------------+       +-------------------+       +---------------------+
|      users        |       |     lessons       |       |   learner_models    |
|  (PK: id UUID)    |<------+  (PK: id UUID)    |       |  (PK: id UUID)      |
|  username, email   |  1:N  |  lesson_code      |       |  user_id -> users   |
|  role, class_id    |       |  bloom, SOLO      |       |  mastery_map JSONB  |
|  grade, is_active  |       |  next_if_pass/fail|       |  bloom_profile      |
+--------+----------+       +---------+---------+       |  error_patterns     |
         |                            |                  |  speed_profile      |
         | 1:N                        | 1:N              +---------------------+
         v                            v
+-------------------+       +-------------------+       +---------------------+
|     events        |       |    questions      |       | agent_decisions     |
| (PK: id+created)  |       |  (PK: id UUID)    |       | (PK: id BIGSERIAL)  |
| PARTITION BY RANGE|       |  bloom, SOLO      |       | rule_fired R01-R10  |
| event_type (18)   |       |  10 question types |       | next_lesson_id      |
| payload JSONB     |       |  psychometric cols |       | confidence, reason  |
+-------------------+       +-------------------+       +---------------------+
         |                            |
         |                            | 1:N
         v                            v
+-------------------+       +-------------------+       +---------------------+
|  quiz_attempts    |       |  aura_lessons     |       |    exams            |
|  user_id, lesson  |       |  lesson_id PK     |       |  8-state workflow   |
|  answers JSONB    |       |  file_type, QA    |       |  blueprint_id       |
|  score, passed    |       |  parse metadata   |       |  question_ids[]     |
+-------------------+       +-------------------+       +---------------------+
                                     |                           |
                                     | 1:N                       | 1:N
                                     v                           v
                            +-------------------+       +---------------------+
                            |  aura_versions    |       | exam_submissions    |
                            |  version_num      |       | learner_id, score   |
                            |  file_hash, minio |       | answers JSONB       |
                            +-------------------+       +---------------------+

+-------------------+       +-------------------+       +---------------------+
| flashcard_decks   |       | gamification_prof |       |   srl_goals         |
| owner_id -> users |       | learner_id -> user|       | learner_id -> users |
| title, mastery_pct|       | total_xp, level   |       | goal_type, status   |
+--------+----------+       | streak, leaderbd  |       | target/current val  |
         | 1:N              +-------------------+       +---------------------+
         v
+-------------------+       +-------------------+
| flashcard_cards   |       | badge_definitions |
| deck_id -> decks  |       | id VARCHAR(30) PK |
| SM-2: EF, interval|       | trigger_event     |
| front/back JSONB  |       | xp_reward         |
+-------------------+       +--------+----------+
                                     | 1:N
                                     v
                            +-------------------+
                            |  badge_awards     |
                            | (learner, badge)  |
                            | PK composite      |
                            +-------------------+
```

**Tong: 22+ tables** (Core: 8, Service: 11, Privacy: 3)

### 2.3.2 Core Tables — Full DDL

Source: Migration 001 (`packages/lms-api/src/db/migrations/001_initial_schema.sql`)

#### users

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  username      VARCHAR(50)  NOT NULL UNIQUE,
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,          -- bcrypt cost=12
  full_name     VARCHAR(255) NOT NULL,
  role          VARCHAR(20)  NOT NULL CHECK (role IN ('student','teacher','admin','observer')),
  class_id      VARCHAR(20),                    -- e.g. '12A1'
  grade         SMALLINT     CHECK (grade BETWEEN 1 AND 12),
  is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
  avatar_url    TEXT,
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ                     -- soft delete
);

CREATE INDEX idx_users_role         ON users(role) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_class        ON users(class_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_email_active ON users(email) WHERE deleted_at IS NULL AND is_active = TRUE;
```

#### lessons

```sql
CREATE TABLE lessons (
  id                  UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  lesson_code         VARCHAR(30)  NOT NULL UNIQUE, -- e.g. "020108.0202a6"
  title               VARCHAR(500) NOT NULL,
  subject             VARCHAR(50)  NOT NULL DEFAULT 'toan',
  grade               SMALLINT     NOT NULL CHECK (grade BETWEEN 1 AND 12),
  unit_l1             VARCHAR(255),               -- Chu de cap 1
  unit_l2             VARCHAR(255),               -- Chu de cap 2
  yccđ_requirement    TEXT,                       -- Yeu cau can dat tu QD 791
  bloom_level         SMALLINT     NOT NULL DEFAULT 1 CHECK (bloom_level BETWEEN 1 AND 6),
  bloom_vi            VARCHAR(50),                -- Nhan biet | Thong hieu | Van dung...
  solo_level          SMALLINT     NOT NULL DEFAULT 3 CHECK (solo_level BETWEEN 1 AND 5),
  solo_target         SMALLINT     NOT NULL DEFAULT 4 CHECK (solo_target BETWEEN 1 AND 5),
  knowledge_type      VARCHAR(20)  NOT NULL DEFAULT 'declarative'
                        CHECK (knowledge_type IN ('declarative','functioning','both')),
  threshold_concept   BOOLEAN      NOT NULL DEFAULT FALSE,
  lesson_model        VARCHAR(20)  NOT NULL DEFAULT 'scaffold'
                        CHECK (lesson_model IN ('scaffold','practice','case','teach',
                               'explore','repair','project','reflect')),
  difficulty_level    VARCHAR(20)  NOT NULL DEFAULT 'nen_tang'
                        CHECK (difficulty_level IN ('nen_tang','mo_rong','chuyen_sau')),
  al_format           VARCHAR(30)  CHECK (al_format IN (
                        'think_pair_share','worked_example_fading','muddiest_point',
                        'exit_ticket','problem_based','peer_instruction','socratic',
                        'flipped','case_study','station_rotation','jigsaw',
                        'argumentation','project_based','design_thinking')),
  kolb_phase          VARCHAR(10)  DEFAULT 'all',
  next_if_pass        VARCHAR(30),                -- lesson_code of next lesson
  next_if_fail        VARCHAR(30),                -- lesson_code of remediation
  prerequisite_codes  TEXT[]       DEFAULT '{}',
  estimated_minutes   SMALLINT     DEFAULT 20,
  html_content        TEXT,                       -- AURA schema HTML
  ilos                JSONB        DEFAULT '[]',  -- [{solo,verb,topic}]
  tlas                JSONB        DEFAULT '[]',  -- 5-stage TLA
  assessment_tasks    JSONB        DEFAULT '[]',
  total_points        SMALLINT     DEFAULT 0,
  status              VARCHAR(20)  NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','review','published','archived')),
  author_id           UUID         REFERENCES users(id),
  published_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deleted_at          TIMESTAMPTZ
);

CREATE INDEX idx_lessons_code   ON lessons(lesson_code);
CREATE INDEX idx_lessons_grade  ON lessons(grade, subject) WHERE deleted_at IS NULL;
CREATE INDEX idx_lessons_bloom  ON lessons(bloom_level) WHERE deleted_at IS NULL;
CREATE INDEX idx_lessons_status ON lessons(status) WHERE deleted_at IS NULL;
CREATE INDEX idx_lessons_search ON lessons USING gin(
  to_tsvector('simple', title || ' ' || COALESCE(yccđ_requirement,''))
);
```

#### learner_models

```sql
CREATE TABLE learner_models (
  id                   UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id              UUID         NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  mastery_map          JSONB        NOT NULL DEFAULT '{}',
  bloom_profile        JSONB        NOT NULL DEFAULT '{"1":0,"2":0,"3":0,"4":0,"5":0,"6":0}',
  error_patterns       JSONB        NOT NULL DEFAULT '{}',
  speed_profile        JSONB        NOT NULL DEFAULT '{"nen_tang":300,"mo_rong":420,"chuyen_sau":600}',
  solo_profile         JSONB        NOT NULL DEFAULT '{}',
  declarative_mastery  JSONB        NOT NULL DEFAULT '{}',
  functioning_mastery  JSONB        NOT NULL DEFAULT '{}',
  ai_literacy_score    JSONB        NOT NULL DEFAULT
    '{"know_understand":0,"use_apply":0,"evaluate_create":0,"ethics":0,"career":0}',
  current_lesson_id    UUID         REFERENCES lessons(id),
  current_level        VARCHAR(20)  NOT NULL DEFAULT 'nen_tang'
                          CHECK (current_level IN ('nen_tang','mo_rong','chuyen_sau')),
  engagement_score     REAL         NOT NULL DEFAULT 0.5 CHECK (engagement_score BETWEEN 0 AND 1),
  preferred_model      VARCHAR(20)  DEFAULT 'scaffold',
  learning_approach    VARCHAR(20)  NOT NULL DEFAULT 'strategic'
                          CHECK (learning_approach IN ('surface','deep','strategic')),
  consecutive_pass     SMALLINT     NOT NULL DEFAULT 0,
  consecutive_fail     SMALLINT     NOT NULL DEFAULT 0,
  tags                 TEXT[]       DEFAULT '{}',
  notes                TEXT         DEFAULT '',
  last_session_at      TIMESTAMPTZ,
  last_lesson_id       UUID         REFERENCES lessons(id),
  streak_days          SMALLINT     NOT NULL DEFAULT 0,
  total_study_minutes  INTEGER      NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_lm_user  ON learner_models(user_id);
CREATE INDEX idx_lm_tags  ON learner_models USING gin(tags);
CREATE INDEX idx_lm_level ON learner_models(current_level);
```

#### agent_decisions

```sql
CREATE TABLE agent_decisions (
  id                   BIGSERIAL    PRIMARY KEY,
  user_id              UUID         NOT NULL REFERENCES users(id),
  trigger_event_id     BIGINT,
  rule_fired           VARCHAR(20)  NOT NULL,    -- R01..R10, DEFAULT
  next_lesson_id       UUID         REFERENCES lessons(id),
  reason               TEXT         NOT NULL,    -- Vietnamese explanation (XAI)
  confidence           REAL         DEFAULT 0.8 CHECK (confidence BETWEEN 0 AND 1),
  learner_model_at     JSONB,
  overridden_by        UUID         REFERENCES users(id),
  override_reason      TEXT,
  override_at          TIMESTAMPTZ,
  outcome_mastery_delta REAL,
  outcome_recorded_at  TIMESTAMPTZ,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ad_user ON agent_decisions(user_id, created_at DESC);
CREATE INDEX idx_ad_rule ON agent_decisions(rule_fired);
```

#### events (partitioned)

```sql
CREATE TABLE events (
  id           BIGSERIAL    NOT NULL,
  user_id      UUID         NOT NULL REFERENCES users(id),
  lesson_id    UUID         REFERENCES lessons(id),
  session_id   UUID,
  event_type   VARCHAR(50)  NOT NULL CHECK (event_type IN (
                 'quiz_submitted','assignment_submitted','video_progress',
                 'session_started','session_ended','discussion_posted',
                 'peer_review_given','lesson_completed','teacher_override',
                 'ai_literacy_assessed','solo_assessed','page_viewed',
                 'hint_requested','code_executed','flashcard_reviewed'
               )),
  payload      JSONB        NOT NULL DEFAULT '{}',
  processed    BOOLEAN      NOT NULL DEFAULT FALSE,
  idempotency_key VARCHAR(36),
  source       VARCHAR(20)  DEFAULT 'lms',
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Monthly partitions
CREATE TABLE events_2026_04 PARTITION OF events
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE events_2026_05 PARTITION OF events
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE events_2026_06 PARTITION OF events
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

CREATE INDEX idx_events_user        ON events(user_id, created_at DESC);
CREATE INDEX idx_events_type        ON events(event_type, created_at DESC);
CREATE INDEX idx_events_proc        ON events(processed, created_at) WHERE processed = FALSE;
CREATE INDEX idx_events_idempotency ON events(idempotency_key) WHERE idempotency_key IS NOT NULL;
```

#### questions

```sql
CREATE TABLE questions (
  id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  lesson_id       UUID         REFERENCES lessons(id),
  question_type   VARCHAR(30)  NOT NULL CHECK (question_type IN (
                    'mcq','true_false','fill_blank','ordering','matching',
                    'short_answer','essay','code_python','math_input','drawing'
                  )),
  bloom_level     SMALLINT     NOT NULL CHECK (bloom_level BETWEEN 1 AND 6),
  solo_level      SMALLINT     NOT NULL DEFAULT 3 CHECK (solo_level BETWEEN 1 AND 5),
  difficulty      VARCHAR(20)  NOT NULL DEFAULT 'medium'
                    CHECK (difficulty IN ('easy','medium','hard')),
  stem            TEXT         NOT NULL,
  options         JSONB        DEFAULT '[]',
  correct_answer  TEXT,
  tolerance       REAL         DEFAULT 0.01,
  explanation     TEXT,
  rubric          JSONB        DEFAULT '[]',
  hints           TEXT[]       DEFAULT '{}',
  auto_grade      BOOLEAN      NOT NULL DEFAULT TRUE,
  points          REAL         NOT NULL DEFAULT 1.0,
  times_used      INTEGER      NOT NULL DEFAULT 0,
  avg_score       REAL,
  discrimination  REAL,
  tags            TEXT[]       DEFAULT '{}',
  author_id       UUID         REFERENCES users(id),
  is_public       BOOLEAN      NOT NULL DEFAULT FALSE,
  status          VARCHAR(20)  NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','review','published','retired')),
  -- v2.0 psychometric extensions (Migration 006)
  difficulty_p        DECIMAL(4,3),
  discrimination_idx  DECIMAL(4,3),
  quality_score       SMALLINT CHECK (quality_score BETWEEN 1 AND 5),
  attempt_count       INT DEFAULT 0,
  correct_count       INT DEFAULT 0,
  is_ai_generated     BOOLEAN DEFAULT FALSE,
  ai_model            VARCHAR(50),
  review_status       VARCHAR(20) DEFAULT 'draft'
                        CHECK (review_status IN ('draft','reviewed','approved','deprecated')),
  reviewed_by         UUID REFERENCES users(id),
  reviewed_at         TIMESTAMPTZ,
  error_type          VARCHAR(50),
  topic_tags          TEXT[] DEFAULT '{}',
  solution_steps      TEXT,
  hint_text           TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ
);

CREATE INDEX idx_q_lesson        ON questions(lesson_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_q_bloom         ON questions(bloom_level, difficulty)
                                   WHERE deleted_at IS NULL AND status = 'published';
CREATE INDEX idx_q_type          ON questions(question_type) WHERE deleted_at IS NULL;
CREATE INDEX idx_q_search        ON questions USING gin(to_tsvector('simple', stem));
CREATE INDEX idx_q_review_status ON questions(review_status) WHERE deleted_at IS NULL;
CREATE INDEX idx_q_topic_tags    ON questions USING gin(topic_tags);
```

#### Cac bang core khac

```sql
-- learner_model_snapshots (immutable history)
CREATE TABLE learner_model_snapshots (
  id             BIGSERIAL    PRIMARY KEY,
  user_id        UUID         NOT NULL REFERENCES users(id),
  snapshot       JSONB        NOT NULL,
  trigger_event  VARCHAR(50),
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_lm_snap_user ON learner_model_snapshots(user_id, created_at DESC);

-- quiz_attempts
CREATE TABLE quiz_attempts (
  id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID         NOT NULL REFERENCES users(id),
  lesson_id       UUID         NOT NULL REFERENCES lessons(id),
  attempt_number  SMALLINT     NOT NULL DEFAULT 1,
  answers         JSONB        NOT NULL DEFAULT '[]',
  total_score     REAL         NOT NULL DEFAULT 0,
  max_score       REAL         NOT NULL DEFAULT 0,
  score_percent   REAL GENERATED ALWAYS AS (
                    CASE WHEN max_score > 0 THEN (total_score / max_score) * 100 ELSE 0 END
                  ) STORED,
  passed          BOOLEAN,
  time_taken_sec  INTEGER,
  started_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  submitted_at    TIMESTAMPTZ,
  graded_at       TIMESTAMPTZ,
  feedback        TEXT,
  error_tags      TEXT[]       DEFAULT '{}',
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_qa_user_lesson ON quiz_attempts(user_id, lesson_id);
CREATE INDEX idx_qa_submitted   ON quiz_attempts(submitted_at DESC) WHERE submitted_at IS NOT NULL;

-- curriculum_rules
CREATE TABLE curriculum_rules (
  id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  rule_code       VARCHAR(10)  NOT NULL UNIQUE,
  name            VARCHAR(100) NOT NULL,
  description     TEXT,
  trigger_condition TEXT       NOT NULL,
  action          TEXT        NOT NULL,
  priority        SMALLINT    NOT NULL,
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  framework_source VARCHAR(50) DEFAULT 'SRS',
  updated_by      UUID         REFERENCES users(id),
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
```

### 2.3.3 Service Tables — Full DDL

Source: Migration 005 (`packages/lms-api/src/db/migrations/005_ch2_new_tables.sql`)

#### aura_lessons

```sql
CREATE TABLE IF NOT EXISTS aura_lessons (
  lesson_id       VARCHAR(30)   PRIMARY KEY,
  file_type       VARCHAR(20)   NOT NULL CHECK (file_type IN ('html','pdf','video','quiz_json','python')),
  original_url    TEXT          NOT NULL,
  exploit_mode    VARCHAR(20)   DEFAULT 'hybrid',
  enable_embed    BOOLEAN       DEFAULT TRUE,
  enable_parse    BOOLEAN       DEFAULT TRUE,
  enable_store    BOOLEAN       DEFAULT TRUE,
  enable_sync     BOOLEAN       DEFAULT TRUE,
  parsed_grade    SMALLINT,
  parsed_subject  VARCHAR(20),
  parsed_bloom    SMALLINT      CHECK (parsed_bloom BETWEEN 1 AND 6),
  has_interactive BOOLEAN       DEFAULT FALSE,
  has_quiz        BOOLEAN       DEFAULT FALSE,
  has_exit_ticket BOOLEAN       DEFAULT FALSE,
  quiz_count      SMALLINT      DEFAULT 0,
  qa_status       VARCHAR(20)   DEFAULT 'pending'
                    CHECK (qa_status IN ('pending','processing','pass','warn','fail')),
  qa_checklist    JSONB,
  parse_error     TEXT,
  uploaded_by     UUID          NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ   DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aura_lessons_status ON aura_lessons(qa_status);
```

#### aura_versions

```sql
CREATE TABLE IF NOT EXISTS aura_versions (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  lesson_id       VARCHAR(30)   NOT NULL REFERENCES aura_lessons(lesson_id) ON DELETE CASCADE,
  version_num     SMALLINT      NOT NULL,
  file_hash       VARCHAR(64)   NOT NULL,
  minio_path      TEXT          NOT NULL,
  change_summary  TEXT,
  created_by      UUID          NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ   DEFAULT NOW(),
  UNIQUE(lesson_id, version_num)
);
```

#### exam_blueprints

```sql
CREATE TABLE IF NOT EXISTS exam_blueprints (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT          NOT NULL,
  lesson_ids      TEXT[]        DEFAULT '{}',
  bloom_dist      JSONB         DEFAULT '{"1":0.10,"2":0.20,"3":0.30,"4":0.20,"5":0.10,"6":0.10}',
  difficulty_dist JSONB         DEFAULT '{"easy":0.30,"medium":0.50,"hard":0.20}',
  total_questions SMALLINT      DEFAULT 40,
  total_score     SMALLINT      DEFAULT 10,
  time_limit_min  SMALLINT      DEFAULT 45,
  anti_repeat_n   SMALLINT      DEFAULT 3,
  allow_shuffle   BOOLEAN       DEFAULT TRUE,
  seed            BIGINT,
  created_by      UUID          NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ   DEFAULT NOW()
);
```

#### exams

```sql
CREATE TABLE IF NOT EXISTS exams (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  title           TEXT          NOT NULL,
  blueprint_id    UUID          REFERENCES exam_blueprints(id),
  question_ids    UUID[]        DEFAULT '{}',
  status          VARCHAR(20)   DEFAULT 'draft'
                    CHECK (status IN ('draft','review','approved','published',
                           'active','closed','graded','archived')),
  class_ids       TEXT[]        DEFAULT '{}',
  start_at        TIMESTAMPTZ,
  end_at          TIMESTAMPTZ,
  time_limit_min  SMALLINT      DEFAULT 45,
  allow_review    BOOLEAN       DEFAULT FALSE,
  shuffle_q       BOOLEAN       DEFAULT TRUE,
  max_attempts    SMALLINT      DEFAULT 1,
  created_by      UUID          NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ   DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_exams_status ON exams(status);
CREATE INDEX IF NOT EXISTS idx_exams_class  ON exams USING gin(class_ids);
```

#### exam_submissions

```sql
CREATE TABLE IF NOT EXISTS exam_submissions (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id         UUID          NOT NULL REFERENCES exams(id),
  learner_id      UUID          NOT NULL REFERENCES users(id),
  attempt_num     SMALLINT      DEFAULT 1,
  started_at      TIMESTAMPTZ   DEFAULT NOW(),
  submitted_at    TIMESTAMPTZ,
  score           DECIMAL(5,2),
  score_pct       DECIMAL(5,2),
  status          VARCHAR(20)   DEFAULT 'in_progress'
                    CHECK (status IN ('in_progress','submitted','graded','error')),
  answers         JSONB         DEFAULT '{}',
  analysis        JSONB         DEFAULT '{}',
  UNIQUE(exam_id, learner_id, attempt_num)
);

CREATE INDEX IF NOT EXISTS idx_exam_sub_learner ON exam_submissions(learner_id, exam_id);
```

#### flashcard_decks + flashcard_cards

```sql
CREATE TABLE IF NOT EXISTS flashcard_decks (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      UUID          NOT NULL REFERENCES users(id),
  title         TEXT          NOT NULL,
  lesson_id     VARCHAR(30),
  is_public     BOOLEAN       DEFAULT FALSE,
  card_count    SMALLINT      DEFAULT 0,
  mastery_pct   DECIMAL(5,2)  DEFAULT 0,
  created_at    TIMESTAMPTZ   DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS flashcard_cards (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  deck_id         UUID          NOT NULL REFERENCES flashcard_decks(id) ON DELETE CASCADE,
  question_id     UUID          REFERENCES questions(id),
  front_content   JSONB         NOT NULL DEFAULT '{"text":""}',
  back_content    JSONB         NOT NULL DEFAULT '{"text":""}',
  easiness_factor DECIMAL(4,3)  DEFAULT 2.5,
  interval_days   SMALLINT      DEFAULT 1,
  repetitions     SMALLINT      DEFAULT 0,
  next_review_at  DATE          DEFAULT CURRENT_DATE,
  last_rating     SMALLINT      CHECK (last_rating BETWEEN 1 AND 5),
  created_at      TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fc_cards_deck ON flashcard_cards(deck_id, next_review_at);
```

#### gamification_profiles + badge_definitions + badge_awards

```sql
CREATE TABLE IF NOT EXISTS gamification_profiles (
  learner_id       UUID          PRIMARY KEY REFERENCES users(id),
  total_xp         INT           DEFAULT 0,
  level            SMALLINT      DEFAULT 1,
  current_streak   SMALLINT      DEFAULT 0,
  longest_streak   SMALLINT      DEFAULT 0,
  last_activity    DATE,
  show_leaderboard BOOLEAN       DEFAULT FALSE,
  updated_at       TIMESTAMPTZ   DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS badge_definitions (
  id              VARCHAR(30)   PRIMARY KEY,
  name_vi         TEXT          NOT NULL,
  description_vi  TEXT,
  xp_reward       SMALLINT      DEFAULT 50,
  trigger_event   VARCHAR(50),
  trigger_cond    JSONB
);

CREATE TABLE IF NOT EXISTS badge_awards (
  learner_id      UUID          NOT NULL REFERENCES users(id),
  badge_id        VARCHAR(30)   NOT NULL REFERENCES badge_definitions(id),
  awarded_at      TIMESTAMPTZ   DEFAULT NOW(),
  context         JSONB,
  PRIMARY KEY(learner_id, badge_id)
);

-- Seed badge definitions
INSERT INTO badge_definitions (id, name_vi, description_vi, xp_reward, trigger_event) VALUES
  ('first_quiz',     'Bai kiem tra dau tien',   'Hoan thanh bai quiz dau tien',        10, 'QUIZ_SUBMITTED'),
  ('first_mastery',  'Thanh thao dau tien',     'Dat mastery >= 0.8 lan dau tien',     50, 'QUIZ_PASSED'),
  ('bloom6_creator', 'Nha sang tao Bloom 6',    'Hoan thanh bai Bloom level 6',       100, 'QUIZ_PASSED'),
  ('streak_3',       'Hoc 3 ngay lien tiep',    'Streak 3 ngay',                       20, 'STREAK_MILESTONE'),
  ('streak_7',       'Hoc 7 ngay lien tiep',    'Streak 7 ngay',                       50, 'STREAK_MILESTONE'),
  ('streak_30',      'Hoc 30 ngay lien tiep',   'Streak 30 ngay',                     200, 'STREAK_MILESTONE'),
  ('flashcard_10',   'On tap deu dan',           'Review 10 flashcard trong 1 ngay',    30, 'FLASHCARD_REVIEWED'),
  ('exam_perfect',   'Diem tuyet doi',           'Dat 100% trong bai thi',             100, 'EXAM_GRADED')
ON CONFLICT (id) DO NOTHING;
```

#### srl_goals

```sql
CREATE TABLE IF NOT EXISTS srl_goals (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  learner_id      UUID          NOT NULL REFERENCES users(id),
  lesson_id       UUID          REFERENCES lessons(id),
  goal_type       VARCHAR(30)   DEFAULT 'mastery'
                    CHECK (goal_type IN ('mastery','completion','streak','bloom')),
  target_value    DECIMAL(5,2),
  current_value   DECIMAL(5,2)  DEFAULT 0,
  status          VARCHAR(20)   DEFAULT 'active'
                    CHECK (status IN ('active','achieved','abandoned')),
  due_date        DATE,
  created_at      TIMESTAMPTZ   DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_srl_learner ON srl_goals(learner_id) WHERE status = 'active';
```

### 2.3.4 [BO SUNG] Privacy Tables — 3 bang moi

Ba bang phuc vu yeu cau bao mat du lieu hoc sinh theo quy dinh Viet Nam va GDPR-like compliance.

#### consent_records

```sql
CREATE TABLE IF NOT EXISTS consent_records (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Loai dong thuan
  consent_type    VARCHAR(50)   NOT NULL CHECK (consent_type IN (
                    'analytics_tracking',    -- thu thap du lieu hoc tap
                    'ai_processing',         -- xu ly boi AI/Agent
                    'leaderboard_display',   -- hien thi tren bang xep hang
                    'data_sharing_teacher',  -- chia se voi giao vien
                    'data_sharing_parent',   -- chia se voi phu huynh
                    'push_notification',     -- thong bao push
                    'email_notification'     -- thong bao email
                  )),
  -- Trang thai
  granted         BOOLEAN       NOT NULL DEFAULT FALSE,
  granted_at      TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  -- Nguoi cap (hoc sinh hoac phu huynh)
  granted_by      UUID          NOT NULL REFERENCES users(id),
  granted_by_role VARCHAR(20)   NOT NULL CHECK (granted_by_role IN ('student','parent','admin')),
  -- Phien ban chinh sach tai thoi diem dong thuan
  policy_version  VARCHAR(20)   NOT NULL DEFAULT '1.0',
  ip_address      INET,
  user_agent      TEXT,
  -- Metadata
  created_at      TIMESTAMPTZ   DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   DEFAULT NOW(),
  UNIQUE(user_id, consent_type)
);

CREATE INDEX idx_consent_user     ON consent_records(user_id);
CREATE INDEX idx_consent_type     ON consent_records(consent_type) WHERE granted = TRUE;
CREATE INDEX idx_consent_revoked  ON consent_records(user_id) WHERE revoked_at IS NOT NULL;
```

#### data_deletion_requests

```sql
CREATE TABLE IF NOT EXISTS data_deletion_requests (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Nguoi yeu cau xoa (hoc sinh, phu huynh, hoac admin)
  requester_id    UUID          NOT NULL REFERENCES users(id),
  requester_role  VARCHAR(20)   NOT NULL,
  -- Hoc sinh bi yeu cau xoa du lieu
  target_user_id  UUID          NOT NULL REFERENCES users(id),
  -- Pham vi xoa
  deletion_scope  VARCHAR(30)   NOT NULL CHECK (deletion_scope IN (
                    'full_account',       -- xoa toan bo tai khoan + du lieu
                    'learning_data',      -- chi xoa du lieu hoc tap (giu tai khoan)
                    'ai_model_data',      -- chi xoa learner_model + agent_decisions
                    'specific_period'     -- xoa du lieu trong khoang thoi gian
                  )),
  -- Khoang thoi gian (chi ap dung voi 'specific_period')
  period_start    TIMESTAMPTZ,
  period_end      TIMESTAMPTZ,
  -- Trang thai pipeline 7 buoc
  status          VARCHAR(20)   NOT NULL DEFAULT 'pending' CHECK (status IN (
                    'pending',       -- B1: yeu cau tiep nhan
                    'verified',      -- B2: xac minh danh tinh
                    'approved',      -- B3: admin phe duyet
                    'processing',    -- B4: dang xoa du lieu
                    'completed',     -- B5: xoa xong, da kiem tra
                    'notified',      -- B6: da thong bao nguoi yeu cau
                    'rejected'       -- Tu choi (vi du: khong du quyen)
                  )),
  -- Audit
  reason          TEXT,
  admin_notes     TEXT,
  approved_by     UUID          REFERENCES users(id),
  approved_at     TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  notified_at     TIMESTAMPTZ,
  -- SLA: 72h tu pending -> notified
  sla_deadline    TIMESTAMPTZ   GENERATED ALWAYS AS (created_at + INTERVAL '72 hours') STORED,
  created_at      TIMESTAMPTZ   DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX idx_deletion_target  ON data_deletion_requests(target_user_id);
CREATE INDEX idx_deletion_status  ON data_deletion_requests(status) WHERE status NOT IN ('completed','notified');
CREATE INDEX idx_deletion_sla     ON data_deletion_requests(sla_deadline) WHERE status NOT IN ('completed','notified');
```

#### privacy_audit_log

```sql
CREATE TABLE IF NOT EXISTS privacy_audit_log (
  id              BIGSERIAL     PRIMARY KEY,
  -- Ai thuc hien hanh dong
  actor_id        UUID          NOT NULL REFERENCES users(id),
  actor_role      VARCHAR(20)   NOT NULL,
  -- Hanh dong
  action          VARCHAR(50)   NOT NULL CHECK (action IN (
                    'consent_granted',
                    'consent_revoked',
                    'data_exported',
                    'data_deleted',
                    'data_accessed',
                    'deletion_requested',
                    'deletion_approved',
                    'deletion_completed',
                    'pii_sent_to_llm',       -- ghi log khi PII gui den LLM (should be anonymized)
                    'learner_model_accessed', -- ghi log khi AI doc learner_model
                    'admin_override'
                  )),
  -- Doi tuong bi tac dong
  target_user_id  UUID          REFERENCES users(id),
  target_table    VARCHAR(50),               -- ten bang bi truy cap/xoa
  target_record_id TEXT,                     -- id ban ghi bi tac dong
  -- Chi tiet
  details         JSONB         DEFAULT '{}',
  ip_address      INET,
  user_agent      TEXT,
  -- Immutable
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Khong co updated_at — bang nay la append-only, khong bao gio UPDATE
CREATE INDEX idx_paudit_actor    ON privacy_audit_log(actor_id, created_at DESC);
CREATE INDEX idx_paudit_target   ON privacy_audit_log(target_user_id, created_at DESC);
CREATE INDEX idx_paudit_action   ON privacy_audit_log(action, created_at DESC);
```

### 2.3.5 Index Strategy

Tong hop 12+ indexes chinh phuc vu performance:

| # | Index | Table | Type | Muc dich |
|---|-------|-------|------|----------|
| 1 | `idx_users_role` | users | B-tree partial | Filter theo role, loai bo soft-deleted |
| 2 | `idx_users_email_active` | users | B-tree partial | Login lookup, chi active users |
| 3 | `idx_lessons_search` | lessons | GIN (tsvector) | Full-text search tieu de + YCCD |
| 4 | `idx_lessons_bloom` | lessons | B-tree partial | Filter theo Bloom level |
| 5 | `idx_lm_tags` | learner_models | GIN (array) | Filter tags: at_risk, peer_expert |
| 6 | `idx_events_type` | events | B-tree | Filter event_type + time range |
| 7 | `idx_events_proc` | events | B-tree partial | Consumer processing queue |
| 8 | `idx_events_idempotency` | events | B-tree partial | Idempotent replay |
| 9 | `idx_q_bloom` | questions | B-tree partial | Blueprint generation: bloom + difficulty |
| 10 | `idx_q_topic_tags` | questions | GIN (array) | Tag-based question search |
| 11 | `idx_fc_cards_deck` | flashcard_cards | B-tree | SM-2 review scheduling per deck |
| 12 | `idx_exam_sub_learner` | exam_submissions | B-tree | Learner submission lookup |

### 2.3.6 Partition Strategy

Bang `events` su dung **PARTITION BY RANGE (created_at)** theo thang. Moi thang tao mot partition moi thong qua cron job hoac migration.

```sql
-- Template: chay hang thang qua pg_cron hoac migration script
CREATE TABLE events_2026_07 PARTITION OF events
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
```

**Loi ich:**

- **Query performance**: truy van gioi han thoi gian chi scan 1 partition
- **Maintenance**: `VACUUM` va `ANALYZE` chay doc lap tren tung partition
- **Archival**: DROP partition cu thay vi DELETE hang trieu rows
- **Dung luong**: moi partition ~50-100MB/thang voi 500 hoc sinh

**Chu y:** Tao partition truoc khi bat dau thang moi. Neu partition khong ton tai, INSERT se fail.

---

## 2.4 Infrastructure

### 2.4.1 Docker Compose

File: `docker-compose.ch2a.yml` — full 10 services + infrastructure cho development/staging.

**Cau truc:**

```
docker-compose.ch2a.yml
|
+-- GATEWAY
|   +-- nginx :80/:443 (SSL termination, rate limiting)
|
+-- P0 CORE SERVICES
|   +-- lms-api :3000 (Node.js 22 + Fastify 4, 512MB)
|   +-- auth-service :3001 (Node.js + JWT RS256, 256MB)
|   +-- agent-service :8000 (Python 3.12 + FastAPI, 512MB)
|   +-- aura-service :8001 (Python 3.12 + FastAPI, 512MB)
|   +-- grader-service :8002 (Python 3.12 + FastAPI, 256MB)
|   +-- qbank-service :3002 (Node.js + Fastify, 256MB)
|   +-- exam-service :3003 (Node.js + Fastify, 256MB)
|   +-- notification-svc :3006 (Node.js, 128MB)
|
+-- P1 SERVICES
|   +-- flashcard-service :3004 (Node.js + Fastify, 128MB)
|   +-- gamification-svc :3005 (Node.js + Fastify, 128MB)
|
+-- WORKERS
|   +-- analytics-proc (Python 3.12, 256MB, no HTTP port)
|
+-- INFRASTRUCTURE
    +-- postgres :5432 (PostgreSQL 15-alpine)
    +-- redis :6379 (Redis 7-alpine, maxmemory 512MB, allkeys-lru)
    +-- minio :9000/:9001 (MinIO, S3-compatible object store)
```

**Environment variables chung:**

```yaml
# Node.js services
DATABASE_URL:  postgresql://adaptlearn:${POSTGRES_PASSWORD}@postgres:5432/adaptlearn
REDIS_URL:     redis://redis:6379
MINIO_ENDPOINT: minio:9000
MINIO_ACCESS_KEY: ${MINIO_ACCESS_KEY}
MINIO_SECRET_KEY: ${MINIO_SECRET_KEY}
INTERNAL_KEY:  ${INTERNAL_KEY}

# Python services
DATABASE_URL:  postgresql://adaptlearn:${POSTGRES_PASSWORD}@postgres:5432/adaptlearn
REDIS_URL:     redis://redis:6379
LOG_LEVEL:     DEBUG
```

**Healthcheck pattern:** Tat ca services dung `curl -f http://localhost:<port>/health` voi interval 15s, timeout 5s, retries 3.

### 2.4.2 MinIO Bucket Structure

MinIO lam S3-compatible object storage cho noi dung hoc lieu AURA.

```
minio/
+-- adaptlearn-content/          -- AURA HTML/PDF/Video content
|   +-- lessons/{lesson_id}/
|   |   +-- v{n}/                -- versioned content
|   |   |   +-- index.html
|   |   |   +-- assets/
|   |   +-- thumbnail.jpg
|   +-- uploads/                 -- raw uploads truoc khi parse
|
+-- adaptlearn-submissions/      -- Bai nop cua hoc sinh
|   +-- exams/{exam_id}/{learner_id}/
|   +-- code/{submission_id}/
|
+-- adaptlearn-exports/          -- Data export (GDPR/privacy)
|   +-- {user_id}/
|       +-- export_{timestamp}.zip
|
+-- adaptlearn-backups/          -- Database backups
    +-- pg_dump_{date}.sql.gz
```

**Bucket policies:**

- `adaptlearn-content`: read-only cho authenticated users (presigned URL, TTL 1h)
- `adaptlearn-submissions`: write-only cho hoc sinh, read cho GV + admin
- `adaptlearn-exports`: read-only cho user so huu, TTL 24h
- `adaptlearn-backups`: admin-only, lifecycle rule xoa sau 30 ngay

### 2.4.3 Redis Configuration

```
redis-server
  --maxmemory 512mb
  --maxmemory-policy allkeys-lru
  --save 60 1000                    # RDB: save every 60s if 1000 keys changed
  --appendonly yes                  # AOF enabled (default)
```

**Su dung Redis:**

| Chuc nang | Key pattern | TTL |
|-----------|------------|-----|
| Event Bus | `events:main` (Stream) | Permanent (XTRIM khi >100k entries) |
| DLQ | `events:dlq` (Stream) | Permanent (manual cleanup) |
| Session cache | `session:{user_id}` | 15 min (access token TTL) |
| Rate limiting | `rate:{ip}:{endpoint}` | 60s sliding window |
| Learner model cache | `lm:{user_id}` | 5 min |
| Quiz lock | `quiz_lock:{user_id}:{lesson_id}` | 30 min |

### 2.4.4 CI/CD Pipeline

```
GitHub Actions Pipeline
|
+-- [Push to main/develop]
|   +-- lint (ESLint + Prettier)
|   +-- typecheck (tsc --noEmit)
|   +-- unit-test (Vitest, coverage >= 80%)
|   +-- build (tsc + Docker build)
|   +-- integration-test (docker compose up, API tests)
|   +-- security-scan (npm audit, Snyk)
|
+-- [Push tag v*]
|   +-- all above +
|   +-- docker push (ghcr.io/adaptlearn/*)
|   +-- deploy staging (docker compose pull + up -d)
|   +-- smoke-test (health endpoints)
|
+-- [Manual approval]
    +-- deploy production
    +-- migration (run pending SQL migrations)
    +-- verify (health + e2e smoke)
```

**Branch strategy:**

- `main`: production-ready, protected
- `develop`: integration branch
- `feature/*`: feature branches, PR to develop
- `hotfix/*`: urgent fixes, PR to main + develop

### 2.4.5 Monitoring Stack

| Tool | Chuc nang | Port | Phase |
|------|----------|------|-------|
| **Prometheus** | Metrics collection (CPU, RAM, request latency, event throughput) | 9090 | P0 |
| **Grafana** | Dashboard visualization, alerting | 3100 | P0 |
| **Sentry** | Error tracking, performance monitoring | SaaS | P0 |
| **Loki** | Log aggregation (structured JSON logs from Pino) | 3200 | P1 |

**Key metrics (Prometheus):**

```
# Event bus health
redis_stream_length{stream="events:main"}
redis_stream_pending{group="agent-processors"}
redis_stream_pending{group="analytics-proc"}

# Service health
http_request_duration_seconds{service="lms-api",quantile="0.95"}
http_requests_total{service="lms-api",status="5xx"}

# Database
pg_stat_activity_count{state="active"}
pg_database_size_bytes{datname="adaptlearn"}

# Business metrics
agent_decisions_total{rule="R01"}
quiz_pass_rate{grade="10",subject="toan"}
learner_mastery_avg{level="nen_tang"}
```

**Alert rules (Grafana):**

| Alert | Condition | Severity |
|-------|----------|----------|
| DLQ backlog | `events:dlq` length > 50 | Critical |
| Service down | health endpoint fail > 3 min | Critical |
| High latency | p95 > 2s for 5 min | Warning |
| DB connections | active > 80% pool | Warning |
| Event lag | consumer pending > 1000 | Warning |

---

## 2.5 [BO SUNG] Privacy Architecture

Phan moi bo sung cho v2.1 — dam bao bao mat du lieu hoc sinh theo quy dinh phap luat Viet Nam (Luat An ninh mang 2018, Nghi dinh 13/2023/ND-CP) va tham khao GDPR.

### 2.5.1 Consent Service (trong auth-service)

Consent management duoc tich hop vao **auth-service** (port 3001) vi no lien quan truc tiep den authentication va user management.

**API Endpoints:**

```
POST   /api/v1/consent              -- Cap dong thuan moi
GET    /api/v1/consent/:userId      -- Xem trang thai dong thuan
PUT    /api/v1/consent/:userId/:type -- Cap nhat dong thuan
DELETE /api/v1/consent/:userId/:type -- Thu hoi dong thuan
```

**7 loai dong thuan:**

| consent_type | Mo ta | Mac dinh | Ai cap? |
|-------------|-------|----------|---------|
| `analytics_tracking` | Thu thap du lieu hoc tap | TRUE (opt-out) | Hoc sinh/Phu huynh |
| `ai_processing` | Xu ly boi AI Agent | TRUE (opt-out) | Hoc sinh/Phu huynh |
| `leaderboard_display` | Hien thi tren bang xep hang | FALSE (opt-in) | Hoc sinh |
| `data_sharing_teacher` | Chia se du lieu voi giao vien | TRUE (opt-out) | Hoc sinh/Phu huynh |
| `data_sharing_parent` | Chia se du lieu voi phu huynh | TRUE (auto) | Admin (khi HS < 16 tuoi) |
| `push_notification` | Thong bao push | FALSE (opt-in) | Hoc sinh |
| `email_notification` | Thong bao email | TRUE (opt-out) | Hoc sinh/Phu huynh |

**Logic dac biet:**

- Hoc sinh duoi 16 tuoi: phu huynh phai cap dong thuan `ai_processing` va `analytics_tracking`
- Thu hoi `ai_processing`: agent-service ngung xu ly learner_model, chi tra ket qua default
- Thu hoi `analytics_tracking`: events van duoc ghi nhung KHONG lien ket voi user_id (anonymize)

### 2.5.2 Data Deletion Pipeline (7 buoc, 72h SLA)

```
     [Hoc sinh / Phu huynh]
              |
              v
    B1: Gui yeu cau xoa (POST /api/v1/privacy/deletion)
              |
              v
    B2: Xac minh danh tinh (email OTP hoac phu huynh confirm)
              |
              v
    B3: Admin phe duyet (dashboard review, auto-approve neu full_account)
              |
              v
    B4: Xu ly xoa du lieu
        +-- anonymize events (user_id -> SHA256 hash)
        +-- DELETE learner_models WHERE user_id = ?
        +-- DELETE agent_decisions WHERE user_id = ?
        +-- DELETE quiz_attempts WHERE user_id = ?
        +-- DELETE flashcard_reviews WHERE user_id = ?
        +-- DELETE notifications WHERE user_id = ?
        +-- MinIO: xoa objects trong adaptlearn-submissions/{user_id}/
        +-- Redis: DEL session:{user_id}, lm:{user_id}
              |
              v
    B5: Kiem tra hoan thanh (verify khong con PII trong tat ca tables)
              |
              v
    B6: Thong bao nguoi yeu cau (email confirmation)
              |
              v
    B7: Ghi privacy_audit_log (action = 'deletion_completed')

    SLA: 72 gio tu B1 -> B6
    Monitoring: alert neu status = 'processing' > 24h
```

**Pham vi xoa theo deletion_scope:**

| Scope | Tables bi xoa | MinIO | Redis |
|-------|--------------|-------|-------|
| `full_account` | ALL tables co user_id FK | Yes | Yes |
| `learning_data` | events, quiz_attempts, flashcard_reviews, exam_submissions | No | Yes (lm cache) |
| `ai_model_data` | learner_models, agent_decisions, learner_model_snapshots | No | Yes (lm cache) |
| `specific_period` | events, quiz_attempts (filtered by created_at) | No | No |

### 2.5.3 DPIA Document Template

Data Protection Impact Assessment (DPIA) theo Nghi dinh 13/2023/ND-CP va tham khao GDPR Article 35.

| STT | Muc | Noi dung |
|-----|-----|---------|
| 1 | **Mo ta xu ly** | He thong hoc tap thich ung cho hoc sinh THPT, thu thap du lieu hoc tap de ca nhan hoa lo trinh |
| 2 | **Muc dich** | Nang cao hieu qua hoc tap thong qua AI adaptive learning |
| 3 | **Co so phap ly** | Dong thuan cua hoc sinh/phu huynh (consent_records), Luat Giao duc, QD 791/QD-BGDDT |
| 4 | **Loai du lieu** | Ho ten, email, lop, diem so, hanh vi hoc tap, learner model, AI decisions |
| 5 | **Chu the du lieu** | Hoc sinh THPT (14-18 tuoi), giao vien, phu huynh |
| 6 | **Thoi gian luu tru** | Du lieu hoc tap: toi da 5 nam sau khi tot nghiep. Tai khoan: cho den khi yeu cau xoa |
| 7 | **Chia se ben thu 3** | Anthropic (Claude API) — PII anonymized truoc khi gui. Khong chia se du lieu tho |
| 8 | **Rui ro** | Re-identification tu learner_model, data breach, unauthorized access |
| 9 | **Bien phap giam thieu** | Encryption at rest (PostgreSQL TDE), TLS 1.3 in transit, RBAC, consent management, audit log |
| 10 | **Danh gia** | Rui ro TRUNG BINH — du lieu hoc tap nhay cam nhung khong thuoc loai dac biet |
| 11 | **Phe duyet** | Hieu truong + Phu trach CNTT + DPO (neu co) |

### 2.5.4 Audit Log Specification

Bang `privacy_audit_log` ghi lai moi hanh dong lien quan den du lieu ca nhan. Bang nay la **append-only** — khong bao gio UPDATE hoac DELETE.

**Cac hanh dong duoc ghi:**

| Action | Khi nao | Chi tiet (JSONB) |
|--------|---------|-----------------|
| `consent_granted` | Hoc sinh/PH cap dong thuan | `{consent_type, policy_version}` |
| `consent_revoked` | Thu hoi dong thuan | `{consent_type, reason}` |
| `data_exported` | Xuat du lieu ca nhan (GDPR portability) | `{format, tables_included}` |
| `data_deleted` | Xoa du lieu (tung ban ghi) | `{table, record_count}` |
| `data_accessed` | Admin/GV truy cap du lieu HS | `{table, query_type}` |
| `deletion_requested` | Gui yeu cau xoa | `{scope, period}` |
| `deletion_approved` | Admin phe duyet yeu cau | `{admin_id, notes}` |
| `deletion_completed` | Xoa hoan tat | `{tables_affected, duration_s}` |
| `pii_sent_to_llm` | GUI PII den Claude API (should not happen) | `{fields, was_anonymized}` |
| `learner_model_accessed` | AI doc learner_model | `{purpose, fields_read}` |
| `admin_override` | Admin thay doi quyet dinh AI | `{decision_id, reason}` |

**Retention:** Audit log giu **toi thieu 7 nam** theo yeu cau luu tru cua Nghi dinh 13/2023/ND-CP.

---

## 2.6 Architecture Decision Records (ADR)

### 2.6.1 ADR-001: Docker Compose -> k3s Migration Path

**Status:** Accepted

**Decision:** Phase 1 (dev/staging): Docker Compose voi 10 containers tren single host. Phase 2 (production): Migrate sang k3s (lightweight Kubernetes) khi can horizontal scaling.

**Reason:**

- Docker Compose don gian, zero learning curve, phu hop team nho trong giai doan dau
- k3s la Kubernetes nhe (<70MB), chay tren VPS thong thuong, khong can managed K8s
- Stateless services (lms-api, auth, agent...) de scale horizontal thong qua Pod replicas
- Stateful services (postgres, redis, minio) can persistent volumes va StatefulSet

| Uu diem | Nhuoc diem |
|---------|-----------|
| Compose de onboard developer moi | Khong co auto-healing trong Compose |
| k3s cho phep rolling deploy, zero-downtime | Complexity tang khi migrate |
| Shared infra tot khi resource con nho | Service discovery khac nhau (DNS vs k3s Service) |

### 2.6.2 ADR-002: PostgreSQL la Primary Database

**Status:** Accepted

**Decision:** Tat ca 10 services dung chung 1 PostgreSQL 15 database `adaptlearn`.

**Reason:**

- ACID transactions can thiet cho diem so, enrollment, exam submission
- JSONB support cho payload linh hoat (quiz_data, learner_model state)
- Row-level security (RLS) cho multi-tenant isolation
- Mature tooling: pg_dump, pgBouncer, pgBackRest

| Uu diem | Nhuoc diem |
|---------|-----------|
| Single source of truth | Single point of failure neu khong co replica |
| JOIN cross-service queries trong monorepo | Services khong hoan toan independent ve data |
| It operational overhead hon 10 databases rieng | Connection pool can cau hinh can than (pgBouncer) |

### 2.6.3 ADR-003: Redis Streams thay vi Kafka cho Event Bus

**Status:** Accepted

**Decision:** Dung Redis Streams (`events:main`) lam Event Bus thay vi Apache Kafka hoac RabbitMQ.

**Reason:**

- Redis da dung cho cache, giam infrastructure dependency
- Redis Streams co built-in consumer groups, message acknowledgment, DLQ pattern
- Kafka overkill cho 18 event types, <1000 events/phut trong giai doan dau
- Redis Streams persistence du (AOF + RDB) cho educational workload

| Uu diem | Nhuoc diem |
|---------|-----------|
| Don gian hon Kafka (khong can ZooKeeper/KRaft) | Throughput thap hon Kafka (single node) |
| Tai su dung Redis instance da co | Retention khong flexible bang Kafka topics |
| Consumer groups built-in, tuong tu Kafka API | Kho hon khi can cross-datacenter replication |
| `XGROUP CREATE ... MKSTREAM` tao stream lazy | Can cau hinh maxmemory can than |

### 2.6.4 ADR-004: Python 3.12 + FastAPI cho AI/ML Services

**Status:** Accepted

**Decision:** agent-service, aura-service, grader-service dung Python 3.12 + FastAPI thay vi Node.js.

**Reason:**

- Anthropic Python SDK (claude-sdk) la first-class, tot hon TypeScript SDK cho streaming
- NumPy/SciPy cho BKT (Bayesian Knowledge Tracing) calculations
- Pyodide WASM cho code sandbox chi co Python ecosystem
- FastAPI cho async I/O tot, Pydantic schema validation, auto OpenAPI docs

| Uu diem | Nhuoc diem |
|---------|-----------|
| Best-in-class ML libraries (sklearn, scipy) | Hai runtime trong cung mot project |
| Anthropic SDK Python on dinh hon | Developer can biet ca Python lan TypeScript |
| Pyodide cho secure sandboxing | Docker image Python lon hon Node |
| Type safety voi Pydantic | Can Bridge pattern khi Node goi Python services |

### 2.6.5 ADR-005: Pyodide WASM cho Code Sandbox

**Status:** Accepted

**Decision:** grader-service dung Pyodide (Python trong WebAssembly) thay vi Docker-in-Docker hoac nsjail de sandbox code hoc sinh.

**Reason:**

- Docker-in-Docker phuc tap, security risk cao, khong phu hop multi-tenant
- nsjail can Linux-specific syscalls, kho port
- Pyodide chay trong isolated WASM context, khong co filesystem/network access
- Gioi han RAM va timeout de enforce: `sandbox_max_ram_mb=256`, `sandbox_timeout_s=10`

| Uu diem | Nhuoc diem |
|---------|-----------|
| Strong isolation (WASM security model) | Chi support Python, khong support Java/C++ |
| Khong can kernel-level privileges | Cold start cham hon native subprocess (~2s) |
| Portable across OS | Khong the install arbitrary packages |
| De resource-limit | Pyodide bundle lon (~30MB) |

### 2.6.6 ADR-006: MinIO S3-Compatible Object Storage (Self-hosted)

**Status:** Accepted

**Decision:** Dung MinIO self-hosted thay vi AWS S3 hoac Google Cloud Storage cho luu tru HTML/PDF/Video.

**Reason:**

- S3-compatible API, co the migrate sang AWS S3 bat ky luc nao bang cach doi endpoint
- Data sovereignty: tai lieu hoc sinh khong ra khoi server truong
- Khong co egress cost (bandwidth tu S3 dat)
- MinIO ho tro bucket policies, presigned URLs, lifecycle rules

| Uu diem | Nhuoc diem |
|---------|-----------|
| Zero cloud cost | Tu quan ly: backup, replication, disk capacity |
| Data sovereignty compliance | Khong co CDN built-in (can them Cloudflare/nginx cache) |
| S3 API compatible, easy migration | Can monitoring disk usage |
| Presigned URL cho upload/download | Single point neu khong setup distributed mode |

### 2.6.7 ADR-007: JWT RS256 Asymmetric Keys

**Status:** Accepted

**Decision:** auth-service ky JWT bang RS256 (RSA private key). Tat ca services verify bang public key — khong can goi auth-service.

**Reason:**

- HMAC HS256 dung shared secret, tat ca services phai biet secret, security risk
- RS256: chi auth-service biet private key; cac service khac chi can public key de verify
- Public key co the distribute qua environment variable hoac JWKS endpoint
- Industry standard cho microservices (Auth0, Keycloak deu dung RS256)

| Uu diem | Nhuoc diem |
|---------|-----------|
| Zero-trust: service verify local, khong can DB lookup | Key rotation phuc tap hon HS256 |
| Private key chi nam trong auth-service | RSA operations cham hon HMAC (~3x) |
| Public key co the public ma khong mat security | Public key phai rotate khi private key bi leak |
| Stateless verification, horizontal scale de | Can giu private key trong secrets manager |

### 2.6.8 [BO SUNG] ADR-008: Kubernetes Migration (Phase 2)

**Status:** Proposed (P2)

**Decision:** Migrate tu Docker Compose sang k3s (lightweight Kubernetes) khi he thong vuot 500 concurrent users hoac can zero-downtime deploy.

**Trigger dieu kien:**

- Concurrent users > 500
- Can rolling update khong downtime
- Can auto-scaling theo load (HPA)
- Can multi-node cho HA

**Ke hoach migration:**

| Buoc | Hanh dong | Thoi gian |
|------|----------|-----------|
| 1 | Install k3s tren staging server | 1 ngay |
| 2 | Chuyen doi docker-compose.yml sang Kubernetes manifests (Deployment, Service, ConfigMap) | 3 ngay |
| 3 | Setup Persistent Volumes cho PostgreSQL, Redis, MinIO (StatefulSet) | 2 ngay |
| 4 | Cau hinh Ingress (thay the Nginx) voi Traefik (k3s default) | 1 ngay |
| 5 | Setup HPA cho stateless services (lms-api, auth, agent) | 1 ngay |
| 6 | Testing + load test tren staging | 3 ngay |
| 7 | Production cutover (blue-green hoac canary) | 1 ngay |

**Kubernetes resource targets:**

```yaml
# lms-api Deployment (example)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: lms-api
spec:
  replicas: 2
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  template:
    spec:
      containers:
      - name: lms-api
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "512Mi"
            cpu: "500m"
```

| Uu diem | Nhuoc diem |
|---------|-----------|
| Auto-healing (restart failed pods) | Learning curve cho team |
| HPA cho auto-scaling | Overhead quan ly (kubectl, manifests) |
| Rolling deploy zero-downtime | k3s single-node van la SPOF |
| Service discovery built-in (CoreDNS) | Monitoring phuc tap hon (Prometheus Operator) |

### 2.6.9 [BO SUNG] ADR-009: Redis Streams -> Kafka (Phase 2+)

**Status:** Proposed (P2+)

**Decision:** Xem xet chuyen tu Redis Streams sang Apache Kafka khi event throughput vuot 10,000 events/phut hoac can event replay/reprocessing dai han.

**Trigger dieu kien:**

- Event throughput > 10,000/phut (Redis Streams bat dau bottleneck tren single node)
- Can event replay tu arbitrary offset (Kafka consumer offset management)
- Can event retention > 7 ngay (Kafka topic retention)
- Can cross-datacenter replication (Kafka MirrorMaker)

**So sanh:**

| Tieu chi | Redis Streams (hien tai) | Apache Kafka (de xuat) |
|----------|------------------------|----------------------|
| Throughput | ~5,000 events/s (single node) | ~100,000 events/s (3-node cluster) |
| Retention | Bounded (maxmemory) | Unbounded (disk-based) |
| Consumer groups | Yes (built-in) | Yes (built-in, more robust) |
| Replay | Limited (XRANGE) | Full replay tu offset bat ky |
| Ops complexity | Thap (da co Redis) | Cao (ZooKeeper/KRaft, cluster management) |
| RAM requirement | 512MB shared voi cache | 1-2GB dedicated per broker |
| Message ordering | Per-stream guaranteed | Per-partition guaranteed |
| Data durability | AOF + RDB (co the mat data) | Replicated log (stronger guarantee) |

**Ke hoach migration (neu thuc hien):**

1. Setup Kafka cluster (3 brokers, KRaft mode — khong can ZooKeeper)
2. Tao topic `adaptlearn.events` voi 5 partitions (mapping 5 consumer groups)
3. Implement dual-write: producer ghi ca Redis Streams va Kafka trong 2 tuan
4. Chuyen consumer groups sang Kafka consumer lun luot
5. Tat Redis Streams event bus, giu Redis cho cache only
6. Cap nhat monitoring (Kafka metrics -> Prometheus)

| Uu diem | Nhuoc diem |
|---------|-----------|
| Throughput vuot troi | Them 1 infra component |
| Event replay manh me | Team can hoc Kafka |
| Retention linh hoat | RAM + disk requirement tang |
| Enterprise-proven tai scale | Overkill neu <1000 users |

---

## Quick Reference

```
Event Bus:  redis://redis:6379  ->  XADD events:main
DLQ:        redis://redis:6379  ->  events:dlq
Auth:       http://auth-service:3001/health
LMS API:    http://lms-api:3000/health
Agent:      http://agent-service:8000/health
MinIO:      http://minio:9000/minio/health/live
MinIO Console: http://minio:9001

Consumer groups (XGROUP CREATE events:main <group> $ MKSTREAM):
  agent-processors  aura-processors  exam-processors  gamification-proc  analytics-proc

JWT:  RS256 | private key: auth-service only | public key: all services
DB:   postgresql://adaptlearn:***@postgres:5432/adaptlearn

Docker: docker compose -f docker-compose.ch2a.yml up -d
```

---

*Phien ban: 2.1 Consolidated | Ngay: 2026-04-08 | Tac gia: SRS Team + AI Assistant*
*Thay the: Ch2 v1.0, Ch2 v2.0, Ch2A, Ch2B, Ch2C, Ch2D*

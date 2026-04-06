# AURA — KẾ HOẠCH TRIỂN KHAI CHI TIẾT
> Cập nhật: 2026-04-06 | Version: 1.0 | Trạng thái: DRAFT → ACTIVE

---

## Tổng quan & Trạng thái hiện tại

### Kiến trúc hiện tại (đã triển khai)

| Layer | Công nghệ | Files |
|-------|-----------|-------|
| Frontend Student | HTML/JS SPA | `index.html`, `index.js`, `page.html`, `course.html` |
| Frontend Admin | HTML/JS SPA | `admin/dashboard.html`, `admin/dashboard.js` |
| Backend | Cloudflare Worker (ES Modules) | `worker/index.js` → `worker/src/handlers/*.js` |
| DB chính | NocoDB REST API | Tables: Courses, Modules, Articles, Users, Enrollments, Quizzes, QuestionBanks, Assessments, Submissions, Announcements |
| DB phụ (analytics) | Cloudflare D1 SQLite | Tables: `student_mastery`, `action_logs`, `ai_sessions`, `interventions`, `spaced_repetition`, `agent_traces`, `xapi_statements`, `module_progressions` |
| AI (client) | Vanilla JS floating tutor | `ai-agent.js` (localStorage-based) |
| AI (admin) | Research Lab | `admin/ai-research.html` |
| Auth | NocoDB Users + JWT | `worker/src/handlers/authHandler.js` |

### Trạng thái Migration D1 hiện tại

```
worker/migrations/
  0001_phase2_analytics.sql   ← student_mastery, action_logs, ai_sessions, interventions, spaced_repetition, agent_traces
  0002_phase2_gradebook.sql   ← assignment_groups, weighted_grades
  0003_phase2_xapi_extended.sql ← xapi_statements, notification_queue, achievements, study_streaks
```

### Gap Analysis — SRS vs Hiện tại

| SRS Component | Trạng thái | Gap cần làm |
|--------------|-----------|------------|
| 784 YCCĐ Toán (hoclieu_toan.json) | MISSING | Import vào D1 `lessons` table |
| Learner Model (mastery_map, bloom_profile, error_patterns...) | PARTIAL | `student_mastery` có BKT nhưng thiếu bloom_profile, speed_profile, consecutive_pass/fail |
| Curriculum Planner 9 luật R01-R09 | MISSING | Cần viết mới hoàn toàn |
| Event Pipeline (9 event types) | PARTIAL | `action_logs` + `xapi_statements` có, thiếu schema chuẩn và routing |
| 5-stage Lesson Structure | MISSING | Chưa có UI builder và renderer |
| Agent Decisions Log | MISSING | Cần `agent_decisions` table + UI |
| Python Grader via LTI | MISSING | Cần bridge endpoint |
| API Contract /agent/* | MISSING | 7 routes chưa implement |
| Adaptive Next Lesson | MISSING | Logic chọn next_if_pass/next_if_fail chưa có |

---

## PHASE 1: Nền tảng dữ liệu (Tháng 1–3)

> **Mục tiêu:** Mọi data pipeline cần cho AI Agent phải sẵn sàng trước khi viết bất kỳ rule nào.
> **P0** = Làm ngay hôm nay. **P1** = Tuần 1. **P2** = Tháng 1.

---

### 1.1 Import 784 YCCĐ Toán vào hệ thống [P0]

**Nguồn dữ liệu:** `content/hoclieu_toan.json` (nếu chưa có: tạo từ SRS spec)

**Schema lesson_id:** `"020108.0202d3"` — format: `MMSSCCXX.YYYYz`
- `MM` = môn (02=Toán)
- `SS` = khối (01=10, 02=11, 03=12)
- `CC` = chương
- `XX` = bài
- `YYYY` = YCCĐ index
- `z` = variant (a/b/c/d)

**D1 Migration file:** `worker/migrations/0004_aura_lessons.sql`

```sql
-- ============================================================
-- AURA Phase 3 — Lessons (YCCĐ) + Agent Core Tables
-- Run: npx wrangler d1 execute aura-analytics --file=migrations/0004_aura_lessons.sql
-- ============================================================

-- ── LESSONS TABLE (ánh xạ từ hoclieu_toan.json) ─────────────────────────────
CREATE TABLE IF NOT EXISTS lessons (
  id               INTEGER  PRIMARY KEY AUTOINCREMENT,
  lesson_id        TEXT     NOT NULL UNIQUE,   -- "020108.0202d3"
  subject          TEXT     NOT NULL DEFAULT 'toan',  -- toan | ly | hoa | ...
  grade_num        INTEGER  NOT NULL,          -- 10, 11, 12
  chapter          TEXT,                        -- e.g. "Chương 1: Hàm số"
  title            TEXT     NOT NULL,
  bloom_level      INTEGER  NOT NULL CHECK(bloom_level BETWEEN 1 AND 6),
  -- Bloom: 1=Nhận biết, 2=Thông hiểu, 3=Vận dụng, 4=Vận dụng cao, 5=Phân tích, 6=Sáng tạo
  lesson_model     TEXT     NOT NULL CHECK(lesson_model IN (
                     'scaffold','practice','case','teach','explore','repair','project','reflect'
                   )),
  level_default    TEXT     NOT NULL DEFAULT 'nen_tang' CHECK(level_default IN (
                     'nen_tang','mo_rong','chuyen_sau'
                   )),
  duration_avg     INTEGER  NOT NULL DEFAULT 45,  -- phút
  media_url        TEXT,
  quiz_ids         TEXT,    -- JSON array: ["quiz_001","quiz_002"]
  next_if_pass     TEXT,    -- lesson_id của bài tiếp theo khi đạt
  next_if_fail     TEXT,    -- lesson_id của bài sửa chữa khi không đạt
  prerequisites    TEXT,    -- JSON array of lesson_ids
  outcome_codes    TEXT,    -- JSON array: ["MA.10.1.2.a"]
  tags             TEXT,    -- JSON array for search/filter
  status           TEXT     NOT NULL DEFAULT 'active' CHECK(status IN ('active','draft','archived')),
  noco_article_id  INTEGER, -- liên kết với NocoDB Articles table (lesson content)
  stage_config     TEXT,    -- JSON: 5-stage config {activate, construct, act, reflect, summarize}
  created_at       TEXT     NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT     NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_lessons_subject_grade ON lessons(subject, grade_num);
CREATE INDEX IF NOT EXISTS idx_lessons_bloom         ON lessons(bloom_level);
CREATE INDEX IF NOT EXISTS idx_lessons_model         ON lessons(lesson_model);
CREATE INDEX IF NOT EXISTS idx_lessons_level         ON lessons(level_default);
CREATE INDEX IF NOT EXISTS idx_lessons_status        ON lessons(status);
CREATE INDEX IF NOT EXISTS idx_lessons_chapter       ON lessons(chapter);
```

**Import Script:** `worker/scripts/import_lessons.js`

```javascript
// worker/scripts/import_lessons.js
// Chạy: node import_lessons.js (cần CLOUDFLARE_API_TOKEN + ACCOUNT_ID + DB_ID trong .env)

import { readFileSync } from 'fs';

const raw = JSON.parse(readFileSync('../../content/hoclieu_toan.json', 'utf-8'));

// Normalize từng lesson từ hoclieu_toan.json format → D1 schema
function normalizeLesson(item) {
  return {
    lesson_id:    item.lesson_id,
    subject:      item.subject || 'toan',
    grade_num:    item.grade_num,
    chapter:      item.chapter || null,
    title:        item.title,
    bloom_level:  item.bloom_level,
    lesson_model: item.lesson_model,
    level_default: item.level_default || 'nen_tang',
    duration_avg: item.duration_avg || 45,
    media_url:    item.media_url || null,
    quiz_ids:     JSON.stringify(item.quiz_ids || []),
    next_if_pass: item.next_if_pass || null,
    next_if_fail: item.next_if_fail || null,
    prerequisites: JSON.stringify(item.prerequisites || []),
    outcome_codes: JSON.stringify(item.outcome_codes || []),
    tags:         JSON.stringify(item.tags || []),
    status:       item.status || 'active',
  };
}

// Batch insert 50 lessons/batch để tránh D1 statement size limit
const BATCH = 50;
const lessons = raw.lessons.map(normalizeLesson);
console.log(`Tổng: ${lessons.length} lessons cần import`);

for (let i = 0; i < lessons.length; i += BATCH) {
  const batch = lessons.slice(i, i + BATCH);
  const placeholders = batch.map(() =>
    '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).join(',');
  const values = batch.flatMap(l => [
    l.lesson_id, l.subject, l.grade_num, l.chapter, l.title,
    l.bloom_level, l.lesson_model, l.level_default, l.duration_avg,
    l.media_url, l.quiz_ids, l.next_if_pass, l.next_if_fail,
    l.prerequisites, l.outcome_codes, l.tags, l.status, 'active'
  ]);
  // TODO: call D1 REST API or wrangler d1 execute
  console.log(`Batch ${Math.floor(i/BATCH)+1}: ${batch.length} rows`);
}
```

**Verify sau import:**
```sql
SELECT grade_num, COUNT(*) as count,
       AVG(bloom_level) as avg_bloom,
       COUNT(DISTINCT lesson_model) as model_types
FROM lessons
GROUP BY grade_num
ORDER BY grade_num;

-- Expected: ~261 rows per grade (10/11/12), 8 model types
```

---

### 1.2 D1 Schema nâng cấp — Learner Model & Event Log [P0]

**File:** `worker/migrations/0005_aura_learner_agent.sql`

```sql
-- ============================================================
-- AURA Phase 3 — Learner Model + Events + Agent Core
-- ============================================================

-- ── LEARNER MODELS TABLE ────────────────────────────────────────────────────
-- Mỗi student có 1 row per subject (toan/ly/hoa/...)
-- Cập nhật sau mỗi event quan trọng (quiz_submitted, lesson_completed)
CREATE TABLE IF NOT EXISTS learner_models (
  id                  INTEGER  PRIMARY KEY AUTOINCREMENT,
  student_id          INTEGER  NOT NULL,
  subject             TEXT     NOT NULL DEFAULT 'toan',

  -- Mastery Map: JSON map lesson_id → mastery_score (0.0-1.0)
  mastery_map         TEXT     NOT NULL DEFAULT '{}',

  -- Bloom Profile: JSON {1:0.8, 2:0.7, 3:0.5, 4:0.3, 5:0.2, 6:0.1}
  -- Điểm trung bình mastery tại mỗi bloom level
  bloom_profile       TEXT     NOT NULL DEFAULT '{"1":0,"2":0,"3":0,"4":0,"5":0,"6":0}',

  -- Error Patterns: JSON array của error codes thường gặp
  -- e.g. ["sign_error","computation","concept_gap_limit"]
  error_patterns      TEXT     NOT NULL DEFAULT '[]',

  -- Speed Profile: JSON {avg_time_per_bloom: {1:120,2:180,...}, percentile: 65}
  speed_profile       TEXT     NOT NULL DEFAULT '{}',

  -- Current Level trong hệ thống 3-tier
  current_level       TEXT     NOT NULL DEFAULT 'nen_tang' CHECK(current_level IN (
                        'nen_tang','mo_rong','chuyen_sau'
                      )),

  -- Engagement: JSON {streak_days, sessions_this_week, avg_session_min, last_active}
  engagement          TEXT     NOT NULL DEFAULT '{}',

  -- Preferred Model: lesson_model nào học tốt nhất
  preferred_model     TEXT     CHECK(preferred_model IN (
                        'scaffold','practice','case','teach','explore','repair','project','reflect',NULL
                      )),

  -- Consecutive pass/fail tracking (cho R01, R03)
  consecutive_pass    INTEGER  NOT NULL DEFAULT 0,
  consecutive_fail    INTEGER  NOT NULL DEFAULT 0,

  -- Current lesson đang học
  current_lesson_id   TEXT,  -- FK → lessons.lesson_id

  -- Bloom gap tracking (cho R05)
  -- JSON: {gap_lesson_id: "...", gap_detected_at: "2026-01-01", gap_bloom_level: 2}
  bloom_gap           TEXT,

  -- Dormant tracking (cho R04)
  last_activity_at    TEXT,
  dormant_days        INTEGER  NOT NULL DEFAULT 0,

  -- Grade being studied
  grade_num           INTEGER  NOT NULL DEFAULT 10,

  -- Peer expert flag (cho R07)
  is_peer_expert      INTEGER  NOT NULL DEFAULT 0,  -- 1 nếu mastery >= 0.9 ở chapter hiện tại

  -- Model variety tracking (cho R09): JSON array of last 5 lesson_models used
  recent_models       TEXT     NOT NULL DEFAULT '[]',

  created_at          TEXT     NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT     NOT NULL DEFAULT (datetime('now')),

  UNIQUE(student_id, subject)
);

CREATE INDEX IF NOT EXISTS idx_lm_student   ON learner_models(student_id);
CREATE INDEX IF NOT EXISTS idx_lm_subject   ON learner_models(subject);
CREATE INDEX IF NOT EXISTS idx_lm_level     ON learner_models(current_level);
CREATE INDEX IF NOT EXISTS idx_lm_dormant   ON learner_models(dormant_days DESC);

-- ── EVENTS TABLE (thay thế learner_events + action_logs cho AURA pipeline) ──
-- Giữ nguyên action_logs để backward compatible. Đây là bảng mới cho AI pipeline.
CREATE TABLE IF NOT EXISTS events (
  id            INTEGER  PRIMARY KEY AUTOINCREMENT,
  event_id      TEXT     NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(8)))),
  student_id    INTEGER  NOT NULL,
  lesson_id     TEXT,    -- FK → lessons.lesson_id
  course_id     INTEGER,
  session_id    TEXT,    -- group events trong cùng 1 phiên học

  -- Event type (9 loại từ SRS)
  event_type    TEXT     NOT NULL CHECK(event_type IN (
                  'quiz_submitted',
                  'assignment_submitted',
                  'video_progress',
                  'session_started',
                  'session_ended',
                  'discussion_posted',
                  'peer_review_given',
                  'lesson_completed',
                  'teacher_override'
                )),

  -- Payload JSON — schema khác nhau theo event_type (xem dưới)
  payload       TEXT     NOT NULL DEFAULT '{}',

  -- Derived metrics (tính ngay khi insert để tránh recompute)
  score         REAL,    -- 0.0-1.0 normalized (quiz_submitted, assignment_submitted)
  passed        INTEGER, -- 1/0 (dựa vào passing_threshold của lesson)
  time_spent_s  INTEGER, -- giây (session_ended, video_progress)
  bloom_level   INTEGER, -- bloom level của lesson tại thời điểm event

  -- Processing status
  processed     INTEGER  NOT NULL DEFAULT 0,  -- 0=pending, 1=processed by agent
  processed_at  TEXT,

  created_at    TEXT     NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_student    ON events(student_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_lesson     ON events(lesson_id);
CREATE INDEX IF NOT EXISTS idx_events_type       ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_session    ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_processed  ON events(processed, created_at);
CREATE INDEX IF NOT EXISTS idx_events_course     ON events(course_id, created_at DESC);

-- Partition-like: index by date prefix for time-range queries
CREATE INDEX IF NOT EXISTS idx_events_date ON events(substr(created_at,1,10));

-- ── AGENT DECISIONS TABLE ───────────────────────────────────────────────────
-- Ghi lại mọi quyết định của Curriculum Planner để debug + audit + ML training
CREATE TABLE IF NOT EXISTS agent_decisions (
  id            INTEGER  PRIMARY KEY AUTOINCREMENT,
  decision_id   TEXT     NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(8)))),
  student_id    INTEGER  NOT NULL,

  -- Trigger event
  trigger_event_id TEXT,  -- FK → events.event_id
  trigger_type  TEXT     NOT NULL,  -- which rule fired (R01-R09 or 'manual')

  -- Input state (snapshot của learner model tại thời điểm quyết định)
  input_state   TEXT     NOT NULL DEFAULT '{}',  -- JSON snapshot

  -- Rules evaluated
  rules_evaluated TEXT   NOT NULL DEFAULT '[]',  -- JSON: [{rule: "R01", fired: true, reason: "..."}, ...]

  -- Decision output
  action_type   TEXT     NOT NULL CHECK(action_type IN (
                  'next_lesson',      -- tiến đến bài tiếp theo
                  'repair_lesson',    -- quay lại sửa chữa
                  'level_upgrade',    -- nâng level (nen_tang → mo_rong)
                  'level_downgrade',  -- hạ level
                  'dormant_reentry',  -- reactivation sau nghỉ dài
                  'bloom_bridge',     -- học bài lấp bloom gap
                  'peer_connect',     -- kết nối với peer expert
                  'model_switch',     -- đổi lesson model
                  'teacher_alert',    -- cảnh báo giáo viên
                  'no_action'         -- không làm gì (stable state)
                )),
  target_lesson_id TEXT,  -- lesson_id được giao tiếp theo
  rationale        TEXT,  -- giải thích bằng tiếng Việt cho học sinh

  -- Outcome tracking (fill sau khi học sinh thực hiện)
  outcome_score    REAL,
  outcome_passed   INTEGER,
  outcome_recorded_at TEXT,

  -- Confidence (Phase 2: rule-based = 1.0; Phase 4: ML = 0.0-1.0)
  confidence    REAL     NOT NULL DEFAULT 1.0,

  created_at    TEXT     NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_decisions_student  ON agent_decisions(student_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_decisions_action   ON agent_decisions(action_type);
CREATE INDEX IF NOT EXISTS idx_decisions_rule     ON agent_decisions(trigger_type);
CREATE INDEX IF NOT EXISTS idx_decisions_outcome  ON agent_decisions(outcome_passed) WHERE outcome_passed IS NOT NULL;

-- ── CURRICULUM RULES TABLE (configurable, không hardcode) ──────────────────
-- Admin có thể điều chỉnh threshold mà không cần deploy lại worker
CREATE TABLE IF NOT EXISTS curriculum_rules (
  id            INTEGER  PRIMARY KEY AUTOINCREMENT,
  rule_id       TEXT     NOT NULL UNIQUE,  -- "R01", "R02", ..., "R09"
  name          TEXT     NOT NULL,
  description   TEXT     NOT NULL,
  enabled       INTEGER  NOT NULL DEFAULT 1,
  priority      INTEGER  NOT NULL DEFAULT 5,  -- 1=cao nhất, 9=thấp nhất
  -- Config JSON — các threshold cụ thể của rule
  config        TEXT     NOT NULL DEFAULT '{}',
  updated_at    TEXT     NOT NULL DEFAULT (datetime('now')),
  updated_by    INTEGER  -- admin user_id
);

-- Seed 9 rules với default config
INSERT OR IGNORE INTO curriculum_rules (rule_id, name, description, priority, config) VALUES
  ('R01', 'Repair Trigger',
   'Kích hoạt bài sửa chữa khi học sinh liên tục thất bại',
   1,
   '{"consecutive_fail_threshold": 2, "repair_model": "repair", "check_window_hours": 48}'),

  ('R02', 'Level Downgrade',
   'Hạ level khi không theo kịp chương trình ở level cao',
   2,
   '{"mastery_threshold_downgrade": 0.4, "min_attempts": 3, "cooldown_days": 7}'),

  ('R03', 'Level Upgrade',
   'Nâng level khi học sinh vượt trội ở level hiện tại',
   3,
   '{"consecutive_pass_threshold": 3, "mastery_threshold_upgrade": 0.8, "min_lessons_at_level": 5}'),

  ('R04', 'Dormant Re-entry',
   'Ôn tập nhẹ sau khi học sinh nghỉ dài ngày',
   4,
   '{"dormant_days_threshold": 7, "review_lessons_count": 3, "use_model": "scaffold"}'),

  ('R05', 'Bloom Gap Bridge',
   'Xác định và lấp lỗ hổng kiến thức theo Bloom taxonomy',
   5,
   '{"gap_bloom_threshold": 0.5, "bridge_model": "teach", "check_bloom_levels": [1,2,3]}'),

  ('R06', 'Timing Optimization',
   'Điều chỉnh thời lượng bài học dựa trên speed profile',
   6,
   '{"slow_percentile_threshold": 25, "fast_percentile_threshold": 75, "max_duration_multiplier": 1.5}'),

  ('R07', 'Peer Expert Connection',
   'Kết nối học sinh giỏi với học sinh cần hỗ trợ',
   7,
   '{"expert_mastery_threshold": 0.9, "struggling_mastery_threshold": 0.4, "chapters_to_check": 1}'),

  ('R08', 'Preferred Model Routing',
   'Ưu tiên lesson model mà học sinh học tốt nhất',
   8,
   '{"min_model_history": 10, "preference_score_threshold": 0.7, "apply_after_days": 14}'),

  ('R09', 'Variety Enforcement',
   'Tránh dùng cùng 1 lesson model quá nhiều lần liên tiếp',
   9,
   '{"max_consecutive_same_model": 3, "variety_pool_size": 3}');

-- ── LESSON SESSIONS TABLE (track phiên học 5-stage) ────────────────────────
CREATE TABLE IF NOT EXISTS lesson_sessions (
  id            INTEGER  PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT     NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(8)))),
  student_id    INTEGER  NOT NULL,
  lesson_id     TEXT     NOT NULL,  -- FK → lessons.lesson_id
  started_at    TEXT     NOT NULL DEFAULT (datetime('now')),
  ended_at      TEXT,
  -- Stage progress: JSON {activate: done, construct: done, act: in_progress, reflect: pending, summarize: pending}
  stage_progress TEXT    NOT NULL DEFAULT '{"activate":"pending","construct":"pending","act":"pending","reflect":"pending","summarize":"pending"}',
  current_stage TEXT     NOT NULL DEFAULT 'activate' CHECK(current_stage IN (
                  'activate','construct','act','reflect','summarize'
                )),
  -- Final outcome
  quiz_score    REAL,
  passed        INTEGER,
  time_spent_s  INTEGER,
  status        TEXT     NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','abandoned'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_student ON lesson_sessions(student_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_lesson  ON lesson_sessions(lesson_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status  ON lesson_sessions(status);
```

---

### 1.3 Worker: Learner Model Service [P0]

**File mới:** `worker/src/handlers/learnerModelHandler.js`

**Routes (thêm vào `worker/index.js`):**

```javascript
// worker/index.js — thêm vào routing block
import {
  handleGetLearnerModel,
  handleUpdateLearnerModel,
  handleInitLearnerModel,
} from './src/handlers/learnerModelHandler.js';

// Routes
if (path.startsWith('/agent/learner/') && method === 'GET')
  return handleGetLearnerModel(request, env, { json, path });
if (path.startsWith('/agent/learner/') && path.endsWith('/model') && method === 'PUT')
  return handleUpdateLearnerModel(request, env, { json, path });
if (path === '/agent/learner/init' && method === 'POST')
  return handleInitLearnerModel(request, env, { json });
```

**Handler implementation:**

```javascript
// worker/src/handlers/learnerModelHandler.js

import { getTokenSecret, verifyToken } from '../auth.js';

/**
 * GET /agent/learner/:id/model
 * Trả về toàn bộ learner model của student (hoặc của chính mình)
 */
export async function handleGetLearnerModel(request, env, { json, path }) {
  const auth = request.headers.get('Authorization') || '';
  const session = await verifyToken(auth.replace('Bearer ',''), getTokenSecret(env));
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const studentId = parseInt(path.split('/')[3]);
  // Students chỉ xem được của mình; teacher/admin xem được của người khác
  if (session.role === 'student' && session.userId !== studentId)
    return json({ error: 'Forbidden' }, 403);

  const subject = new URL(request.url).searchParams.get('subject') || 'toan';

  const row = await env.D1.prepare(
    `SELECT * FROM learner_models WHERE student_id = ? AND subject = ?`
  ).bind(studentId, subject).first();

  if (!row) {
    // Auto-init nếu chưa có
    return json(await initLearnerModelInternal(env, studentId, subject));
  }

  // Parse JSON fields
  return json({
    ...row,
    mastery_map:    JSON.parse(row.mastery_map || '{}'),
    bloom_profile:  JSON.parse(row.bloom_profile || '{}'),
    error_patterns: JSON.parse(row.error_patterns || '[]'),
    speed_profile:  JSON.parse(row.speed_profile || '{}'),
    engagement:     JSON.parse(row.engagement || '{}'),
    recent_models:  JSON.parse(row.recent_models || '[]'),
    bloom_gap:      row.bloom_gap ? JSON.parse(row.bloom_gap) : null,
  });
}

/**
 * POST /agent/learner/init
 * Khởi tạo learner model lần đầu cho student
 */
export async function handleInitLearnerModel(request, env, { json }) {
  const auth = request.headers.get('Authorization') || '';
  const session = await verifyToken(auth.replace('Bearer ',''), getTokenSecret(env));
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const { student_id, subject = 'toan', grade_num = 10 } = await request.json();
  const targetId = student_id || session.userId;

  const model = await initLearnerModelInternal(env, targetId, subject, grade_num);
  return json(model, 201);
}

/**
 * Internal: tạo hoặc trả về learner model
 */
export async function initLearnerModelInternal(env, studentId, subject = 'toan', gradeNum = 10) {
  const existing = await env.D1.prepare(
    `SELECT id FROM learner_models WHERE student_id = ? AND subject = ?`
  ).bind(studentId, subject).first();

  if (existing) return existing;

  await env.D1.prepare(`
    INSERT INTO learner_models (student_id, subject, grade_num)
    VALUES (?, ?, ?)
  `).bind(studentId, subject, gradeNum).run();

  return await env.D1.prepare(
    `SELECT * FROM learner_models WHERE student_id = ? AND subject = ?`
  ).bind(studentId, subject).first();
}

/**
 * PUT /agent/learner/:id/model
 * Cập nhật learner model sau khi xử lý event
 * Chỉ Worker nội bộ gọi (hoặc admin)
 */
export async function handleUpdateLearnerModel(request, env, { json, path }) {
  const auth = request.headers.get('Authorization') || '';
  const session = await verifyToken(auth.replace('Bearer ',''), getTokenSecret(env));
  if (!session || !['admin','teacher'].includes(session.role))
    return json({ error: 'Forbidden' }, 403);

  const studentId = parseInt(path.split('/')[3]);
  const updates = await request.json();

  // Serialize JSON fields
  const fields = {};
  for (const [k, v] of Object.entries(updates)) {
    if (typeof v === 'object') fields[k] = JSON.stringify(v);
    else fields[k] = v;
  }
  fields['updated_at'] = new Date().toISOString();

  const setClauses = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  const values = [...Object.values(fields), studentId, updates.subject || 'toan'];

  await env.D1.prepare(
    `UPDATE learner_models SET ${setClauses} WHERE student_id = ? AND subject = ?`
  ).bind(...values).run();

  return json({ ok: true });
}
```

---

### 1.4 Worker: Event Processing Pipeline [P0]

**File mới:** `worker/src/handlers/eventHandler.js`

**Routes:**

```javascript
// worker/index.js additions
import { handlePostEvent, handleGetEvents } from './src/handlers/eventHandler.js';

if (path === '/agent/events' && method === 'POST')
  return handlePostEvent(request, env, { json });
if (path === '/agent/events' && method === 'GET')
  return handleGetEvents(request, env, { json });
```

**Event payload schemas (tài liệu hóa trong code):**

```javascript
// worker/src/handlers/eventHandler.js

/**
 * Event Payload Schemas:
 *
 * quiz_submitted:
 *   { quiz_id, score (0-1), answers: [{q_id, correct}], time_spent_s }
 *
 * assignment_submitted:
 *   { assignment_id, score (0-1), rubric_scores: {criterion: score}, time_spent_s }
 *
 * video_progress:
 *   { video_id, percent_watched (0-100), paused_at_s, completed: bool }
 *
 * session_started:
 *   { device, browser, locale }
 *
 * session_ended:
 *   { duration_s, pages_visited: [] }
 *
 * discussion_posted:
 *   { discussion_id, word_count, has_question: bool }
 *
 * peer_review_given:
 *   { submission_id, rubric_scores: {}, comment_length }
 *
 * lesson_completed:
 *   { stage_progress: {}, final_score (0-1), time_spent_s, passed: bool }
 *
 * teacher_override:
 *   { override_type: 'skip'|'retry'|'level_change', target_lesson_id, reason }
 */

import { getTokenSecret, verifyToken } from '../auth.js';
import { initLearnerModelInternal } from './learnerModelHandler.js';

export async function handlePostEvent(request, env, { json }) {
  const auth = request.headers.get('Authorization') || '';
  const session = await verifyToken(auth.replace('Bearer ',''), getTokenSecret(env));
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const body = await request.json();
  const { event_type, lesson_id, course_id, session_id, payload = {}, score, passed, time_spent_s } = body;

  if (!event_type) return json({ error: 'event_type required' }, 400);

  // Lookup bloom_level từ lesson nếu có
  let bloomLevel = null;
  if (lesson_id) {
    const lesson = await env.D1.prepare(
      `SELECT bloom_level FROM lessons WHERE lesson_id = ?`
    ).bind(lesson_id).first();
    bloomLevel = lesson?.bloom_level || null;
  }

  // Insert event
  const result = await env.D1.prepare(`
    INSERT INTO events (student_id, lesson_id, course_id, session_id, event_type,
                        payload, score, passed, time_spent_s, bloom_level)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    session.userId, lesson_id || null, course_id || null, session_id || null,
    event_type, JSON.stringify(payload),
    score != null ? score : null,
    passed != null ? (passed ? 1 : 0) : null,
    time_spent_s || null,
    bloomLevel
  ).run();

  // Ensure learner model exists
  await initLearnerModelInternal(env, session.userId, 'toan');

  // Async: trigger curriculum planner (via ctx.waitUntil in real Worker)
  // processEventAsync(env, session.userId, result.meta.last_row_id, event_type);

  return json({ ok: true, event_id: result.meta.last_row_id }, 201);
}

export async function handleGetEvents(request, env, { json }) {
  const auth = request.headers.get('Authorization') || '';
  const session = await verifyToken(auth.replace('Bearer ',''), getTokenSecret(env));
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const url = new URL(request.url);
  const studentId = url.searchParams.get('student_id') || session.userId;
  const eventType = url.searchParams.get('event_type');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
  const before = url.searchParams.get('before'); // ISO timestamp

  // Students chỉ xem của mình
  if (session.role === 'student' && parseInt(studentId) !== session.userId)
    return json({ error: 'Forbidden' }, 403);

  let query = `SELECT * FROM events WHERE student_id = ?`;
  const params = [studentId];

  if (eventType) { query += ` AND event_type = ?`; params.push(eventType); }
  if (before)   { query += ` AND created_at < ?`; params.push(before); }
  query += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);

  const rows = await env.D1.prepare(query).bind(...params).all();
  return json({ events: rows.results, total: rows.results.length });
}
```

---

### 1.5 LMS Core: Gắn lesson_id vào Articles [P1]

**Mục đích:** Liên kết bài học trong NocoDB Articles với YCCĐ trong D1 `lessons`.

**NocoDB Articles table — thêm fields:**
- Field `LessonId` (Text) — chứa `lesson_id` từ D1 (`"020108.0202d3"`)
- Field `LessonModel` (SingleLineText, options: scaffold/practice/case/teach/explore/repair/project/reflect)
- Field `BloomLevel` (Number, 1-6)
- Field `LevelDefault` (SingleLineText, options: nen_tang/mo_rong/chuyen_sau)
- Field `StageConfig` (LongText, JSON) — cấu hình 5 stages

**Admin UI thêm vào `admin/dashboard.js`:**

```javascript
// admin/dashboard.js — thêm vào Article editor form
// Khi admin tạo/sửa Article, cho phép gắn lesson_id

async function populateLessonIdDropdown(gradeNum, subject = 'toan') {
  const resp = await apiFetch(`/api/lessons?grade_num=${gradeNum}&subject=${subject}&limit=200`);
  const { lessons } = await resp.json();
  const select = document.getElementById('lesson-id-select');
  select.innerHTML = `<option value="">-- Chọn YCCĐ --</option>` +
    lessons.map(l =>
      `<option value="${l.lesson_id}">[Bloom ${l.bloom_level}] ${l.title} (${l.lesson_model})</option>`
    ).join('');
}
```

**Worker route mới:**

```javascript
// worker/index.js
import { handleLessonList, handleLessonGet } from './src/handlers/lessonHandler.js';

if (path === '/api/lessons' && method === 'GET')
  return handleLessonList(request, env, { json });
if (path.startsWith('/api/lessons/') && method === 'GET')
  return handleLessonGet(request, env, { json, path });
```

**File mới:** `worker/src/handlers/lessonHandler.js`

```javascript
// worker/src/handlers/lessonHandler.js

export async function handleLessonList(request, env, { json }) {
  const url = new URL(request.url);
  const gradeNum = url.searchParams.get('grade_num');
  const subject  = url.searchParams.get('subject') || 'toan';
  const model    = url.searchParams.get('lesson_model');
  const bloom    = url.searchParams.get('bloom_level');
  const level    = url.searchParams.get('level_default');
  const limit    = Math.min(parseInt(url.searchParams.get('limit') || '50'), 500);
  const offset   = parseInt(url.searchParams.get('offset') || '0');

  let q = `SELECT * FROM lessons WHERE subject = ? AND status = 'active'`;
  const p = [subject];

  if (gradeNum) { q += ` AND grade_num = ?`; p.push(gradeNum); }
  if (model)    { q += ` AND lesson_model = ?`; p.push(model); }
  if (bloom)    { q += ` AND bloom_level = ?`; p.push(bloom); }
  if (level)    { q += ` AND level_default = ?`; p.push(level); }
  q += ` ORDER BY grade_num, lesson_id LIMIT ? OFFSET ?`;
  p.push(limit, offset);

  const rows = await env.D1.prepare(q).bind(...p).all();
  return json({ lessons: rows.results, total: rows.results.length });
}

export async function handleLessonGet(request, env, { json, path }) {
  const lessonId = path.split('/')[3];
  const row = await env.D1.prepare(
    `SELECT * FROM lessons WHERE lesson_id = ?`
  ).bind(lessonId).first();

  if (!row) return json({ error: 'Lesson not found' }, 404);
  return json({
    ...row,
    quiz_ids:     JSON.parse(row.quiz_ids || '[]'),
    prerequisites: JSON.parse(row.prerequisites || '[]'),
    outcome_codes: JSON.parse(row.outcome_codes || '[]'),
    tags:         JSON.parse(row.tags || '[]'),
    stage_config: row.stage_config ? JSON.parse(row.stage_config) : null,
  });
}
```

---

## PHASE 2: AI Agent Engine — Rule-based (Tháng 3–5)

> **Mục tiêu:** Curriculum Planner với 9 luật hoạt động đầy đủ, mọi quyết định được log vào D1.

---

### 2.1 Curriculum Planner: 9 luật R01–R09 [P0]

**File mới:** `worker/src/curriculumPlanner.js`

```javascript
/**
 * worker/src/curriculumPlanner.js
 * ─────────────────────────────────────────────────────────────────────────────
 * AURA Curriculum Planner — Rule-based Engine (Phase 2)
 *
 * Input:  learnerModel object + triggering event
 * Output: { action_type, target_lesson_id, rationale, rules_evaluated }
 *
 * Luật được đánh giá theo priority: R01 → R09
 * Luật đầu tiên FIRE sẽ thắng (short-circuit evaluation)
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Hàm chính — gọi từ eventHandler sau mỗi event quan trọng
 *
 * @param {object} env           - Worker env bindings (D1, etc.)
 * @param {number} studentId
 * @param {object} learnerModel  - Row từ learner_models table (đã parse JSON fields)
 * @param {object} event         - Row từ events table (đã parse)
 * @param {object} currentLesson - Row từ lessons table
 * @returns {Promise<object>}    - Decision object để insert vào agent_decisions
 */
export async function runCurriculumPlanner(env, studentId, learnerModel, event, currentLesson) {
  // Load rule configs từ D1 (cached per request, không per-student)
  const rulesRows = await env.D1.prepare(
    `SELECT rule_id, config, enabled FROM curriculum_rules ORDER BY priority ASC`
  ).all();

  const rules = {};
  for (const r of rulesRows.results) {
    rules[r.rule_id] = { ...JSON.parse(r.config), enabled: r.enabled === 1 };
  }

  const evaluated = [];
  let decision = null;

  // ── R01: Repair Trigger ─────────────────────────────────────────────────
  // Kích hoạt khi: học sinh fail >= consecutive_fail_threshold lần liên tiếp
  // Action: chuyển sang bài 'repair' (next_if_fail của current lesson)
  if (rules.R01?.enabled) {
    const cfg = rules.R01;
    const fired = learnerModel.consecutive_fail >= cfg.consecutive_fail_threshold;
    evaluated.push({
      rule: 'R01',
      fired,
      reason: fired
        ? `Thất bại ${learnerModel.consecutive_fail} lần liên tiếp (ngưỡng: ${cfg.consecutive_fail_threshold})`
        : `consecutive_fail = ${learnerModel.consecutive_fail} < ${cfg.consecutive_fail_threshold}`
    });

    if (fired && !decision) {
      const repairLessonId = currentLesson?.next_if_fail;
      // Nếu không có next_if_fail, tìm bài repair cùng bloom_level - 1
      const targetId = repairLessonId || await findRepairLesson(env, currentLesson, learnerModel);
      decision = {
        action_type: 'repair_lesson',
        target_lesson_id: targetId,
        rationale: `Bạn đang gặp khó khăn với bài này. Hãy ôn lại kiến thức nền tảng trước nhé!`,
        trigger_type: 'R01',
      };
    }
  }

  // ── R02: Level Downgrade ────────────────────────────────────────────────
  // Kích hoạt khi: mastery tại level hiện tại < mastery_threshold_downgrade
  //               sau min_attempts lần thử
  if (rules.R02?.enabled && !decision) {
    const cfg = rules.R02;
    const currentLevelMastery = getLevelMastery(learnerModel, currentLesson?.level_default);
    const totalAttempts = await countAttemptsAtLevel(env, studentId, learnerModel.current_level);
    const fired = totalAttempts >= cfg.min_attempts
      && currentLevelMastery < cfg.mastery_threshold_downgrade
      && learnerModel.current_level !== 'nen_tang';  // Không thể hạ xuống dưới nen_tang

    evaluated.push({
      rule: 'R02', fired,
      reason: fired
        ? `Mastery tại ${learnerModel.current_level}: ${currentLevelMastery.toFixed(2)} < ${cfg.mastery_threshold_downgrade} sau ${totalAttempts} lần`
        : `Chưa đủ điều kiện downgrade`
    });

    if (fired) {
      const newLevel = learnerModel.current_level === 'chuyen_sau' ? 'mo_rong' : 'nen_tang';
      decision = {
        action_type: 'level_downgrade',
        target_lesson_id: await findLessonAtLevel(env, currentLesson, newLevel),
        rationale: `Chúng ta sẽ củng cố thêm ở mức ${getLevelLabel(newLevel)} để học vững hơn nhé!`,
        trigger_type: 'R02',
        level_change: { from: learnerModel.current_level, to: newLevel },
      };
    }
  }

  // ── R03: Level Upgrade ──────────────────────────────────────────────────
  // Kích hoạt khi: consecutive_pass >= threshold VÀ mastery_map trung bình >= upgrade_threshold
  if (rules.R03?.enabled && !decision) {
    const cfg = rules.R03;
    const avgMastery = getAverageMastery(learnerModel.mastery_map);
    const lessonsAtLevel = await countLessonsCompletedAtLevel(env, studentId, learnerModel.current_level);
    const fired = learnerModel.consecutive_pass >= cfg.consecutive_pass_threshold
      && avgMastery >= cfg.mastery_threshold_upgrade
      && lessonsAtLevel >= cfg.min_lessons_at_level
      && learnerModel.current_level !== 'chuyen_sau';  // Đã ở cao nhất

    evaluated.push({
      rule: 'R03', fired,
      reason: fired
        ? `${learnerModel.consecutive_pass} lần pass liên tiếp, mastery ${avgMastery.toFixed(2)}`
        : `Chưa đủ điều kiện upgrade`
    });

    if (fired) {
      const newLevel = learnerModel.current_level === 'nen_tang' ? 'mo_rong' : 'chuyen_sau';
      decision = {
        action_type: 'level_upgrade',
        target_lesson_id: await findLessonAtLevel(env, currentLesson, newLevel),
        rationale: `Xuất sắc! Bạn đã thành thạo mức ${getLevelLabel(learnerModel.current_level)}. Chúng ta tiến lên ${getLevelLabel(newLevel)} nhé!`,
        trigger_type: 'R03',
        level_change: { from: learnerModel.current_level, to: newLevel },
      };
    }
  }

  // ── R04: Dormant Re-entry ───────────────────────────────────────────────
  // Kích hoạt khi: session_started sau nghỉ >= dormant_days_threshold ngày
  if (rules.R04?.enabled && !decision && event.event_type === 'session_started') {
    const cfg = rules.R04;
    const dormantDays = learnerModel.dormant_days || 0;
    const fired = dormantDays >= cfg.dormant_days_threshold;

    evaluated.push({ rule: 'R04', fired,
      reason: fired ? `Nghỉ ${dormantDays} ngày (ngưỡng: ${cfg.dormant_days_threshold})` : `Hoạt động bình thường` });

    if (fired) {
      // Chọn 1 bài ôn tập scaffold ở bloom level thấp nhất chưa vững
      const reviewLesson = await findReviewLesson(env, learnerModel, cfg.use_model);
      decision = {
        action_type: 'dormant_reentry',
        target_lesson_id: reviewLesson?.lesson_id,
        rationale: `Chào mừng bạn trở lại sau ${dormantDays} ngày! Hãy ôn nhanh vài bài trước khi tiếp tục nhé.`,
        trigger_type: 'R04',
      };
    }
  }

  // ── R05: Bloom Gap Bridge ───────────────────────────────────────────────
  // Kích hoạt khi: bloom_profile tại level thấp < threshold trong khi đang học level cao
  if (rules.R05?.enabled && !decision) {
    const cfg = rules.R05;
    const bloomProfile = learnerModel.bloom_profile || {};
    let gapBloom = null;

    // Kiểm tra từ bloom level thấp lên cao
    for (const bl of cfg.check_bloom_levels) {
      if ((bloomProfile[bl] || 0) < cfg.gap_bloom_threshold) {
        // Chỉ báo gap nếu đang học bloom level cao hơn
        if (currentLesson?.bloom_level > bl) {
          gapBloom = bl;
          break;
        }
      }
    }

    const fired = gapBloom !== null;
    evaluated.push({ rule: 'R05', fired,
      reason: fired ? `Lỗ hổng tại Bloom ${gapBloom}: ${(bloomProfile[gapBloom]||0).toFixed(2)} < ${cfg.gap_bloom_threshold}` : `Bloom profile ổn` });

    if (fired) {
      const bridgeLesson = await findBloomBridgeLesson(env, learnerModel, gapBloom, cfg.bridge_model);
      decision = {
        action_type: 'bloom_bridge',
        target_lesson_id: bridgeLesson?.lesson_id,
        rationale: `Mình phát hiện bạn cần củng cố thêm ở mức tư duy Bloom ${gapBloom}. Hãy học bài này trước nhé!`,
        trigger_type: 'R05',
        bloom_gap: { level: gapBloom, score: bloomProfile[gapBloom] || 0 },
      };
    }
  }

  // ── R06: Timing Optimization ────────────────────────────────────────────
  // R06 không tạo 'decision' mà chỉ điều chỉnh duration recommendation
  // Kích hoạt khi: speed_profile cho thấy student chậm/nhanh đáng kể
  if (rules.R06?.enabled && !decision) {
    const cfg = rules.R06;
    const speedProfile = learnerModel.speed_profile || {};
    const percentile = speedProfile.percentile || 50;
    const fired = percentile < cfg.slow_percentile_threshold || percentile > cfg.fast_percentile_threshold;

    evaluated.push({ rule: 'R06', fired,
      reason: fired ? `Speed percentile: ${percentile}` : `Tốc độ bình thường` });

    // R06 không block, chỉ annotate decision
    // duration_recommendation sẽ được thêm vào decision cuối
  }

  // ── R07: Peer Expert Connection ─────────────────────────────────────────
  // Kích hoạt khi: student cần hỗ trợ VÀ có peer expert trong cùng chapter
  if (rules.R07?.enabled && !decision) {
    const cfg = rules.R07;
    const avgMastery = getAverageMastery(learnerModel.mastery_map);
    const fired = avgMastery < cfg.struggling_mastery_threshold;

    if (fired) {
      const peerExpert = await findPeerExpert(env, studentId, currentLesson, cfg.expert_mastery_threshold);
      if (peerExpert) {
        evaluated.push({ rule: 'R07', fired: true, reason: `Mastery thấp (${avgMastery.toFixed(2)}), có peer expert #${peerExpert.student_id}` });
        decision = {
          action_type: 'peer_connect',
          target_lesson_id: currentLesson?.lesson_id,
          peer_expert_id: peerExpert.student_id,
          rationale: `Hãy thử hỏi bạn học giỏi hơn trong lớp — học từ bạn bè rất hiệu quả!`,
          trigger_type: 'R07',
        };
      } else {
        evaluated.push({ rule: 'R07', fired: false, reason: `Không tìm thấy peer expert phù hợp` });
      }
    } else {
      evaluated.push({ rule: 'R07', fired: false, reason: `Mastery đủ tốt` });
    }
  }

  // ── R08: Preferred Model Routing ────────────────────────────────────────
  // Kích hoạt khi: có đủ lịch sử để xác định preferred_model
  // Nếu bài tiếp theo có nhiều variant, chọn model mà student học tốt nhất
  if (rules.R08?.enabled && !decision) {
    const cfg = rules.R08;
    const preferredModel = learnerModel.preferred_model;
    const nextLessonId = currentLesson?.next_if_pass;

    if (preferredModel && nextLessonId) {
      // Kiểm tra xem có lesson variant nào với preferred_model không
      const variantLesson = await findLessonVariant(env, nextLessonId, preferredModel);
      if (variantLesson) {
        evaluated.push({ rule: 'R08', fired: true,
          reason: `Preferred model: ${preferredModel}, tìm thấy variant` });
        // Không tạo decision mới, chỉ override target_lesson_id trong next_lesson
        // Được xử lý trong handleGetNextLesson
      } else {
        evaluated.push({ rule: 'R08', fired: false, reason: `Không có variant cho model ${preferredModel}` });
      }
    } else {
      evaluated.push({ rule: 'R08', fired: false, reason: `Chưa đủ lịch sử hoặc không có next lesson` });
    }
  }

  // ── R09: Variety Enforcement ────────────────────────────────────────────
  // Kích hoạt khi: recent_models có max_consecutive_same_model lần cùng model liên tiếp
  if (rules.R09?.enabled && !decision) {
    const cfg = rules.R09;
    const recentModels = learnerModel.recent_models || [];
    const lastN = recentModels.slice(-cfg.max_consecutive_same_model);
    const fired = lastN.length >= cfg.max_consecutive_same_model
      && new Set(lastN).size === 1;  // tất cả giống nhau

    evaluated.push({ rule: 'R09', fired,
      reason: fired ? `Dùng model '${lastN[0]}' ${cfg.max_consecutive_same_model} lần liên tiếp` : `Đa dạng bình thường` });

    if (fired) {
      const currentModel = lastN[0];
      const alternativeLesson = await findAlternativeModelLesson(
        env, currentLesson, currentModel, cfg.variety_pool_size
      );
      if (alternativeLesson) {
        decision = {
          action_type: 'model_switch',
          target_lesson_id: alternativeLesson.lesson_id,
          rationale: `Để học hiệu quả hơn, hãy thử cách tiếp cận mới nhé!`,
          trigger_type: 'R09',
        };
      }
    }
  }

  // ── Default: next_lesson ────────────────────────────────────────────────
  // Không rule nào fire → tiến thẳng theo next_if_pass
  if (!decision) {
    const nextId = event.passed ? currentLesson?.next_if_pass : currentLesson?.next_if_fail;
    decision = {
      action_type: nextId ? 'next_lesson' : 'no_action',
      target_lesson_id: nextId || null,
      rationale: event.passed
        ? `Tuyệt vời! Bạn đã hoàn thành bài học. Tiếp tục với bài tiếp theo nhé!`
        : `Hãy thử lại bài này hoặc ôn tập thêm.`,
      trigger_type: 'default',
    };
    evaluated.push({ rule: 'DEFAULT', fired: true, reason: 'Không rule nào áp dụng' });
  }

  return { ...decision, rules_evaluated: evaluated };
}

// ── Helper functions ──────────────────────────────────────────────────────────

function getAverageMastery(masteryMap) {
  const values = Object.values(masteryMap || {}).filter(v => typeof v === 'number');
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function getLevelMastery(learnerModel, level) {
  // Lấy mastery trung bình của các lessons ở level hiện tại
  const map = learnerModel.mastery_map || {};
  const entries = Object.entries(map).filter(([, v]) => v > 0);
  if (!entries.length) return 0;
  return entries.reduce((a, [, v]) => a + v, 0) / entries.length;
}

function getLevelLabel(level) {
  return { nen_tang: 'Nền tảng', mo_rong: 'Mở rộng', chuyen_sau: 'Chuyên sâu' }[level] || level;
}

async function findRepairLesson(env, currentLesson, learnerModel) {
  if (!currentLesson) return null;
  const row = await env.D1.prepare(`
    SELECT lesson_id FROM lessons
    WHERE grade_num = ? AND subject = ? AND lesson_model = 'repair'
      AND bloom_level <= ? AND status = 'active'
    ORDER BY bloom_level DESC, lesson_id LIMIT 1
  `).bind(currentLesson.grade_num, currentLesson.subject,
          Math.max(1, currentLesson.bloom_level - 1)).first();
  return row?.lesson_id || null;
}

async function findLessonAtLevel(env, currentLesson, newLevel) {
  if (!currentLesson) return null;
  const row = await env.D1.prepare(`
    SELECT lesson_id FROM lessons
    WHERE grade_num = ? AND subject = ? AND level_default = ?
      AND bloom_level = ? AND status = 'active'
    LIMIT 1
  `).bind(currentLesson.grade_num, currentLesson.subject, newLevel, currentLesson.bloom_level).first();
  return row?.lesson_id || null;
}

async function findReviewLesson(env, learnerModel, model) {
  // Tìm bài ôn tập ở bloom level thấp nhất có mastery < 0.7
  const map = learnerModel.mastery_map || {};
  const weakLessons = Object.entries(map).filter(([, v]) => v < 0.7).map(([k]) => k);
  if (!weakLessons.length) return null;

  const row = await env.D1.prepare(`
    SELECT lesson_id FROM lessons
    WHERE lesson_id IN (${weakLessons.map(() => '?').join(',')})
      AND lesson_model = ? AND status = 'active'
    ORDER BY bloom_level ASC LIMIT 1
  `).bind(...weakLessons, model).first();
  return row;
}

async function findBloomBridgeLesson(env, learnerModel, bloomLevel, model) {
  const row = await env.D1.prepare(`
    SELECT lesson_id FROM lessons
    WHERE grade_num = ? AND subject = ? AND bloom_level = ? AND lesson_model = ?
      AND level_default = ? AND status = 'active'
    LIMIT 1
  `).bind(learnerModel.grade_num, 'toan', bloomLevel, model, learnerModel.current_level).first();
  return row;
}

async function findPeerExpert(env, studentId, currentLesson, expertThreshold) {
  if (!currentLesson) return null;
  const row = await env.D1.prepare(`
    SELECT lm.student_id, AVG(sm.bkt_state) as mastery
    FROM learner_models lm
    JOIN student_mastery sm ON sm.student_id = lm.student_id AND sm.subject = lm.subject
    WHERE lm.subject = 'toan' AND lm.is_peer_expert = 1
      AND lm.student_id != ? AND lm.grade_num = ?
    GROUP BY lm.student_id
    HAVING mastery >= ?
    ORDER BY mastery DESC LIMIT 1
  `).bind(studentId, currentLesson.grade_num, expertThreshold).first();
  return row;
}

async function findLessonVariant(env, lessonId, preferredModel) {
  const base = await env.D1.prepare(`SELECT * FROM lessons WHERE lesson_id = ?`).bind(lessonId).first();
  if (!base) return null;
  const variant = await env.D1.prepare(`
    SELECT lesson_id FROM lessons
    WHERE grade_num = ? AND bloom_level = ? AND lesson_model = ? AND level_default = ?
      AND lesson_id != ? AND status = 'active'
    LIMIT 1
  `).bind(base.grade_num, base.bloom_level, preferredModel, base.level_default, lessonId).first();
  return variant;
}

async function findAlternativeModelLesson(env, currentLesson, excludeModel, poolSize) {
  if (!currentLesson) return null;
  const row = await env.D1.prepare(`
    SELECT lesson_id FROM lessons
    WHERE grade_num = ? AND bloom_level = ? AND level_default = ?
      AND lesson_model != ? AND status = 'active'
    ORDER BY RANDOM() LIMIT 1
  `).bind(currentLesson.grade_num, currentLesson.bloom_level, currentLesson.level_default, excludeModel).first();
  return row;
}

async function countAttemptsAtLevel(env, studentId, level) {
  const row = await env.D1.prepare(`
    SELECT COUNT(*) as cnt FROM events e
    JOIN lessons l ON l.lesson_id = e.lesson_id
    WHERE e.student_id = ? AND l.level_default = ?
      AND e.event_type IN ('quiz_submitted','lesson_completed')
  `).bind(studentId, level).first();
  return row?.cnt || 0;
}

async function countLessonsCompletedAtLevel(env, studentId, level) {
  const row = await env.D1.prepare(`
    SELECT COUNT(DISTINCT e.lesson_id) as cnt FROM events e
    JOIN lessons l ON l.lesson_id = e.lesson_id
    WHERE e.student_id = ? AND l.level_default = ? AND e.passed = 1
  `).bind(studentId, level).first();
  return row?.cnt || 0;
}
```

---

### 2.2 Feedback Engine [P1]

**File mới:** `worker/src/feedbackEngine.js`

Feedback Engine tạo message ngắn gọn bằng tiếng Việt dựa trên decision của Curriculum Planner:

```javascript
// worker/src/feedbackEngine.js

/**
 * Tạo feedback message cho học sinh dựa trên decision
 * Phase 2: Template-based. Phase 4: LLM-generated.
 */
export function generateFeedback(decision, learnerModel, currentLesson, event) {
  const templates = {
    repair_lesson: [
      `Bài này có vẻ khó với bạn. Hãy ôn lại "${currentLesson?.title}" với cách tiếp cận nhẹ nhàng hơn nhé!`,
      `Đừng lo! Mình sẽ giúp bạn củng cố lại từ đầu bài này.`,
    ],
    level_downgrade: [
      `Chúng ta sẽ quay về mức Nền tảng để học chắc hơn. Đây là bước quan trọng!`,
    ],
    level_upgrade: [
      `Chúc mừng! Bạn đã sẵn sàng cho thử thách mới ở mức ${getLevelLabel(decision.level_change?.to)}!`,
    ],
    dormant_reentry: [
      `Chào mừng trở lại! Hãy ôn nhanh để lấy lại phong độ nhé 💪`,
    ],
    bloom_bridge: [
      `Mình thấy có một chỗ cần lấp đầy — học bài này sẽ giúp bạn hiểu sâu hơn nhiều!`,
    ],
    peer_connect: [
      `Thử hỏi bạn học trong lớp nhé — học theo bạn bè rất hiệu quả!`,
    ],
    next_lesson: [
      `Tiến thẳng! Bài tiếp theo đang chờ bạn 🎯`,
    ],
    no_action: [
      `Bạn đang học rất tốt. Tiếp tục nhé!`,
    ],
  };

  const options = templates[decision.action_type] || templates.no_action;
  // Chọn ngẫu nhiên để tránh nhàm chán
  return options[Math.floor(Math.random() * options.length)];
}

function getLevelLabel(level) {
  return { nen_tang: 'Nền tảng', mo_rong: 'Mở rộng', chuyen_sau: 'Chuyên sâu' }[level] || level;
}
```

---

### 2.3 API Contract implementation [P0]

**7 routes cần implement — thêm vào `worker/index.js`:**

```javascript
// worker/index.js — Agent API Contract routes
import { handleGetLearnerModel, handleUpdateLearnerModel, handleInitLearnerModel }
  from './src/handlers/learnerModelHandler.js';
import { handlePostEvent, handleGetEvents } from './src/handlers/eventHandler.js';
import { handleGetNextLesson, handleGetAgentDecisions, handleGetRules, handleUpdateRule }
  from './src/handlers/agentHandler.js';

// /agent/learner/:id/model  — GET (xem learner model)
if (path.match(/^\/agent\/learner\/\d+\/model$/) && method === 'GET')
  return handleGetLearnerModel(request, env, { json, path });

// /agent/learner/:id/next   — GET (lấy bài tiếp theo theo AI)
if (path.match(/^\/agent\/learner\/\d+\/next$/) && method === 'GET')
  return handleGetNextLesson(request, env, { json, path });

// /agent/events             — POST (ghi event), GET (lấy events)
if (path === '/agent/events' && method === 'POST')
  return handlePostEvent(request, env, { json });
if (path === '/agent/events' && method === 'GET')
  return handleGetEvents(request, env, { json });

// /agent/decisions          — GET (admin: xem log quyết định)
if (path === '/agent/decisions' && method === 'GET')
  return handleGetAgentDecisions(request, env, { json });

// /agent/rules              — GET (xem rules), PUT (admin: update rule config)
if (path === '/agent/rules' && method === 'GET')
  return handleGetRules(request, env, { json });
if (path.match(/^\/agent\/rules\/R\d+$/) && method === 'PUT')
  return handleUpdateRule(request, env, { json, path });

// /auth, /lessons           — đã có (xem trên)
```

**File mới:** `worker/src/handlers/agentHandler.js`

```javascript
// worker/src/handlers/agentHandler.js

import { getTokenSecret, verifyToken, verifyAdminAuth } from '../auth.js';
import { runCurriculumPlanner } from '../curriculumPlanner.js';

/**
 * GET /agent/learner/:id/next
 * Trả về bài học tiếp theo được AI recommend cho student
 */
export async function handleGetNextLesson(request, env, { json, path }) {
  const auth = request.headers.get('Authorization') || '';
  const session = await verifyToken(auth.replace('Bearer ',''), getTokenSecret(env));
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const studentId = parseInt(path.split('/')[3]);
  if (session.role === 'student' && session.userId !== studentId)
    return json({ error: 'Forbidden' }, 403);

  const subject = new URL(request.url).searchParams.get('subject') || 'toan';

  // 1. Load learner model
  const lmRow = await env.D1.prepare(
    `SELECT * FROM learner_models WHERE student_id = ? AND subject = ?`
  ).bind(studentId, subject).first();

  if (!lmRow) return json({ error: 'Learner model not found. POST /agent/learner/init first.' }, 404);

  const learnerModel = {
    ...lmRow,
    mastery_map:    JSON.parse(lmRow.mastery_map || '{}'),
    bloom_profile:  JSON.parse(lmRow.bloom_profile || '{}'),
    error_patterns: JSON.parse(lmRow.error_patterns || '[]'),
    speed_profile:  JSON.parse(lmRow.speed_profile || '{}'),
    engagement:     JSON.parse(lmRow.engagement || '{}'),
    recent_models:  JSON.parse(lmRow.recent_models || '[]'),
  };

  // 2. Load current lesson
  const currentLesson = lmRow.current_lesson_id
    ? await env.D1.prepare(`SELECT * FROM lessons WHERE lesson_id = ?`)
        .bind(lmRow.current_lesson_id).first()
    : null;

  // 3. Load last event để biết context
  const lastEvent = await env.D1.prepare(
    `SELECT * FROM events WHERE student_id = ? ORDER BY created_at DESC LIMIT 1`
  ).bind(studentId).first();

  // 4. Run curriculum planner
  const decision = await runCurriculumPlanner(env, studentId, learnerModel, lastEvent || {}, currentLesson);

  // 5. Load target lesson details
  const targetLesson = decision.target_lesson_id
    ? await env.D1.prepare(`SELECT * FROM lessons WHERE lesson_id = ?`)
        .bind(decision.target_lesson_id).first()
    : null;

  // 6. Log decision
  await env.D1.prepare(`
    INSERT INTO agent_decisions (student_id, trigger_event_id, trigger_type,
      input_state, rules_evaluated, action_type, target_lesson_id, rationale)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    studentId, lastEvent?.event_id || null, decision.trigger_type,
    JSON.stringify({ current_lesson_id: lmRow.current_lesson_id, current_level: lmRow.current_level }),
    JSON.stringify(decision.rules_evaluated),
    decision.action_type, decision.target_lesson_id, decision.rationale
  ).run();

  return json({
    student_id: studentId,
    action_type: decision.action_type,
    target_lesson: targetLesson ? {
      ...targetLesson,
      quiz_ids: JSON.parse(targetLesson.quiz_ids || '[]'),
      stage_config: targetLesson.stage_config ? JSON.parse(targetLesson.stage_config) : null,
    } : null,
    rationale: decision.rationale,
    rules_evaluated: decision.rules_evaluated,
  });
}

/**
 * GET /agent/decisions
 * Admin/Teacher: xem log quyết định AI
 */
export async function handleGetAgentDecisions(request, env, { json }) {
  const auth = request.headers.get('Authorization') || '';
  const session = await verifyToken(auth.replace('Bearer ',''), getTokenSecret(env));
  if (!session || !['admin','teacher'].includes(session.role))
    return json({ error: 'Forbidden' }, 403);

  const url = new URL(request.url);
  const studentId = url.searchParams.get('student_id');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
  const actionType = url.searchParams.get('action_type');

  let q = `SELECT * FROM agent_decisions WHERE 1=1`;
  const p = [];
  if (studentId) { q += ` AND student_id = ?`; p.push(studentId); }
  if (actionType) { q += ` AND action_type = ?`; p.push(actionType); }
  q += ` ORDER BY created_at DESC LIMIT ?`;
  p.push(limit);

  const rows = await env.D1.prepare(q).bind(...p).all();
  return json({ decisions: rows.results });
}

/**
 * GET /agent/rules — Xem danh sách rules
 * PUT /agent/rules/:id — Admin update rule config
 */
export async function handleGetRules(request, env, { json }) {
  const rows = await env.D1.prepare(
    `SELECT * FROM curriculum_rules ORDER BY priority ASC`
  ).all();
  return json({ rules: rows.results.map(r => ({ ...r, config: JSON.parse(r.config) })) });
}

export async function handleUpdateRule(request, env, { json, path }) {
  const isAdmin = await verifyAdminAuth(request, env);
  if (!isAdmin) return json({ error: 'Admin only' }, 403);

  const ruleId = path.split('/')[3];  // R01, R02, ...
  const { enabled, config, priority } = await request.json();

  const updates = [];
  const params = [];
  if (enabled !== undefined) { updates.push('enabled = ?'); params.push(enabled ? 1 : 0); }
  if (config !== undefined)  { updates.push('config = ?');  params.push(JSON.stringify(config)); }
  if (priority !== undefined){ updates.push('priority = ?'); params.push(priority); }
  updates.push('updated_at = ?'); params.push(new Date().toISOString());
  params.push(ruleId);

  await env.D1.prepare(
    `UPDATE curriculum_rules SET ${updates.join(', ')} WHERE rule_id = ?`
  ).bind(...params).run();

  return json({ ok: true, rule_id: ruleId });
}
```

---

### 2.4 Admin: Decision Log Dashboard [P1]

**File:** `admin/dashboard.js` — thêm section "Agent Decisions"

**UI components cần thêm vào `admin/dashboard.html`:**

```html
<!-- admin/dashboard.html — thêm tab "AI Decisions" -->
<div id="section-agent-decisions" class="dashboard-section" style="display:none">
  <h2>🤖 Agent Decision Log</h2>

  <!-- Filter bar -->
  <div class="filter-bar">
    <input id="filter-student" type="text" placeholder="Student ID..." style="width:120px">
    <select id="filter-action">
      <option value="">Tất cả action</option>
      <option value="next_lesson">next_lesson</option>
      <option value="repair_lesson">repair_lesson</option>
      <option value="level_upgrade">level_upgrade</option>
      <option value="level_downgrade">level_downgrade</option>
      <option value="bloom_bridge">bloom_bridge</option>
      <option value="dormant_reentry">dormant_reentry</option>
    </select>
    <button onclick="loadDecisions()">Tải</button>
  </div>

  <!-- Decisions table -->
  <table id="decisions-table">
    <thead>
      <tr>
        <th>Thời gian</th>
        <th>Student</th>
        <th>Action</th>
        <th>Target Lesson</th>
        <th>Rule kích hoạt</th>
        <th>Rationale</th>
        <th>Outcome</th>
      </tr>
    </thead>
    <tbody id="decisions-tbody"></tbody>
  </table>

  <!-- Rules config -->
  <h3>Cấu hình luật</h3>
  <div id="rules-config-panel"></div>
</div>
```

---

## PHASE 3: Nội dung & Trải nghiệm học (Tháng 5–8)

---

### 3.1 5-Stage Lesson Builder (Admin) [P1]

**Cấu trúc 5 stages:**

```
Kích hoạt (Activate)    → warm-up, recall kiến thức cũ, 5-10 phút
Kiến tạo (Construct)    → học kiến thức mới, video/đọc/khám phá, 15-20 phút
Hành động (Act)         → làm bài tập, quiz, thực hành, 10-15 phút
Phản chiếu (Reflect)    → tự đánh giá, ghi chú học, 5-10 phút
Tổng kết (Summarize)    → tóm tắt, chốt kiến thức, 5 phút
```

**`stage_config` JSON schema:**

```json
{
  "activate": {
    "type": "flashcard|video|question",
    "content": "...",
    "duration_min": 5,
    "resources": []
  },
  "construct": {
    "type": "video|reading|interactive",
    "content_url": "...",
    "reading_text": "...",
    "duration_min": 20
  },
  "act": {
    "type": "quiz|exercise|problem_set",
    "quiz_ids": ["quiz_001"],
    "passing_threshold": 0.7,
    "max_attempts": 3
  },
  "reflect": {
    "type": "self_assessment|journal|checklist",
    "prompts": ["Bạn hiểu được gì hôm nay?", "Điều gì còn chưa rõ?"],
    "save_to_portfolio": false
  },
  "summarize": {
    "type": "key_points|mindmap|teacher_note",
    "content": "...",
    "next_lesson_preview": true
  }
}
```

**Admin UI:** `admin/modules/lesson-builder.html` (file mới)

```html
<!-- admin/modules/lesson-builder.html -->
<!-- 5-tab accordion: mỗi tab = 1 stage -->
<!-- Drag-and-drop để sắp xếp content blocks trong từng stage -->
<!-- Preview button → mở modal giả lập student view -->
<!-- Save → PUT /api/lessons/:lesson_id/stage-config -->
```

**Worker route:**

```javascript
// worker/index.js
if (path.match(/^\/api\/lessons\/[\w.]+\/stage-config$/) && method === 'PUT')
  return handleUpdateStageConfig(request, env, { json, path });
```

---

### 3.2 Adaptive Learning Path (Student) [P1]

**File:** `page.html` + `index.js` — thêm logic adaptive navigation

**Luồng học của student:**

```
1. Student mở page.html?lesson_id=020108.0202d3
2. page.html gọi GET /api/lessons/:lesson_id
3. Render 5 stages tuần tự (tab/stepper UI)
4. Khi hoàn thành stage "Act" (quiz passed):
   a. POST /agent/events {event_type: "quiz_submitted", lesson_id, score, passed}
   b. GET /agent/learner/:id/next
   c. Hiển thị decision: "Bài tiếp theo: [title]" + rationale
5. Student click "Tiếp tục" → navigate đến next lesson
```

**Code snippet cho `page.html`:**

```javascript
// Trong page.html <script> block hoặc page.js

async function onQuizComplete(lessonId, score, passed) {
  // 1. Ghi event
  await fetch('/api/agent/events', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event_type: 'quiz_submitted',
      lesson_id: lessonId,
      score,
      passed,
      payload: { quiz_id: currentQuizId, time_spent_s: getSessionTime() },
    })
  });

  // 2. Lấy recommendation
  const resp = await fetch(`/api/agent/learner/${getUserId()}/next?subject=toan`, {
    headers: { 'Authorization': `Bearer ${getToken()}` }
  });
  const { action_type, target_lesson, rationale } = await resp.json();

  // 3. Hiển thị UI
  showNextLessonModal({ action_type, target_lesson, rationale });
}

function showNextLessonModal({ action_type, target_lesson, rationale }) {
  const modal = document.getElementById('next-lesson-modal');
  const icons = {
    repair_lesson: '🔧', level_upgrade: '🚀', level_downgrade: '📖',
    bloom_bridge: '🌉', next_lesson: '➡️', no_action: '✅'
  };
  modal.innerHTML = `
    <div class="modal-icon">${icons[action_type] || '📚'}</div>
    <p class="rationale">${rationale}</p>
    ${target_lesson ? `
      <div class="next-lesson-card">
        <span class="bloom-badge">Bloom ${target_lesson.bloom_level}</span>
        <h3>${target_lesson.title}</h3>
        <span class="model-badge">${target_lesson.lesson_model}</span>
      </div>
      <button onclick="navigateToLesson('${target_lesson.lesson_id}')">
        Bắt đầu bài tiếp theo
      </button>
    ` : '<button onclick="closeModal()">Tiếp tục ôn tập</button>'}
  `;
  modal.style.display = 'flex';
}
```

---

### 3.3 Python Grader Integration [P2]

**Approach:** REST Bridge endpoint tại Worker, forward đến Python grader service

**Worker route:**

```javascript
// worker/index.js
if (path === '/api/grade/code' && method === 'POST')
  return handleCodeGrade(request, env, { json });
```

**File:** `worker/src/handlers/graderHandler.js`

```javascript
// worker/src/handlers/graderHandler.js

/**
 * Bridge đến Python Grader (tự host hoặc Judge0)
 * Config: env.PYTHON_GRADER_URL, env.PYTHON_GRADER_KEY
 *
 * Request body:
 * { submission_id, code, language: 'python', test_cases: [...] }
 *
 * Response:
 * { passed, score, feedback: [{test_case, status, output, expected}] }
 */
export async function handleCodeGrade(request, env, { json }) {
  const auth = request.headers.get('Authorization') || '';
  const session = await verifyToken(auth.replace('Bearer ',''), getTokenSecret(env));
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const graderUrl = env.PYTHON_GRADER_URL;
  if (!graderUrl) return json({ error: 'Grader not configured' }, 503);

  const body = await request.json();

  const resp = await fetch(`${graderUrl}/grade`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': env.PYTHON_GRADER_KEY || '',
    },
    body: JSON.stringify(body),
  });

  const result = await resp.json();

  // Auto-submit event nếu grading thành công
  if (result.score != null && body.lesson_id) {
    await env.D1.prepare(`
      INSERT INTO events (student_id, lesson_id, event_type, payload, score, passed)
      VALUES (?, ?, 'assignment_submitted', ?, ?, ?)
    `).bind(session.userId, body.lesson_id, JSON.stringify(result), result.score, result.passed ? 1 : 0).run();
  }

  return json(result);
}
```

**Wrangler config (thêm vào `worker/wrangler.toml`):**

```toml
[vars]
PYTHON_GRADER_URL = ""  # Set via wrangler secret

# Secret: wrangler secret put PYTHON_GRADER_KEY
```

---

### 3.4 Analytics Dashboard [P1]

**Thêm vào `admin/dashboard.js`:**

**Charts cần hiển thị:**
1. **Bloom Distribution Heatmap** — phân phối mastery theo bloom level × grade
2. **Rule Firing Frequency** — R01-R09 được kích hoạt bao nhiêu lần/tuần
3. **Level Transition Flow** — Sankey chart: nen_tang → mo_rong → chuyen_sau (và ngược lại)
4. **Event Volume Timeseries** — số events/ngày theo event_type
5. **At-Risk Students** — học sinh có consecutive_fail > 2 hoặc dormant_days > 7

**Worker route mới:**

```javascript
// worker/index.js
if (path === '/api/analytics/agent-overview' && method === 'GET')
  return handleAgentAnalyticsOverview(request, env, { json });
```

**Query SQL cho agent overview:**

```sql
-- Rule firing frequency (7 ngày gần nhất)
SELECT trigger_type, COUNT(*) as count
FROM agent_decisions
WHERE created_at > datetime('now', '-7 days')
GROUP BY trigger_type ORDER BY count DESC;

-- At-risk students
SELECT student_id, consecutive_fail, dormant_days, current_level
FROM learner_models
WHERE consecutive_fail >= 2 OR dormant_days >= 7
ORDER BY consecutive_fail DESC, dormant_days DESC LIMIT 20;

-- Bloom profile distribution (class-level)
SELECT
  json_extract(bloom_profile, '$.1') as bloom1,
  json_extract(bloom_profile, '$.2') as bloom2,
  json_extract(bloom_profile, '$.3') as bloom3,
  AVG(CAST(json_extract(bloom_profile, '$.1') as REAL)) as avg_b1,
  AVG(CAST(json_extract(bloom_profile, '$.2') as REAL)) as avg_b2,
  AVG(CAST(json_extract(bloom_profile, '$.3') as REAL)) as avg_b3
FROM learner_models WHERE subject = 'toan';
```

---

## PHASE 4: Learning Agent + LLM (Tháng 9–12)

---

### 4.1 Anthropic API Integration [P1]

**Điều kiện:** `env.ANTHROPIC_API_KEY` đã có trong Worker secrets.

**Hiện tại** `worker/src/handlers/aiAgentHandler.js` đã có `callAI()` helper — Phase 4 mở rộng để:

1. **Personalized rationale**: thay vì template text, gọi Claude để tạo giải thích theo ngữ cảnh cụ thể của student
2. **Error analysis**: nhận list error_patterns, gọi Claude để phân tích nguyên nhân
3. **Content generation**: tạo bài tập mới theo Bloom level + lesson model

**Config trong `curriculum_rules`:**

```json
// Thêm field vào R01-R09 config để bật LLM:
{
  "use_llm_rationale": true,
  "llm_max_tokens": 150,
  "llm_system_prompt": "Bạn là giáo viên toán THPT, giải thích ngắn gọn bằng tiếng Việt cho học sinh lớp 10-12..."
}
```

**File:** `worker/src/llmRationale.js`

```javascript
// worker/src/llmRationale.js

export async function generateLLMRationale(env, decision, learnerModel, currentLesson) {
  if (!env.ANTHROPIC_API_KEY) return decision.rationale; // Fallback to template

  const systemPrompt = `Bạn là AURA — AI tutor toán THPT. Hãy giải thích quyết định học tập bằng tiếng Việt,
thân thiện, khuyến khích, tối đa 2 câu. KHÔNG dùng emoji.`;

  const userMessage = `Học sinh đang học: "${currentLesson?.title || 'chưa rõ'}" (Bloom ${currentLesson?.bloom_level}).
Quyết định: ${decision.action_type}.
Lý do kỹ thuật: ${decision.rules_evaluated.find(r => r.fired)?.reason || 'N/A'}.
Hãy viết message khuyến khích cho học sinh.`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-3-5',  // Fast + cheap cho inline feedback
      max_tokens: 150,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!resp.ok) return decision.rationale;
  const data = await resp.json();
  return data.content?.[0]?.text || decision.rationale;
}
```

---

### 4.2 A/B Testing Framework [P2]

**D1 table mới:** trong `0006_aura_ab_testing.sql`

```sql
CREATE TABLE IF NOT EXISTS ab_experiments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  experiment_id TEXT    NOT NULL UNIQUE,
  name          TEXT    NOT NULL,
  description   TEXT,
  variants      TEXT    NOT NULL DEFAULT '[]',  -- JSON [{id, name, weight, config}]
  status        TEXT    NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','running','completed','paused')),
  metric        TEXT    NOT NULL,  -- 'lesson_completion_rate' | 'mastery_gain' | 'session_retention'
  started_at    TEXT,
  ended_at      TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ab_assignments (
  student_id    INTEGER NOT NULL,
  experiment_id TEXT    NOT NULL,
  variant_id    TEXT    NOT NULL,
  assigned_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (student_id, experiment_id)
);
```

**Sử dụng trong Curriculum Planner:**

```javascript
// curriculumPlanner.js — trong runCurriculumPlanner()
// Nếu có A/B experiment đang chạy, ghi đè decision
const abVariant = await getABVariant(env, studentId, 'planner_rule_weights');
if (abVariant) {
  // Apply variant config (e.g. thay đổi threshold của R03)
  Object.assign(rules.R03, abVariant.config);
}
```

---

### 4.3 ML Layer cho Curriculum Planner [P2]

**Approach:** Offline training (Python/scikit-learn), export model weights vào D1, Worker dùng simple scoring.

**D1 table:**

```sql
CREATE TABLE IF NOT EXISTS ml_model_weights (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  model_name  TEXT    NOT NULL,  -- 'rule_weight_predictor'
  version     TEXT    NOT NULL,
  weights     TEXT    NOT NULL,  -- JSON serialized weights
  features    TEXT    NOT NULL,  -- JSON list of feature names
  accuracy    REAL,
  trained_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  active      INTEGER NOT NULL DEFAULT 0
);
```

**Training pipeline (offline, Python):**

```python
# scripts/train_rule_predictor.py
# Input: agent_decisions với outcome_passed (labeled data)
# Features: bloom_level, consecutive_fail, mastery_avg, dormant_days, level, ...
# Target: action_type → one-hot
# Model: Random Forest (scikit-learn) → export coefficients as JSON
# Deploy: PUT /admin/ml/upload-weights
```

---

### 4.4 Multi-subject Expansion [P2]

**Thêm môn học:** Vật lý, Hóa học, Ngữ văn

**Chuẩn bị từ Phase 1:**
- `lessons.subject` đã có (TEXT field)
- `learner_models` UNIQUE(student_id, subject) — mỗi môn 1 row riêng
- Import scripts tương tự `import_lessons.js` với `subject = 'ly'`, `'hoa'`, etc.

**NocoDB:** Thêm field `Subject` vào Courses table để lọc theo môn.

---

## Bảng ánh xạ SRS → Tech Stack hiện tại

| SRS Component | SRS Location | AURA Tech Stack | File/Table | Trạng thái |
|--------------|-------------|----------------|-----------|-----------|
| 784 YCCĐ Toán | hoclieu_toan.json | D1 `lessons` table | `0004_aura_lessons.sql` | PLAN P0 |
| Learner Model: mastery_map | SRS §4.2 | D1 `learner_models.mastery_map` JSON | `0005_aura_learner_agent.sql` | PLAN P0 |
| Learner Model: bloom_profile | SRS §4.2 | D1 `learner_models.bloom_profile` JSON | `0005_aura_learner_agent.sql` | PLAN P0 |
| Learner Model: error_patterns | SRS §4.2 | D1 `learner_models.error_patterns` JSON | `0005_aura_learner_agent.sql` | PLAN P0 |
| Learner Model: speed_profile | SRS §4.2 | D1 `learner_models.speed_profile` JSON | `0005_aura_learner_agent.sql` | PLAN P0 |
| Learner Model: consecutive_pass/fail | SRS §4.2 | D1 `learner_models.consecutive_pass/fail` | `0005_aura_learner_agent.sql` | PLAN P0 |
| Event: quiz_submitted | SRS §5.1 | D1 `events` table (event_type) | `eventHandler.js` | PLAN P0 |
| Event: lesson_completed | SRS §5.1 | D1 `events` table | `eventHandler.js` | PLAN P0 |
| Event: teacher_override | SRS §5.1 | D1 `events` table | `eventHandler.js` | PLAN P1 |
| 9 Rules R01-R09 | SRS §6 | `curriculumPlanner.js` | `worker/src/curriculumPlanner.js` | PLAN P0 |
| Agent Decisions Log | SRS §7 | D1 `agent_decisions` table | `0005_aura_learner_agent.sql` | PLAN P0 |
| Configurable Rules | SRS §6 | D1 `curriculum_rules` table | `0005_aura_learner_agent.sql` | PLAN P0 |
| 5-Stage Lesson | SRS §3.2 | `lessons.stage_config` JSON + `lesson_sessions` | `0005_aura_learner_agent.sql` | PLAN P1 |
| 8 Lesson Models | SRS §3.1 | `lessons.lesson_model` TEXT ENUM | D1 lessons | PLAN P0 |
| 3 Level Tiers | SRS §3.3 | `lessons.level_default` + `learner_models.current_level` | D1 | PLAN P0 |
| API: /agent/learner/:id/model | SRS §8.1 | Worker GET `/agent/learner/:id/model` | `learnerModelHandler.js` | PLAN P0 |
| API: /agent/learner/:id/next | SRS §8.2 | Worker GET `/agent/learner/:id/next` | `agentHandler.js` | PLAN P0 |
| API: /agent/events | SRS §8.3 | Worker POST/GET `/agent/events` | `eventHandler.js` | PLAN P0 |
| API: /agent/decisions | SRS §8.4 | Worker GET `/agent/decisions` | `agentHandler.js` | PLAN P1 |
| API: /agent/rules | SRS §8.5 | Worker GET/PUT `/agent/rules` | `agentHandler.js` | PLAN P1 |
| Python Grader | SRS §9 | Worker bridge `/api/grade/code` | `graderHandler.js` | PLAN P2 |
| Anthropic LLM | SRS §10 (Phase 3) | `aiAgentHandler.js` callAI() + `llmRationale.js` | Phase 4 | PLAN P1 (Phase 4) |
| A/B Testing | SRS §11 | D1 `ab_experiments`, `ab_assignments` | `0006_aura_ab_testing.sql` | PLAN P2 |
| ML Layer | SRS §12 (Phase 2) | D1 `ml_model_weights` | Phase 4.3 | PLAN P2 |
| Analytics: bloom heatmap | SRS §7 | `/api/analytics/agent-overview` | `analyticsHandler.js` | PLAN P1 |
| BKT Mastery (đã có) | SRS §4.1 | D1 `student_mastery.bkt_state` | `0001_phase2_analytics.sql` | DONE |
| xAPI Events (đã có) | SRS §5 | D1 `xapi_statements` | `0003_phase2_xapi_extended.sql` | DONE |
| AI Sessions (đã có) | — | D1 `ai_sessions` | `0001_phase2_analytics.sql` | DONE |
| Spaced Repetition (đã có) | — | D1 `spaced_repetition` | `0001_phase2_analytics.sql` | DONE |
| Auth/JWT (đã có) | — | `authHandler.js` | Worker | DONE |
| NocoDB Articles/Courses (đã có) | — | NocoDB REST | Worker `pageHandler.js` | DONE |

---

## Checklist ưu tiên (ngay hôm nay)

### P0 — Làm ngay (Day 1-3)

- [ ] **[DB]** Tạo `worker/migrations/0004_aura_lessons.sql` (copy từ section 1.1 trên)
- [ ] **[DB]** Tạo `worker/migrations/0005_aura_learner_agent.sql` (copy từ section 1.2 trên)
- [ ] **[DEPLOY]** Chạy migrations: `npx wrangler d1 execute aura-analytics --file=migrations/0004_aura_lessons.sql`
- [ ] **[DEPLOY]** Chạy migrations: `npx wrangler d1 execute aura-analytics --file=migrations/0005_aura_learner_agent.sql`
- [ ] **[DATA]** Kiểm tra `content/hoclieu_toan.json` có tồn tại không; nếu không, tạo từ SRS schema
- [ ] **[DATA]** Viết + chạy `worker/scripts/import_lessons.js` để import 784 YCCĐ
- [ ] **[VERIFY]** Chạy query verify: `SELECT COUNT(*), grade_num FROM lessons GROUP BY grade_num`
- [ ] **[CODE]** Tạo `worker/src/handlers/learnerModelHandler.js`
- [ ] **[CODE]** Tạo `worker/src/handlers/eventHandler.js`
- [ ] **[CODE]** Tạo `worker/src/handlers/lessonHandler.js`
- [ ] **[CODE]** Thêm routes vào `worker/index.js` (4 new import blocks)
- [ ] **[DEPLOY]** `npx wrangler deploy` từ `worker/` directory

### P1 — Tuần 1-2

- [ ] **[CODE]** Tạo `worker/src/curriculumPlanner.js` (9 rules)
- [ ] **[CODE]** Tạo `worker/src/handlers/agentHandler.js` (GET /next + /decisions + /rules)
- [ ] **[CODE]** Tạo `worker/src/feedbackEngine.js`
- [ ] **[CODE]** Thêm `agentHandler` routes vào `worker/index.js`
- [ ] **[TEST]** Viết test cho từng rule R01-R09 với mock learner model
- [ ] **[UI]** Thêm `LessonId` field vào NocoDB Articles table qua NocoDB admin
- [ ] **[UI]** Thêm lesson-id dropdown vào Admin article editor
- [ ] **[DEPLOY]** Deploy và test end-to-end: POST event → GET /next → verify decision log

### P2 — Tháng 1-2

- [ ] **[UI]** Tạo `admin/modules/lesson-builder.html` (5-stage builder)
- [ ] **[UI]** Thêm "Agent Decisions" tab vào `admin/dashboard.html`
- [ ] **[UI]** Cập nhật `page.html` với adaptive navigation + next lesson modal
- [ ] **[CODE]** Tạo `worker/src/handlers/graderHandler.js`
- [ ] **[CODE]** Tạo `worker/migrations/0006_aura_ab_testing.sql`
- [ ] **[ANALYTICS]** Thêm `handleAgentAnalyticsOverview` vào `analyticsHandler.js`
- [ ] **[CONFIG]** Set `PYTHON_GRADER_URL` secret nếu có grader service

### Phase 4 Prerequisites (chuẩn bị trước tháng 9)

- [ ] Thu thập ít nhất 1000 `agent_decisions` với `outcome_passed` được fill (labeled data cho ML)
- [ ] Verify `ANTHROPIC_API_KEY` secret trong Worker
- [ ] Đọc `worker/src/handlers/aiAgentHandler.js` để hiểu `callAI()` interface trước khi viết `llmRationale.js`
- [ ] Setup A/B experiment framework trước khi có đủ users để test

---

## Dependency Graph

```
0004_lessons.sql
    └── import_lessons.js         [cần 0004 trước]
        └── lessonHandler.js      [cần data]
            └── eventHandler.js   [cần lessons để lookup bloom_level]
                └── curriculumPlanner.js  [cần events + learner_models]
                    └── agentHandler.js   [gọi curriculumPlanner]

0005_learner_agent.sql
    └── learnerModelHandler.js    [cần 0005 trước]
        └── agentHandler.js       [gọi learnerModelHandler]

curriculumPlanner.js
    └── feedbackEngine.js         [cần decision object]
    └── llmRationale.js           [Phase 4, cần ANTHROPIC_API_KEY]

admin/dashboard.html (agent tab)
    └── agentHandler.js           [cần decisions table]
    └── analyticsHandler.js       [extend existing]

page.html (adaptive nav)
    └── agentHandler.js GET /next [cần curriculumPlanner deployed]
```

---

## File Structure Summary (files mới cần tạo)

```
worker/
  migrations/
    0004_aura_lessons.sql              ← NEW (P0)
    0005_aura_learner_agent.sql        ← NEW (P0)
    0006_aura_ab_testing.sql           ← NEW (P2)
  scripts/
    import_lessons.js                  ← NEW (P0)
  src/
    curriculumPlanner.js               ← NEW (P0)
    feedbackEngine.js                  ← NEW (P1)
    llmRationale.js                    ← NEW (Phase 4)
    handlers/
      lessonHandler.js                 ← NEW (P0)
      learnerModelHandler.js           ← NEW (P0)
      eventHandler.js                  ← NEW (P0)
      agentHandler.js                  ← NEW (P0)
      graderHandler.js                 ← NEW (P2)
      analyticsHandler.js              ← EXTEND existing
  index.js                             ← EXTEND (add routes)

admin/
  modules/
    lesson-builder.html                ← NEW (P1)
  dashboard.html                       ← EXTEND (add agent tab)
  dashboard.js                         ← EXTEND (add loadDecisions, renderRules)

content/
  hoclieu_toan.json                    ← VERIFY exists or CREATE
```

---

*Kế hoạch này đủ chi tiết để developer bắt đầu ngay từ Phase 1 Day 1 mà không cần hỏi thêm về schema hay API contract. Mọi code snippet đều là production-ready pseudocode, cần test và adjust thresholds dựa trên data thực tế.*

*Review lại kế hoạch này sau mỗi sprint (2 tuần) để cập nhật trạng thái checklist.*

---
---

# PHẦN B — KHUNG KỸ THUẬT PHẦN MỀM (Theo Pressman & Maxim, 9th Ed.)

> Tài liệu tham chiếu: *Software Engineering: A Practitioner's Approach* — Roger S. Pressman & Bruce R. Maxim (McGraw-Hill, 2019)
> Áp dụng các chương: Ch.3 (Agility), Ch.4 (Recommended Process), Ch.7-8 (Requirements), Ch.9-10 (Architecture), Ch.15-17 (Quality), Ch.19-20 (Testing), Ch.22 (SCM), Ch.23 (Metrics), Ch.26 (Risk)

---

## B.1 Mô hình quy trình phát triển — Agile Incremental

**Cơ sở lý thuyết (Pressman Ch.3–4):**
> "Any agile software process is characterized by an incremental delivery strategy that gets working software to the customer as rapidly as feasible."

AURA áp dụng **Agile Incremental** với Sprint 2 tuần:

```
┌─────────────────────────────────────────────────────────┐
│              AURA AGILE PROCESS MODEL                   │
│                                                         │
│  Sprint 0 (Setup)  →  Sprint 1-6 (Phase 1)             │
│  Sprint 7-16 (Phase 2)  →  Sprint 17-26 (Phase 3)      │
│  Sprint 27+ (Phase 4 — Learning Agent)                  │
│                                                         │
│  Mỗi Sprint:                                            │
│  ┌──────────┬──────────┬──────────┬──────────┐          │
│  │ Day 1-2  │ Day 3-8  │ Day 9-10 │ Day 10   │          │
│  │ Planning │ Develop  │ Test     │ Review   │          │
│  │ (backlog)│ + review │ + deploy │ +retro   │          │
│  └──────────┴──────────┴──────────┴──────────┘          │
└─────────────────────────────────────────────────────────┘
```

### Sprint Backlog ưu tiên (áp dụng Scrum — Ch.3.4)

| Sprint | Deliverable | Điều kiện "Done" (DoD) |
|--------|-------------|------------------------|
| S1 | D1 migration `0004` + `0005` chạy OK | `wrangler d1 execute` không lỗi, 5 bảng tồn tại |
| S2 | Import 784 lessons từ JSON | Query `SELECT COUNT(*) FROM lessons` = 784 |
| S3 | Learner Model CRUD API `/agent/learner/:id/model` | Postman test: GET/PATCH trả đúng schema |
| S4 | Event Pipeline `/agent/events` xử lý 9 loại | 100 events ghi vào D1 < 500ms (SRS TC05) |
| S5 | Rules R01-R03 (Critical) | TC01, TC02, TC03 pass |
| S6 | Rules R04-R09 + `/agent/learner/:id/next` | Agent trả `lesson_id` + `reason` cho mọi case |
| S7 | Pilot 1 lớp (30 HS) — Toán 8 | Không có critical bug trong 2 tuần pilot |
| S8 | 5-Stage Lesson Builder UI | Admin có thể tạo bài với 5 giai đoạn |
| ... | ... | ... |

---

## B.2 Đặc tả yêu cầu & Ma trận truy xuất nguồn gốc

**Cơ sở lý thuyết (Pressman Ch.7 — Requirements Traceability):**
> "Traceability provides a foundation for understanding the dependencies between requirements and design elements."

### Ma trận yêu cầu → Hiện thực (RTM)

| ID | Yêu cầu (từ SRS v1.0) | Loại | Components | Status |
|----|-----------------------|------|------------|--------|
| REQ-01 | Ghi event log mọi hành động HS (< 100ms) | Functional | `eventHandler.js`, D1 `events` | TODO |
| REQ-02 | Learner Model cập nhật sau mỗi quiz (< 200ms) | Performance | `curriculumPlanner.js`, `learnerModelHandler.js` | TODO |
| REQ-03 | Curriculum Planner quyết định bài tiếp theo (< 300ms) | Functional | `agentHandler.js GET /next` | TODO |
| REQ-04 | Mọi quyết định Agent có `reason` text (Explainable AI) | Non-Functional | `agent_decisions.reason` NOT NULL | TODO |
| REQ-05 | 784 YCCĐ Toán lớp 1-12 sẵn sàng trong DB | Data | D1 `lessons`, import script | TODO |
| REQ-06 | 9 luật R01-R09 hoạt động đúng | Functional | 9 test cases TC01-TC09 | TODO |
| REQ-07 | Giáo viên override được quyết định Agent | Functional | `POST /agent/decisions/:id/override` | TODO |
| REQ-08 | Bảo mật: không lộ data giữa học sinh | Security | JWT check, 403 on cross-access | TODO |
| REQ-09 | Python Grader tích hợp (submit → result < 10s) | Integration | `graderHandler.js`, external Grader API | TODO |
| REQ-10 | Snapshot Learner Model sau mỗi session | Reliability | `learner_model_snapshots` table | TODO |
| REQ-11 | Push notification khi dormant > 48h (R04) | Functional | `notification_queue` + scheduler | TODO |
| REQ-12 | Analytics Dashboard cho giáo viên | UI | `admin/dashboard.html` agent tab | TODO |
| REQ-13 | Response time P95 < 1s dưới 500 concurrent users | Performance | Load test `k6` | TODO |
| REQ-14 | LLM Feedback tiếng Việt (Phase 3) | Functional | `llmRationale.js`, Anthropic API | Phase 4 |
| REQ-15 | A/B testing luật Agent | Research | `ab_experiments` D1 table | Phase 4 |

### Use Cases chính (Pressman Ch.8 — Use Case Modeling)

```
UC-01: Học sinh bắt đầu phiên học
  Actor: Student
  Precondition: Đã đăng nhập
  Flow: session_started event → Agent kiểm tra R04 → chọn bài phù hợp giờ học
  Postcondition: Learner Model.last_session_at cập nhật

UC-02: Học sinh nộp quiz
  Actor: Student
  Precondition: Đang trong bài học
  Flow: quiz_submitted event → Cập nhật mastery_map → Chạy luật R01-R03 → Trả next lesson
  Postcondition: agent_decisions có 1 record mới với reason

UC-03: Giáo viên override bài học
  Actor: Teacher
  Precondition: Xem agent_decisions của học sinh cụ thể
  Flow: teacher_override event → Ghi audit log → Agent dùng bài GV chọn
  Postcondition: override_count tăng, Phase 3 học từ pattern này

UC-04: Agent trigger bài Repair
  Actor: System (AI Agent)
  Precondition: HS mắc cùng lỗi ≥ 3 lần (R01)
  Flow: Quiz error detected → R01 fire → Insert repair lesson → Notify teacher
  Postcondition: Repair lesson xuất hiện trong learning path của HS

UC-05: Admin xem Decision Log
  Actor: Admin/Teacher
  Flow: GET /agent/decisions?learner_id=X → Hiển thị bảng rule/reason/confidence
  Postcondition: Audit trail rõ ràng, GV có thể review từng quyết định
```

---

## B.3 Kiến trúc phần mềm — Phân tích theo Pressman

**Cơ sở lý thuyết (Pressman Ch.10 — Architectural Design):**
> "Architecture represents the structure of the data and program components that are required to build a computer-based system."

### B.3.1 Architectural Style — Event-Driven + Layered

AURA áp dụng **kết hợp 2 kiểu kiến trúc** từ Pressman's Taxonomy (Ch.10.3):

```
┌─────────────────────────────────────────────────────────────────┐
│  LAYERED ARCHITECTURE (Presentation → Business → Data)         │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ L1: Presentation  — index.html, admin/dashboard.html    │   │
│  │ L2: API Gateway   — Cloudflare Worker (worker/index.js) │   │
│  │ L3: Business Logic— handlers/*.js, curriculumPlanner.js │   │
│  │ L4: Data          — NocoDB REST + D1 SQLite             │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  EVENT-DRIVEN OVERLAY (cắt ngang các lớp)                      │
│  Student Action → eventHandler → D1 events → Agent Subscribe   │
│                ↗                                      ↘         │
│          LMS (NocoDB)               Curriculum Planner          │
│                                            ↓                    │
│                                   agent_decisions + next lesson  │
└─────────────────────────────────────────────────────────────────┘
```

### B.3.2 Design Concepts áp dụng (Pressman Ch.9)

| Concept | Áp dụng trong AURA |
|---------|-------------------|
| **Modularity** | Mỗi handler = 1 module độc lập (`eventHandler`, `agentHandler`, `lessonHandler`) |
| **Information Hiding** | `curriculumPlanner.js` chỉ expose `getNextLesson(learnerId, subject)` |
| **Separation of Concerns** | Rules R01-R09 tách khỏi business logic chính |
| **Cohesion** | Mỗi rule là pure function: `(learnerModel) → decision` |
| **Coupling** | Handler ↔ Planner giao tiếp qua interface, không trực tiếp query D1 |
| **Refactoring** | Phase 2: Refactor `action_logs` thành `events` chuẩn SRS |

### B.3.3 Component Diagram (theo Pressman Ch.11)

```
┌─────────────────┐   events   ┌──────────────────┐
│  LMS Core       │ ─────────> │  Event Handler   │
│  (NocoDB +      │            │  eventHandler.js  │
│   Worker API)   │ <───────── │  POST /agent/     │
└─────────────────┘  next      │  events           │
                     lesson    └─────────┬─────────┘
                                         │ update
                                         ▼
┌─────────────────┐           ┌──────────────────────┐
│  Student UI     │           │  Learner Model Store  │
│  index.html     │           │  D1: learner_models   │
│  page.html      │           │  + learner_model_     │
└───────┬─────────┘           │    snapshots          │
        │ GET /next            └──────────┬───────────┘
        ▼                                 │ read
┌─────────────────┐           ┌──────────▼───────────┐
│  Agent Handler  │ ──rules─> │ Curriculum Planner   │
│  agentHandler.js│           │ curriculumPlanner.js  │
│  GET /next      │ <──────── │ evaluateRules(R01-R09)│
└─────────────────┘  decision └──────────────────────┘
        │ write
        ▼
┌─────────────────┐
│ agent_decisions │
│ D1 table        │
│ (audit log)     │
└─────────────────┘
```

---

## B.4 Kế hoạch kiểm thử toàn diện (Pressman Ch.19-21)

**Cơ sở lý thuyết (Pressman Ch.19.1):**
> "Software testing is a process of executing a program with the intent of finding an error. A good test case is one that has a high probability of finding an as-yet-undiscovered error."

### B.4.1 Chiến lược kiểm thử 3 lớp

```
        ┌──────────────────────────────────┐
        │   Acceptance Tests (SRS TC01-10)  │ ← 10 test cases từ SRS Ch.6
        │   API Contract Tests (Postman)    │
        ├──────────────────────────────────┤
        │   Integration Tests               │
        │   Event → Planner → Decision      │
        ├──────────────────────────────────┤
        │   Unit Tests (Jest)               │
        │   9 rules R01-R09                 │
        │   Learner Model update functions  │
        └──────────────────────────────────┘
```

### B.4.2 Unit Test Cases — 9 Rules (White-Box Testing, Ch.19.4)

```javascript
// worker/src/__tests__/curriculumPlanner.test.js

describe('Rule R01 — Repair Trigger', () => {
  test('R01: same error type ≥3 times → insert Repair', () => {
    const model = {
      mastery_map: { '020108.0202a6': 0.35 },
      error_patterns: [
        { type: 'index_error', count: 3, lesson_id: '020108.0202a6', last_seen: Date.now() - 1000 }
      ]
    };
    const decision = evaluateRules(model, '020108.0202a6');
    expect(decision.rule_triggered).toBe('R01');
    expect(decision.action).toBe('insert_repair');
    expect(decision.reason).not.toBe(''); // Explainable AI
  });
});

describe('Rule R02 — Downgrade', () => {
  test('R02: score < 0.5 AND time > 200% median → downgrade', () => {
    const model = {
      current_level: 'mo_rong',
      speed_profile: { toan: 0.45 } // 45% median = 200% time
    };
    const quizResult = { score: 0.45, duration_sec: 680, lesson_median: 300 };
    const decision = evaluateRules(model, '020108.0202b6', quizResult);
    expect(decision.rule_triggered).toBe('R02');
    expect(decision.new_level).toBe('nen_tang');
    expect(decision.notify_teacher).toBe(true);
  });
});

describe('Rule R03 — Upgrade', () => {
  test('R03: score > 0.85, fast, 3 consecutive passes → upgrade', () => {
    const model = {
      current_level: 'nen_tang',
      consecutive_pass: 3,
      speed_profile: { toan: 2.2 } // 2.2x median = 45% time
    };
    const quizResult = { score: 0.88, duration_sec: 130, lesson_median: 300 };
    const decision = evaluateRules(model, '020108.0202c1', quizResult);
    expect(decision.rule_triggered).toBe('R03');
    expect(decision.new_level).toBe('mo_rong');
    expect(decision.requires_teacher_confirm).toBe(true);
  });
});

describe('Rule R04 — Dormant Learner', () => {
  test('R04: last session > 48h → suggest short lesson', () => {
    const model = {
      last_session_at: new Date(Date.now() - 50 * 3600000).toISOString()
    };
    const decision = evaluateRules(model);
    expect(decision.rule_triggered).toBe('R04');
    expect(decision.max_duration_min).toBeLessThanOrEqual(15);
  });
});

// TC01 (SRS Critical) — bao phủ trong R01 test
// TC02 (SRS Critical) — bao phủ trong R02 test
// TC03 (SRS High)     — bao phủ trong R03 test
```

### B.4.3 Integration Test — Event Flow End-to-End

```javascript
// worker/src/__tests__/eventFlow.integration.test.js
// Pressman Ch.20: Integration Testing — Bottom-Up

describe('Event Pipeline Integration', () => {
  test('TC05: 100 concurrent events → all processed correctly', async () => {
    const events = Array.from({ length: 100 }, (_, i) => ({
      event_type: 'quiz_submitted',
      learner_id: `learner_${i}`,
      lesson_id: '020108.0202a6',
      payload: { score: Math.random(), duration_sec: 300 }
    }));
    
    const start = Date.now();
    const results = await Promise.all(events.map(e => 
      fetch('/agent/events', { method: 'POST', body: JSON.stringify([e]) })
    ));
    const duration = Date.now() - start;
    
    expect(results.every(r => r.status === 202)).toBe(true);
    expect(duration).toBeLessThan(500); // SRS: < 500ms
    
    // Verify all events persisted
    const count = await D1.query('SELECT COUNT(*) FROM events WHERE created_at > ?', [new Date(start).toISOString()]);
    expect(count).toBe(100);
  });
});
```

### B.4.4 Black-Box Test Cases — Boundary Value Analysis (Ch.19.5.3)

| Test | Input (Ranh giới) | Expected | SRS TC |
|------|-------------------|----------|--------|
| BVA-01 | `mastery_score = 0.5` (ngưỡng R01) | R01 NOT triggered | TC01 |
| BVA-02 | `mastery_score = 0.49` | R01 triggered | TC01 |
| BVA-03 | `quiz_score = 0.85` (ngưỡng R03) | R03 NOT triggered | TC03 |
| BVA-04 | `quiz_score = 0.851` | R03 triggered (kèm kiều kiện khác) | TC03 |
| BVA-05 | `duration = 2.0x median` (ngưỡng R02) | R02 NOT triggered | TC02 |
| BVA-06 | `duration = 2.01x median` | R02 triggered | TC02 |
| BVA-07 | `last_session = 48h ago exactly` | R04 NOT triggered | — |
| BVA-08 | `last_session = 48h + 1min` | R04 triggered | — |
| BVA-09 | `consecutive_pass = 2` | R03 NOT triggered | TC03 |
| BVA-10 | `consecutive_pass = 3` | R03 TRIGGERED | TC03 |

### B.4.5 Security Testing (Pressman Ch.18, 21.7)

```javascript
describe('TC10: Data Privacy — Cross-learner access prevention', () => {
  test('HS A không thể đọc model của HS B', async () => {
    const tokenA = await login('student_a');
    const learnerB_id = 'uuid-of-learner-b';
    
    const res = await fetch(`/agent/learner/${learnerB_id}/model`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    
    expect(res.status).toBe(403); // SRS TC10: Critical
    // Verify audit log entry
    const auditLog = await D1.query(
      'SELECT * FROM events WHERE event_type = ? AND learner_id = ?',
      ['unauthorized_access_attempt', learnerB_id]
    );
    expect(auditLog.length).toBe(1); // Phải ghi audit
  });
});
```

### B.4.6 Performance Testing (Pressman Ch.21.8)

**Tool:** k6 (thay thế JMeter cho Cloudflare Worker)

```javascript
// k6/load_test.js
import http from 'k6/http';
import { check, sleep } from 'k6';

export let options = {
  stages: [
    { duration: '2m', target: 100 },  // Ramp up
    { duration: '5m', target: 500 },  // SRS TC07: 500 concurrent users
    { duration: '2m', target: 0 },    // Ramp down
  ],
  thresholds: {
    'http_req_duration': ['p(95)<1000', 'p(99)<2000'], // SRS TC07
    'http_req_failed': ['rate<0.01'],                   // < 1% error rate
  },
};

export default function () {
  // Simulate: student submits quiz
  const quizResult = http.post(`${BASE_URL}/agent/events`, JSON.stringify([{
    event_type: 'quiz_submitted',
    learner_id: `learner_${Math.floor(Math.random() * 500)}`,
    lesson_id: '020108.0202a6',
    payload: { score: 0.75, duration_sec: 280, attempt: 1 }
  }]), { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` } });
  
  check(quizResult, {
    'event queued (202)': (r) => r.status === 202,
    'response < 500ms (SRS agent decision)': (r) => r.timings.duration < 500,
  });
  
  sleep(1);
}
```

---

## B.5 Quản lý rủi ro — RMMM Plan (Pressman Ch.26)

**Cơ sở lý thuyết:** RMMM = Risk Mitigation, Monitoring, and Management

### B.5.1 Bảng rủi ro (Risk Table)

| ID | Rủi ro | Xác suất | Tác động | Điểm RE | Chiến lược |
|----|--------|----------|---------|---------|-----------|
| R-01 | **NocoDB schema không có field cần thiết** (ModuleId, bloom_level...) | Cao (0.8) | Trung bình (0.5) | **0.40** | Dùng D1 làm source of truth cho Agent data; NocoDB chỉ cho content |
| R-02 | **Cloudflare D1 latency spike** > 300ms under load | Trung bình (0.5) | Cao (0.7) | **0.35** | Thêm Cloudflare KV cache cho hot Learner Models |
| R-03 | **AI Agent rules sai sư phạm** — giảm/tăng mức không đúng | Trung bình (0.4) | Cao (0.8) | **0.32** | Pilot 1 lớp, GV review agent_decisions hàng ngày 2 tuần đầu |
| R-04 | **Học sinh không tương tác** (churn) — AI agent không có data | Cao (0.6) | Cao (0.7) | **0.42** | Gamification (XP, streak), notification R04, short lessons |
| R-05 | **Import 784 lessons bị lỗi encoding/schema** | Thấp (0.3) | Thấp (0.3) | **0.09** | Validate script + unit test trước import |
| R-06 | **Anthropic API rate limit** khi scale Phase 3 | Trung bình (0.5) | Trung bình (0.5) | **0.25** | Queue + fallback sang template-based feedback |
| R-07 | **Giáo viên không dùng** admin decision log | Cao (0.6) | Cao (0.6) | **0.36** | UX đơn giản, training 1 buổi, dashboard hiển thị nổi bật |
| R-08 | **D1 storage limit** (Cloudflare free: 5GB) | Thấp (0.2) | Cao (0.7) | **0.14** | Archive events cũ > 6 tháng, partition by month |
| R-09 | **Cloudflare Worker timeout** 50ms CPU limit | Trung bình (0.4) | Cao (0.7) | **0.28** | curriculumPlanner < 10ms; async event processing |
| R-10 | **Dữ liệu học sinh bị lộ** (GDPR-like) | Thấp (0.2) | Rất cao (0.9) | **0.18** | JWT check mọi route; audit log; anonymize export |

> **RE (Risk Exposure)** = Probability × Impact. Ưu tiên xử lý RE ≥ 0.30.

### B.5.2 Chiến lược giảm thiểu rủi ro cao (RE ≥ 0.30)

**R-01 (NocoDB schema):**
- Tách hoàn toàn: D1 = Agent data (lessons, learner_models, events, agent_decisions)
- NocoDB = Content only (Articles body, media_url)
- Link: `lessons.noco_article_id` → `Articles.Id`

**R-04 (Student churn):**
```javascript
// Trong eventHandler, sau mỗi lesson_completed:
if (model.consecutive_pass >= 1) {
  await awardXP(learnerId, 10 * model.consecutive_pass);  // streak bonus
}
// Gửi notification R04 qua notification_queue
if (hoursSince(model.last_session_at) > 48) {
  await enqueueNotification(learnerId, 'Bạn chưa học hôm nay! Chỉ cần 10 phút 📚');
}
```

**R-07 (Teacher adoption):**
- Tạo `admin/dashboard.html` tab "AI Quyết định" với traffic light indicator
- Xanh = Agent hoạt động bình thường | Vàng = có override gần đây | Đỏ = R02 triggered nhiều
- Daily digest email tóm tắt: "Hôm nay Agent đã điều chỉnh lộ trình cho 3 học sinh"

---

## B.6 Metrics & Quality Assurance (Pressman Ch.17, 23)

**Cơ sở lý thuyết (Pressman Ch.23.1):**
> "A software metric is any type of measurement that relates to the software system, process, or related documentation."

### B.6.1 Metrics sản phẩm

| Metric | Mục tiêu | Công thức | Tool |
|--------|---------|-----------|------|
| **Agent Decision Accuracy** | > 80% GV đồng ý | `agree_count / total_decisions` | Dashboard |
| **Event Processing Latency** | P95 < 500ms | Cloudflare Analytics | CF Dashboard |
| **Mastery Gain Rate** | > 0.1 per session avg | `(mastery_after - mastery_before).avg` | Analytics |
| **Learner Retention (7-day)** | > 70% active | `active_day_7 / cohort_size` | D1 query |
| **Rule Trigger Rate** | R01/R02 < 20% sessions | `rule_count / session_count` | agent_decisions |
| **Override Rate** | < 15% decisions | `override_count / total_decisions` | Dashboard |
| **Test Coverage** | > 80% | Istanbul/v8 | CI |
| **API Error Rate** | < 0.1% | `5xx_count / total_requests` | CF Analytics |

### B.6.2 Metrics quy trình (Pressman Ch.23.6)

| Metric | Sprint Target | Đo lường |
|--------|--------------|---------|
| Velocity | ≥ 10 story points/sprint | Jira/GitHub Projects |
| Defect Density | < 2 bugs / KLOC | GitHub Issues |
| Build Success Rate | > 95% | GitHub Actions |
| Code Review Coverage | 100% PRs reviewed | GitHub PR rules |
| Deployment Frequency | ≥ 1x/sprint | `wrangler deploy` log |

### B.6.3 Kế hoạch QA — SQA Tasks (Pressman Ch.17.4.1)

```
Sprint QA Checklist (áp dụng mỗi sprint):
□ 1. Code review bởi ít nhất 1 người khác (FTR — Formal Technical Review)
□ 2. Unit tests pass (coverage > 80%)  
□ 3. Integration tests pass (event flow end-to-end)
□ 4. Manual test: chạy SRS test case liên quan
□ 5. Performance: không regression so với sprint trước
□ 6. Security: không có endpoint mới expose learner data
□ 7. Deploy vào staging trước production
□ 8. Rollback plan documented
```

---

## B.7 Software Configuration Management (Pressman Ch.22)

**Cơ sở lý thuyết:** SCM đảm bảo "change is managed rather than chaotic."

### B.7.1 Branching Strategy

```
main (production)
  └── develop (staging)
       ├── feature/phase1-lessons-import
       ├── feature/phase1-learner-model
       ├── feature/phase2-curriculum-planner
       ├── fix/429-throttle-dashboard
       └── ...
```

**Rule:**
- `main` ← merge từ `develop` chỉ sau Sprint Review
- `feature/*` ← merge vào `develop` sau code review + CI pass
- Tag mỗi deploy: `v1.0.0`, `v1.1.0`, ...

### B.7.2 CI/CD Pipeline (Cloudflare Workers + GitHub Actions)

```yaml
# .github/workflows/deploy.yml  ← cần khôi phục (đã bị xóa, xem git log)
name: Deploy AURA Worker
on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm test                      # Unit + Integration tests
      - run: npm run lint
  
  deploy:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Deploy Worker
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CF_API_TOKEN }}
          command: deploy --env production
      - name: Run D1 Migrations
        run: |
          npx wrangler d1 migrations apply aura-analytics --env production
```

### B.7.3 Configuration Items (Baseline)

| Item | Version | Baseline Date |
|------|---------|--------------|
| `worker/index.js` + handlers | v2.x | Sprint 1 end |
| D1 Schema (migrations 0001-0003) | v1.0 | Đã deploy |
| D1 Schema (migrations 0004-0005) | v1.1 | Sprint 1 target |
| `hoclieu_toan.json` (784 records) | v1.0 | Từ QĐ 791 |
| Curriculum Rules R01-R09 | v1.0 | Sprint 5 |
| API Contract (5 modules) | v1.0 | Sprint 6 |

---

## B.8 User Experience Design (Pressman Ch.12)

**Pressman's Golden Rules áp dụng cho AURA:**

### Rule 1: "Place the User in Control"
- **Học sinh:** Luôn thấy bài học AI chọn + LÝ DO. Có nút "Học bài khác" để override.
- **Giáo viên:** Override agent_decisions bất kỳ lúc nào. Agent giải thích quyết định bằng tiếng Việt.

### Rule 2: "Reduce the User's Memory Load"
- Dashboard học sinh: 3 thông tin chính: **Đang học gì — Tiến độ ra sao — Việc tiếp theo là gì**
- Agent nói ngắn gọn: "Bài tiếp theo: _Hàm số bậc nhất_ — vì em đã thành thạo 85% bài trước ✓"

### Rule 3: "Make the Interface Consistent"
- Màu sắc nhất quán: Xanh = đạt | Vàng = đang học | Đỏ = cần sửa
- Mô hình bài học luôn hiển thị 5 giai đoạn (dù nội dung thay đổi)

### UX Flow — Adaptive Learning Path (student)

```
index.html → course.html → page.html (bài học)
                                │
                     [Hoàn thành giai đoạn 5]
                                │
                    GET /agent/learner/:id/next
                                │
                    ┌──────────▼──────────┐
                    │ Agent Decision UI   │
                    │ "Bài tiếp theo:"    │
                    │ [Tên bài]           │
                    │ Lý do: "..."        │
                    │ [Học ngay] [Học sau]│
                    └─────────────────────┘
```

---

## B.9 Emerging Trends — AI trong Giáo dục (Pressman Ch.29)

Pressman Ch.29 xác định các xu hướng nổi bật phù hợp với AURA:

| Trend (Pressman) | Áp dụng trong AURA |
|-----------------|-------------------|
| **Machine Learning Integration** | Phase 3: ML thay rule-based cho Curriculum Planner |
| **AI-Assisted Testing** | GitHub Copilot/Claude code review + test generation |
| **Data Science for SE** (App.2) | Analytics Dashboard: Bloom distribution, mastery heatmap |
| **Continuous Intelligence** | Real-time Learner Model update sau mỗi event |
| **Explainable AI (XAI)** | `agent_decisions.reason` bắt buộc, teacher-readable |
| **Adaptive Systems** | Core mission của AURA — cá nhân hóa 40 HS cùng lúc |

---

## B.10 Tóm tắt ánh xạ SRS ↔ Pressman ↔ AURA Tech Stack

| Khái niệm SRS | Pressman Reference | AURA Implementation |
|--------------|-------------------|-------------------|
| Event-Driven Architecture | Ch.10.3 Architectural Styles | Cloudflare Worker + D1 event log |
| Learner Model (AI data) | Ch.11 Component Design | `learnerModelHandler.js` + D1 `learner_models` |
| Curriculum Planner (rules) | Ch.14 Pattern-Based Design | `curriculumPlanner.js` (Strategy Pattern) |
| Explainable AI | Ch.15 Quality Concepts | `agent_decisions.reason` NOT NULL constraint |
| API Contract | Ch.5 (from SRS), Ch.8 Use Cases | Cloudflare Worker routes in `index.js` |
| Testing Strategy | Ch.19-21 | Jest unit + k6 performance + Postman API |
| Risk Management | Ch.26 RMMM | Risk table B.5.1 (10 risks identified) |
| Configuration Management | Ch.22 SCM | Git branching + GitHub Actions CI/CD |
| Quality Metrics | Ch.23 Software Metrics | Decision accuracy, retention rate, latency |
| Agile Process | Ch.3-4 | Sprint 2 tuần, Scrum artifacts |
| Requirements Traceability | Ch.7.2.6 Traceability | RTM table B.2 (15 requirements) |
| User Experience | Ch.12 UX Design | 3 Golden Rules áp dụng, adaptive UI |

---

*Phần B này là khung chuẩn kỹ thuật phần mềm theo Pressman & Maxim (2019), áp dụng đặc thù cho hệ thống giáo dục AURA. Mỗi quyết định kiến trúc và quy trình đều có cơ sở lý thuyết rõ ràng.*

*Tài liệu tổng hợp: SRS v1.0 (QĐ 791/QĐ-SGDĐT) + ThietKeBaiHoc v1.0 + schema_791 (784 YCCĐ) + Pressman 9th Ed.*
*Cập nhật: 2026-04-06 | THPT Thủ Thiêm — Tổ Tin học*

---

# PHẦN C — KHUNG SƯ PHẠM HIỆN ĐẠI (Pedagogical Frameworks)

> **Nguồn:** Biggs & Tang *Teaching for Quality Learning at University* (5th ed) · Anders *Designing Instruction with Generative AI* (2026) · Southworth et al. *Developing a Model for AI Across the Curriculum* (2023, Computers & Education: AI vol.4)

---

## C.1 Biggs & Tang — Constructive Alignment (Thiết kế Căn chỉnh Kiến tạo)

### C.1.1 Nguyên lý Cốt lõi

**Constructive Alignment** = đảm bảo 3 thành tố căn chỉnh nhất quán:

```
ILO (Intended Learning Outcome)
  ↓ "Verb + Topic + Context/Standard"
TLA (Teaching-Learning Activity)  
  ↓ hoạt động giúp đạt ILO
AT (Assessment Task)
  ↓ đánh giá có đo đúng ILO không?
```

**Nguyên tắc then chốt (Biggs):**
- "The verb in the ILO has two main functions: it says what the student is to be able to DO with the topic AND at what level"
- Học sinh tự kiến tạo nghĩa qua hoạt động học — giáo viên **thiết kế bối cảnh** (not content delivery)
- **Declarative Knowledge**: biết VỀ điều gì (sự kiện, khái niệm, lý thuyết) → cần ghi nhớ, hiểu
- **Functioning Knowledge**: biết CÁC DÙNG điều đó trong thực tế → cần áp dụng, phân tích, tạo ra

### C.1.2 SOLO Taxonomy (Structure of Observed Learning Outcomes)

Thay thế / bổ sung Bloom's 6 cấp bằng **5 mức cấu trúc nhận thức quan sát được**:

| Level | Code | Mô tả | Ví dụ Toán học | Bloom tương đương |
|-------|------|--------|----------------|-------------------|
| 1 | SOLO_1 | **Prestructural** — Không hiểu; câu trả lời lạc đề | "Em không biết" hoặc hoàn toàn sai | — |
| 2 | SOLO_2 | **Unistructural** — Hiểu 1 khía cạnh; trả lời đơn giản | Nhắc lại công thức đúng nhưng không dùng được | Remember |
| 3 | SOLO_3 | **Multistructural** — Hiểu nhiều khía cạnh riêng lẻ | Giải được từng bước nhưng chưa kết nối | Understand |
| 4 | SOLO_4 | **Relational** — Kết nối các phần thành tổng thể | Hiểu vì sao mỗi bước cần thiết, áp dụng linh hoạt | Apply/Analyse |
| 5 | SOLO_5 | **Extended Abstract** — Khái quát hóa, áp dụng ngoài bối cảnh | Tạo bài toán mới, dạy lại, phát hiện ứng dụng mới | Evaluate/Create |

**Ý nghĩa cho AURA:**
- SOLO_1 → học sinh chưa học được → cần **Repair** pathway ngay lập tức
- SOLO_2-3 → đang học → tiếp tục TLA với scaffold
- SOLO_4 → đã đạt → chuyển sang Practice/Extend
- SOLO_5 → mastery → Teaching/Peer Expert, dự án mở

### C.1.3 Threshold Concepts

Một số khái niệm có tính **Threshold** — khi hiểu được, toàn bộ nhận thức thay đổi; khi chưa hiểu, gây block tiến bộ:

Ví dụ trong Toán:
- Số âm và trục số (lớp 6)
- Giới hạn và vô cực (lớp 11-12)
- Xác suất và biến ngẫu nhiên (lớp 11)
- Đạo hàm như "tỉ lệ thay đổi" (lớp 11)

**Thiết kế AURA**: khi `threshold_concept = 1`, agent ưu tiên **Repair** sâu hơn bình thường; không chuyển bài cho đến khi threshold được vượt qua.

### C.1.4 Formative Feedback Loop

Biggs nhấn mạnh **Formative Assessment** (đánh giá vì học) > Summative (đánh giá kết quả):

```
Student attempts → Agent observes SOLO level → 
Feedback (sửa lỗi + gợi ý cụ thể) → Student revises → 
SOLO level tăng → Agent confirms + moves forward
```

Feedback hiệu quả: "Feed-forward" (chỉ cách tiến) + "Feed-back" (xác nhận điều đúng) + "Feed-up" (nhắc mục tiêu ILO).

---

## C.2 Anders (2026) — Instructional Design với Generative AI

### C.2.1 ADDIE Model ánh xạ sang AURA Lesson Builder

| ADDIE Stage | Mô tả | AURA Implementation |
|-------------|-------|---------------------|
| **A**nalysis | Xác định nhu cầu học, đặc điểm người học, context | `learner_models` profile + `events` history; 784 YCCĐ đã có sẵn |
| **D**esign | ILO → TLA → AT; chọn lesson model, phương thức assessment | `lesson_design` table: `ilos`, `tlas`, `assessment_tasks` (JSON) |
| **D**evelopment | Tạo nội dung thực tế (câu hỏi, bài đọc, video) | Cloudflare Pages content + NocoDB articles/assessments |
| **I**mplementation | Triển khai với học sinh thực tế | Event log từ student sessions |
| **E**valuation | Đánh giá hiệu quả, cải tiến | Analytics: mastery rate, time-on-task, agent decision accuracy |

### C.2.2 Backward Design (Wiggins & McTighe) trong AURA

```
Stage 1: Desired Results (ILOs)
  "Học sinh sẽ có thể ___" — dùng SOLO verb + Bloom verb
  
Stage 2: Evidence (AT)  
  "Học sinh chứng minh ILO qua ___" — quiz, project, peer teach
  
Stage 3: Learning Plan (TLA)
  "Học sinh sẽ trải qua ___" — 5-Stage Lesson Structure
```

### C.2.3 Kolb's Experiential Learning Cycle

Mỗi **lesson session** lý tưởng đi qua 4 pha:

| Kolb Phase | AURA Stage | Hoạt động mẫu |
|------------|------------|----------------|
| **Concrete Experience** | Kích hoạt (Stage 1) | Quiz kiến thức cũ, tình huống thực tế, câu hỏi mở |
| **Reflective Observation** | Phản chiếu (Stage 4) | "Em nhận ra điều gì?", self-assessment, so sánh với bài làm cũ |
| **Abstract Conceptualization** | Kiến tạo (Stage 2) | Giải thích công thức, xây dựng rule tổng quát |
| **Active Experimentation** | Hành động (Stage 3) | Bài tập áp dụng, bài toán mới, dự án thực |

**AURA field**: `kolb_phase` trong `lessons` table cho biết lesson chủ yếu ở pha nào của Kolb.

### C.2.4 AI Literacy Framework (Anders 4 thành phần)

| Component | Định nghĩa | Thể hiện trong AURA |
|-----------|-----------|---------------------|
| **Awareness** | Nhận biết AI xuất hiện ở đâu, ảnh hưởng thế nào | Banner "AI Agent đang hỗ trợ bạn" + explain decisions |
| **Capability** | Biết cách dùng AI hiệu quả (prompt engineering) | TICRR Prompt Builder trong AI Tutor interface |
| **Knowledge** | Hiểu AI hoạt động ra sao (cơ bản) | AI Literacy module trong curriculum |
| **Critical Thinking** | Đánh giá, kiểm tra output của AI | "Kiểm tra lại bước này với AI?" CTA button |

**TICRR Prompt Formula (Anders):**
```
T — Task: Nhiệm vụ cụ thể
I — Instruction: Hướng dẫn chi tiết cách làm
C — Context: Bối cảnh, đối tượng, ngữ cảnh
R — Restriction: Giới hạn, ràng buộc
R — Reference: Nguồn tham chiếu, ví dụ mẫu
```

---

## C.3 Southworth et al. (2023) — AI Literacy SLOs

### C.3.1 Năm loại AI Literacy (UF Model)

| # | Literacy Type | SLO Cốt lõi | Assessment Indicator |
|---|--------------|-------------|---------------------|
| 1 | **Know & Understand** | Giải thích AI là gì, phân biệt AI mạnh/yếu, nhận ra bias | Câu hỏi khái niệm MCQ/True-False |
| 2 | **Use & Apply** | Dùng AI tools để hoàn thành nhiệm vụ thực tế | Task-completion rate với AI tool |
| 3 | **Evaluate & Create** | Đánh giá chất lượng AI output, tạo prompt hiệu quả | Rubric-based peer assessment |
| 4 | **Ethics** | Nhận biết vấn đề đạo đức AI: privacy, bias, accountability | Case study analysis |
| 5 | **Professional/Career** | Biết AI thay đổi ngành nghề thế nào, upskill phù hợp | Career reflection essay |

### C.3.2 Rubric-based Mastery cho AI Literacy

Mỗi SLO được đánh giá qua rubric 4 mức:

| Mức | Mô tả |
|-----|-------|
| **4 — Exemplary** | Vượt kỳ vọng; có thể giải thích/dạy lại cho người khác |
| **3 — Proficient** | Đáp ứng đầy đủ SLO; độc lập thực hiện |
| **2 — Developing** | Đang tiến bộ; cần hỗ trợ một số phần |
| **1 — Beginning** | Mới bắt đầu; cần hướng dẫn trực tiếp |

### C.3.3 Ánh xạ AI Literacy → Curriculum AURA

| Course Module | AI Literacy Type | Bài học mẫu |
|---------------|-----------------|-------------|
| Toán cơ bản | Know & Understand | "AI giải bài toán này thế nào?" |
| Lập trình | Use & Apply | "Dùng Copilot viết function, kiểm tra output" |
| Ngữ văn | Evaluate & Create | "So sánh bài luận AI vs bài của em" |
| GDCD | Ethics | "Bài toán tuyển dụng dùng AI có công bằng?" |
| Hướng nghiệp | Professional/Career | "10 nghề nào thay đổi nhất vì AI?" |

---

## C.4 Tích hợp 3 Khung vào AURA System

### C.4.1 Kiến trúc tổng hợp (Biggs + Anders + Southworth)

```
┌─────────────────────────────────────────────────────────────┐
│              CONSTRUCTIVE ALIGNMENT LAYER (Biggs)           │
│                                                             │
│  ILO ──────────────────────────────────────────→ AT        │
│  (SOLO verb + topic)           (rubric-based)              │
│              ↓                                              │
│           TLA (5-Stage Lesson + Kolb Cycle)                │
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│              ADDIE DESIGN LAYER (Anders)                    │
│                                                             │
│  Analysis → Design → Development → Implementation →        │
│  Evaluation (đo SOLO level sau mỗi session)                │
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│              AI LITERACY LAYER (Southworth)                 │
│                                                             │
│  AI xuất hiện trong từng bài → học sinh thấy AI thinking   │
│  → Tuần 1 lesson "AI là gì" → SLO tracking                 │
└─────────────────────────────────────────────────────────────┘
```

### C.4.2 Lesson Design Flow nâng cấp (có Constructive Alignment)

```
Teacher/Admin tạo bài học:
  1. Nhập lesson_id (từ 784 YCCĐ)
  2. Hệ thống gợi ý SOLO level phù hợp (từ Bloom level của YCCĐ)
  3. Hệ thống gợi ý ILO template: "Sau bài này, HS có thể [SOLO verb] [topic]"
  4. Chọn TLA (Teaching-Learning Activity):
     - Stage 1: Kích hoạt (Kolb: CE)
     - Stage 2: Kiến tạo (Kolb: AC)
     - Stage 3: Hành động (Kolb: AE)
     - Stage 4: Phản chiếu (Kolb: RO)
     - Stage 5: Tổng kết
  5. Chọn Assessment Type (AT) phù hợp với ILO verb
  6. Lưu vào lesson_design table + cập nhật constructive_alignment JSON
```

### C.4.3 Adaptive Engine nâng cấp

Bổ sung vào 9 quy tắc R01-R09 (từ Phần A):

| Rule | Trigger mới | Hành động mới |
|------|------------|---------------|
| **R01 (Repair)** | `solo_level <= 2` OR `threshold_concept = 1 AND mastery < 0.6` | Repair pathway bắt buộc trước khi tiến |
| **R02 (Downgrade)** | `consecutive_fail >= 2 AND solo_level > target_solo` | Giảm SOLO target, không chỉ giảm Bloom |
| **R06 (Timing)** | Kolb phase mismatch: e.g., học CE khi HS cần AE | Chuyển sang Kolb phase phù hợp với trạng thái HS |
| **R_NEW (Deep vs Surface)** | `learning_approach = 'surface' AND consecutive_pass >= 3` | Chuyển sang bài yêu cầu Functioning Knowledge |

---

## C.5 Cập nhật Schema D1 — Migrations mới

### C.5.1 Migration 0004 — Bảng `lessons` nâng cấp (Pedagogical fields)

**File:** `worker/migrations/0004_aura_lessons.sql`

```sql
-- Migration 0004: Lessons table với pedagogical framework fields
-- Biggs & Tang: SOLO taxonomy, Constructive Alignment, Threshold Concepts
-- Anders: Kolb cycle, ADDIE, Knowledge Type
-- Southworth: AI Literacy integration

CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  
  -- Core fields (từ schema_791 và SRS)
  lesson_id TEXT NOT NULL UNIQUE,           -- e.g., "020108.0202d3" 
  subject TEXT NOT NULL DEFAULT 'toan',
  grade_num INTEGER NOT NULL,               -- 1-12
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft'      -- draft | active | archived
    CHECK (status IN ('draft','active','archived')),
  
  -- Bloom's Taxonomy (từ schema_791)
  bloom_level INTEGER NOT NULL DEFAULT 1    -- 1-6
    CHECK (bloom_level BETWEEN 1 AND 6),
  bloom_vi TEXT,                            -- Nhớ | Hiểu | Vận dụng | Phân tích | Đánh giá | Sáng tạo
  
  -- SOLO Taxonomy (Biggs & Tang)
  solo_level INTEGER NOT NULL DEFAULT 3     -- 1-5 (1=Prestructural...5=Extended Abstract)
    CHECK (solo_level BETWEEN 1 AND 5),
  solo_target INTEGER NOT NULL DEFAULT 4    -- target SOLO level sau khi học xong
    CHECK (solo_target BETWEEN 2 AND 5),
  
  -- Knowledge Type (Biggs & Tang: Declarative vs Functioning)
  knowledge_type TEXT NOT NULL DEFAULT 'declarative'
    CHECK (knowledge_type IN ('declarative','functioning','both')),
  
  -- Threshold Concept (Biggs & Tang)
  threshold_concept INTEGER NOT NULL DEFAULT 0  -- 0=no, 1=yes (boolean)
    CHECK (threshold_concept IN (0,1)),
  threshold_notes TEXT,                     -- Giải thích tại sao là threshold concept
  
  -- Kolb's Experiential Learning Cycle (Anders)
  kolb_phase TEXT DEFAULT 'all'             -- CE | RO | AC | AE | all
    CHECK (kolb_phase IN ('CE','RO','AC','AE','all')),
  
  -- Lesson Model (từ SRS)
  lesson_model TEXT NOT NULL DEFAULT 'scaffold'
    CHECK (lesson_model IN ('scaffold','practice','case','teach','explore','repair','project','reflect')),
  lesson_level TEXT NOT NULL DEFAULT 'nen_tang'
    CHECK (lesson_level IN ('nen_tang','mo_rong','chuyen_sau')),
  
  -- Navigation (từ schema_791)
  next_if_pass TEXT,                        -- lesson_id của bài tiếp nếu đạt
  next_if_fail TEXT,                        -- lesson_id của bài tiếp nếu không đạt
  prerequisite_ids TEXT DEFAULT '[]',       -- JSON array of lesson_ids
  
  -- Constructive Alignment (Biggs & Tang + Anders ADDIE)
  constructive_alignment TEXT DEFAULT '{}',
  -- JSON: {
  --   "ilos": ["Sau bài này HS có thể [verb] [topic]"],
  --   "tlas": ["Stage 1: ...", "Stage 2: ...", "Stage 3: ..."],
  --   "ats": [{"type":"quiz","criteria":"solo_level >= 4"}],
  --   "addie": {"analysis":"...","design":"...","evaluation_method":"..."}
  -- }

  -- AI Literacy Integration (Southworth)
  ai_literacy_type TEXT DEFAULT NULL       -- null | know_understand | use_apply | evaluate_create | ethics | career
    CHECK (ai_literacy_type IS NULL OR ai_literacy_type IN (
      'know_understand','use_apply','evaluate_create','ethics','career'
    )),
  
  -- Metadata
  content_url TEXT,                         -- URL đến nội dung thực tế (NocoDB article)
  estimated_minutes INTEGER DEFAULT 20,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_lessons_lesson_id ON lessons(lesson_id);
CREATE INDEX IF NOT EXISTS idx_lessons_grade ON lessons(grade_num);
CREATE INDEX IF NOT EXISTS idx_lessons_bloom ON lessons(bloom_level);
CREATE INDEX IF NOT EXISTS idx_lessons_solo ON lessons(solo_level);
CREATE INDEX IF NOT EXISTS idx_lessons_threshold ON lessons(threshold_concept);
CREATE INDEX IF NOT EXISTS idx_lessons_knowledge_type ON lessons(knowledge_type);
```

### C.5.2 Migration 0005 — Learner Model, Events, Agent Decisions nâng cấp

**File:** `worker/migrations/0005_aura_learner_agent.sql`

```sql
-- Migration 0005: Learner Model + Agent Architecture
-- Biggs: SOLO profile, Declarative vs Functioning mastery, Learning Approach
-- Southworth: AI Literacy score
-- SRS: Curriculum rules, Planner R01-R09

-- ══════════════════════════════════════════════════════════
-- LEARNER MODELS
-- ══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS learner_models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL UNIQUE,
  
  -- Core mastery (từ SRS)
  mastery_map TEXT NOT NULL DEFAULT '{}',
  -- JSON: { "020108.0202d3": 0.72, ... } keyed by lesson_id
  
  bloom_profile TEXT NOT NULL DEFAULT '{}',
  -- JSON: { "1": 0.9, "2": 0.8, "3": 0.6, "4": 0.4, "5": 0.2, "6": 0.1 }
  
  error_patterns TEXT NOT NULL DEFAULT '{}',
  -- JSON: { "lesson_id": ["type_error_1", "type_error_2"] }
  
  speed_profile TEXT NOT NULL DEFAULT '{}',
  -- JSON: { "nen_tang": 180, "mo_rong": 240, "chuyen_sau": 420 } (seconds per problem)
  
  -- SOLO Profile (Biggs & Tang) — new
  solo_profile TEXT NOT NULL DEFAULT '{}',
  -- JSON: { "lesson_id": {"achieved":3,"target":4,"last_assessed":"2026-04-06"} }
  
  -- Knowledge Type Mastery (Biggs & Tang) — new
  declarative_mastery TEXT NOT NULL DEFAULT '{}',
  -- JSON: { "lesson_id": 0.85 } — biết VỀ khái niệm
  functioning_mastery TEXT NOT NULL DEFAULT '{}',
  -- JSON: { "lesson_id": 0.65 } — biết DÙNG trong thực tế
  
  -- Learning Approach (Biggs) — new
  learning_approach TEXT NOT NULL DEFAULT 'strategic'
    CHECK (learning_approach IN ('surface','deep','strategic')),
  -- surface: chỉ học để qua bài; deep: muốn hiểu thật sự; strategic: tối ưu điểm số
  
  -- AI Literacy Score (Southworth) — new
  ai_literacy_score TEXT NOT NULL DEFAULT '{}',
  -- JSON: {
  --   "know_understand": 0.0,    -- 0.0 to 1.0
  --   "use_apply": 0.0,
  --   "evaluate_create": 0.0,
  --   "ethics": 0.0,
  --   "career": 0.0,
  --   "last_assessed": null
  -- }
  
  -- State (từ SRS)
  current_lesson_id TEXT,
  current_level TEXT DEFAULT 'nen_tang',
  engagement_score REAL DEFAULT 0.5,
  preferred_model TEXT DEFAULT 'scaffold',
  consecutive_pass INTEGER DEFAULT 0,
  consecutive_fail INTEGER DEFAULT 0,
  
  -- Timestamps
  last_active TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_learner_user ON learner_models(user_id);

-- ══════════════════════════════════════════════════════════
-- EVENT LOG
-- ══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  lesson_id TEXT,
  event_type TEXT NOT NULL
    CHECK (event_type IN (
      'quiz_submitted','assignment_submitted','video_progress',
      'session_started','session_ended','discussion_posted',
      'peer_review_given','lesson_completed','teacher_override',
      'ai_literacy_assessed','solo_assessed'   -- new event types
    )),
  payload TEXT NOT NULL DEFAULT '{}',
  -- For quiz_submitted: {"score":0.8,"bloom_level":3,"solo_level":4,"time_seconds":180,"errors":["type_A"]}
  -- For solo_assessed: {"solo_level":4,"assessor":"agent|teacher","notes":"..."}
  -- For ai_literacy_assessed: {"type":"use_apply","score":0.7,"rubric_score":3}
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id);
CREATE INDEX IF NOT EXISTS idx_events_lesson ON events(lesson_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);

-- ══════════════════════════════════════════════════════════
-- AGENT DECISIONS (Curriculum Planner output)
-- ══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS agent_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  triggered_by_event_id INTEGER REFERENCES events(id),
  rule_fired TEXT NOT NULL,           -- R01, R02, ..., R09, R_DEEP, R_THRESHOLD
  decision TEXT NOT NULL,             -- lesson_id được giao tiếp theo
  reason TEXT NOT NULL,               -- Giải thích bằng tiếng Việt (XAI requirement)
  confidence REAL DEFAULT 0.8,        -- 0.0-1.0
  accepted INTEGER DEFAULT NULL,      -- NULL=pending, 1=accepted, 0=rejected by teacher/student
  outcome TEXT,                       -- mastery delta sau khi học xong bài được giao
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_decisions_user ON agent_decisions(user_id);

-- ══════════════════════════════════════════════════════════
-- CURRICULUM RULES
-- ══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS curriculum_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id TEXT NOT NULL UNIQUE,       -- R01, R02, ..., R09, R_DEEP, R_THRESHOLD
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  trigger_condition TEXT NOT NULL,    -- JS-like pseudocode for documentation
  action TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 5,   -- 1 (highest) to 10 (lowest)
  is_active INTEGER NOT NULL DEFAULT 1,
  -- Pedagogical source (new)
  framework_source TEXT DEFAULT 'SRS',   -- SRS | Biggs | Anders | Southworth
  created_at TEXT DEFAULT (datetime('now'))
);

-- Seed rules R01-R09 + new pedagogical rules
INSERT OR IGNORE INTO curriculum_rules (rule_id, name, description, trigger_condition, action, priority, framework_source) VALUES
  ('R01', 'Repair Trigger', 'Kích hoạt sửa chữa khi điểm thấp liên tiếp hoặc threshold concept chưa vượt qua',
   'consecutive_fail >= 3 OR (threshold_concept = 1 AND mastery < 0.6)',
   'assign lesson_model=repair, solo_target -= 1', 1, 'SRS+Biggs'),
  ('R02', 'Downgrade Level', 'Giảm độ khó khi học sinh không theo kịp',
   'consecutive_fail >= 2 AND current_level != nen_tang',
   'current_level -= 1 step (chuyen_sau→mo_rong→nen_tang)', 2, 'SRS'),
  ('R03', 'Upgrade Level', 'Tăng độ khó khi học sinh vượt kỳ vọng',
   'consecutive_pass >= 3 AND mastery >= 0.85',
   'current_level += 1 step', 3, 'SRS'),
  ('R04', 'Dormant Review', 'Ôn lại bài không học trong 7 ngày',
   'days_since_last_active >= 7',
   'assign spaced-repetition review lesson', 4, 'SRS'),
  ('R05', 'Bloom Gap', 'Lấp đầy khoảng trống Bloom khi HS giỏi nhớ nhưng kém vận dụng',
   'bloom_profile[1..2] > 0.8 AND bloom_profile[3..4] < 0.5',
   'assign case-based or project lesson (bloom 3-4)', 5, 'SRS'),
  ('R06', 'Timing Optimization', 'Điều chỉnh thời điểm học theo Kolb phase của học sinh',
   'session_context indicates Kolb mismatch',
   'reassign lesson with matching kolb_phase', 6, 'SRS+Anders'),
  ('R07', 'Peer Expert', 'Chuyển HS giỏi sang vai trò dạy bạn',
   'consecutive_pass >= 5 AND mastery >= 0.9',
   'assign lesson_model=teach, create peer_review opportunity', 7, 'SRS'),
  ('R08', 'Preferred Model', 'Dùng mô hình học sinh ưa thích khi cần tăng engagement',
   'engagement_score < 0.4',
   'assign lesson with preferred_model', 8, 'SRS'),
  ('R09', 'Variety', 'Tránh lặp lại cùng lesson_model quá 3 lần',
   'last_3_models all same',
   'rotate to different lesson_model', 9, 'SRS'),
  ('R_THRESHOLD', 'Threshold Concept Block', 'Không cho tiến khi threshold concept chưa vượt qua',
   'threshold_concept = 1 AND solo_level <= 2',
   'force repair pathway; block next_if_pass navigation', 1, 'Biggs'),
  ('R_DEEP', 'Surface to Deep Learning', 'Chuyển học sinh surface sang deep learning khi đủ nền tảng',
   'learning_approach = surface AND consecutive_pass >= 3 AND knowledge_type = declarative',
   'assign functioning knowledge lesson (apply in context)', 5, 'Biggs');

-- ══════════════════════════════════════════════════════════
-- LESSON SESSIONS (individual student sessions per lesson)
-- ══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS lesson_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  lesson_id TEXT NOT NULL,
  session_start TEXT NOT NULL,
  session_end TEXT,
  stage_reached INTEGER DEFAULT 1,    -- 1-5 (5-Stage lesson model)
  kolb_phase_experienced TEXT,        -- which Kolb phase this session covered
  solo_level_before INTEGER,          -- SOLO level assessed before session
  solo_level_after INTEGER,           -- SOLO level assessed after session
  bloom_score REAL,                   -- 0.0-1.0 for this session
  time_on_task_seconds INTEGER DEFAULT 0,
  interactions INTEGER DEFAULT 0,     -- number of AI tutor interactions
  hint_count INTEGER DEFAULT 0,
  ai_literacy_practiced TEXT,         -- which AI literacy type practiced this session
  status TEXT DEFAULT 'active'
    CHECK (status IN ('active','completed','abandoned')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON lesson_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_lesson ON lesson_sessions(lesson_id);
```

### C.5.3 Migration 0006 — Pedagogical Design Tables

**File:** `worker/migrations/0006_aura_pedagogical.sql`

```sql
-- Migration 0006: Pedagogical Framework Support Tables
-- Biggs: Constructive Alignment detail, SOLO assessments
-- Southworth: AI Literacy assessments
-- Anders: ADDIE lesson design records

-- ══════════════════════════════════════════════════════════
-- LESSON DESIGN (ADDIE + Constructive Alignment records)
-- ══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS lesson_design (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lesson_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  
  -- ILOs (Intended Learning Outcomes) — Biggs: verb + topic + context
  ilos TEXT NOT NULL DEFAULT '[]',
  -- JSON: [
  --   {"level": 4, "verb": "phân tích", "topic": "phương trình bậc 2", "context": "trong bài toán thực tế"},
  --   {"level": 3, "verb": "áp dụng", "topic": "công thức nghiệm", "context": "giải bài tập cơ bản"}
  -- ]
  
  -- Teaching-Learning Activities — Kolb cycle + 5-Stage
  tlas TEXT NOT NULL DEFAULT '[]',
  -- JSON: [
  --   {"stage": 1, "kolb": "CE", "activity": "Xem video tình huống thực tế", "duration_min": 3},
  --   {"stage": 2, "kolb": "AC", "activity": "Xây dựng công thức từ ví dụ", "duration_min": 10},
  --   {"stage": 3, "kolb": "AE", "activity": "Giải 5 bài tập có hướng dẫn", "duration_min": 15},
  --   {"stage": 4, "kolb": "RO", "activity": "So sánh cách giải của mình", "duration_min": 5},
  --   {"stage": 5, "kolb": "all", "activity": "Tóm tắt và tự kiểm tra", "duration_min": 5}
  -- ]
  
  -- Assessment Tasks — aligned with ILOs
  assessment_tasks TEXT NOT NULL DEFAULT '[]',
  -- JSON: [
  --   {"type":"quiz","format":"MCQ","bloom_level":3,"solo_target":4,"rubric_score_pass":3},
  --   {"type":"project","format":"open_ended","bloom_level":5,"solo_target":5}
  -- ]
  
  -- ADDIE stages documentation
  addie_analysis TEXT,                -- Nhu cầu học, đặc điểm HS, constraints
  addie_design TEXT,                  -- Quyết định thiết kế + rationale
  addie_development TEXT,             -- Nội dung được tạo ra
  addie_evaluation_plan TEXT,         -- Cách đo hiệu quả bài học
  
  -- Backward Design (Wiggins & McTighe)
  desired_results TEXT,               -- Stage 1: Students will be able to...
  evidence_of_learning TEXT,          -- Stage 2: AT descriptions
  learning_plan TEXT,                 -- Stage 3: TLA summary
  
  is_current INTEGER DEFAULT 1,       -- 1 = current version
  created_by TEXT,                    -- teacher/admin user_id
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_design_lesson ON lesson_design(lesson_id);
CREATE INDEX IF NOT EXISTS idx_design_current ON lesson_design(lesson_id, is_current);

-- ══════════════════════════════════════════════════════════
-- SOLO ASSESSMENTS
-- ══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS solo_assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  lesson_id TEXT NOT NULL,
  solo_level INTEGER NOT NULL CHECK (solo_level BETWEEN 1 AND 5),
  assessor_type TEXT NOT NULL DEFAULT 'agent'
    CHECK (assessor_type IN ('agent','teacher','self','peer')),
  evidence TEXT,                      -- Ví dụ: câu trả lời của HS dẫn đến đánh giá này
  notes TEXT,                         -- Ghi chú của assessor
  session_id INTEGER REFERENCES lesson_sessions(id),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_solo_user_lesson ON solo_assessments(user_id, lesson_id);
CREATE INDEX IF NOT EXISTS idx_solo_created ON solo_assessments(created_at);

-- ══════════════════════════════════════════════════════════
-- AI LITERACY ASSESSMENTS (Southworth 5-type framework)
-- ══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS ai_literacy_assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  literacy_type TEXT NOT NULL
    CHECK (literacy_type IN ('know_understand','use_apply','evaluate_create','ethics','career')),
  rubric_score INTEGER NOT NULL CHECK (rubric_score BETWEEN 1 AND 4),
  -- 1=Beginning, 2=Developing, 3=Proficient, 4=Exemplary (Southworth rubric)
  normalized_score REAL NOT NULL CHECK (normalized_score BETWEEN 0.0 AND 1.0),
  evidence TEXT,                      -- Sản phẩm học/bài làm dẫn đến điểm này
  lesson_context TEXT,                -- lesson_id hoặc module context
  assessor_type TEXT DEFAULT 'agent'
    CHECK (assessor_type IN ('agent','teacher','self','peer')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ai_lit_user ON ai_literacy_assessments(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_lit_type ON ai_literacy_assessments(literacy_type);

-- ══════════════════════════════════════════════════════════
-- THRESHOLD CONCEPT TRACKING
-- ══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS threshold_progress (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  lesson_id TEXT NOT NULL,            -- lesson với threshold_concept = 1
  status TEXT NOT NULL DEFAULT 'blocked'
    CHECK (status IN ('blocked','liminal','passed')),
  -- blocked: chưa hiểu; liminal: đang trong quá trình; passed: đã vượt qua
  attempts INTEGER DEFAULT 0,         -- số lần thử
  first_attempt TEXT,
  breakthrough_at TEXT,               -- khi nào vượt threshold
  notes TEXT,                         -- ghi chú từ teacher
  UNIQUE(user_id, lesson_id)
);

CREATE INDEX IF NOT EXISTS idx_threshold_user ON threshold_progress(user_id);
CREATE INDEX IF NOT EXISTS idx_threshold_status ON threshold_progress(status);
```

---

## C.6 Cập nhật Curriculum Planner — Pseudocode nâng cấp

### C.6.1 `curriculumPlanner.js` — Thêm xử lý SOLO + Threshold

```javascript
// ══════════════════════════════════════════════════════════
// curriculumPlanner.js — Nâng cấp với Biggs & Tang framework
// ══════════════════════════════════════════════════════════

/**
 * R_THRESHOLD — Threshold Concept Block (Biggs)
 * Priority 1: Nếu lesson là threshold concept và HS chưa vượt qua
 * → Block tiến bộ, force repair mode
 */
async function checkThresholdBlock(learner, lesson, db) {
  if (!lesson.threshold_concept) return null;
  
  const progress = await db.prepare(
    'SELECT status, attempts FROM threshold_progress WHERE user_id = ? AND lesson_id = ?'
  ).bind(learner.user_id, lesson.lesson_id).first();
  
  if (!progress || progress.status === 'blocked') {
    return {
      rule: 'R_THRESHOLD',
      decision: lesson.lesson_id, // Stay on same lesson
      lesson_model: 'repair',
      reason: `"${lesson.title}" là Threshold Concept — cần vượt qua trước khi tiến. ` +
              `Đây là khái niệm cốt lõi thay đổi cách hiểu. Tiếp tục luyện tập với hỗ trợ.`,
      confidence: 0.95
    };
  }
  return null; // threshold passed, continue normal flow
}

/**
 * R_DEEP — Surface to Deep Learning (Biggs)
 * Nếu HS dùng surface approach và đã qua declarative phase
 * → Chuyển sang functioning knowledge
 */
function checkDeepLearning(learner, lesson) {
  if (learner.learning_approach !== 'surface') return null;
  if (learner.consecutive_pass < 3) return null;
  if (lesson.knowledge_type !== 'declarative') return null;
  
  return {
    rule: 'R_DEEP',
    lesson_model: 'case',  // case-based để kích hoạt functioning knowledge
    reason: `Em đã nhớ tốt phần lý thuyết (declarative). ` +
            `Giờ là lúc thử áp dụng vào bài toán thực tế (functioning knowledge).`,
    confidence: 0.75
  };
}

/**
 * Tính SOLO level tiếp theo cần đạt
 */
function getNextSoloTarget(currentSolo, bloomLevel) {
  // Map Bloom level → expected SOLO target
  const bloomToSolo = { 1: 2, 2: 3, 3: 4, 4: 4, 5: 5, 6: 5 };
  const targetFromBloom = bloomToSolo[bloomLevel] || 3;
  return Math.min(targetFromBloom, currentSolo + 1);
}

/**
 * Main planner function — nâng cấp
 */
export async function planNextLesson(learner, db) {
  const currentLesson = await getLessonById(learner.current_lesson_id, db);
  
  // Priority 1: Threshold block (Biggs)
  const thresholdBlock = await checkThresholdBlock(learner, currentLesson, db);
  if (thresholdBlock) return thresholdBlock;
  
  // Priority 2: R01 Repair trigger (tích hợp SOLO)
  const soloProfile = JSON.parse(learner.solo_profile || '{}');
  const currentSolo = soloProfile[learner.current_lesson_id]?.achieved || 3;
  if (learner.consecutive_fail >= 3 || currentSolo <= 2) {
    return {
      rule: 'R01',
      decision: currentLesson.lesson_id, // repair current lesson
      lesson_model: 'repair',
      reason: `Em gặp khó khăn liên tiếp (SOLO level: ${currentSolo}/5). ` +
              `Hãy ôn lại từ đầu với hướng dẫn chi tiết hơn.`,
      confidence: 0.9
    };
  }
  
  // Priority 3: Deep learning shift (Biggs R_DEEP)
  const deepShift = checkDeepLearning(learner, currentLesson);
  if (deepShift) return deepShift;
  
  // ... tiếp tục R02-R09 như cũ ...
}
```

### C.6.2 SOLO Assessment Engine

```javascript
/**
 * assessSOLOLevel() — Tự động đánh giá SOLO level từ quiz response
 * Input: câu trả lời HS + metadata bài
 * Output: SOLO level 1-5 với evidence
 */
export function assessSOLOLevel(response, lesson) {
  const { score, errors, hint_count, time_seconds, answer_text } = response;
  
  // Level 1 (Prestructural): không trả lời / hoàn toàn sai
  if (score < 0.1 && errors.length > 3) return { level: 1, evidence: 'Câu trả lời hoàn toàn sai hoặc không liên quan' };
  
  // Level 2 (Unistructural): nhớ đúng công thức nhưng không áp dụng được
  if (score >= 0.3 && score < 0.5 && hint_count >= 2) return { level: 2, evidence: 'Nhớ công thức nhưng cần gợi ý khi áp dụng' };
  
  // Level 3 (Multistructural): làm đúng từng bước riêng lẻ, không kết nối
  if (score >= 0.5 && score < 0.7) return { level: 3, evidence: 'Làm đúng các bước cơ bản nhưng chưa liên kết tổng thể' };
  
  // Level 4 (Relational): hiểu kết nối, áp dụng đúng ngữ cảnh
  if (score >= 0.7 && score < 0.9) return { level: 4, evidence: 'Áp dụng đúng trong ngữ cảnh, hiểu tại sao từng bước cần thiết' };
  
  // Level 5 (Extended Abstract): vượt ra ngoài bài, tổng quát hóa
  if (score >= 0.9 && time_seconds < lesson.estimated_minutes * 30) 
    return { level: 5, evidence: 'Giải nhanh, chính xác — có thể tổng quát hóa bài toán' };
  
  return { level: 4, evidence: 'Đạt yêu cầu cơ bản' };
}
```

---

## C.7 Lesson Builder UI — Nâng cấp Constructive Alignment

### C.7.1 Form tạo bài học (Teacher Dashboard)

Bổ sung vào form tạo bài học tại `teacher/dashboard.html`:

```html
<!-- Section: Constructive Alignment (Biggs) -->
<div class="ca-section" style="border:1px solid var(--border);border-radius:8px;padding:16px;margin-top:16px;">
  <h4 style="margin:0 0 12px;color:var(--primary);">
    <i class="fas fa-bullseye"></i> Thiết kế Căn chỉnh (Constructive Alignment)
  </h4>
  
  <!-- ILO Builder -->
  <label>Mục tiêu học tập (ILOs) — "Sau bài này, học sinh có thể..."</label>
  <div id="ilo-list">
    <div class="ilo-row" style="display:flex;gap:8px;margin-bottom:8px;">
      <select class="ilo-solo" style="width:120px;">
        <option value="2">SOLO 2 — Nhắc lại</option>
        <option value="3">SOLO 3 — Mô tả</option>
        <option value="4" selected>SOLO 4 — Kết nối</option>
        <option value="5">SOLO 5 — Khái quát</option>
      </select>
      <input type="text" class="ilo-verb" placeholder="Động từ (phân tích, áp dụng...)" style="width:160px;">
      <input type="text" class="ilo-topic" placeholder="Chủ đề" style="flex:1;">
      <button onclick="removeILO(this)">✕</button>
    </div>
  </div>
  <button class="btn btn-outline btn-sm" onclick="addILO()">+ Thêm ILO</button>
  
  <!-- Knowledge Type -->
  <div style="margin-top:12px;display:flex;gap:16px;">
    <label><input type="radio" name="knowledge_type" value="declarative" checked> Declarative (biết VỀ)</label>
    <label><input type="radio" name="knowledge_type" value="functioning"> Functioning (biết DÙNG)</label>
    <label><input type="radio" name="knowledge_type" value="both"> Cả hai</label>
  </div>
  
  <!-- Threshold Concept toggle -->
  <div style="margin-top:8px;">
    <label>
      <input type="checkbox" id="threshold-toggle">
      <b>Threshold Concept</b> — Khái niệm cốt lõi cần vượt trước khi tiến
    </label>
  </div>
</div>

<!-- Section: Kolb Cycle -->
<div style="margin-top:12px;">
  <label>Pha Kolb chính của bài học</label>
  <select id="kolb-phase">
    <option value="all">Đầy đủ 4 pha</option>
    <option value="CE">CE — Trải nghiệm cụ thể</option>
    <option value="RO">RO — Quan sát phản chiếu</option>
    <option value="AC">AC — Khái niệm hóa trừu tượng</option>
    <option value="AE">AE — Thử nghiệm chủ động</option>
  </select>
</div>
```

---

## C.8 AI Literacy Dashboard (Student View)

### C.8.1 Widget hiển thị AI Literacy Progress

Bổ sung vào `student/dashboard.html`:

```html
<!-- AI Literacy Progress Card -->
<div class="card" id="ai-literacy-card">
  <div class="card-header">
    <i class="fas fa-robot"></i> AI Literacy Progress
    <span class="badge-info">Powered by Southworth Framework</span>
  </div>
  <div class="card-body">
    <div id="ai-literacy-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      <!-- Generated by JS -->
    </div>
  </div>
</div>
```

```javascript
const AI_LITERACY_LABELS = {
  know_understand:  { label: 'Hiểu AI',        icon: 'fa-lightbulb',    color: '#2563EB' },
  use_apply:        { label: 'Dùng AI',         icon: 'fa-tools',        color: '#16A34A' },
  evaluate_create:  { label: 'Đánh giá AI',     icon: 'fa-balance-scale',color: '#D97706' },
  ethics:           { label: 'Đạo đức AI',      icon: 'fa-shield-alt',   color: '#7C3AED' },
  career:           { label: 'AI & Nghề nghiệp',icon: 'fa-briefcase',    color: '#E66000' },
};

function renderAILiteracyWidget(scores) {
  const grid = document.getElementById('ai-literacy-grid');
  if (!grid) return;
  grid.innerHTML = Object.entries(AI_LITERACY_LABELS).map(([key, meta]) => {
    const score = (scores[key] || 0) * 100;
    const rubric = Math.ceil(score / 25); // 1-4 rubric score
    const rubricLabels = ['', 'Beginning', 'Developing', 'Proficient', 'Exemplary'];
    return `
      <div style="background:var(--bg);border-radius:8px;padding:12px;">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
          <i class="fas ${meta.icon}" style="color:${meta.color}"></i>
          <span style="font-size:12px;font-weight:600;">${meta.label}</span>
        </div>
        <div style="height:6px;background:var(--border);border-radius:100px;overflow:hidden;">
          <div style="height:100%;width:${score}%;background:${meta.color};border-radius:100px;transition:width .5s;"></div>
        </div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">${rubricLabels[rubric]||'Chưa đánh giá'} (${Math.round(score)}%)</div>
      </div>`;
  }).join('');
}
```

---

## C.9 Tóm tắt ánh xạ 3 Khung → AURA

| Khái niệm Sư phạm | Nguồn | AURA Implementation |
|-------------------|-------|---------------------|
| Constructive Alignment ILO→TLA→AT | Biggs & Tang | `lesson_design.ilos`, `lesson_design.tlas`, `lesson_design.assessment_tasks` |
| SOLO Taxonomy 5 levels | Biggs & Tang | `lessons.solo_level`, `solo_assessments` table, `assessSOLOLevel()` function |
| Declarative vs Functioning Knowledge | Biggs & Tang | `lessons.knowledge_type`, `learner_models.declarative_mastery`, `learner_models.functioning_mastery` |
| Threshold Concepts | Biggs & Tang | `lessons.threshold_concept`, `threshold_progress` table, `R_THRESHOLD` rule |
| Learning Approach surface/deep | Biggs & Tang | `learner_models.learning_approach`, `R_DEEP` rule |
| ADDIE Model | Anders | `lesson_design.addie_*` fields |
| Backward Design | Anders (Wiggins) | `lesson_design.desired_results`, `evidence_of_learning`, `learning_plan` |
| Kolb's Cycle 4 phases | Anders | `lessons.kolb_phase`, `lesson_sessions.kolb_phase_experienced`, `R06` updated |
| AI Literacy 4 components (TICRR) | Anders | AI Tutor prompt builder, `learner_models.ai_literacy_score` |
| 5 AI Literacy SLOs | Southworth | `ai_literacy_assessments` table, `AI_LITERACY_LABELS` widget |
| Rubric-based Mastery (4 levels) | Southworth | `ai_literacy_assessments.rubric_score` (1-4) |
| Interdisciplinary AI integration | Southworth | `lessons.ai_literacy_type` field per lesson |

---

*Phần C tích hợp 3 khung sư phạm hiện đại vào kiến trúc AURA, đảm bảo hệ thống không chỉ là LMS kỹ thuật mà còn là hệ thống học tập thích nghi có căn cứ lý thuyết vững chắc.*

*Cập nhật: 2026-04-06 | Nguồn bổ sung: Biggs & Tang (5th ed) + Anders (2026) + Southworth et al. (2023)*

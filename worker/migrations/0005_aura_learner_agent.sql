-- Migration 0005: Learner Model + Agent Architecture
-- SRS: Learner Model fields, Curriculum Rules R01-R09, Event Log, Agent Decisions
-- Biggs: SOLO profile, Declarative/Functioning mastery, Learning Approach
-- Southworth: AI Literacy score (5 types)
-- Anders: Kolb phase tracking per session

-- ══════════════════════════════════════════════════════════
-- LEARNER MODELS
-- ══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS learner_models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL UNIQUE,

  -- Core mastery map (SRS)
  -- JSON: { "020108.0202d3": 0.72, "020108.0202d4": 0.45 }
  mastery_map TEXT NOT NULL DEFAULT '{}',

  -- Bloom profile across 6 levels (SRS)
  -- JSON: { "1": 0.9, "2": 0.8, "3": 0.6, "4": 0.4, "5": 0.2, "6": 0.1 }
  bloom_profile TEXT NOT NULL DEFAULT '{}',

  -- Error patterns per lesson (SRS)
  -- JSON: { "lesson_id": ["arithmetic_error", "sign_error"] }
  error_patterns TEXT NOT NULL DEFAULT '{}',

  -- Speed profile by level (SRS) — seconds per problem
  -- JSON: { "nen_tang": 180, "mo_rong": 240, "chuyen_sau": 420 }
  speed_profile TEXT NOT NULL DEFAULT '{}',

  -- SOLO Profile (Biggs & Tang)
  -- JSON: { "lesson_id": { "achieved": 3, "target": 4, "last_assessed": "2026-04-06" } }
  solo_profile TEXT NOT NULL DEFAULT '{}',

  -- Declarative vs Functioning Mastery (Biggs & Tang)
  -- declarative_mastery: knows ABOUT concepts (recognition, recall)
  -- JSON: { "lesson_id": 0.85 }
  declarative_mastery TEXT NOT NULL DEFAULT '{}',
  -- functioning_mastery: can USE concepts in real tasks
  -- JSON: { "lesson_id": 0.65 }
  functioning_mastery TEXT NOT NULL DEFAULT '{}',

  -- Learning Approach (Biggs & Tang)
  -- surface: memorise for exam; deep: seek understanding; strategic: optimise grades
  learning_approach TEXT NOT NULL DEFAULT 'strategic'
    CHECK (learning_approach IN ('surface','deep','strategic')),

  -- AI Literacy Score (Southworth 5-type framework)
  -- JSON: { "know_understand": 0.0, "use_apply": 0.0, "evaluate_create": 0.0, "ethics": 0.0, "career": 0.0 }
  ai_literacy_score TEXT NOT NULL DEFAULT '{}',

  -- State (SRS)
  current_lesson_id TEXT,
  current_level TEXT DEFAULT 'nen_tang'
    CHECK (current_level IN ('nen_tang','mo_rong','chuyen_sau')),
  engagement_score REAL DEFAULT 0.5
    CHECK (engagement_score BETWEEN 0.0 AND 1.0),
  preferred_model TEXT DEFAULT 'scaffold'
    CHECK (preferred_model IN ('scaffold','practice','case','teach','explore','repair','project','reflect')),
  consecutive_pass INTEGER DEFAULT 0,
  consecutive_fail INTEGER DEFAULT 0,

  -- Timestamps
  last_active TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_learner_user        ON learner_models(user_id);
CREATE INDEX IF NOT EXISTS idx_learner_lesson      ON learner_models(current_lesson_id);
CREATE INDEX IF NOT EXISTS idx_learner_approach    ON learner_models(learning_approach);

-- ══════════════════════════════════════════════════════════
-- EVENT LOG
-- ══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  lesson_id TEXT,
  event_type TEXT NOT NULL
    CHECK (event_type IN (
      'quiz_submitted',
      'assignment_submitted',
      'video_progress',
      'session_started',
      'session_ended',
      'discussion_posted',
      'peer_review_given',
      'lesson_completed',
      'teacher_override',
      'ai_literacy_assessed',   -- Southworth: one of 5 types assessed
      'solo_assessed'           -- Biggs: SOLO level determined
    )),
  -- Payload varies by event_type:
  -- quiz_submitted:       { "score":0.8, "bloom_level":3, "solo_level":4, "time_seconds":180, "errors":["type_A"] }
  -- solo_assessed:        { "solo_level":4, "assessor":"agent|teacher", "notes":"..." }
  -- ai_literacy_assessed: { "type":"use_apply", "score":0.7, "rubric_score":3 }
  -- lesson_completed:     { "mastery":0.82, "time_seconds":1200, "model":"scaffold" }
  -- teacher_override:     { "field":"mastery", "old_value":0.5, "new_value":0.8, "reason":"..." }
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_user    ON events(user_id);
CREATE INDEX IF NOT EXISTS idx_events_lesson  ON events(lesson_id);
CREATE INDEX IF NOT EXISTS idx_events_type    ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);

-- ══════════════════════════════════════════════════════════
-- AGENT DECISIONS (Curriculum Planner output — XAI requirement)
-- ══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS agent_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  triggered_by_event_id INTEGER REFERENCES events(id),
  rule_fired TEXT NOT NULL,             -- R01, R02, ..., R09, R_THRESHOLD, R_DEEP
  decision TEXT NOT NULL,               -- lesson_id assigned next
  reason TEXT NOT NULL,                 -- Human-readable Vietnamese explanation (XAI)
  confidence REAL DEFAULT 0.8
    CHECK (confidence BETWEEN 0.0 AND 1.0),
  -- NULL=pending student action, 1=accepted, 0=rejected by teacher or student
  accepted INTEGER DEFAULT NULL
    CHECK (accepted IS NULL OR accepted IN (0,1)),
  outcome TEXT,                         -- mastery delta after completing assigned lesson
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_decisions_user    ON agent_decisions(user_id);
CREATE INDEX IF NOT EXISTS idx_decisions_rule    ON agent_decisions(rule_fired);
CREATE INDEX IF NOT EXISTS idx_decisions_created ON agent_decisions(created_at);

-- ══════════════════════════════════════════════════════════
-- CURRICULUM RULES (seed data)
-- ══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS curriculum_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id TEXT NOT NULL UNIQUE,         -- R01..R09, R_THRESHOLD, R_DEEP
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  trigger_condition TEXT NOT NULL,      -- Pseudocode for documentation
  action TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 5   -- 1 (highest) to 10 (lowest)
    CHECK (priority BETWEEN 1 AND 10),
  is_active INTEGER NOT NULL DEFAULT 1
    CHECK (is_active IN (0,1)),
  -- Pedagogical framework source
  framework_source TEXT DEFAULT 'SRS'   -- SRS | Biggs | Anders | Southworth | SRS+Biggs | SRS+Anders
    CHECK (framework_source IN ('SRS','Biggs','Anders','Southworth','SRS+Biggs','SRS+Anders')),
  created_at TEXT DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO curriculum_rules
  (rule_id, name, description, trigger_condition, action, priority, framework_source)
VALUES
  ('R01', 'Repair Trigger',
   'Kích hoạt sửa chữa khi điểm thấp liên tiếp hoặc SOLO <= 2 hoặc threshold chưa vượt qua',
   'consecutive_fail >= 3 OR solo_level <= 2',
   'assign lesson_model=repair on current lesson; decrease solo_target by 1',
   1, 'SRS+Biggs'),

  ('R02', 'Downgrade Level',
   'Giảm độ khó khi học sinh không theo kịp cấp độ hiện tại',
   'consecutive_fail >= 2 AND current_level != "nen_tang"',
   'current_level -= 1 step (chuyen_sau→mo_rong→nen_tang)',
   2, 'SRS'),

  ('R03', 'Upgrade Level',
   'Tăng độ khó khi học sinh vượt kỳ vọng liên tiếp',
   'consecutive_pass >= 3 AND mastery >= 0.85 AND current_level != "chuyen_sau"',
   'current_level += 1 step; assign next lesson at higher level',
   3, 'SRS'),

  ('R04', 'Dormant Review',
   'Ôn lại bài không học trong 7 ngày (spaced repetition — SM-2)',
   'days_since_last_active >= 7',
   'assign spaced-repetition review of dormant lessons; prioritise by mastery decay',
   4, 'SRS'),

  ('R05', 'Bloom Gap',
   'Lấp đầy khoảng trống Bloom khi HS giỏi nhớ/hiểu nhưng kém vận dụng/phân tích',
   'bloom_profile["1..2"] > 0.8 AND bloom_profile["3..4"] < 0.5',
   'assign case-based or project lesson targeting bloom levels 3-4',
   5, 'SRS'),

  ('R06', 'Timing / Kolb Phase',
   'Điều chỉnh bài học theo Kolb phase phù hợp với trạng thái học tập hiện tại',
   'session_context.kolb_mismatch = true OR engagement_score < 0.4',
   'reassign lesson with matching kolb_phase; rotate lesson_model for variety',
   6, 'SRS+Anders'),

  ('R07', 'Peer Expert',
   'Chuyển HS giỏi sang vai trò dạy bạn (Peer Expert / Teach-back)',
   'consecutive_pass >= 5 AND mastery >= 0.9',
   'assign lesson_model=teach; create peer_review opportunity for target lesson',
   7, 'SRS'),

  ('R08', 'Preferred Model Boost',
   'Dùng mô hình học sinh ưa thích khi cần tăng lại engagement thấp',
   'engagement_score < 0.4 AND preferred_model != current_model',
   'assign lesson using preferred_model; monitor engagement next session',
   8, 'SRS'),

  ('R09', 'Variety Rotation',
   'Tránh lặp lại cùng lesson_model quá 3 lần liên tiếp để tránh nhàm',
   'last_3_models all same',
   'rotate to different lesson_model suitable for current bloom/solo level',
   9, 'SRS'),

  ('R_THRESHOLD', 'Threshold Concept Block',
   'Không cho tiến khi threshold concept chưa vượt qua — ưu tiên tuyệt đối',
   'threshold_concept = 1 AND (solo_level <= 2 OR mastery < 0.6)',
   'force repair pathway on threshold lesson; block next_if_pass until solo_level >= 3 AND mastery >= 0.7',
   1, 'Biggs'),

  ('R_DEEP', 'Surface to Deep Learning Shift',
   'Chuyển HS từ surface learning sang functioning knowledge khi đã đủ nền tảng declarative',
   'learning_approach = "surface" AND consecutive_pass >= 3 AND knowledge_type = "declarative"',
   'assign case/project lesson requiring functioning knowledge; update preferred_model',
   5, 'Biggs');

-- ══════════════════════════════════════════════════════════
-- LESSON SESSIONS (per-student, per-lesson session tracking)
-- ══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS lesson_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  lesson_id TEXT NOT NULL,
  session_start TEXT NOT NULL,
  session_end TEXT,
  -- 5-Stage lesson model progress (1=Kích hoạt, 2=Kiến tạo, 3=Hành động, 4=Phản chiếu, 5=Tổng kết)
  stage_reached INTEGER DEFAULT 1
    CHECK (stage_reached BETWEEN 1 AND 5),
  -- Kolb phase primarily experienced in this session (Anders)
  kolb_phase_experienced TEXT
    CHECK (kolb_phase_experienced IS NULL OR kolb_phase_experienced IN ('CE','RO','AC','AE','all')),
  -- SOLO assessment before/after (Biggs)
  solo_level_before INTEGER CHECK (solo_level_before IS NULL OR solo_level_before BETWEEN 1 AND 5),
  solo_level_after  INTEGER CHECK (solo_level_after  IS NULL OR solo_level_after  BETWEEN 1 AND 5),
  bloom_score REAL
    CHECK (bloom_score IS NULL OR bloom_score BETWEEN 0.0 AND 1.0),
  time_on_task_seconds INTEGER DEFAULT 0,
  interactions INTEGER DEFAULT 0,       -- number of AI Tutor chat turns
  hint_count INTEGER DEFAULT 0,
  -- Which AI literacy type was practiced this session (Southworth)
  ai_literacy_practiced TEXT
    CHECK (ai_literacy_practiced IS NULL OR ai_literacy_practiced IN (
      'know_understand','use_apply','evaluate_create','ethics','career'
    )),
  status TEXT DEFAULT 'active'
    CHECK (status IN ('active','completed','abandoned')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_user    ON lesson_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_lesson  ON lesson_sessions(lesson_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status  ON lesson_sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_created ON lesson_sessions(created_at);

-- Migration 0006: Pedagogical Framework Support Tables
-- Biggs & Tang: Constructive Alignment detail (lesson_design), SOLO assessments, Threshold tracking
-- Anders: ADDIE lesson design documentation
-- Southworth: AI Literacy 5-type rubric assessments

-- ══════════════════════════════════════════════════════════
-- LESSON DESIGN (ADDIE + Constructive Alignment — Biggs & Anders)
-- Full design record for each lesson; versioned for iterative improvement
-- ══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS lesson_design (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lesson_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,

  -- ILOs — Intended Learning Outcomes (Biggs: verb + topic + context)
  -- JSON: [
  --   { "solo_level": 4, "verb": "phân tích", "topic": "phương trình bậc 2",
  --     "context": "trong bài toán thực tế", "bloom_level": 4 },
  --   { "solo_level": 3, "verb": "áp dụng",  "topic": "công thức nghiệm",
  --     "context": "giải bài tập cơ bản",    "bloom_level": 3 }
  -- ]
  ilos TEXT NOT NULL DEFAULT '[]',

  -- TLAs — Teaching-Learning Activities (Kolb cycle + 5-Stage)
  -- JSON: [
  --   { "stage": 1, "kolb": "CE", "activity": "Xem video tình huống thực tế",  "duration_min": 3 },
  --   { "stage": 2, "kolb": "AC", "activity": "Xây dựng công thức từ ví dụ",   "duration_min": 10 },
  --   { "stage": 3, "kolb": "AE", "activity": "Giải 5 bài tập có hướng dẫn",   "duration_min": 15 },
  --   { "stage": 4, "kolb": "RO", "activity": "So sánh cách giải của em vs mẫu","duration_min": 5 },
  --   { "stage": 5, "kolb": "all","activity": "Tóm tắt và tự kiểm tra",        "duration_min": 5 }
  -- ]
  tlas TEXT NOT NULL DEFAULT '[]',

  -- ATs — Assessment Tasks aligned with ILOs
  -- JSON: [
  --   { "type": "quiz", "format": "MCQ", "bloom_level": 3, "solo_target": 4, "rubric_score_pass": 3 },
  --   { "type": "project", "format": "open_ended", "bloom_level": 5, "solo_target": 5 }
  -- ]
  assessment_tasks TEXT NOT NULL DEFAULT '[]',

  -- ADDIE documentation (Anders)
  addie_analysis TEXT,          -- Learner needs, prior knowledge, constraints
  addie_design TEXT,            -- Design decisions + rationale
  addie_development TEXT,       -- Content created (URLs, media, quiz IDs)
  addie_evaluation_plan TEXT,   -- How effectiveness will be measured

  -- Backward Design (Wiggins & McTighe, via Anders)
  desired_results TEXT,         -- Stage 1: "Students will be able to..."
  evidence_of_learning TEXT,    -- Stage 2: Assessment task descriptions
  learning_plan TEXT,           -- Stage 3: TLA summary narrative

  is_current INTEGER NOT NULL DEFAULT 1
    CHECK (is_current IN (0,1)),
  created_by TEXT,              -- teacher/admin user_id
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),

  UNIQUE(lesson_id, version)
);

CREATE INDEX IF NOT EXISTS idx_design_lesson   ON lesson_design(lesson_id);
CREATE INDEX IF NOT EXISTS idx_design_current  ON lesson_design(lesson_id, is_current);
CREATE INDEX IF NOT EXISTS idx_design_creator  ON lesson_design(created_by);

-- ══════════════════════════════════════════════════════════
-- SOLO ASSESSMENTS (Biggs & Tang SOLO Taxonomy)
-- Records each SOLO level determination per student per lesson
-- Enables tracking progression: 1→2→3→4→5 over time
-- ══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS solo_assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  lesson_id TEXT NOT NULL,
  -- SOLO level: 1=Prestructural, 2=Unistructural, 3=Multistructural, 4=Relational, 5=Extended Abstract
  solo_level INTEGER NOT NULL CHECK (solo_level BETWEEN 1 AND 5),
  assessor_type TEXT NOT NULL DEFAULT 'agent'
    CHECK (assessor_type IN ('agent','teacher','self','peer')),
  -- Evidence: student response or behaviour that led to this assessment
  evidence TEXT,
  notes TEXT,                   -- Teacher or agent notes
  session_id INTEGER REFERENCES lesson_sessions(id),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_solo_user_lesson ON solo_assessments(user_id, lesson_id);
CREATE INDEX IF NOT EXISTS idx_solo_level       ON solo_assessments(solo_level);
CREATE INDEX IF NOT EXISTS idx_solo_created     ON solo_assessments(created_at);

-- ══════════════════════════════════════════════════════════
-- AI LITERACY ASSESSMENTS (Southworth et al. 5-type framework)
-- Rubric-based: 1=Beginning, 2=Developing, 3=Proficient, 4=Exemplary
-- ══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS ai_literacy_assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  -- Southworth 5 types:
  --   know_understand  = Knows/Understands AI concepts
  --   use_apply        = Uses/Applies AI tools effectively
  --   evaluate_create  = Evaluates AI output, creates prompts
  --   ethics           = Understands AI ethics (bias, privacy, accountability)
  --   career           = Understands AI's impact on career/professional context
  literacy_type TEXT NOT NULL
    CHECK (literacy_type IN ('know_understand','use_apply','evaluate_create','ethics','career')),
  -- Rubric score (Southworth 4-level rubric)
  rubric_score INTEGER NOT NULL CHECK (rubric_score BETWEEN 1 AND 4),
  -- Normalized 0.0-1.0 for learner_models.ai_literacy_score
  normalized_score REAL NOT NULL CHECK (normalized_score BETWEEN 0.0 AND 1.0),
  evidence TEXT,                -- Student work/behaviour evidence
  lesson_context TEXT,          -- lesson_id or module where assessed
  assessor_type TEXT DEFAULT 'agent'
    CHECK (assessor_type IN ('agent','teacher','self','peer')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ai_lit_user    ON ai_literacy_assessments(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_lit_type    ON ai_literacy_assessments(literacy_type);
CREATE INDEX IF NOT EXISTS idx_ai_lit_created ON ai_literacy_assessments(created_at);

-- ══════════════════════════════════════════════════════════
-- THRESHOLD CONCEPT PROGRESS (Biggs & Tang)
-- Tracks student progression through "stuck" threshold concepts
-- Status: blocked → liminal (in-between) → passed
-- ══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS threshold_progress (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  lesson_id TEXT NOT NULL,              -- lesson with threshold_concept = 1
  status TEXT NOT NULL DEFAULT 'blocked'
    CHECK (status IN ('blocked','liminal','passed')),
  -- blocked:  student cannot proceed; has not grasped the concept
  -- liminal:  in-between state; partial understanding, transforming
  -- passed:   threshold crossed; understanding has qualitatively changed
  attempts INTEGER NOT NULL DEFAULT 0,
  first_attempt TEXT,                   -- datetime of first attempt
  breakthrough_at TEXT,                 -- datetime when status changed to 'passed'
  teacher_notes TEXT,                   -- qualitative notes from teacher
  UNIQUE(user_id, lesson_id)
);

CREATE INDEX IF NOT EXISTS idx_threshold_user   ON threshold_progress(user_id);
CREATE INDEX IF NOT EXISTS idx_threshold_status ON threshold_progress(status);
CREATE INDEX IF NOT EXISTS idx_threshold_lesson ON threshold_progress(lesson_id);

-- Migration 0004: Lessons table với pedagogical framework fields
-- Biggs & Tang: SOLO taxonomy, Constructive Alignment, Threshold Concepts
-- Anders: Kolb cycle, ADDIE, Knowledge Type
-- Southworth: AI Literacy integration
-- Schema source: schema_791 (784 YCCĐ Toán lớp 1-12, QĐ 791/QĐ-SGDĐT)

CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Core fields (từ schema_791 và SRS)
  lesson_id TEXT NOT NULL UNIQUE,           -- e.g., "020108.0202d3"
  subject TEXT NOT NULL DEFAULT 'toan',
  grade_num INTEGER NOT NULL,               -- 1-12
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','active','archived')),

  -- Bloom's Taxonomy (từ schema_791)
  bloom_level INTEGER NOT NULL DEFAULT 1    -- 1-6
    CHECK (bloom_level BETWEEN 1 AND 6),
  bloom_vi TEXT,                            -- Nhớ | Hiểu | Vận dụng | Phân tích | Đánh giá | Sáng tạo

  -- SOLO Taxonomy (Biggs & Tang)
  -- 1=Prestructural, 2=Unistructural, 3=Multistructural, 4=Relational, 5=Extended Abstract
  solo_level INTEGER NOT NULL DEFAULT 3
    CHECK (solo_level BETWEEN 1 AND 5),
  solo_target INTEGER NOT NULL DEFAULT 4    -- target SOLO level after lesson completion
    CHECK (solo_target BETWEEN 2 AND 5),

  -- Knowledge Type (Biggs & Tang: Declarative vs Functioning)
  -- declarative = know ABOUT; functioning = know HOW TO USE
  knowledge_type TEXT NOT NULL DEFAULT 'declarative'
    CHECK (knowledge_type IN ('declarative','functioning','both')),

  -- Threshold Concept (Biggs & Tang)
  -- 1 = this is a threshold concept; blocks progression until mastered
  threshold_concept INTEGER NOT NULL DEFAULT 0
    CHECK (threshold_concept IN (0,1)),
  threshold_notes TEXT,                     -- Why this is a threshold concept

  -- Kolb's Experiential Learning Cycle (Anders)
  -- CE=Concrete Experience, RO=Reflective Observation, AC=Abstract Conceptualization, AE=Active Experimentation
  kolb_phase TEXT DEFAULT 'all'
    CHECK (kolb_phase IN ('CE','RO','AC','AE','all')),

  -- Lesson Model (từ SRS + ThietKeBaiHoc)
  lesson_model TEXT NOT NULL DEFAULT 'scaffold'
    CHECK (lesson_model IN ('scaffold','practice','case','teach','explore','repair','project','reflect')),
  lesson_level TEXT NOT NULL DEFAULT 'nen_tang'
    CHECK (lesson_level IN ('nen_tang','mo_rong','chuyen_sau')),

  -- Navigation (từ schema_791)
  next_if_pass TEXT,                        -- lesson_id of next lesson if mastered
  next_if_fail TEXT,                        -- lesson_id of remediation lesson
  prerequisite_ids TEXT DEFAULT '[]',       -- JSON array of prerequisite lesson_ids

  -- Constructive Alignment (Biggs & Tang + Anders ADDIE)
  -- JSON: { "ilos": [...], "tlas": [...], "ats": [...], "addie": {...} }
  constructive_alignment TEXT DEFAULT '{}',

  -- AI Literacy Integration (Southworth)
  ai_literacy_type TEXT DEFAULT NULL
    CHECK (ai_literacy_type IS NULL OR ai_literacy_type IN (
      'know_understand','use_apply','evaluate_create','ethics','career'
    )),

  -- Metadata
  content_url TEXT,                         -- URL to actual content (NocoDB article)
  estimated_minutes INTEGER DEFAULT 20,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_lessons_lesson_id       ON lessons(lesson_id);
CREATE INDEX IF NOT EXISTS idx_lessons_grade           ON lessons(grade_num);
CREATE INDEX IF NOT EXISTS idx_lessons_subject_grade   ON lessons(subject, grade_num);
CREATE INDEX IF NOT EXISTS idx_lessons_bloom           ON lessons(bloom_level);
CREATE INDEX IF NOT EXISTS idx_lessons_solo            ON lessons(solo_level);
CREATE INDEX IF NOT EXISTS idx_lessons_threshold       ON lessons(threshold_concept);
CREATE INDEX IF NOT EXISTS idx_lessons_knowledge_type  ON lessons(knowledge_type);
CREATE INDEX IF NOT EXISTS idx_lessons_status          ON lessons(status);

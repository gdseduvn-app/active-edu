-- Migration 003: AURA Pedagogical Extensions
-- Source: SRS-CH04 §4.6, SRS-CH07 §7.4, Worker migrations 0004-0006
-- Extends the base schema with lesson design, AURA pipeline metadata,
-- SOLO assessments, and AI literacy tracking.

-- ══════════════════════════════════════════════════════════
-- LESSON DESIGN (ADDIE model + Constructive Alignment)
-- ══════════════════════════════════════════════════════════
CREATE TABLE lesson_designs (
  id                UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  lesson_id         UUID         NOT NULL UNIQUE REFERENCES lessons(id) ON DELETE CASCADE,

  -- Constructive Alignment (Biggs & Tang)
  ilos              JSONB        NOT NULL DEFAULT '[]',
  -- [{ id, code, description, bloom_level, solo_target, verb, condition, standard }]

  tlas              JSONB        NOT NULL DEFAULT '[]',
  -- [{ id, name, al_format, duration_min, kolb_phase, description }]

  assessment_tasks  JSONB        NOT NULL DEFAULT '[]',
  -- [{ id, name, type, weight_percent, rubric_criteria }]

  -- ADDIE model fields
  analysis_notes    TEXT,
  design_notes      TEXT,
  development_notes TEXT,
  implementation_notes TEXT,
  evaluation_notes  TEXT,

  -- Active Learning
  al_format         VARCHAR(50),   -- think_pair_share, pbl, jigsaw, etc.
  kolb_cycle        JSONB          DEFAULT '[]',  -- [{phase, duration_min, activity}]

  -- Knowledge type (Biggs)
  knowledge_type    VARCHAR(20)   DEFAULT 'declarative'
                      CHECK (knowledge_type IN ('declarative','functioning','both')),
  threshold_concept BOOLEAN       NOT NULL DEFAULT FALSE,
  threshold_concept_name VARCHAR(200),

  -- AI Literacy (Southworth et al. 2023)
  ai_literacy_type  VARCHAR(20)   CHECK (ai_literacy_type IN (
                      'know_ai','use_ai','evaluate_ai','create_ai','act_responsibly', NULL
                    )),
  ai_literacy_slos  JSONB         DEFAULT '[]',  -- Southworth SLOs

  -- SOLO target
  solo_target       SMALLINT      DEFAULT 4 CHECK (solo_target BETWEEN 1 AND 5),

  -- Revision tracking
  version           INTEGER       NOT NULL DEFAULT 1,
  designed_by       UUID          REFERENCES users(id),
  reviewed_by       UUID          REFERENCES users(id),
  reviewed_at       TIMESTAMPTZ,

  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ld_lesson    ON lesson_designs(lesson_id);
CREATE INDEX idx_ld_al_format ON lesson_designs(al_format) WHERE al_format IS NOT NULL;

-- ══════════════════════════════════════════════════════════
-- SOLO ASSESSMENTS (per quiz attempt)
-- ══════════════════════════════════════════════════════════
CREATE TABLE solo_assessments (
  id                UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID         NOT NULL REFERENCES users(id),
  lesson_id         UUID         NOT NULL REFERENCES lessons(id),
  quiz_attempt_id   UUID         REFERENCES quiz_attempts(id),

  -- SOLO level scored (1-5)
  solo_level        SMALLINT     NOT NULL CHECK (solo_level BETWEEN 1 AND 5),
  solo_label        VARCHAR(30)  NOT NULL,  -- 'Multistructural', etc.
  evidence          TEXT,                   -- short justification

  -- Sub-scores by category
  recall_score      REAL,         -- Levels 1-2
  connection_score  REAL,         -- Level 3-4
  extension_score   REAL,         -- Level 5

  assessed_by       VARCHAR(10)  NOT NULL DEFAULT 'ai'
                      CHECK (assessed_by IN ('ai','teacher','self')),
  assessed_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  UNIQUE(user_id, quiz_attempt_id)
);

CREATE INDEX idx_sa_user_lesson ON solo_assessments(user_id, lesson_id);

-- ══════════════════════════════════════════════════════════
-- AI LITERACY ASSESSMENTS (Southworth 5-type, 4-level rubric)
-- ══════════════════════════════════════════════════════════
CREATE TABLE ai_literacy_assessments (
  id                UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID         NOT NULL REFERENCES users(id),
  lesson_id         UUID         NOT NULL REFERENCES lessons(id),

  -- Southworth type assessed
  literacy_type     VARCHAR(20)  NOT NULL
                      CHECK (literacy_type IN ('know_ai','use_ai','evaluate_ai','create_ai','act_responsibly')),

  -- 4-level rubric score (1=Beginning, 2=Developing, 3=Proficient, 4=Advanced)
  rubric_level      SMALLINT     NOT NULL CHECK (rubric_level BETWEEN 1 AND 4),
  rubric_label      VARCHAR(20)  NOT NULL,  -- 'Beginning', 'Developing', etc.

  -- Evidence
  evidence_text     TEXT,
  task_ref_id       UUID,         -- reference to quiz attempt or activity

  assessed_by       VARCHAR(10)  NOT NULL DEFAULT 'ai',
  assessed_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ala_user ON ai_literacy_assessments(user_id, literacy_type);

-- ══════════════════════════════════════════════════════════
-- NOTIFICATIONS (System + AI alerts)
-- ══════════════════════════════════════════════════════════
CREATE TABLE notifications (
  id                UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type              VARCHAR(30)  NOT NULL CHECK (type IN (
                      'ai_alert', 'quiz_graded', 'badge_earned', 'level_up',
                      'teacher_message', 'flashcard_due', 'peer_review_request',
                      'threshold_breakthrough', 'announcement'
                    )),
  title             VARCHAR(200) NOT NULL,
  body              TEXT         NOT NULL,
  data              JSONB        DEFAULT '{}',  -- contextual data (lesson_id, badge, etc.)
  is_read           BOOLEAN      NOT NULL DEFAULT FALSE,
  read_at           TIMESTAMPTZ,
  created_by        UUID         REFERENCES users(id),  -- NULL = system
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notif_user_unread ON notifications(user_id, created_at DESC) WHERE is_read = FALSE;
CREATE INDEX idx_notif_user_all    ON notifications(user_id, created_at DESC);

-- ══════════════════════════════════════════════════════════
-- PEER REVIEWS (for Peer Instruction / Jigsaw AL formats)
-- ══════════════════════════════════════════════════════════
CREATE TABLE peer_reviews (
  id                UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  lesson_id         UUID         NOT NULL REFERENCES lessons(id),
  reviewer_id       UUID         NOT NULL REFERENCES users(id),
  reviewee_id       UUID         NOT NULL REFERENCES users(id),
  quiz_attempt_id   UUID         REFERENCES quiz_attempts(id),

  score             REAL,
  rubric_scores     JSONB        DEFAULT '[]',  -- [{criterion, score, comment}]
  comment           TEXT,
  is_anonymous      BOOLEAN      NOT NULL DEFAULT FALSE,

  status            VARCHAR(15)  NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','submitted','accepted')),
  submitted_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  UNIQUE(reviewer_id, reviewee_id, quiz_attempt_id)
);

CREATE INDEX idx_pr_reviewee ON peer_reviews(reviewee_id, status);
CREATE INDEX idx_pr_lesson   ON peer_reviews(lesson_id, status);

-- ══════════════════════════════════════════════════════════
-- DISCUSSIONS / Q&A (per lesson)
-- ══════════════════════════════════════════════════════════
CREATE TABLE discussions (
  id                UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  lesson_id         UUID         NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  parent_id         UUID         REFERENCES discussions(id),  -- NULL = top-level thread
  author_id         UUID         NOT NULL REFERENCES users(id),

  body              TEXT         NOT NULL,
  is_pinned         BOOLEAN      NOT NULL DEFAULT FALSE,
  is_answered       BOOLEAN      NOT NULL DEFAULT FALSE,  -- for Q&A threads
  upvotes           INTEGER      NOT NULL DEFAULT 0,

  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deleted_at        TIMESTAMPTZ
);

CREATE INDEX idx_disc_lesson  ON discussions(lesson_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_disc_parent  ON discussions(parent_id) WHERE parent_id IS NOT NULL;

-- ══════════════════════════════════════════════════════════
-- EXTEND lessons table with pedagogical columns
-- ══════════════════════════════════════════════════════════
ALTER TABLE lessons
  ADD COLUMN IF NOT EXISTS solo_level    SMALLINT  DEFAULT 3 CHECK (solo_level BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS solo_target   SMALLINT  DEFAULT 4 CHECK (solo_target BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS knowledge_type VARCHAR(20) DEFAULT 'declarative'
    CHECK (knowledge_type IN ('declarative','functioning','both')),
  ADD COLUMN IF NOT EXISTS threshold_concept BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS al_format     VARCHAR(50),
  ADD COLUMN IF NOT EXISTS kolb_phase    VARCHAR(20) DEFAULT 'all',
  ADD COLUMN IF NOT EXISTS ai_literacy_type VARCHAR(20)
    CHECK (ai_literacy_type IN ('know_ai','use_ai','evaluate_ai','create_ai','act_responsibly', NULL)),
  ADD COLUMN IF NOT EXISTS constructive_alignment JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS yccđ_codes    TEXT[]  DEFAULT '{}',  -- QĐ 791 codes
  ADD COLUMN IF NOT EXISTS shuffle_questions BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS show_hints       BOOLEAN NOT NULL DEFAULT TRUE;

-- ══════════════════════════════════════════════════════════
-- EXTEND learner_models with SOLO + AI literacy
-- ══════════════════════════════════════════════════════════
ALTER TABLE learner_models
  ADD COLUMN IF NOT EXISTS solo_profile    JSONB  DEFAULT '{}',  -- {lesson_code: solo_level}
  ADD COLUMN IF NOT EXISTS ai_literacy_score JSONB DEFAULT '{}', -- {type: rubric_level}
  ADD COLUMN IF NOT EXISTS declarative_mastery REAL DEFAULT 0.0,
  ADD COLUMN IF NOT EXISTS functioning_mastery REAL DEFAULT 0.0,
  ADD COLUMN IF NOT EXISTS learning_approach VARCHAR(20) DEFAULT 'surface'
    CHECK (learning_approach IN ('deep','surface','strategic'));

-- ══════════════════════════════════════════════════════════
-- UPDATED_AT triggers for new tables
-- ══════════════════════════════════════════════════════════
CREATE TRIGGER trg_lesson_designs_updated
  BEFORE UPDATE ON lesson_designs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_discussions_updated
  BEFORE UPDATE ON discussions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Migration 001: Initial Schema — AdaptLearn LMS
-- Source: SRS-CH02 v1.0 (THPT Thủ Thiêm)
-- All tables use UUID PK except events (BIGSERIAL for insert performance)
-- Soft delete via deleted_at (NULL = not deleted)

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- for full-text search

-- ══════════════════════════════════════════════════════════
-- USERS & ROLES
-- ══════════════════════════════════════════════════════════
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

-- ══════════════════════════════════════════════════════════
-- LESSONS (Kho học liệu — linked to YCCĐ QĐ 791)
-- ══════════════════════════════════════════════════════════
CREATE TABLE lessons (
  id                  UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  lesson_code         VARCHAR(30)  NOT NULL UNIQUE, -- e.g. "020108.0202a6"
  title               VARCHAR(500) NOT NULL,
  subject             VARCHAR(50)  NOT NULL DEFAULT 'toan',
  grade               SMALLINT     NOT NULL CHECK (grade BETWEEN 1 AND 12),
  unit_l1             VARCHAR(255),               -- Chủ đề cấp 1
  unit_l2             VARCHAR(255),               -- Chủ đề cấp 2
  yccđ_requirement    TEXT,                       -- Yêu cầu cần đạt từ QĐ 791
  bloom_level         SMALLINT     NOT NULL DEFAULT 1 CHECK (bloom_level BETWEEN 1 AND 6),
  bloom_vi            VARCHAR(50),                -- Nhận biết | Thông hiểu | Vận dụng...
  solo_level          SMALLINT     NOT NULL DEFAULT 3 CHECK (solo_level BETWEEN 1 AND 5),
  solo_target         SMALLINT     NOT NULL DEFAULT 4 CHECK (solo_target BETWEEN 1 AND 5),
  knowledge_type      VARCHAR(20)  NOT NULL DEFAULT 'declarative'
                        CHECK (knowledge_type IN ('declarative','functioning','both')),
  threshold_concept   BOOLEAN      NOT NULL DEFAULT FALSE,
  lesson_model        VARCHAR(20)  NOT NULL DEFAULT 'scaffold'
                        CHECK (lesson_model IN ('scaffold','practice','case','teach','explore','repair','project','reflect')),
  difficulty_level    VARCHAR(20)  NOT NULL DEFAULT 'nen_tang'
                        CHECK (difficulty_level IN ('nen_tang','mo_rong','chuyen_sau')),
  al_format           VARCHAR(30)  CHECK (al_format IN (
                        'think_pair_share','worked_example_fading','muddiest_point','exit_ticket',
                        'problem_based','peer_instruction','socratic','flipped',
                        'case_study','station_rotation','jigsaw','argumentation',
                        'project_based','design_thinking')),
  kolb_phase          VARCHAR(10)  DEFAULT 'all',
  next_if_pass        VARCHAR(30),                -- lesson_code of next lesson
  next_if_fail        VARCHAR(30),                -- lesson_code of remediation
  prerequisite_codes  TEXT[]       DEFAULT '{}',
  estimated_minutes   SMALLINT     DEFAULT 20,
  -- AURA HTML content (from Lesson Studio)
  html_content        TEXT,                       -- AURA schema HTML
  -- Constructive Alignment (Biggs)
  ilos                JSONB        DEFAULT '[]',  -- [{solo,verb,topic}]
  tlas                JSONB        DEFAULT '[]',  -- 5-stage TLA
  assessment_tasks    JSONB        DEFAULT '[]',
  -- Scoring
  total_points        SMALLINT     DEFAULT 0,
  -- Status
  status              VARCHAR(20)  NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','review','published','archived')),
  author_id           UUID         REFERENCES users(id),
  published_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deleted_at          TIMESTAMPTZ
);

CREATE INDEX idx_lessons_code       ON lessons(lesson_code);
CREATE INDEX idx_lessons_grade      ON lessons(grade, subject) WHERE deleted_at IS NULL;
CREATE INDEX idx_lessons_bloom      ON lessons(bloom_level) WHERE deleted_at IS NULL;
CREATE INDEX idx_lessons_status     ON lessons(status) WHERE deleted_at IS NULL;
CREATE INDEX idx_lessons_search     ON lessons USING gin(to_tsvector('simple', title || ' ' || COALESCE(yccđ_requirement,'')));

-- ══════════════════════════════════════════════════════════
-- LEARNER MODELS (Single source of truth per student)
-- ══════════════════════════════════════════════════════════
CREATE TABLE learner_models (
  id                   UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id              UUID         NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  -- Mastery (key = lesson_code, value = 0.0–1.0)
  mastery_map          JSONB        NOT NULL DEFAULT '{}',
  -- Bloom profile ({1:0.9, 2:0.8, ...})
  bloom_profile        JSONB        NOT NULL DEFAULT '{"1":0,"2":0,"3":0,"4":0,"5":0,"6":0}',
  -- Error patterns ({lesson_code: ["arithmetic","sign_error"]})
  error_patterns       JSONB        NOT NULL DEFAULT '{}',
  -- Speed profile ({nen_tang:180, mo_rong:240, chuyen_sau:420}) seconds
  speed_profile        JSONB        NOT NULL DEFAULT '{"nen_tang":300,"mo_rong":420,"chuyen_sau":600}',
  -- SOLO profile ({lesson_code: {achieved:3, target:4}})
  solo_profile         JSONB        NOT NULL DEFAULT '{}',
  -- Declarative vs Functioning mastery
  declarative_mastery  JSONB        NOT NULL DEFAULT '{}',
  functioning_mastery  JSONB        NOT NULL DEFAULT '{}',
  -- AI Literacy (Southworth 5-type)
  ai_literacy_score    JSONB        NOT NULL DEFAULT '{"know_understand":0,"use_apply":0,"evaluate_create":0,"ethics":0,"career":0}',
  -- Current state
  current_lesson_id    UUID         REFERENCES lessons(id),
  current_level        VARCHAR(20)  NOT NULL DEFAULT 'nen_tang'
                          CHECK (current_level IN ('nen_tang','mo_rong','chuyen_sau')),
  engagement_score     REAL         NOT NULL DEFAULT 0.5 CHECK (engagement_score BETWEEN 0 AND 1),
  preferred_model      VARCHAR(20)  DEFAULT 'scaffold',
  learning_approach    VARCHAR(20)  NOT NULL DEFAULT 'strategic'
                          CHECK (learning_approach IN ('surface','deep','strategic')),
  consecutive_pass     SMALLINT     NOT NULL DEFAULT 0,
  consecutive_fail     SMALLINT     NOT NULL DEFAULT 0,
  -- Tags: 'peer_expert', 'at_risk', 'fast_learner', 'needs_repair'
  tags                 TEXT[]       DEFAULT '{}',
  notes                TEXT         DEFAULT '',    -- GV notes, Agent does NOT read this
  last_session_at      TIMESTAMPTZ,               -- Triggers R04 if NOW() - > 48h
  last_lesson_id       UUID         REFERENCES lessons(id),
  streak_days          SMALLINT     NOT NULL DEFAULT 0,
  total_study_minutes  INTEGER      NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_lm_user    ON learner_models(user_id);
CREATE INDEX idx_lm_tags    ON learner_models USING gin(tags);
CREATE INDEX idx_lm_level   ON learner_models(current_level);

-- ══════════════════════════════════════════════════════════
-- LEARNER MODEL SNAPSHOTS (immutable history)
-- ══════════════════════════════════════════════════════════
CREATE TABLE learner_model_snapshots (
  id             BIGSERIAL    PRIMARY KEY,
  user_id        UUID         NOT NULL REFERENCES users(id),
  snapshot       JSONB        NOT NULL,
  trigger_event  VARCHAR(50),                     -- event type that triggered snapshot
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_lm_snap_user ON learner_model_snapshots(user_id, created_at DESC);

-- ══════════════════════════════════════════════════════════
-- EVENTS (Append-only event log — BIGSERIAL for insert perf)
-- ══════════════════════════════════════════════════════════
CREATE TABLE events (
  id           BIGSERIAL    PRIMARY KEY,
  user_id      UUID         NOT NULL REFERENCES users(id),
  lesson_id    UUID         REFERENCES lessons(id),
  session_id   UUID,                              -- groups events in same session
  event_type   VARCHAR(50)  NOT NULL CHECK (event_type IN (
                 'quiz_submitted','assignment_submitted','video_progress',
                 'session_started','session_ended','discussion_posted',
                 'peer_review_given','lesson_completed','teacher_override',
                 'ai_literacy_assessed','solo_assessed','page_viewed',
                 'hint_requested','code_executed','flashcard_reviewed'
               )),
  payload      JSONB        NOT NULL DEFAULT '{}',
  processed    BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
) PARTITION BY RANGE (created_at);

-- Monthly partitions (create via script)
CREATE TABLE events_2026_04 PARTITION OF events
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE events_2026_05 PARTITION OF events
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

CREATE INDEX idx_events_user    ON events(user_id, created_at DESC);
CREATE INDEX idx_events_type    ON events(event_type, created_at DESC);
CREATE INDEX idx_events_proc    ON events(processed, created_at) WHERE processed = FALSE;

-- ══════════════════════════════════════════════════════════
-- AGENT DECISIONS (Immutable audit log of AI decisions)
-- ══════════════════════════════════════════════════════════
CREATE TABLE agent_decisions (
  id                   BIGSERIAL    PRIMARY KEY,
  user_id              UUID         NOT NULL REFERENCES users(id),
  trigger_event_id     BIGINT       REFERENCES events(id),
  rule_fired           VARCHAR(20)  NOT NULL,    -- R01..R10, DEFAULT
  next_lesson_id       UUID         REFERENCES lessons(id),
  reason               TEXT         NOT NULL,    -- Vietnamese explanation (XAI)
  confidence           REAL         DEFAULT 0.8 CHECK (confidence BETWEEN 0 AND 1),
  learner_model_at     JSONB,                    -- snapshot of LM at decision time
  -- Teacher override
  overridden_by        UUID         REFERENCES users(id),
  override_reason      TEXT,
  override_at          TIMESTAMPTZ,
  -- Outcome (filled after student completes the lesson)
  outcome_mastery_delta REAL,
  outcome_recorded_at  TIMESTAMPTZ,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ad_user    ON agent_decisions(user_id, created_at DESC);
CREATE INDEX idx_ad_rule    ON agent_decisions(rule_fired);

-- ══════════════════════════════════════════════════════════
-- QUESTIONS (Ngân hàng đề — Question Bank)
-- ══════════════════════════════════════════════════════════
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
  -- Content
  stem            TEXT         NOT NULL,          -- question text (supports LaTeX)
  options         JSONB        DEFAULT '[]',       -- [{id,text,is_correct}]
  correct_answer  TEXT,                           -- for fill_blank, math_input
  tolerance       REAL         DEFAULT 0.01,      -- numeric tolerance
  explanation     TEXT,                           -- shown after submit
  rubric          JSONB        DEFAULT '[]',       -- [{score,criteria}] for AI grading
  hints           TEXT[]       DEFAULT '{}',
  -- Auto-grading config
  auto_grade      BOOLEAN      NOT NULL DEFAULT TRUE,
  points          REAL         NOT NULL DEFAULT 1.0,
  -- Item Analysis stats (updated after each exam)
  times_used      INTEGER      NOT NULL DEFAULT 0,
  avg_score       REAL,
  discrimination  REAL,                           -- Item discrimination index
  -- Metadata
  tags            TEXT[]       DEFAULT '{}',
  author_id       UUID         REFERENCES users(id),
  is_public       BOOLEAN      NOT NULL DEFAULT FALSE,  -- shared in question bank
  status          VARCHAR(20)  NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','review','published','retired')),
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ
);

CREATE INDEX idx_q_lesson  ON questions(lesson_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_q_bloom   ON questions(bloom_level, difficulty) WHERE deleted_at IS NULL AND status = 'published';
CREATE INDEX idx_q_type    ON questions(question_type) WHERE deleted_at IS NULL;
CREATE INDEX idx_q_search  ON questions USING gin(to_tsvector('simple', stem));

-- ══════════════════════════════════════════════════════════
-- QUIZ ATTEMPTS
-- ══════════════════════════════════════════════════════════
CREATE TABLE quiz_attempts (
  id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID         NOT NULL REFERENCES users(id),
  lesson_id       UUID         NOT NULL REFERENCES lessons(id),
  attempt_number  SMALLINT     NOT NULL DEFAULT 1,
  -- Answers: [{question_id, answer, is_correct, score, time_ms}]
  answers         JSONB        NOT NULL DEFAULT '[]',
  total_score     REAL         NOT NULL DEFAULT 0,
  max_score       REAL         NOT NULL DEFAULT 0,
  score_percent   REAL GENERATED ALWAYS AS (
                    CASE WHEN max_score > 0 THEN (total_score / max_score) * 100 ELSE 0 END
                  ) STORED,
  passed          BOOLEAN,                        -- NULL until graded
  time_taken_sec  INTEGER,
  started_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  submitted_at    TIMESTAMPTZ,
  graded_at       TIMESTAMPTZ,
  feedback        TEXT,                           -- from Feedback Engine
  error_tags      TEXT[]       DEFAULT '{}',      -- error patterns detected
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_qa_user_lesson ON quiz_attempts(user_id, lesson_id);
CREATE INDEX idx_qa_submitted   ON quiz_attempts(submitted_at DESC) WHERE submitted_at IS NOT NULL;

-- ══════════════════════════════════════════════════════════
-- AURA LEARNING MATERIALS (Module AURA v3.0)
-- ══════════════════════════════════════════════════════════
CREATE TABLE learning_materials (
  id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  lesson_id       UUID         NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  material_type   VARCHAR(20)  NOT NULL CHECK (material_type IN (
                    'html','pdf','video','quiz_json','python_script','image','audio'
                  )),
  -- EMBED
  embed_url       TEXT,                           -- AURA proxy URL (not MinIO direct)
  embed_config    JSONB        DEFAULT '{}',      -- sandbox policy, restrict_download, etc.
  -- PARSE
  parsed_content  JSONB        DEFAULT '{}',      -- structured metadata
  word_count      INTEGER,
  page_count      INTEGER,
  duration_seconds INTEGER,
  -- STORE
  minio_bucket    VARCHAR(100),
  minio_key       TEXT,
  file_size_bytes BIGINT,
  mime_type       VARCHAR(100),
  checksum_sha256 CHAR(64),
  -- SYNC (Agent data)
  agent_metadata  JSONB        DEFAULT '{}',      -- {learning_objectives, key_concepts, difficulty_indicators}
  -- Versioning
  version         INTEGER      NOT NULL DEFAULT 1,
  is_current      BOOLEAN      NOT NULL DEFAULT TRUE,
  -- Status
  pipeline_status VARCHAR(20)  NOT NULL DEFAULT 'pending'
                    CHECK (pipeline_status IN ('pending','processing','ready','error')),
  pipeline_error  TEXT,
  -- Auth
  uploaded_by     UUID         REFERENCES users(id),
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_lm_lesson   ON learning_materials(lesson_id) WHERE pipeline_status = 'ready';
CREATE INDEX idx_lm_type     ON learning_materials(material_type);

-- ══════════════════════════════════════════════════════════
-- FLASHCARDS (Spaced Repetition Engine)
-- ══════════════════════════════════════════════════════════
CREATE TABLE flashcards (
  id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  lesson_id       UUID         REFERENCES lessons(id),
  front           TEXT         NOT NULL,
  back            TEXT         NOT NULL,
  difficulty      VARCHAR(10)  DEFAULT 'medium',
  tags            TEXT[]       DEFAULT '{}',
  author_id       UUID         REFERENCES users(id),
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE flashcard_reviews (
  id              BIGSERIAL    PRIMARY KEY,
  user_id         UUID         NOT NULL REFERENCES users(id),
  flashcard_id    UUID         NOT NULL REFERENCES flashcards(id),
  -- SM-2 algorithm fields
  quality         SMALLINT     NOT NULL CHECK (quality BETWEEN 0 AND 5),
  ease_factor     REAL         NOT NULL DEFAULT 2.5,
  interval_days   REAL         NOT NULL DEFAULT 1,
  repetitions     SMALLINT     NOT NULL DEFAULT 0,
  next_review_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  reviewed_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_fcr_due ON flashcard_reviews(user_id, next_review_at)
  WHERE next_review_at <= NOW() + INTERVAL '1 day';

-- ══════════════════════════════════════════════════════════
-- METACOGNITION JOURNALS
-- ══════════════════════════════════════════════════════════
CREATE TABLE metacognition_journals (
  id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID         NOT NULL REFERENCES users(id),
  lesson_id       UUID         REFERENCES lessons(id),
  -- Agent reads metadata only, NOT content (privacy)
  word_count      INTEGER      NOT NULL DEFAULT 0,
  sentiment_score REAL,                           -- -1.0 to 1.0 (Phase 2+)
  topics          TEXT[]       DEFAULT '{}',      -- extracted topics (Phase 2+)
  -- Content encrypted at application level (Phase 2+)
  entry_encrypted TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_journal_user ON metacognition_journals(user_id, created_at DESC);

-- ══════════════════════════════════════════════════════════
-- CURRICULUM RULES (Configurable rule engine)
-- ══════════════════════════════════════════════════════════
CREATE TABLE curriculum_rules (
  id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  rule_code       VARCHAR(10)  NOT NULL UNIQUE,  -- R01..R10, DEFAULT
  name            VARCHAR(100) NOT NULL,
  description     TEXT,
  trigger_condition TEXT       NOT NULL,          -- pseudocode / documentation
  action          TEXT        NOT NULL,
  priority        SMALLINT    NOT NULL,           -- 1=highest
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  framework_source VARCHAR(50) DEFAULT 'SRS',
  updated_by      UUID         REFERENCES users(id),
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ══════════════════════════════════════════════════════════
-- THRESHOLD CONCEPT PROGRESS
-- ══════════════════════════════════════════════════════════
CREATE TABLE threshold_progress (
  id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID         NOT NULL REFERENCES users(id),
  lesson_id       UUID         NOT NULL REFERENCES lessons(id),
  status          VARCHAR(20)  NOT NULL DEFAULT 'blocked'
                    CHECK (status IN ('blocked','liminal','passed')),
  attempts        INTEGER      NOT NULL DEFAULT 0,
  first_attempt   TIMESTAMPTZ,
  breakthrough_at TIMESTAMPTZ,
  teacher_notes   TEXT,
  UNIQUE(user_id, lesson_id)
);

-- ══════════════════════════════════════════════════════════
-- GAMIFICATION
-- ══════════════════════════════════════════════════════════
CREATE TABLE student_xp (
  user_id         UUID         PRIMARY KEY REFERENCES users(id),
  total_xp        INTEGER      NOT NULL DEFAULT 0,
  level           SMALLINT     NOT NULL DEFAULT 1,
  level_name      VARCHAR(50)  DEFAULT 'Người mới bắt đầu',
  badges          JSONB        NOT NULL DEFAULT '[]',
  streak_max      SMALLINT     NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE xp_transactions (
  id              BIGSERIAL    PRIMARY KEY,
  user_id         UUID         NOT NULL REFERENCES users(id),
  amount          INTEGER      NOT NULL,
  reason          VARCHAR(100) NOT NULL,
  ref_id          UUID,                           -- lesson/quiz reference
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ══════════════════════════════════════════════════════════
-- UPDATED_AT triggers
-- ══════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated         BEFORE UPDATE ON users          FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_lessons_updated       BEFORE UPDATE ON lessons         FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_learner_models_updated BEFORE UPDATE ON learner_models FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_questions_updated     BEFORE UPDATE ON questions       FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_curriculum_updated    BEFORE UPDATE ON curriculum_rules FOR EACH ROW EXECUTE FUNCTION update_updated_at();

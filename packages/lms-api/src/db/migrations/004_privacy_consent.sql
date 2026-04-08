-- Migration 004: Privacy & Consent — NĐ 13/2023/NĐ-CP Compliance
-- Source: SRS-CH01 §1.8, SRS-CH02 §2.3.4, §2.5
-- Required BEFORE Go-Live: consent_records, data_deletion_requests, privacy_audit_log

-- ══════════════════════════════════════════════════════════
-- CONSENT RECORDS — Đ11, Đ20 NĐ 13/2023
-- HS dưới 18 tuổi = trẻ em → cần consent kép (student_assent + parent_consent)
-- ══════════════════════════════════════════════════════════
CREATE TABLE consent_records (
  id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  consent_version VARCHAR(10)  NOT NULL DEFAULT 'v1.0',
  consent_type    VARCHAR(20)  NOT NULL
                    CHECK (consent_type IN ('student_assent', 'parent_consent')),
  -- Mục đích xử lý DLCN — Đ11.4: liệt kê rõ từng mục đích
  purpose         TEXT[]       NOT NULL DEFAULT '{learning_analytics,ai_agent}',
  granted         BOOLEAN      NOT NULL,
  granted_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- Đ12: Quyền rút lại sự đồng ý
  withdrawn_at    TIMESTAMPTZ,
  withdrawal_reason TEXT,
  -- Bằng chứng consent — Đ11.5: định dạng kiểm chứng được
  ip_hash         VARCHAR(64),   -- hash SHA-256 của IP, không lưu IP thật
  user_agent_hash VARCHAR(64),
  evidence_url    TEXT,           -- screenshot/PDF lưu MinIO
  -- Cơ sở pháp lý
  legal_basis     TEXT           DEFAULT 'Điều 11 NĐ 13/2023/NĐ-CP'
);

CREATE INDEX idx_consent_user_type ON consent_records(user_id, consent_type)
  WHERE withdrawn_at IS NULL;
CREATE INDEX idx_consent_granted   ON consent_records(user_id)
  WHERE granted = TRUE AND withdrawn_at IS NULL;

-- Helper view: kiểm tra nhanh consent status
CREATE VIEW v_consent_status AS
SELECT
  u.id AS user_id,
  u.full_name,
  u.role,
  -- Student assent
  EXISTS(
    SELECT 1 FROM consent_records cr
    WHERE cr.user_id = u.id
      AND cr.consent_type = 'student_assent'
      AND cr.granted = TRUE
      AND cr.withdrawn_at IS NULL
  ) AS has_student_assent,
  -- Parent consent
  EXISTS(
    SELECT 1 FROM consent_records cr
    WHERE cr.user_id = u.id
      AND cr.consent_type = 'parent_consent'
      AND cr.granted = TRUE
      AND cr.withdrawn_at IS NULL
  ) AS has_parent_consent,
  -- Fully consented (cả 2 cho HS < 18)
  CASE
    WHEN u.role != 'student' THEN TRUE
    ELSE (
      EXISTS(SELECT 1 FROM consent_records cr WHERE cr.user_id = u.id AND cr.consent_type = 'student_assent' AND cr.granted = TRUE AND cr.withdrawn_at IS NULL)
      AND
      EXISTS(SELECT 1 FROM consent_records cr WHERE cr.user_id = u.id AND cr.consent_type = 'parent_consent' AND cr.granted = TRUE AND cr.withdrawn_at IS NULL)
    )
  END AS fully_consented
FROM users u
WHERE u.deleted_at IS NULL;

-- ══════════════════════════════════════════════════════════
-- DATA DELETION REQUESTS — Đ16 NĐ 13/2023
-- Đ16.5: Xóa trong 72 giờ sau yêu cầu
-- ══════════════════════════════════════════════════════════
CREATE TABLE data_deletion_requests (
  id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID         NOT NULL REFERENCES users(id),
  requested_by    VARCHAR(20)  NOT NULL
                    CHECK (requested_by IN ('student', 'parent', 'admin', 'system')),
  reason          TEXT,
  status          VARCHAR(20)  NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'processing', 'completed', 'rejected')),
  -- Admin approval
  approved_by     UUID         REFERENCES users(id),
  approved_at     TIMESTAMPTZ,
  rejection_reason TEXT,
  -- Processing
  processing_started_at TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  -- Audit: what was deleted/anonymized
  deletion_log    JSONB        DEFAULT '{}',
  -- {tables_affected: ['users','learner_models','events',...],
  --  rows_anonymized: 1234, rows_deleted: 56,
  --  exceptions: ['audit_logs: kept per Đ16.2']}
  -- SLA tracking
  sla_deadline    TIMESTAMPTZ,  -- created_at + 72 hours
  sla_breached    BOOLEAN      DEFAULT FALSE,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_deletion_status ON data_deletion_requests(status)
  WHERE status IN ('pending', 'approved', 'processing');
CREATE INDEX idx_deletion_user   ON data_deletion_requests(user_id);

-- Auto-set SLA deadline
CREATE OR REPLACE FUNCTION set_deletion_sla()
RETURNS TRIGGER AS $$
BEGIN
  NEW.sla_deadline = NEW.created_at + INTERVAL '72 hours';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_deletion_sla
  BEFORE INSERT ON data_deletion_requests
  FOR EACH ROW EXECUTE FUNCTION set_deletion_sla();

-- ══════════════════════════════════════════════════════════
-- PRIVACY AUDIT LOG — Đ26, Đ27 NĐ 13/2023
-- Append-only: ứng dụng KHÔNG được DELETE/UPDATE
-- Ghi log mọi truy cập PII, export, consent thay đổi
-- ══════════════════════════════════════════════════════════
CREATE TABLE privacy_audit_log (
  id              BIGSERIAL    PRIMARY KEY,
  actor_id        UUID         NOT NULL,  -- user who performed action (NO FK — may be deleted)
  actor_role      VARCHAR(20)  NOT NULL,  -- role at time of action
  action          VARCHAR(50)  NOT NULL
                    CHECK (action IN (
                      'view_learner_model',
                      'view_student_profile',
                      'export_data',
                      'consent_granted',
                      'consent_withdrawn',
                      'deletion_requested',
                      'deletion_approved',
                      'deletion_completed',
                      'override_agent_decision',
                      'access_journal_metadata',
                      'pii_sent_external_api',
                      'admin_impersonation'
                    )),
  target_user_id  UUID,        -- student whose data was accessed
  resource_type   VARCHAR(50), -- 'learner_model', 'quiz_attempts', 'journals', etc.
  details         JSONB        DEFAULT '{}',
  ip_hash         VARCHAR(64), -- SHA-256 of IP
  request_id      UUID,        -- correlate with API request
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_actor   ON privacy_audit_log(actor_id, created_at DESC);
CREATE INDEX idx_audit_target  ON privacy_audit_log(target_user_id, created_at DESC);
CREATE INDEX idx_audit_action  ON privacy_audit_log(action, created_at DESC);

-- Append-only enforcement: revoke DELETE and UPDATE for application role
-- (Run after creating the app_user role)
-- REVOKE DELETE, UPDATE ON privacy_audit_log FROM app_user;

-- ══════════════════════════════════════════════════════════
-- PARENT LINK — Liên kết phụ huynh với học sinh
-- Cần cho consent kép (Đ20 NĐ 13/2023)
-- ══════════════════════════════════════════════════════════
CREATE TABLE parent_links (
  id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  parent_email    VARCHAR(255) NOT NULL,
  student_id      UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verified        BOOLEAN      NOT NULL DEFAULT FALSE,
  verification_token VARCHAR(128),
  token_expires_at TIMESTAMPTZ,
  verified_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_parent_student ON parent_links(student_id);
CREATE UNIQUE INDEX idx_parent_email_student ON parent_links(parent_email, student_id);

-- ══════════════════════════════════════════════════════════
-- ADD AURA-specific tables if not exist from 003
-- ══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS aura_lessons (
  lesson_id       VARCHAR(30)  PRIMARY KEY REFERENCES lessons(lesson_code),
  file_type       VARCHAR(20)  NOT NULL CHECK (file_type IN ('html','pdf','video','quiz_json','python')),
  original_url    TEXT         NOT NULL,
  exploit_mode    VARCHAR(20)  DEFAULT 'hybrid'
                    CHECK (exploit_mode IN ('embed','extract','store','hybrid')),
  enable_embed    BOOLEAN      DEFAULT TRUE,
  enable_parse    BOOLEAN      DEFAULT TRUE,
  enable_store    BOOLEAN      DEFAULT TRUE,
  enable_sync     BOOLEAN      DEFAULT TRUE,
  parsed_grade    SMALLINT,
  parsed_subject  VARCHAR(20),
  parsed_bloom    SMALLINT,
  has_interactive BOOLEAN      DEFAULT FALSE,
  has_quiz        BOOLEAN      DEFAULT FALSE,
  has_exit_ticket BOOLEAN      DEFAULT FALSE,
  quiz_count      SMALLINT     DEFAULT 0,
  qa_status       VARCHAR(20)  DEFAULT 'pending'
                    CHECK (qa_status IN ('pending','pass','warn','fail')),
  qa_checklist    JSONB,
  parse_error     TEXT,
  uploaded_by     UUID         NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ  DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS aura_versions (
  id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  lesson_id       VARCHAR(30)  NOT NULL REFERENCES aura_lessons(lesson_id),
  version_num     SMALLINT     NOT NULL,
  file_hash       VARCHAR(64)  NOT NULL,
  minio_path      TEXT         NOT NULL,
  change_summary  TEXT,
  created_by      UUID         NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE(lesson_id, version_num)
);

-- ══════════════════════════════════════════════════════════
-- EXAM TABLES (Ch08 §8.3)
-- ══════════════════════════════════════════════════════════
CREATE TABLE exam_blueprints (
  id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            TEXT         NOT NULL,
  lesson_ids      TEXT[],
  bloom_dist      JSONB        DEFAULT '{"1":0.10,"2":0.20,"3":0.30,"4":0.20,"5":0.10,"6":0.10}',
  difficulty_dist JSONB        DEFAULT '{"easy":0.30,"medium":0.50,"hard":0.20}',
  total_questions SMALLINT     DEFAULT 40,
  time_limit_min  SMALLINT     DEFAULT 45,
  anti_repeat_n   SMALLINT     DEFAULT 3,
  allow_shuffle   BOOLEAN      DEFAULT TRUE,
  seed            BIGINT,
  created_by      UUID         NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ  DEFAULT NOW()
);

CREATE TABLE exams (
  id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  title           TEXT         NOT NULL,
  description     TEXT,
  exam_type       VARCHAR(20)  NOT NULL
                    CHECK (exam_type IN ('quiz_15','quiz_45','midterm','final','practice','diagnostic','formative')),
  blueprint_id    UUID         REFERENCES exam_blueprints(id),
  question_ids    UUID[]       NOT NULL,
  question_order  UUID[],
  time_limit_min  INTEGER,
  available_from  TIMESTAMPTZ,
  available_to    TIMESTAMPTZ,
  allow_late_min  INTEGER      DEFAULT 0,
  target_class_codes TEXT[],
  password        VARCHAR(50),
  shuffle_questions BOOLEAN    DEFAULT FALSE,
  shuffle_options   BOOLEAN    DEFAULT TRUE,
  show_correct_after VARCHAR(20) DEFAULT 'after_graded'
                    CHECK (show_correct_after IN ('never','after_submit','after_graded')),
  allow_review    BOOLEAN      DEFAULT TRUE,
  multiple_attempts SMALLINT   DEFAULT 1,
  total_points    REAL         DEFAULT 10.0,
  passing_score   REAL         DEFAULT 5.0,
  grading_policy  VARCHAR(20)  DEFAULT 'highest'
                    CHECK (grading_policy IN ('highest','latest','average')),
  linked_lesson_ids VARCHAR(30)[],
  update_mastery  BOOLEAN      DEFAULT TRUE,
  status          VARCHAR(20)  DEFAULT 'draft'
                    CHECK (status IN ('draft','review','approved','published','active','closed','graded','archived')),
  content_hash    VARCHAR(64),
  created_by      UUID         REFERENCES users(id),
  approved_by     UUID         REFERENCES users(id),
  created_at      TIMESTAMPTZ  DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX idx_exams_status ON exams(status);
CREATE INDEX idx_exams_class  ON exams USING gin(target_class_codes);

CREATE TABLE exam_submissions (
  id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  exam_id         UUID         NOT NULL REFERENCES exams(id),
  learner_id      UUID         NOT NULL REFERENCES users(id),
  attempt_number  SMALLINT     NOT NULL DEFAULT 1,
  started_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  submitted_at    TIMESTAMPTZ,
  time_spent_sec  INTEGER,
  answers         JSONB        NOT NULL DEFAULT '{}',
  auto_score      REAL,
  manual_score    REAL,
  final_score     REAL,
  is_late         BOOLEAN      DEFAULT FALSE,
  status          VARCHAR(10)  DEFAULT 'in_progress'
                    CHECK (status IN ('in_progress','submitted','graded')),
  UNIQUE(exam_id, learner_id, attempt_number)
);

CREATE INDEX idx_exam_sub_exam    ON exam_submissions(exam_id);
CREATE INDEX idx_exam_sub_learner ON exam_submissions(learner_id);

-- ══════════════════════════════════════════════════════════
-- Add event types for AURA, Exam, Flashcard, Gamification
-- ══════════════════════════════════════════════════════════
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_event_type_check;
ALTER TABLE events ADD CONSTRAINT events_event_type_check CHECK (event_type IN (
  -- Core (v1.0)
  'quiz_submitted','assignment_submitted','video_progress',
  'session_started','session_ended','discussion_posted',
  'peer_review_given','lesson_completed','teacher_override',
  'ai_literacy_assessed','solo_assessed','page_viewed',
  'hint_requested','code_executed','flashcard_reviewed',
  -- AURA (v2.0)
  'AURA_HTML_QUIZ_ANSWER','AURA_HTML_QUIZ_COMPLETE',
  'AURA_EXIT_TICKET_SUBMITTED','AURA_VIDEO_MILESTONE',
  -- Exam/Flashcard (v2.0)
  'FLASHCARD_DECK_MASTERED','EXAM_SUBMITTED','EXAM_GRADED',
  -- Gamification (v2.0)
  'BADGE_EARNED','STREAK_MILESTONE','METACOGNITION_JOURNAL_SAVED'
));

-- ══════════════════════════════════════════════════════════
-- Extend questions table with psychometric fields (Ch08 §8.2)
-- ══════════════════════════════════════════════════════════
ALTER TABLE questions ADD COLUMN IF NOT EXISTS difficulty_p      DECIMAL(4,3);
ALTER TABLE questions ADD COLUMN IF NOT EXISTS discrimination_idx DECIMAL(4,3);
ALTER TABLE questions ADD COLUMN IF NOT EXISTS quality_score     SMALLINT;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS attempt_count     INTEGER DEFAULT 0;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS correct_count     INTEGER DEFAULT 0;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS is_ai_generated   BOOLEAN DEFAULT FALSE;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS ai_model          VARCHAR(50);
ALTER TABLE questions ADD COLUMN IF NOT EXISTS review_status     VARCHAR(20) DEFAULT 'draft';
ALTER TABLE questions ADD COLUMN IF NOT EXISTS reviewed_by       UUID REFERENCES users(id);
ALTER TABLE questions ADD COLUMN IF NOT EXISTS error_type        VARCHAR(50);
ALTER TABLE questions ADD COLUMN IF NOT EXISTS topic_tags        TEXT[];
ALTER TABLE questions ADD COLUMN IF NOT EXISTS solution_steps    TEXT;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS hint_text         TEXT;

CREATE INDEX IF NOT EXISTS idx_q_tags ON questions USING gin(topic_tags);
CREATE INDEX IF NOT EXISTS idx_q_review ON questions(review_status) WHERE deleted_at IS NULL;

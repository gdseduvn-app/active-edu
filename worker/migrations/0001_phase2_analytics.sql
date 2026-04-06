-- ============================================================
-- AURA Phase 2 — Cloudflare D1 Schema
-- Database: aura-analytics
-- Run: npx wrangler d1 execute aura-analytics --file=migrations/0001_phase2_analytics.sql
-- ============================================================

-- ── Student Mastery (hot-path, edge-written after every submission) ──────────
CREATE TABLE IF NOT EXISTS student_mastery (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id      INTEGER NOT NULL,
  outcome_id      INTEGER,
  outcome_code    TEXT    NOT NULL,
  subject         TEXT    NOT NULL DEFAULT '',
  grade           TEXT    NOT NULL DEFAULT '',
  score           REAL    NOT NULL DEFAULT 0.0  CHECK(score BETWEEN 0 AND 1),
  attempts        INTEGER NOT NULL DEFAULT 0,
  bkt_state       REAL    NOT NULL DEFAULT 0.3  CHECK(bkt_state BETWEEN 0 AND 1),
  irt_theta       REAL,                           -- IRT ability estimate (logits)
  last_response   INTEGER,                        -- 0=incorrect, 1=correct (latest)
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(student_id, outcome_code)
);

CREATE INDEX IF NOT EXISTS idx_mastery_student    ON student_mastery(student_id);
CREATE INDEX IF NOT EXISTS idx_mastery_outcome    ON student_mastery(outcome_code);
CREATE INDEX IF NOT EXISTS idx_mastery_subject    ON student_mastery(subject, grade);
CREATE INDEX IF NOT EXISTS idx_mastery_score      ON student_mastery(score);

-- ── Action Logs / xAPI-lite Events ──────────────────────────────────────────
-- xAPI verb: started | completed | attempted | passed | failed | experienced | commented
CREATE TABLE IF NOT EXISTS action_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id  INTEGER NOT NULL,
  course_id   INTEGER,
  item_id     INTEGER,
  verb        TEXT    NOT NULL,       -- xAPI verb (see above)
  object_type TEXT    NOT NULL DEFAULT 'item',  -- item | course | outcome | session
  object_id   TEXT,
  result_score  REAL,                 -- 0-1 normalized score
  result_success INTEGER,             -- 0 or 1
  duration_s  INTEGER,               -- time on task in seconds
  extensions  TEXT,                  -- JSON blob for extra xAPI extensions
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_logs_student    ON action_logs(student_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_course     ON action_logs(course_id);
CREATE INDEX IF NOT EXISTS idx_logs_verb       ON action_logs(verb);
CREATE INDEX IF NOT EXISTS idx_logs_created    ON action_logs(created_at DESC);

-- ── AI Session History (migrated from localStorage in Phase 2) ──────────────
CREATE TABLE IF NOT EXISTS ai_sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  agent_type  TEXT    NOT NULL,   -- coaching | research | assessment | content
  session_key TEXT    NOT NULL,   -- client-side generated UUID
  messages    TEXT    NOT NULL,   -- JSON array [{role, content, timestamp}]
  token_count INTEGER DEFAULT 0,
  course_id   INTEGER,
  item_id     INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, session_key)
);

CREATE INDEX IF NOT EXISTS idx_sessions_user   ON ai_sessions(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_agent  ON ai_sessions(agent_type);

-- ── Interventions (from meta_create_intervention tool) ──────────────────────
CREATE TABLE IF NOT EXISTS interventions (
  id                TEXT    PRIMARY KEY,  -- INT-timestamp-randomhex
  target_type       TEXT    NOT NULL,     -- student | class
  target_id         TEXT    NOT NULL,
  intervention_type TEXT    NOT NULL,     -- remediation | enrichment | re_engagement | teacher_alert | peer_support
  priority          TEXT    NOT NULL DEFAULT 'medium',
  message_vi        TEXT    NOT NULL,
  suggested_items   TEXT,                -- JSON array of item IDs
  created_by_agent  TEXT,               -- which agent created this
  resolved          INTEGER NOT NULL DEFAULT 0,
  resolved_at       TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_interventions_target   ON interventions(target_id, target_type);
CREATE INDEX IF NOT EXISTS idx_interventions_priority ON interventions(priority, resolved);
CREATE INDEX IF NOT EXISTS idx_interventions_created  ON interventions(created_at DESC);

-- ── Spaced Repetition Schedule (SM-2 output storage) ────────────────────────
CREATE TABLE IF NOT EXISTS spaced_repetition (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id      INTEGER NOT NULL,
  item_id         INTEGER NOT NULL,
  repetitions     INTEGER NOT NULL DEFAULT 0,
  ease_factor     REAL    NOT NULL DEFAULT 2.5,
  interval_days   INTEGER NOT NULL DEFAULT 1,
  next_review     TEXT    NOT NULL,
  last_quality    INTEGER,            -- 0-5 quality score
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(student_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_sr_student     ON spaced_repetition(student_id, next_review);
CREATE INDEX IF NOT EXISTS idx_sr_due         ON spaced_repetition(next_review);

-- ── Research Agent Traces (for researchers to inspect agent reasoning) ───────
CREATE TABLE IF NOT EXISTS agent_traces (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  mode        TEXT    NOT NULL,
  task        TEXT    NOT NULL,
  iterations  INTEGER NOT NULL DEFAULT 0,
  tools_used  TEXT,                   -- JSON array
  trace       TEXT    NOT NULL,       -- Full JSON trace from return_trace=true
  result      TEXT,                   -- Final agent result (JSON or text)
  input_tokens  INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_traces_user    ON agent_traces(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_traces_mode    ON agent_traces(mode);

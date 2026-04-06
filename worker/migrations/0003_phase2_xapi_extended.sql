-- ============================================================
-- Phase 2 Extended: xAPI Events + Course Fields Cache
-- ============================================================

-- Extended xAPI verb tracking
CREATE TABLE IF NOT EXISTS xapi_statements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id    INTEGER NOT NULL,          -- student_id
  actor_email TEXT,
  verb        TEXT    NOT NULL,          -- xAPI verb IRI
  verb_display TEXT   NOT NULL,          -- Human readable: "completed", "attempted"...
  object_id   TEXT    NOT NULL,          -- IRI of the activity
  object_type TEXT    NOT NULL DEFAULT 'Activity',
  object_name TEXT,
  result_score_raw     REAL,
  result_score_min     REAL DEFAULT 0,
  result_score_max     REAL DEFAULT 100,
  result_success       INTEGER,          -- 0 or 1
  result_completion    INTEGER,          -- 0 or 1
  result_duration_s    INTEGER,
  context_course_id    INTEGER,
  context_module_id    INTEGER,
  context_platform     TEXT DEFAULT 'ActiveEdu',
  context_language     TEXT DEFAULT 'vi-VN',
  timestamp   TEXT NOT NULL DEFAULT (datetime('now')),
  stored      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_xapi_actor   ON xapi_statements(actor_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_xapi_verb    ON xapi_statements(verb);
CREATE INDEX IF NOT EXISTS idx_xapi_object  ON xapi_statements(object_id);
CREATE INDEX IF NOT EXISTS idx_xapi_course  ON xapi_statements(context_course_id, timestamp DESC);

-- Notification queue (edge-processed)
CREATE TABLE IF NOT EXISTS notification_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  type        TEXT    NOT NULL,   -- intervention | reminder | achievement | grade_posted
  title       TEXT    NOT NULL,
  body        TEXT    NOT NULL,
  data        TEXT,               -- JSON extra data
  read        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notification_queue(user_id, read, created_at DESC);

-- Achievement / Badge system
CREATE TABLE IF NOT EXISTS achievements (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id    INTEGER NOT NULL,
  badge_code    TEXT    NOT NULL,   -- streak_7, perfect_score, mastery_TOAN, etc.
  badge_name    TEXT    NOT NULL,
  badge_icon    TEXT,               -- emoji or icon name
  earned_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(student_id, badge_code)
);
CREATE INDEX IF NOT EXISTS idx_achievements_student ON achievements(student_id, earned_at DESC);

-- Weekly study streaks
CREATE TABLE IF NOT EXISTS study_streaks (
  student_id    INTEGER PRIMARY KEY,
  current_days  INTEGER NOT NULL DEFAULT 0,
  longest_days  INTEGER NOT NULL DEFAULT 0,
  last_study    TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

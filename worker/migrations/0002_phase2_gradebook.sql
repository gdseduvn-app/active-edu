-- Assignment Groups
CREATE TABLE IF NOT EXISTS assignment_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 0 CHECK(weight BETWEEN 0 AND 100),
  dropping_lowest INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ag_course ON assignment_groups(course_id);

-- Cache table for weighted grades (updated after each submission)
CREATE TABLE IF NOT EXISTS weighted_grades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  course_id INTEGER NOT NULL,
  weighted_total REAL NOT NULL DEFAULT 0,
  letter_grade TEXT NOT NULL DEFAULT 'F',
  computed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(student_id, course_id)
);
CREATE INDEX IF NOT EXISTS idx_wg_course ON weighted_grades(course_id);
CREATE INDEX IF NOT EXISTS idx_wg_student ON weighted_grades(student_id);

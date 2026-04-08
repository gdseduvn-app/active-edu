-- Seed Data — AdaptLearn v2.0
-- 10 users (2 admin, 3 teacher, 5 student)
-- 20 lessons Toán 8
-- Curriculum rules R01-R10 (from 002_curriculum_rules_seed.sql)
-- Sample learner models

-- ══════════════════════════════════════════════════════════
-- USERS — bcrypt hash for 'password123' (cost=12)
-- ══════════════════════════════════════════════════════════
INSERT INTO users (username, email, password_hash, full_name, role, class_id, grade) VALUES
  ('admin1',    'admin@thuthiem.edu.vn',     '$2b$12$LJ3pHTjXlqAzJLjJgYPz5eO5lOxRVCuS7RnXGK8S3YR0hQzHwF5Ky', 'Nguyễn Văn Admin',   'admin',   NULL,   NULL),
  ('admin2',    'admin2@thuthiem.edu.vn',    '$2b$12$LJ3pHTjXlqAzJLjJgYPz5eO5lOxRVCuS7RnXGK8S3YR0hQzHwF5Ky', 'Trần Thị Admin',     'admin',   NULL,   NULL),
  ('gv_toan',   'toan@thuthiem.edu.vn',      '$2b$12$LJ3pHTjXlqAzJLjJgYPz5eO5lOxRVCuS7RnXGK8S3YR0hQzHwF5Ky', 'Lê Văn Toán',        'teacher', NULL,   NULL),
  ('gv_ly',     'ly@thuthiem.edu.vn',        '$2b$12$LJ3pHTjXlqAzJLjJgYPz5eO5lOxRVCuS7RnXGK8S3YR0hQzHwF5Ky', 'Phạm Thị Lý',        'teacher', NULL,   NULL),
  ('gv_tin',    'tin@thuthiem.edu.vn',        '$2b$12$LJ3pHTjXlqAzJLjJgYPz5eO5lOxRVCuS7RnXGK8S3YR0hQzHwF5Ky', 'Hoàng Văn Tin',      'teacher', NULL,   NULL),
  ('hs_minh',   'minh@student.thuthiem.edu.vn','$2b$12$LJ3pHTjXlqAzJLjJgYPz5eO5lOxRVCuS7RnXGK8S3YR0hQzHwF5Ky','Nguyễn Minh',        'student', '8A1',  8),
  ('hs_lan',    'lan@student.thuthiem.edu.vn', '$2b$12$LJ3pHTjXlqAzJLjJgYPz5eO5lOxRVCuS7RnXGK8S3YR0hQzHwF5Ky','Trần Thị Lan',       'student', '8A1',  8),
  ('hs_duc',    'duc@student.thuthiem.edu.vn', '$2b$12$LJ3pHTjXlqAzJLjJgYPz5eO5lOxRVCuS7RnXGK8S3YR0hQzHwF5Ky','Lê Đức',             'student', '8A2',  8),
  ('hs_hoa',    'hoa@student.thuthiem.edu.vn', '$2b$12$LJ3pHTjXlqAzJLjJgYPz5eO5lOxRVCuS7RnXGK8S3YR0hQzHwF5Ky','Phạm Hoa',           'student', '8A2',  8),
  ('hs_nam',    'nam@student.thuthiem.edu.vn', '$2b$12$LJ3pHTjXlqAzJLjJgYPz5eO5lOxRVCuS7RnXGK8S3YR0hQzHwF5Ky','Hoàng Nam',          'student', '9A1',  9)
ON CONFLICT (username) DO NOTHING;

-- ══════════════════════════════════════════════════════════
-- LESSONS — 20 bài Toán 8 theo QĐ 791
-- ══════════════════════════════════════════════════════════
INSERT INTO lessons (lesson_code, title, subject, grade, bloom_level, lesson_model, difficulty_level, estimated_minutes, status, author_id) VALUES
  ('020108.0101a1', 'Nhân đơn thức với đa thức',              'toan', 8, 1, 'scaffold',  'nen_tang',    20, 'published', (SELECT id FROM users WHERE username='gv_toan')),
  ('020108.0101b2', 'Chia đơn thức cho đơn thức',             'toan', 8, 2, 'explain',   'nen_tang',    25, 'published', (SELECT id FROM users WHERE username='gv_toan')),
  ('020108.0101c3', 'Hằng đẳng thức đáng nhớ (1)',            'toan', 8, 3, 'practice',  'mo_rong',     30, 'published', (SELECT id FROM users WHERE username='gv_toan')),
  ('020108.0101d4', 'Hằng đẳng thức đáng nhớ (2)',            'toan', 8, 4, 'challenge', 'mo_rong',     35, 'published', (SELECT id FROM users WHERE username='gv_toan')),
  ('020108.0102a1', 'Phân tích đa thức thành nhân tử',        'toan', 8, 1, 'scaffold',  'nen_tang',    25, 'published', (SELECT id FROM users WHERE username='gv_toan')),
  ('020108.0102b2', 'Đặt nhân tử chung',                      'toan', 8, 2, 'practice',  'nen_tang',    25, 'published', (SELECT id FROM users WHERE username='gv_toan')),
  ('020108.0102c3', 'Dùng hằng đẳng thức để phân tích',       'toan', 8, 3, 'practice',  'mo_rong',     30, 'published', (SELECT id FROM users WHERE username='gv_toan')),
  ('020108.0201a1', 'Phân thức đại số',                        'toan', 8, 1, 'scaffold',  'nen_tang',    20, 'published', (SELECT id FROM users WHERE username='gv_toan')),
  ('020108.0201b2', 'Tính chất cơ bản của phân thức',          'toan', 8, 2, 'explain',   'nen_tang',    25, 'published', (SELECT id FROM users WHERE username='gv_toan')),
  ('020108.0201c3', 'Rút gọn phân thức',                       'toan', 8, 3, 'practice',  'mo_rong',     30, 'published', (SELECT id FROM users WHERE username='gv_toan')),
  ('020108.0202a1', 'Cộng phân thức cùng mẫu',                 'toan', 8, 1, 'scaffold',  'nen_tang',    20, 'published', (SELECT id FROM users WHERE username='gv_toan')),
  ('020108.0202b2', 'Cộng phân thức khác mẫu',                 'toan', 8, 2, 'practice',  'nen_tang',    25, 'published', (SELECT id FROM users WHERE username='gv_toan')),
  ('020108.0202c3', 'Trừ phân thức đại số',                    'toan', 8, 3, 'practice',  'mo_rong',     30, 'published', (SELECT id FROM users WHERE username='gv_toan')),
  ('020808.0101a1', 'Phương trình bậc nhất một ẩn',            'toan', 8, 1, 'scaffold',  'nen_tang',    20, 'published', (SELECT id FROM users WHERE username='gv_toan')),
  ('020808.0101b2', 'Giải phương trình bậc nhất',              'toan', 8, 2, 'explain',   'nen_tang',    25, 'published', (SELECT id FROM users WHERE username='gv_toan')),
  ('020808.0101c3', 'Phương trình đưa về dạng bậc nhất',       'toan', 8, 3, 'practice',  'mo_rong',     30, 'published', (SELECT id FROM users WHERE username='gv_toan')),
  ('020808.0201a1', 'Hệ phương trình bậc nhất hai ẩn',         'toan', 8, 1, 'scaffold',  'nen_tang',    25, 'published', (SELECT id FROM users WHERE username='gv_toan')),
  ('020808.0201b3', 'Giải hệ pt bằng phương pháp thế',         'toan', 8, 3, 'practice',  'mo_rong',     30, 'published', (SELECT id FROM users WHERE username='gv_toan')),
  ('020808.0201c4', 'Giải hệ pt bằng phương pháp cộng',        'toan', 8, 4, 'challenge', 'mo_rong',     35, 'published', (SELECT id FROM users WHERE username='gv_toan')),
  ('020808.0201d5', 'Bài toán thực tế về hệ pt',               'toan', 8, 5, 'create',    'chuyen_sau',  40, 'published', (SELECT id FROM users WHERE username='gv_toan'))
ON CONFLICT (lesson_code) DO NOTHING;

-- ══════════════════════════════════════════════════════════
-- LEARNER MODELS — for 5 students
-- ══════════════════════════════════════════════════════════
INSERT INTO learner_models (user_id, mastery_map, bloom_profile, current_level, engagement_score, streak_days)
SELECT id,
  '{"020108.0101a1":0.85,"020108.0101b2":0.72,"020108.0101c3":0.45}'::jsonb,
  '{"1":0.9,"2":0.8,"3":0.6,"4":0.3,"5":0.1,"6":0.0}'::jsonb,
  'mo_rong', 0.7, 5
FROM users WHERE username = 'hs_minh'
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO learner_models (user_id, mastery_map, bloom_profile, current_level, engagement_score, streak_days)
SELECT id,
  '{"020108.0101a1":0.95,"020108.0101b2":0.88,"020108.0101c3":0.75,"020108.0101d4":0.55}'::jsonb,
  '{"1":0.95,"2":0.9,"3":0.75,"4":0.5,"5":0.2,"6":0.0}'::jsonb,
  'mo_rong', 0.85, 12
FROM users WHERE username = 'hs_lan'
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO learner_models (user_id, mastery_map, bloom_profile, current_level, engagement_score, streak_days)
SELECT id,
  '{"020108.0101a1":0.55,"020108.0101b2":0.35}'::jsonb,
  '{"1":0.6,"2":0.4,"3":0.2,"4":0.0,"5":0.0,"6":0.0}'::jsonb,
  'nen_tang', 0.4, 1
FROM users WHERE username = 'hs_duc'
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO learner_models (user_id, mastery_map, bloom_profile, current_level, engagement_score, streak_days)
SELECT id, '{}'::jsonb,
  '{"1":0,"2":0,"3":0,"4":0,"5":0,"6":0}'::jsonb,
  'nen_tang', 0.5, 0
FROM users WHERE username = 'hs_hoa'
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO learner_models (user_id, mastery_map, bloom_profile, current_level, engagement_score, streak_days)
SELECT id,
  '{"020108.0101a1":0.7,"020108.0101b2":0.6}'::jsonb,
  '{"1":0.8,"2":0.65,"3":0.4,"4":0.15,"5":0.0,"6":0.0}'::jsonb,
  'nen_tang', 0.6, 3
FROM users WHERE username = 'hs_nam'
ON CONFLICT (user_id) DO NOTHING;

-- ══════════════════════════════════════════════════════════
-- GAMIFICATION — XP for students
-- ══════════════════════════════════════════════════════════
INSERT INTO student_xp (user_id, total_xp, level, level_name, badges, streak_max)
SELECT id, 340, 3, 'Người khám phá', '["streak_7"]'::jsonb, 12
FROM users WHERE username = 'hs_lan'
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO student_xp (user_id, total_xp, level, level_name, badges, streak_max)
SELECT id, 150, 2, 'Học viên', '[]'::jsonb, 5
FROM users WHERE username = 'hs_minh'
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO student_xp (user_id, total_xp, level, level_name, badges, streak_max)
SELECT id, 30, 1, 'Người mới bắt đầu', '[]'::jsonb, 1
FROM users WHERE username = 'hs_duc'
ON CONFLICT (user_id) DO NOTHING;

-- ══════════════════════════════════════════════════════════
-- SAMPLE QUESTIONS — 5 câu cho bài 020108.0101a1
-- ══════════════════════════════════════════════════════════
INSERT INTO questions (lesson_id, question_type, bloom_level, difficulty, stem, options, correct_answer, explanation, points, auto_grade, status, author_id)
SELECT l.id, 'mcq', 1, 'easy',
  'Kết quả của phép nhân 3x · (2x + 1) là:',
  '[{"id":"a","text":"6x² + 3x","is_correct":true},{"id":"b","text":"6x + 3","is_correct":false},{"id":"c","text":"5x² + 3x","is_correct":false},{"id":"d","text":"6x² + 1","is_correct":false}]'::jsonb,
  'a', '3x · 2x = 6x², 3x · 1 = 3x. Kết quả: 6x² + 3x', 1, true, 'published',
  (SELECT id FROM users WHERE username='gv_toan')
FROM lessons l WHERE l.lesson_code = '020108.0101a1'
ON CONFLICT DO NOTHING;

INSERT INTO questions (lesson_id, question_type, bloom_level, difficulty, stem, options, correct_answer, explanation, points, auto_grade, status, author_id)
SELECT l.id, 'fill_blank', 2, 'medium',
  'Nhân đơn thức 2x² với đa thức (x - 3): 2x² · (x - 3) = ___',
  '[]'::jsonb,
  '2x³ - 6x²', 'Nhân từng hạng tử: 2x²·x = 2x³, 2x²·(-3) = -6x²', 1, true, 'published',
  (SELECT id FROM users WHERE username='gv_toan')
FROM lessons l WHERE l.lesson_code = '020108.0101a1'
ON CONFLICT DO NOTHING;

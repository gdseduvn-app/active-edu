-- Migration 002: Seed Curriculum Rules R01–R10 + DEFAULT
-- Source: SRS-CH04 v1.0 §4.3 Curriculum Planner

INSERT INTO curriculum_rules (rule_code, name, description, trigger_condition, action, priority, framework_source) VALUES

('R01', 'Repair Trigger',
 'Kích hoạt sửa chữa khi điểm thấp liên tiếp, SOLO thấp hoặc threshold concept chưa vượt',
 'consecutive_fail >= 3 OR (solo_level <= 2 AND attempts >= 2) OR (threshold_concept = TRUE AND mastery < 0.6)',
 'Chèn bài Repair NGAY TRƯỚC bài tiếp theo. lesson_model = repair. Không thể tắt.', 1, 'SRS-CH04'),

('R02', 'Downgrade Level',
 'Giảm độ khó khi HS không theo kịp cấp độ hiện tại',
 'consecutive_fail >= 2 AND current_level != nen_tang',
 'current_level -= 1 step (chuyen_sau→mo_rong→nen_tang). Ghi lý do.', 2, 'SRS-CH04'),

('R03', 'Upgrade Level',
 'Tăng độ khó khi HS vượt kỳ vọng liên tiếp',
 'consecutive_pass >= 3 AND mastery_score >= 0.85 AND current_level != chuyen_sau',
 'current_level += 1 step. Thông báo GV.', 3, 'SRS-CH04'),

('R04', 'Dormant Learner',
 'Ôn tập khi HS không học trong 48h+ (spaced repetition)',
 'NOW() - last_session_at > INTERVAL 48 hours',
 'Ưu tiên bài ôn tập có mastery_score thấp nhất trong 7 ngày trở lại.', 4, 'SRS-CH04'),

('R05', 'Bloom Gap',
 'Lấp khoảng trống Bloom: giỏi nhớ/hiểu nhưng kém vận dụng',
 'bloom_profile[1..2] > 0.8 AND bloom_profile[3..4] < 0.5 AND lesson_count >= 5',
 'Chuyển sang bài case/project nhắm Bloom 3–4.', 5, 'SRS-CH04'),

('R06', 'Engagement Drop',
 'Tăng engagement khi học sinh mất hứng thú',
 'engagement_score < 0.35 AND session_count_today >= 1',
 'Chuyển sang preferred_model. Xen kẽ gamification event.', 6, 'SRS-CH04'),

('R07', 'Peer Expert',
 'Chuyển HS giỏi thành người dạy bạn',
 'consecutive_pass >= 5 AND mastery_score >= 0.9 AND NOT has_tag(peer_expert)',
 'Gán tag peer_expert. Gợi ý bài Teach-back. Thông báo GV.', 7, 'SRS-CH04'),

('R08', 'Speed Mismatch',
 'Điều chỉnh khi HS làm quá nhanh (không đọc) hoặc quá chậm (bí)',
 'avg_time < speed_profile * 0.3 OR avg_time > speed_profile * 3.0',
 'Nếu quá nhanh: thêm câu hỏi reflection. Nếu quá chậm: giảm số câu, tăng hint.', 8, 'SRS-CH04'),

('R09', 'Variety Rotation',
 'Tránh lặp cùng lesson_model quá 3 lần',
 'last_3_lesson_models all same',
 'Rotate sang model khác phù hợp bloom/solo hiện tại.', 9, 'SRS-CH04'),

('R10', 'At-Risk Alert',
 'Cảnh báo GV khi HS có nguy cơ cao',
 'consecutive_fail >= 5 OR (mastery_score < 0.3 AND attempts >= 5) OR engagement_score < 0.2',
 'Gán tag at_risk. Tạo notification cho GV. Không auto-change lộ trình — chờ GV can thiệp.', 10, 'SRS-CH04'),

('DEFAULT', 'Continue Path',
 'Tiến theo lộ trình bình thường khi không có luật nào trigger',
 'Không có luật nào từ R01–R10 trigger',
 'Chọn lesson theo next_if_pass hoặc next bài trong unit. current_level giữ nguyên.', 99, 'SRS-CH04');

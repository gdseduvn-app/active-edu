# CHƯƠNG 8: BÀI TẬP, NGÂN HÀNG ĐỀ & ĐÁNH GIÁ — Consolidated v2.0

> **Mã tài liệu:** SRS-CH08 v2.0 · Tháng 4/2025
> **6 Modules:** Quiz · Flashcard · QBank · Exam · Gamification · SRL & Metacognition
> **Consolidated từ:** Ch8 v2.0 Final + Ch8 v1.0 (850 dòng) + Ch8A-B Quiz/SRL + UI_Ch8 + TEST_Ch8

---

## 8.1 Module 1 — Quiz & Bài tập (9 loại câu hỏi)

| Loại câu hỏi | Ký hiệu DB | Cách render | Chấm điểm | Bloom |
|-------------|-----------|------------|-----------|-------|
| Trắc nghiệm 1 đáp án | single_choice | 4 option radio. Shuffle | Binary 1/0 | B1-B3 |
| Trắc nghiệm nhiều đáp án | multi_choice | Checkbox. "Chọn tất cả đúng" | Partial: correct/total − wrong | B2-B4 |
| Điền vào chỗ trống | fill_blank | Input text inline. Normalize | Exact match hoặc regex | B2-B3 |
| Ghép đôi | matching | Kéo thả 2 cột. Mobile: dropdown | score = correct_pairs/total | B2-B3 |
| Sắp xếp thứ tự | ordering | Kéo thả sắp xếp | Partial: consecutive correct | B3-B4 |
| Đúng/Sai | true_false | 2 radio: Đúng/Sai | Binary 1/0 | B1-B2 |
| Tự luận ngắn | short_answer | Textarea. Min 20 chars | GV chấm hoặc LLM [P2] | B4-B6 |
| Vẽ đồ thị/Sơ đồ | canvas_draw | Canvas JS. Export PNG | GV chấm thủ công | B4-B6 |
| Code Python | code_python | Monaco Editor. Submit → Grader | Test cases pass/fail, partial | B3-B6 |

### Flashcard thích nghi — SM-2 Algorithm

```python
def update_sm2(card, rating: int):
    '''rating: 1=fail, 2=hard, 3=good, 4=easy, 5=perfect'''
    if rating >= 3:
        if card.repetitions == 0: card.interval = 1
        elif card.repetitions == 1: card.interval = 6
        else: card.interval = round(card.interval * card.ef)
        card.ef += 0.1 - (5 - rating) * (0.08 + (5 - rating) * 0.02)
        card.ef = max(1.3, min(2.5, card.ef))
        card.repetitions += 1
    else:
        card.interval = 1
        card.repetitions = 0
    card.next_review_at = today + timedelta(days=card.interval)
    return card

# EF khởi tạo từ mastery_score:
# mastery > 0.85 → EF_init = 2.5 (dễ)
# mastery 0.6-0.85 → EF_init = 2.0
# mastery < 0.6 → EF_init = 1.5 (khó)
```

### Active Learning items (ngoài quiz)

| Dạng | Mô tả | Events | Bloom |
|------|-------|--------|-------|
| Concept Map | Kéo-thả nodes, vẽ mũi tên quan hệ | assignment_submitted | B4-B6 |
| Annotation | Highlight + ghi chú inline | discussion_posted | B2-B4 |
| Simulation | Canvas tham số, quan sát kết quả | video_progress (simulation) | B3-B5 |
| Gallery Walk | Đăng sản phẩm, bạn comment + rate | peer_review_given | B5-B6 |
| Think-Pair-Share | 3 phase timer. Think → Pair → Share | session:heartbeat | B2-B5 |
| Quick Poll | GV tạo realtime. Bar chart live | poll_responded | B1-B2 |

### Import OCR Pipeline

```
POST /import/questions (multipart: PDF ≤10MB hoặc image ≤5MB)
→ OCR: PyMuPDF text + Mathpix LaTeX
→ AI parse: pattern detect câu hỏi, đáp án, Bloom
→ GV review trong Import UI
→ Batch import → questions table
```

| Nguồn | Công nghệ | Độ chính xác |
|-------|----------|-------------|
| PDF có text | PyMuPDF text extraction | 95%+ text, 85%+ công thức |
| PDF scan | Tesseract + Mathpix | 80%+ tiếng Việt, 75%+ công thức |
| Ảnh chụp | Tesseract + Mathpix + auto-rotate | 75%+ (ảnh rõ) |
| Word .docx | python-docx parse | 90%+ |
| Excel .xlsx | openpyxl (mỗi row = 1 câu) | Phụ thuộc format |

---

## 8.2 Module 2 — Ngân hàng Đề (QBank)

### Questions DDL v2.0

```sql
CREATE TABLE questions (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content           JSONB NOT NULL,  -- {stem, options[], answer, explanation}
    question_type     VARCHAR(30) DEFAULT 'single_choice',
    bloom_level       SMALLINT,
    lesson_id         VARCHAR(20) REFERENCES lessons(id),
    difficulty_p      DECIMAL(4,3),    -- p-value thực nghiệm
    discrimination_idx DECIMAL(4,3),   -- D-index
    quality_score     SMALLINT,        -- 1-5
    attempt_count     INT DEFAULT 0,
    correct_count     INT DEFAULT 0,
    is_ai_generated   BOOLEAN DEFAULT FALSE,
    ai_model          VARCHAR(50),
    review_status     VARCHAR(20) DEFAULT 'draft',
    reviewed_by       UUID REFERENCES users(id),
    error_type        VARCHAR(50),     -- link error_patterns Ch4
    topic_tags        TEXT[],
    solution_steps    TEXT,
    hint_text         TEXT,
    created_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_q_bloom   ON questions(bloom_level);
CREATE INDEX idx_q_lesson  ON questions(lesson_id);
CREATE INDEX idx_q_status  ON questions(review_status);
CREATE INDEX idx_q_tags    ON questions USING gin(topic_tags);
```

### Item Analysis — 5 chỉ số

| Chỉ số | Công thức | Ngưỡng tốt | Hành động khi kém |
|--------|----------|-----------|------------------|
| p-value (độ khó) | p = correct_count / attempt_count | 0.3 ≤ p ≤ 0.7 | p < 0.2: quá khó. p > 0.85: quá dễ |
| D-index (phân biệt) | D = p_high27 − p_low27 | D > 0.3 | D < 0: loại ngay (phản loại) |
| Point-Biserial (r_pb) | Tương quan điểm câu vs điểm bài | r_pb > 0.2 | r_pb < 0: loại (N ≥ 30) |
| Cronbach Alpha (α) | α = n/(n-1) × (1 − Σσ²_i/σ²_total) | α ≥ 0.7 | α < 0.6: đề thiếu nhất quán |
| Distractors | % HS chọn từng đáp án sai | Mỗi distractor ≥ 5% | < 1%: sửa realistic hơn |

---

## 8.3 Module 3 — Đề Kiểm tra (Exam Engine)

### Vòng đời 8 trạng thái

```
draft → review → approved → published → active → closed → graded → archived
  │                                                              │
  └──────────────────── (rejected) ──────────────────────────────┘
```

| Trạng thái | Hệ thống làm gì | Ai được xem |
|-----------|-----------------|------------|
| draft | Lưu blueprint + câu hỏi. Chạy checklist nhẹ | Chỉ GV tạo đề |
| review | Gửi notification Tổ trưởng. Lock GV sửa | GV + Tổ trưởng |
| approved | Hash SHA-256. Không sửa nội dung nữa | GV + Tổ trưởng |
| published | HS thấy nhưng chưa làm được | GV + HS lớp được phân |
| active | Timer đếm ngược. Lock vào muộn > 30% | HS đang làm |
| closed | Auto-submit. Chấm tự động những câu có thể | GV xem kết quả |
| graded | Publish kết quả. Agent cập nhật LM | GV + HS + PH [P2] |
| archived | Ẩn dashboard. Lưu phân tích | Admin, Tổ trưởng |

### Exam Blueprint — Sinh đề tự động

```sql
CREATE TABLE exam_blueprints (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    lesson_ids      TEXT[],
    bloom_dist      JSONB,  -- {1:0.10, 2:0.20, 3:0.30, 4:0.20, 5:0.10, 6:0.10}
    difficulty_dist JSONB,  -- {easy:0.30, medium:0.50, hard:0.20}
    total_questions SMALLINT DEFAULT 40,
    time_limit_min  SMALLINT DEFAULT 45,
    anti_repeat_n   SMALLINT DEFAULT 3,
    allow_shuffle   BOOLEAN DEFAULT TRUE,
    seed            BIGINT,
    created_by      UUID NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 8.4 Module 4 — ��ánh giá 5 chiều

| Chiều đánh giá | Dữ liệu nguồn | Hiển thị UI |
|---------------|---------------|------------|
| **Mastery** | quiz_attempts, lesson_completed | Heatmap YCCĐ. Xanh→đỏ. Tooltip: trend |
| **Bloom Profile** | bloom_level từng bài | Radar chart 6 cạnh + benchmark lớp |
| **Error Patterns** | grader error_types, quiz wrong answers | Danh sách lỗi + click xem bài sai |
| **Learning Velocity** | lessons_per_week vs target | Sparkline. Green/amber |
| **Self-Regulation** | reflection word_count, exit ticket | Score 1-5 stars. Participation only |

---

## 8.5 Module 5 — Gamification (Intrinsic Motivation)

> **Triết lý:** XP reward **hành vi học tập đúng**, KHÔNG reward điểm số cao. Leaderboard **mặc định ẩn**.

| Hành vi | XP | Bloom multiplier | Lý do sư phạm |
|---------|-----|-----------------|---------------|
| Hoàn thành GĐ3 quiz | 10 base | × bloom_level/3 | Reward nỗ lực, không kết quả |
| Đạt mastery > 0.85 | 50 | × 1.0 | Nhận biết tiến bộ dài hạn |
| Bloom 5-6 activity | 20 base | **× 2.0 (Bloom 6)** | Khuyến khích tư duy bậc cao |
| Streak mỗi ngày | 5 | × 1.0 | Học đều đặn |
| Flashcard review | 3/card | × 1.0 | Ôn tập đều |
| Exit ticket nộp | 5 | × 1.0 | Metacognition habit |
| **KHÔNG: điểm 10/10** | **0 XP** | — | **Tránh reward outcome** |

### Badges — 8 huy hiệu cốt lõi

| Badge | Điều kiện | Thông điệp | Loại động lực |
|-------|----------|-----------|--------------|
| 🔥 Streak 7 ngày | 7 ngày liên tiếp ≥ 1 bài | "Thói quen tốt đang hình thành" | Consistency |
| 🧠 Tư duy bậc cao | Lần đầu đúng Bloom ≥ 4 | "Bài đòi hỏi tư duy phân tích!" | Growth mindset |
| 🔧 Sửa lỗi thần tốc | Pass Repair ngay lần đầu | "Phát hiện và sửa lỗi nhanh chóng!" | Mistake as learning |
| 👥 Mentor | Peer review 5★ từ 3 b��n | "Bạn bè học từ nhận xét của em!" | Social learning |
| 📚 YCCĐ Chinh phục | Mastery ≥ 0.85 toàn bộ 1 ĐVKT | "Thành thạo toàn bộ [ĐVKT]!" | Competence |
| 🎯 Perfect Bloom | Tất cả 6 cấp ≥ 0.5 | "Phát triển đồng đều 6 cấp tư duy!" | Holistic growth |
| 🌱 Kiên trì | Hoàn thành sau ≥ 3 lần thử | "Không bỏ cuộc — sức mạnh thật sự!" | Resilience |
| 💡 Tự học | Journal word_count > 200 × 5 lần | "Kỹ năng tự học — kỹ năng suốt đời!" | Metacognition |

> **[BỔ SUNG v2.1]** Anti-gaming: Detect multi-account (same IP + similar patterns → flag). Flashcard spam (rate 'Easy' > 90% cards → alert GV). Quiz retry farming (> 5 attempts same quiz trong 1h → XP cap).

---

## 8.6 Module 6 — Học sâu, Tự học & Metacognition (SRL)

### Socratic Questioning Engine [Phase 2]

Max 5 turns. Không cho đáp án. PII anonymized trước Claude API. Graceful end: gợi ý Repair lesson.

### Spaced Repetition — SM-2

| Cơ chế | Tích hợp Learner Model |
|--------|----------------------|
| SM-2: I(n) = I(n-1) × EF. Rating 1-4 | mastery thấp → EF thấp → ôn sớm hơn |
| Smart deck: auto-add câu sai + mastery < 0.6 | Deck update real-time khi mastery thay đổi |
| Optimal review time: engagement heatmap | Reminder 30 phút trước qua notification |
| Retention prediction: R = e^(-t/S) | Hiển thị: "Em sẽ quên trong ~3 ngày" |

### Metacognition Journal

- **3 prompt types:** Pre-lesson ("Mình biết gì?"), Post-lesson ("Điều gì chưa rõ?"), Error-reflect ("Tại sao sai?")
- **Private by default.** GV chỉ xem metadata (word_count). HS opt-in cho GV xem nội dung
- **Weekly synthesis:** count + cluster themes. Gợi ý câu hỏi tổng kết tuần
- **Agent KHÔNG đọc nội dung** — chỉ đọc word_count, frequency

### SRL Dashboard — 6 widgets

| Widget | Nội dung | Câu h��i HS tự hỏi |
|--------|---------|-------------------|
| Learning Compass | Radar 6 chiều: Mastery, Consistency, Reflection, Challenge, Help, Peer | "Năng lực nào em mạnh nhất?" |
| Study Pattern Clock | Clock 24h: giờ học nhiều vs hiệu quả | "Em học hiệu quả lúc mấy giờ?" |
| Error Portfolio | Bộ sưu tập lỗi + Repair đã làm | "Em hay sai dạng nào?" |
| Goal Tracker | HS tự đặt mục tiêu tuần | "Tuần này em muốn đ���t gì?" |
| Learning Style Insights | preferred_model, engagement patterns | "Cách học nào phù hợp em?" |
| Next Step | 3 gợi ý: bài tiếp, flashcard, challenge | "Em nên học gì tiếp theo?" |

### Growth Mindset Scaffolding

| Tình huống | Thông điệp | Cơ sở tâm lý |
|-----------|-----------|-------------|
| HS sai nhiều lần | "Mỗi lần sai = não đang học!" | Carol Dweck: praise effort |
| HS muốn bỏ cuộc | "Muốn thử cách khác? 3 gợi ý..." | SDT: competence → smaller steps |
| HS hoàn thành bài khó | "Đòi hỏi tư duy phức tạp. Em đã nỗ lực!" | Attribution: effort-based praise |
| HS so sánh với b���n | "Tiến bộ so với chính em mới quan trọng" | Temporal self-comparison |
| Streak bị phá | "Không xóa những gì đã học. Học lại hôm nay!" | Self-compassion |

---

## 8.7 UI Screens — Ch8

| Screen | Route | Mô tả |
|--------|-------|-------|
| SCR-8-01 | /qbank | QBank Manager: Question list, Bloom filter, import OCR |
| SCR-8-02 | /exam/new | Exam Builder: Blueprint, auto-generate, preview |
| SCR-8-03 | /achievements | Gamification Hub: XP bar, badges, streak calendar, leaderboard |
| SCR-8-04 | /flashcards | Flashcard Review: swipe interface, SM-2 rating |
| SCR-8-05 | /srl | SRL Dashboard: 6 widgets |
| SCR-8-06 | /journal | Metacognition Journal: prompts, history, tags |

---

## 8.8 Test Cases — Ch8

| TC | Scenario | Expected | Sev |
|----|----------|----------|-----|
| TC-8-001 | SM-2 rating 'Again' → interval reset | interval = 1, repetitions = 0 | P0 |
| TC-8-002 | Exam answers hidden khi active | No correct_answer in response | P0 |
| TC-8-003 | XP server-side only | Client POST XP → 403 | P0 |
| TC-8-004 | Leaderboard opt-out | show_leaderboard=false → 401 | P1 |
| TC-8-005 | Item Analysis p-value correct | p = correct_count / attempt_count (N≥30) | P1 |
| TC-8-006 | Journal privacy: GV no content | Teacher GET → word_count only | P0 |
| TC-8-007 | Blueprint sinh đề 40 câu | Bloom distribution matches blueprint | P1 |
| TC-8-008 | Growth mindset message after fail | Encouraging message, no negative language | P2 |

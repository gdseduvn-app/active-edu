# CHƯƠNG 3: THIẾT KẾ BÀI HỌC THÍCH NGHI — Consolidated v2.1

> **Mã tài liệu:** SRS-CH03 v2.1 · Tháng 4/2025
> **Consolidated từ:** Ch3 v2.0 + Ch3A LessonStudio v1.1 + Ch3B LearningExperience v1.1 + Ch3C AdaptiveEngine v1.1 + Ch3D RepairError v1.1 + Ch3E LessonAnalytics v1.1 + UI_Ch3A-E + TEST_Ch3A-E
> **Phụ thuộc:** Ch2B (DB Schema), Ch2C (Service Tables), Ch7 (AURA), Ch8 (Quiz/SRL)

---

## 3.1 Triết lý thiết kế bài học

Mọi bài học trong AdaptLearn tuân theo 3 nguyên tắc nền tảng:

| # | Nguyên tắc | Biểu hiện trong hệ thống |
|---|-----------|-------------------------|
| 1 | **Active Learning** — học sinh hành động, không thụ động | Mọi bài có ≥1 interactive element: quiz, code sandbox, exit ticket. GĐ3 bắt buộc |
| 2 | **Adaptive** — nội dung thay đổi theo trạng thái người học | Agent chọn mô hình bài học (8 loại) dựa trên mastery_score + bloom_profile |
| 3 | **Explainable** — GV hiểu tại sao hệ thống chọn gì | `agent_decisions.reason` ≥ 20 ký tự tiếng Việt. Dashboard GV hiển thị lý do |

---

## 3.2 Cấu trúc 5 Giai đoạn Universal v2.0

### 3.2.1 Sơ đồ tổng quan

```
GĐ1: Kích hoạt (3-5')     GĐ2: Nội dung (10-15')    GĐ3: Hành động (8-12')
─────────────────────     ──────────────────────     ──────────────────────
• Pre-lesson reflection   • Trình bày ý tưởng        • Bài tập / Lab
• Metacognition Journal   • Ví dụ minh hoạ           • Interactive quiz
  (prompt: 'Mình biết    • Video/PDF (AURA)          • Code sandbox
   gì?')                  • HTML học liệu (AURA)     • Quiz JSON (AURA)
• Kết nối YCCĐ trước      • Slide/Demo               • Peer discussion
• Brain warm-up                                       • Active Learning items

GĐ4: Phản chiếu (3-5')    GĐ5: Gắn kết (2-3')
──────────────────────     ──────────────────────
• Exit ticket (AURA)       • Tóm tắt cốt lõi
• Metacognition Journal    • Flashcard deck (SM-2)
  (prompt: 'Điều gì       • Next lesson preview
   còn chưa rõ?')          • Outcome check → Agent
• Error review             • → trigger LESSON_COMPLETED
• GV phản hồi cá nhân
```

### 3.2.2 Chi tiết từng giai đoạn

| GĐ | Tên | Hoạt động bắt buộc | Tích hợp AURA/Ch8 | Thời gian |
|----|-----|--------------------|--------------------|-----------|
| 1 | Kích hoạt | Pre-lesson reflection. Kết nối kiến thức cũ. Brain warm-up | Metacognition Journal (Ch8): prompt "Mình biết gì về chủ đề này?" | 3-5 phút |
| 2 | Nội dung | Trình bày ý tưởng chính. Ví dụ. Demo. Active Learning items | AURA HTML / Video / PDF embed (Ch7). Active learning items 5 loại | 10-15 phút |
| 3 | Hành động | ≥1 bài tập tương tác. Immediate feedback | Quiz JSON từ AURA (Ch7). Code sandbox Pyodide (Ch7). QBank questions (Ch8) | 8-12 phút |
| 4 | Phản chiếu | HS nhìn lại quá trình. GV xác nhận hiểu biết | Exit Ticket (AURA Ch7). Metacognition Journal prompt 2 (Ch8). Error review link | 3-5 phút |
| 5 | Gắn kết | Tóm tắt. Flashcard. Preview bài tiếp | Flashcard deck auto-generate từ key concepts (Ch8). Agent trigger next lesson | 2-3 phút |

---

## 3.3 Ma trận 8 Mô hình Bài học

| Mô hình | Tên | Bloom target | Trigger Agent | Thời lượng | Tích hợp Ch7/Ch8 |
|---------|-----|-------------|---------------|-----------|------------------|
| M1 | Scaffold | 1-2 (Nhận biết, Hiểu) | mastery < 0.4 | 25-30' | AURA HTML basic. Flashcard deck sau bài |
| M2 | Explain | 2-3 (Hiểu, Vận dụng) | mastery 0.4-0.59 | 25' | AURA Video embed. PDF tài liệu tham khảo |
| M3 | Practice | 3-4 (Vận dụng, Phân tích) | mastery 0.6-0.74 | 30' | Quiz JSON AURA (≥5 câu). QBank random 10 câu |
| M4 | Challenge | 4-5 (Phân tích, Đánh giá) | mastery 0.75-0.89 | 35' | Code Python sandbox (Ch7). Socratic Engine (Ch8) |
| M5 | Create | 5-6 (Đánh giá, Sáng tạo) | mastery ≥ 0.9 | 40' | Project-based. HTML do HS tạo. Bloom 6 XP×2 |
| M6 | Repair | 1-3 (theo lỗi) | error_count ≥ 3 | 20' | Error-targeted: Quiz JSON câu liên quan. Error Portfolio Ch8 |
| M7 | Explore | 2-5 (tuỳ chọn) | HS yêu cầu / curiosity | 30' | AURA HTML interactive, Journal mở, SRL Goal |
| M8 | Review | 1-4 (ôn tập) | review_due từ SRE | 20' | Flashcard SM-2 deck (Ch8). Spaced Rep auto |

### AURA file type → Giai đoạn mapping

| AURA File Type | Phù hợp GĐ | Mô hình bài học | Events sinh ra | Bloom target |
|---------------|------------|----------------|----------------|-------------|
| HTML interactive | GĐ2 + GĐ3 | M1-M5 tuỳ nội dung | AURA_HTML_QUIZ_*, AURA_EXIT_TICKET | 1-6 |
| PDF tài liệu | GĐ2 | M1-M4 (đọc hiểu) | (chỉ view tracking) | 1-3 |
| Video HLS | GĐ2 | M1-M3 (explain) | AURA_VIDEO_MILESTONE (25/50/75/100%) | 1-3 |
| Quiz JSON | GĐ3 | M3 Practice, M6 Repair | AURA_HTML_QUIZ_ANSWER | 2-5 |
| Python Script | GĐ3 | M4 Challenge, M5 Create | GRADER_RESULT_RECEIVED | 3-6 |

---

## 3.4 Bài mẫu — Toán 8: Phương trình bậc nhất 2 ẩn

```
lesson_id: 020808.0201b3 | Môn: Toán 8 | Bloom: 3 (Vận dụng) | Mô hình: M3 Practice
Mục tiêu: HS giải được hệ phương trình bậc nhất 2 ẩn bằng phương pháp thế và cộng.
```

| GĐ | Hoạt động | Nội dung | Tích hợp kỹ thuật | KPI đo |
|----|----------|---------|-------------------|--------|
| 1 | Warm-up | Nhắc lại pt bậc nhất 1 ẩn. "Em biết gì về hệ pt?" | Metacognition Journal pre-lesson (Ch8). Timer 3' | Journal saved |
| 2 | AURA HTML | HTML interactive: nhập hệ pt, kéo slider xem giao điểm đồ thị. Video 5' | AURA iframe embed. Video.js HLS. 3 Active Learning items | AURA_VIDEO_MILESTONE(50%) |
| 3 | Practice | 10 bài từ QBank: 4 dễ (p=0.8), 4 TB (p=0.5), 2 khó (p=0.3). Chữa ngay | QBank random blueprint. Quiz JSON AURA. Grader nếu có code | QUIZ_SUBMITTED events |
| 4 | Exit Ticket | (1) Giải 1 hệ, (2) Chỉ lỗi sai bài mẫu, (3) "Điều nào còn chưa rõ?" | Exit Ticket AURA. Journal post (Ch8). Câu 3 = private | AURA_EXIT_TICKET |
| 5 | Gắn kết | Tóm tắt 3 bước giải. GV phản hồi chung. 5 flashcard key concepts | Flashcard deck auto. Agent nhận LESSON_COMPLETED | LESSON_COMPLETED |

---

## 3.5 Ch3A — LESSON STUDIO

### 3.5.1 Giao diện 4-panel Editor

```
┌──────────────────────────────────────────────────────────┐
│ Topbar: lesson_id | Trạng thái (Draft) | [QA Check] [Publish] │
├───────────┬──────────────────────────────┬───────────────┤
│ Lesson    │                              │ Settings      │
│ Tree      │     Content Editor           │ Panel         │
│ (GĐ1-5)  │     (Rich text + Quiz)       │ (Bloom,       │
│           │                              │  Model,       │
│ Alt+1..5  │     [✨ AI Assist]           │  Timer)       │
│ navigate  │                              │               │
├───────────┴──────────────────────────────┴───────────────┤
│ Bottom Bar: Auto-save 3s ago | Version 12 | [Preview HS] │
└──────────────────────────────────────────────────────────┘
```

### 3.5.2 API Endpoints — Lesson Studio

| Method | Endpoint | Request | Response | Notes |
|--------|---------|---------|----------|-------|
| POST | /lessons | `{yccnd_id, title, model_type, bloom_level}` | 201: `{lesson_id, status:'draft'}` | Auto-fill subject, grade từ lesson_id |
| GET | /lessons/:id | — | 200: lesson object đầy đủ gd_config | GV chỉ xem bài mình. Admin xem all |
| PATCH | /lessons/:id | `{title?, model_type?, gd_config?}` | 200: updated lesson | Trigger auto-save. lesson_drafts INSERT |
| POST | /lessons/:id/publish | — | 200: `{status:'published'}` | Chạy QA 10 điểm trước. Block nếu P0 fail |
| GET | /lessons/:id/qa | — | 200: `{checklist[], passed, blocked}` | QA check realtime |
| GET | /lessons/:id/drafts | `?limit=50` | 200: `[{version, saved_at, preview}]` | Max 50 versions. Auto-purge oldest |
| POST | /lessons/:id/drafts/:version/restore | — | 200: lesson restored | Tạo version mới từ content cũ |
| DELETE | /lessons/:id | — | 204 | Soft delete. status='archived' |

### 3.5.3 AI Assist — 4 chức năng

| # | Chức năng | Input | Output | Cost | Latency |
|---|----------|-------|--------|------|---------|
| 1 | **Suggest Title** từ YCCĐ | lesson_id → fetch YCCĐ text | Dropdown 3 options → GV chọn/edit | ~$0.001 | < 2s |
| 2 | **Generate GĐ3 Questions** | gd2_content, bloom_level, count(3-5) | Quiz Builder pre-filled → GV review | ~$0.005 | < 5s |
| 3 | **Extract Flashcard** | gd2_content | flashcard_concepts[] → GĐ5 auto-populate | ~$0.002 | < 3s |
| 4 | **Improve Lesson** (audit) | full gd_config + QA results | Gợi ý cụ thể: "GĐ3 thiếu câu Bloom 4..." | ~$0.01 | < 8s |

> **PII:** KHÔNG gửi learner data. Chỉ gửi lesson content (public).
> **Fallback:** Claude API timeout > 5s → toast "AI Assist không khả dụng"

### 3.5.4 Keyboard Shortcuts

| Shortcut | Action | Context |
|----------|--------|---------|
| Ctrl+S | Save draft immediately | Bất kỳ đâu |
| Ctrl+Z / Ctrl+Y | Undo / Redo (50 steps) | Content Editor |
| Ctrl+P | Preview HS view | Bất kỳ đâu |
| Ctrl+Enter | Publish (nếu QA pass) | Bất kỳ đâu |
| Alt+1..5 | Chuyển sang GĐ tương ứng | Lesson Tree |
| Ctrl+Q | Mở Quick Quiz Builder | GĐ3 editor active |
| Escape | Đóng modal/dialog | Khi modal mở |
| Ctrl+/ | Toggle AI Assist panel | Bất kỳ đâu |

### 3.5.5 Error States — 6 tình huống

| Scenario | System behavior | GV thấy gì |
|----------|----------------|------------|
| Network mất khi soạn | Auto-save queue locally (IndexedDB). Retry khi có mạng | Toast vàng: "Mất kết nối — đang lưu cục bộ" |
| Publish nhưng QA fail | Block publish. Highlight items fail. Link sửa | Modal: "Không thể publish — AURA cần sửa" |
| Session timeout | Auto-save draft. Prompt re-login. Resume từ draft cuối | Modal: "Phiên hết hạn". Sau login: khôi phục |
| YCCĐ lesson_id không hợp lệ | L01 QA fail. AI suggest lesson_id gần nhất | Input border đỏ. Helper: "Không tìm thấy YCCĐ này" |
| Draft version limit 50 | Tự động xóa 10 version cũ nhất. Log deletion | Toast: "Đã tự động dọn 10 phiên bản cũ" |
| 2 GV edit cùng bài | Lock optimistic: last-write-wins. Alert GV thứ 2 | Banner: "Bài đang được chỉnh bởi GV khác" |

---

## 3.6 Ch3B — LEARNING EXPERIENCE (Trải nghiệm học sinh)

### 3.6.1 Error Recovery — 5 tình huống

| Lỗi xảy ra tại | Recovery action | HS trải nghiệm |
|----------------|----------------|----------------|
| GĐ2: AURA iframe crash | Reload iframe tự động sau 3s. Fail 3 lần: fallback text | Toast: "Đang tải lại bài học..." → "Chuyển sang chế độ văn bản" |
| GĐ3: Submit quiz network mất | Queue locally. Retry khi có mạng. Không mất progress | Spinner trên nút. Toast: "Đang chờ kết nối" |
| GĐ4: Exit ticket submit fail | Local save. Retry background. Log error queue | Toast vàng: "Đã lưu cục bộ — sẽ gửi khi có kết nối" |
| Hết pin/đóng tab giữa GĐ3 | lesson_sessions.state persist. Câu đã làm lưu sessionStorage | Khi mở lại: "Tiếp tục từ câu 3/5" |
| AURA Video buffer stall | HLS adaptive bitrate giảm quality. Fallback 360p | Quality badge: "360p — kết nối yếu" |

### 3.6.2 Accessibility — WCAG 2.1 AA

| Tiêu chí | Yêu cầu | Implementation |
|----------|---------|---------------|
| Contrast ratio | Tối thiểu 4.5:1 text, 3:1 UI components | CSS variables `--color-text-primary`. Kiểm tra axe-core |
| Keyboard navigation | Mọi interactive element accessible bằng Tab/Enter/Esc | Focus indicator rõ ràng. Tab order GĐ1→2→3→4→5 |
| Screen reader | ARIA labels cho tất cả form fields và buttons | `aria-label`, `aria-describedby`. Live region cho feedback quiz |
| Motion reduction | Respect `prefers-reduced-motion` | CSS `@media (prefers-reduced-motion: reduce)` tắt animations |
| Touch targets | Tối thiểu 44×44px cho mobile | Rating buttons SM-2: 56×56px. Quiz options: full-width |
| Focus trap | Modal và dialog không để focus thoát ra ngoài | Focus trap khi modal mở. Esc đóng. Restore focus |

### 3.6.3 Pause & Resume Flow

```
Pause triggers:
  • Click nút [⏸ Tạm dừng] trong topbar
  • Điện thoại nhận cuộc gọi (Page Visibility API: visibilitychange)
  • Đóng browser tab (beforeunload event)

Khi PAUSE:
  1. lesson_sessions.state persist → DB (PATCH /sessions/:id)
  2. Câu đã làm trong GĐ3 lưu vào sessionStorage
  3. Timer GĐ dừng (store elapsed_seconds)
  4. AURA video: pause() gọi qua postMessage

Khi RESUME:
  1. GET /sessions/:lesson_id/current → restore state
  2. Scroll đến GĐ đang dở
  3. Câu đã làm hiển thị lại (pre-filled từ sessionStorage)
  4. Timer resume từ elapsed_seconds
  5. AURA video: seek đến timestamp đã lưu

Giới hạn: Pause tối đa 24h. Sau 24h → session expire, phải làm lại.
```

---

## 3.7 Ch3C — ADAPTIVE ENGINE

### 3.7.1 GV Override API

| Method | Endpoint | Body | Business rule |
|--------|---------|------|--------------|
| POST | /agent/override/:learner_id | `{lesson_id, model_type, reason (≥20 chars)}` | reason bắt buộc. agent_decisions.override=true |
| GET | /agent/decisions/:learner_id | `?limit=20&from=date` | 20 decisions gần nhất. Cả override và auto |
| DELETE | /agent/override/:learner_id | — | Xóa override hiện tại. Agent tự quyết từ lần sau |
| GET | /agent/model-suggestion/:learner_id | — | Xem AI đề xuất. Không apply. GV tham khảo |

### 3.7.2 Fallback Cascade — 6 bước

Khi `select_next(learner)` trả về empty set (không tìm được bài phù hợp):

```
1. Mở rộng anti-repeat: 7 ngày → 3 ngày
2. Mở rộng bloom range: ±1 level
3. Chuyển model sang M8 Review (ôn bài cũ)
4. Gợi ý Flashcard review (nếu có cards due)
5. Notify GV qua dashboard: 'HS {name} thiếu lesson để học'
   → GV notification + link Gap Analysis
6. Return null → Dashboard: 'Liên hệ GV để được hỗ trợ'
```

### 3.7.3 Monitoring Metrics — 6 chỉ số

| Metric | Target | Alert khi |
|--------|--------|----------|
| agent_decisions per minute | 5-20 (peak) | < 1: idle. > 100: overload |
| Override rate | < 15% decisions | ≥ 30%: GV không tin Agent |
| Fallback cascade rate | < 5% requests | ≥ 15%: lesson library thiếu |
| ZPD accuracy | P(correct) trong [0.55-0.80] | < 0.40 hoặc > 0.90: recalibrate |
| Rule R01 trigger rate | < 20% decisions | ≥ 40%: error rate bất thường |
| agent_service P95 latency | < 500ms | ≥ 1s: circuit breaker |

---

## 3.8 Ch3D — REPAIR & ERROR SYSTEM

### 3.8.1 ML Auto-detect Error Type

```python
# Rule-based classifier (fast, free):
IF chosen has wrong sign AND correct involves sign change
    → error_type = 'arithmetic_sign_flip'
IF chosen = correct_for_different_formula
    → error_type = 'formula_misremembered'
IF time_spent < 3s AND wrong
    → error_type = 'calculation_error' (rushed)
IF bloom_level >= 4 AND wrong AND similar_bloom_passed
    → error_type = 'conceptual_confusion'

# LLM fallback (khi rule không match):
#   Claude Haiku: 'Classify this math error type: ...'
#   Cost: ~$0.001/wrong answer. Latency: < 2s (async)
#   Confidence threshold: >= 0.70 để gán vào error_portfolio
#   Below 0.70: error_type = 'unknown', không trigger R01
```

### 3.8.2 Repair Flow v2.0

| Error Type | Repair Action | QBank filter |
|-----------|---------------|-------------|
| arithmetic_sign_flip | 5 bài tập dấu âm. AURA HTML giải thích quy tắc dấu | `error_type='sign' AND bloom_level<=3` |
| formula_misremembered | Flashcard 3 công thức. Quiz 5 câu điền vào chỗ trống | `error_type='formula' AND question_type='fill_blank'` |
| procedural_skip_step | Bài tập step-by-step. Scaffold bắt buộc | `error_type='procedure' AND bloom_level=3` |
| conceptual_confusion | AURA HTML + Socratic Engine (P2). Explain lại Bloom 2 | `error_type='concept' AND bloom_level<=2` |
| code_logic_error | Grader: 3 bài code với test cases. Hint từng bước | `error_type='logic' AND question_type='code_python'` |

### 3.8.3 GV Notification — Error Spike

| Trigger | Ngưỡng | Nội dung notification |
|---------|--------|----------------------|
| Error spike cả lớp | ≥ 5 HS cùng error_type trong 24h | "10/35 HS lớp 10A1 gặp lỗi sign_flip hôm nay. [Xem bài ôn →]" |
| Error tích lũy 1 HS | error_count ≥ 3, repaired=false > 7 ngày | "Minh Tuấn gặp sign_flip 5 lần, chưa hoàn thành bài ôn" |
| Repair thất bại | repair_attempts ≥ 3, resolved=false | "An Nhiên đã làm ôn 3 lần nhưng vẫn tái phát. Cần hỗ trợ trực tiếp" |
| Error mới chưa có bài ôn | error_type không có question trong QBank | "Phát hiện lỗi mới: code_logic_error. [Tạo bài →]" |

### 3.8.4 Error Resolution Criteria

Error `resolved = true` khi PASS cả 3 điều kiện:

1. **REPAIR_COMPLETED:** `repair_attempts >= 1` (HS đã hoàn thành ít nhất 1 Repair M6)
2. **NO_RECURRENCE:** Không gặp lại error_type trong 5 ngày học liên tiếp có quiz liên quan
3. **ACCURACY_THRESHOLD:** Trong 5 câu gần nhất cùng error_type: accuracy ≥ 0.80

Khi resolved:
- Badge earned: "Đã sửa lỗi {error_type_display}" → BADGE_EARNED event
- Notify HS: "Bạn đã khắc phục được lỗi này!"
- GV dashboard: resolved count tăng
- **Re-open:** Nếu gặp lại sau 14 ngày → resolved = false

### 3.8.5 Error Portfolio API

| Method | Endpoint | Auth | Response |
|--------|---------|------|----------|
| GET | /error-portfolio/:learner_id | Owner or Teacher | `[{error_type, count, repair_attempts, resolved, last_seen}]` |
| GET | /error-portfolio/:learner_id/:error_type | Owner or Teacher | `{count, lessons[], repair_lessons[], resolution_criteria_status}` |
| GET | /error-portfolio/class/:class_id/heatmap | Teacher only | `{matrix: error_type x learner_id, counts}` |
| POST | /error-portfolio/:learner_id/resolve-check | System only | Run resolution criteria. Return `{resolved: bool, reasons[]}` |

---

## 3.9 Ch3E — LESSON ANALYTICS

### 3.9.1 Data Retention & Privacy

| Data type | Retention | Anonymize sau | Legal basis |
|-----------|-----------|--------------|-------------|
| lesson_sessions raw | 36 tháng | Sau 36 tháng | NĐ 13/2023 Đ11 — nghiên cứu học tập |
| quiz_attempts per HS | 36 tháng | Sau 36 tháng | Đánh giá học tập, cần cho KT lại |
| metacognition_journals | 12 tháng (private) | **Không anonymize — xóa hẳn** | Dữ liệu nhạy cảm, tối thiểu hóa |
| lesson_analytics aggregate | Vô thời hạn (đã anonymize) | Ngay khi tính | Aggregate = không còn PII |
| error_portfolio | Đến khi HS ra trường + 2 năm | Sau đó anonymize | Hỗ trợ HS dài hạn |
| aura_events per session | 6 tháng | Sau 6 tháng | Cải thiện học liệu |

### 3.9.2 Export Formats

| Format | Nội dung | Privacy |
|--------|---------|---------|
| CSV | lesson_sessions aggregate: lesson_id, avg_completion, avg_time, avg_accuracy | Không có learner_id cá nhân. Class aggregate |
| PDF Report | Per-lesson report: metrics, charts, exit ticket summary, recommendations | Anonymized. Dùng trình BGH |
| Excel | Full class analytics: mỗi row 1 HS (anonymized), nhiều metrics | Anonymized learner_key thay tên |
| JSON | Raw analytics data cho BI tools | Chỉ Admin. Anonymized |

### 3.9.3 Scheduled Reports

| Loại | Lịch | Nội dung |
|------|------|---------|
| **Weekly Digest** | Thứ Hai 07:00 | Top 3 bài hiệu quả, top 3 bài cần cải thiện, HS at-risk mới |
| **Monthly Report** | Ngày 1 hàng tháng | PDF đầy đủ: tất cả bài trong tháng, Bloom coverage, error summary, so sánh tháng trước |
| **Alert Immediate** | Realtime | Bài completion < 50% (sau 10 HS), confusion > 50%, AURA engagement < 2 events/session |

GV config bật/tắt từng loại trong Settings → Notifications. Default: tất cả bật.

### 3.9.4 GV Improvement Action Workflow

Sau khi AI suggest cải thiện, GV có thể:

| # | Action | Thực hiện |
|---|--------|----------|
| 1 | Sửa nội dung GĐ2 | Mở Lesson Studio tại GĐ2. Pre-filled suggestion. Track: `lesson_improvement_log` |
| 2 | Thêm câu quiz | Mở Quiz Builder inline. Bloom pre-selected. Câu mới `review_status='draft'` |
| 3 | Rút ngắn AURA | Mở AURA Manager. Highlight section dài bất thường. Upload file mới → version v2 |
| 4 | Bỏ qua gợi ý | Log `{action:'dismissed', suggestion_id, reason}`. Không hiện lại 30 ngày |
| 5 | Xem chi tiết HS | Drill-down: từng HS outlier (anonymized key). Filter completion < 50% hoặc time > 2× avg |

---

## 3.10 Test Cases — Ch3 tổng hợp

### Test Cases từ Ch3A-E

| TC | Module | Scenario | Expected | Severity |
|----|--------|----------|----------|----------|
| TC-3A-001 | Lesson Studio | Auto-save khi edit gd_config | lesson_drafts INSERT. Version tăng | P1 |
| TC-3A-002 | Lesson Studio | Publish khi QA fail | Block. Modal hiện checklist items fail | P0 |
| TC-3A-003 | Lesson Studio | AI Assist generate quiz timeout | Toast "AI Assist không khả dụng". Không block GV | P2 |
| TC-3B-001 | Learning Experience | Network mất giữa GĐ3 quiz submit | Queue locally. Auto-retry khi online | P0 |
| TC-3B-002 | Learning Experience | WCAG: Tab navigation qua 5 GĐ | Focus ring visible. Tab order đúng GĐ1→5 | P1 |
| TC-3B-003 | Learning Experience | Pause/Resume sau 12h | State restore. Câu đã làm pre-filled | P1 |
| TC-3C-001 | Adaptive Engine | Override R01 (Error Repair) | HTTP 403. Cannot override non-overridable | P0 |
| TC-3C-002 | Adaptive Engine | Fallback cascade khi library rỗng | 6 bước cascade. Cuối: notify GV | P1 |
| TC-3D-001 | Repair & Error | ML detect error_type sign_flip | error_type='arithmetic_sign_flip'. Confidence ≥ 0.70 | P1 |
| TC-3D-002 | Repair & Error | Resolution criteria 3 ĐK | resolved=true chỉ khi cả 3 pass | P1 |
| TC-3E-001 | Lesson Analytics | Export CSV không có PII | CSV columns: lesson_id, avg metrics. Không có learner_id | P0 |
| TC-3E-002 | Lesson Analytics | Scheduled weekly digest | Email GV đúng thứ Hai 07:00. Content đúng | P2 |

---

> **[BỔ SUNG v2.1]** Toàn bộ Ch3A-E v1.1 đã được inline vào chương này, bao gồm: 8 Studio API endpoints, AI Assist 4 chức năng, WCAG 2.1 AA 6 tiêu chí, Pause/Resume, Fallback cascade 6 bước, ML error detection, Error Portfolio API, Data retention NĐ 13/2023, Export formats, Scheduled reports.

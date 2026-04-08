# CHƯƠNG 4: AI AGENT — Consolidated v2.1

> **Mã tài liệu:** SRS-CH04 v2.1 · Tháng 4/2025
> **Consolidated từ:** Ch4 v2.0 + Ch4A CoreAgent v1.0 + Ch4B PipelineEngine v1.0 + UI_Ch4A-B + TEST_Ch4A-B
> **Phụ thuộc:** Ch2B (DB Schema), Ch3C (Adaptive Engine), Ch7 (AURA events), Ch8 (Exam/Flashcard events)

---

## 4.1 Kiến trúc AI Agent — 4 Thành phần

```
┌─────────────────────────────────────────┐
│            AI AGENT SERVICE              │
│                                         │
Event Bus ──────► │  Event Processor (13 handlers)     │
(18 types)        │     │                              │
                  │     ▼                              │
                  │  Learner Model Service (17 fields)  │
                  │     │                              │
                  │     ▼                              │
                  │  Curriculum Planner (R01-R10)       │
                  │     │                              │
                  │     ├──► Lesson recommendation      │
                  │     ├──► Flashcard SRE trigger      │
                  │     ├──► Exam analysis trigger       │
                  │     └──► Feedback Engine (3 mode)   │
                  │           (LLM Phase 2+)            │
                  └─────────────────────────────────────┘
```

| Thành phần | Trách nhiệm | Input | Output |
|-----------|-------------|-------|--------|
| **Learner Model Service** | Duy trì trạng thái học tập. Single source of truth. Cache Redis TTL 30m + persist PostgreSQL | Events từ Event Processor, GV override | LM object cập nhật Redis + PostgreSQL |
| **Curriculum Planner** | Đọc LM → áp 10 luật theo priority → chọn lesson_id → ghi lý do. **Deterministic** | Learner Model, lesson catalog, teacher overrides | next_lesson_id, rule_triggered, reason → agent_decisions |
| **Feedback Engine** | Sinh phản hồi cá nhân hoá. Phase 1: template. Phase 2+: Claude API | Grader result, error_patterns, LM context | Feedback text → LMS hiển thị cho HS |
| **Event Processor** | Subscribe Redis Streams, parse event, route đến đúng handler. At-least-once + idempotency | Redis Streams events:main (18 event types) | Trigger LM update + Planner + Feedback |

---

## 4.2 Functional Requirements — 6 nguyên tắc bắt buộc

| FR | Nguyên tắc | Implementation | Verify bằng |
|----|-----------|---------------|-------------|
| FR-41-01 | **Explainability** | `agent_decisions.reason` NOT NULL, length ≥ 20 ký tự, tiếng Việt | Unit test: reason phải có trong mọi INSERT |
| FR-41-02 | **Determinism** | Cùng LM + catalog + rule version → cùng kết quả. Không random | Unit test: gọi Planner 3 lần cùng input → assert output giống |
| FR-41-03 | **Graceful Degradation** | Agent down → LMS fallback `next_if_pass`. HS vẫn học được | Integration test: kill agent → verify HS vẫn xem bài |
| FR-41-04 | **Teacher Authority** | GV override bất kỳ lúc nào. R01 và R02 là ngoại lệ — không override | API test: POST /agent/override khi R01 active → HTTP 403 |
| FR-41-05 | **Privacy by Design** | Không gửi PII ra external API. Anonymize trước Claude API (Phase 2) | Code review: grep ANTHROPIC → verify no learner email/name |
| FR-41-06 | **Idempotency** | Xử lý cùng event nhiều lần → kết quả như 1 lần. Redis key SET TTL 24h | Test: publish event 3 lần cùng key → LM chỉ update 1 lần |

---

## 4.3 Learner Model — 17 Fields

| Field | Type / Range | Default | Ý nghĩa & Cập nhật khi |
|-------|-------------|---------|------------------------|
| learner_id | UUID | gen_random_uuid() | FK users.id. Bất biến |
| mastery_map | JSONB `{str:float 0-1}` | `{}` | Điểm thành thạo từng YCCĐ. weighted_avg(scores, decay=0.9). Sau quiz_submitted, lesson_completed |
| bloom_profile | JSONB `{1-6:float}` | `{1:0,...,6:0}` | Tỉ lệ thành công rolling avg 20 bài theo cấp Bloom. Sau graded assignment |
| error_patterns | JSONB `[{type,count,first_seen,last_seen,lesson_ids,repaired}]` | `[]` | Mẫu lỗi lặp. count++ khi cùng error_type. Xoá khi Repair pass. Expire 30 ngày |
| speed_profile | JSONB `{subject:float}` | `{}` | duration_actual / median_class. Rolling avg 10 bài. 1.0=trung bình |
| current_level | enum nen_tang/mo_rong/chuyen_sau | nen_tang | Thay đổi khi R02 (hạ) hoặc R03 (tăng). GV set thủ công được |
| engagement | JSONB `{dow_h:float}` | `{}` | avg quiz score theo giờ trong tuần. Key: mon_8, fri_20. Sau session_ended |
| preferred_model | TEXT[] ordered | `[]` | Model hiệu quả nhất. score = quiz×0.4 + completion×0.3 + engagement×0.3 |
| consecutive_pass | INT ≥ 0 | 0 | Bài liên tiếp > 80%. Reset khi < 80%. Trigger R03 khi ≥ 3 |
| consecutive_fail | INT ≥ 0 | 0 | Bài liên tiếp < 60%. Reset khi > 60%. Trigger R02 khi ≥ 2 |
| total_session_time | INT phút | 0 | Cộng dồn. Dùng báo cáo, không dùng decision-making |
| session_count | INT ≥ 0 | 0 | Tổng số phiên học. Sau session_started |
| last_session_at | TIMESTAMPTZ | NULL | Trigger R04 khi `NOW() - last_session_at > 48h` |
| last_lesson_id | VARCHAR(20) | NULL | Bài vừa hoàn thành. Agent dùng cho DEFAULT rule tiếp nối |
| tags | TEXT[] | `[]` | Nhãn: peer_expert, at_risk, fast_learner, needs_repair. Agent gán tự động |
| exam_history | JSONB `[{exam_id, score_pct, bloom_profile}]` | `[]` | **[v2.0]** Lịch sử thi. Sau EXAM_GRADED |
| flashcard_stats | JSONB `{cards_due, avg_ef, decks_count}` | `{}` | **[v2.0]** Thống kê flashcard. Trigger R09 khi cards_due > 0 |
| srl_engagement | JSONB `{journal_count, goal_active, goal_done}` | `{}` | **[v2.0]** Self-regulated learning. Sau METACOGNITION_JOURNAL_SAVED |

### Mastery Score Algorithm

```python
def calculate_mastery(attempts, decay_factor=0.9, time_decay_days=30.0):
    if not attempts: return {"score": 0.0, "confidence": 0.0}
    sorted_attempts = sorted(attempts, key=lambda x: x.submitted_at)
    now = datetime.now(timezone.utc)
    weighted_sum = weight_total = 0.0
    for i, attempt in enumerate(sorted_attempts):
        recency_weight = decay_factor ** (len(sorted_attempts) - 1 - i)
        days_ago = (now - attempt.submitted_at).days
        time_weight = math.exp(-days_ago / time_decay_days)
        combined = recency_weight * time_weight
        weighted_sum += attempt.score * combined
        weight_total += combined
    mastery = weighted_sum / weight_total if weight_total > 0 else 0.0
    confidence = min(1.0, len(attempts) / 3)
    return {"score": round(mastery, 4), "confidence": round(confidence, 4)}

MASTERY_THRESHOLDS = {
    "nen_tang":   (0.0,  0.60),
    "mo_rong":    (0.60, 0.85),
    "chuyen_sau": (0.85, 1.01),
}
```

---

## 4.4 Rule Engine — 10 Luật R01-R10

| Rule | Tên | Priority | Điều kiện kích hoạt | Hành động | v2.0 |
|------|-----|---------|---------------------|-----------|------|
| **R01** | Repair | **P0** | error_patterns[any].count ≥ 3 AND repaired=false | Chọn M6 Repair. QBank filter error_type. Ghi Error Portfolio | Thêm Error Portfolio Ch8 |
| **R02** | Overload | **P0** | fatigue_score > 0.8 OR session_time > 90 phút | Đề xuất nghỉ hoặc bài nhẹ Bloom 1-2 | Không đổi |
| **R03** | Mastery up | P1 | mastery_map[lesson] > 0.85 | Chuyển lên Bloom +1. Cập nhật bloom_profile | Không đổi |
| **R04** | Streak | P1 | current_streak === 7 OR 30 | Đề xuất Challenge/Create. Badge trigger (Ch8) | Thêm badge |
| **R05** | Pacing | P2 | 3 bài liên tiếp bloom=1-2 | Tăng độ khó nhẹ. Không stuck Bloom thấp | Không đổi |
| **R06** | Engagement | P2 | engagement_score < 0.4 AND last_active < 3 ngày | Bài ngắn (Explore), push notification nhẹ | Không đổi |
| **R07** | Prerequisite | P3 | mastery prerequisites < 0.6 | Ưu tiên bài nền tảng trước | Không đổi |
| **R08** | Bloom gap | P3 | bloom_profile[6] = 0 AND nhiều bài Bloom 1-3 | Gợi ý M5 Create nếu cơ bản đã vững | Không đổi |
| **R09** | **Flashcard due** | **P2** | flashcard_stats.cards_due > 0 | Gợi ý review flashcard deck | **MỚI Ch8** |
| **R10** | **Exam coming** | **P1** | exam sắp đến trong 3 ngày | Đề xuất bài ôn + Practice mode | **MỚI Ch8** |

> **R01 và R02 KHÔNG thể override bởi GV** (FR-41-04). POST /agent/override khi R01/R02 active → HTTP 403.

> **[BỔ SUNG v2.1]** Same-priority conflict resolution: Khi nhiều rule cùng priority trigger đồng thời, ưu tiên theo thứ tự ID (R01 > R02, R03 > R04, etc.). Agent chỉ fire 1 rule per decision cycle.

---

## 4.5 Event Processor — 13 Handlers

| Event Type | LM fields cập nhật | Logic xử lý |
|-----------|-------------------|-------------|
| quiz_submitted | mastery_map, bloom_profile, error_patterns, consecutive | calculate_mastery(). bloom_profile update. Detect error_types. Trigger R01 nếu count ≥ 3 |
| assignment_submitted | mastery_map, error_patterns, preferred_model | Grader result → mastery. error_types → error_patterns. peer_review: preferred_model signal |
| session_started | last_session_at, session_count, engagement | last_session_at=NOW(). session_count++. Check R04 (dormant > 48h). Pre-load Planner |
| session_ended | total_session_time, engagement | total_session_time += duration. engagement[dow_hour]=avg_score. Snapshot LM |
| lesson_completed | mastery_map, consecutive_pass, last_lesson_id | mastery update. consecutive_pass++. last_lesson_id set. **Run Rule Engine** |
| AURA_HTML_QUIZ_ANSWER | error_patterns, engagement | Nếu wrong: detect error_type → error_patterns. engagement positive update |
| AURA_EXIT_TICKET_SUBMITTED | engagement | engagement += 0.1. Nếu confusion_detected: notify_teacher |
| AURA_VIDEO_MILESTONE | engagement | Chỉ update khi pct=100. engagement += 0.05 |
| EXAM_GRADED | exam_history, mastery_map, error_patterns | exam_history.append. Merge error_patterns. **mastery weight=0.3** (nhẹ hơn quiz=0.7 vì thi có áp lực) |
| FLASHCARD_DECK_MASTERED | srl_engagement | goal_done++. Check badge flashcard_champion (≥ 5 decks) |
| BADGE_EARNED | tags | tags.append badge_type nếu chưa có |
| STREAK_MILESTONE | consecutive_pass, tags | streak 7d: check R04. streak 30d: tag fast_learner |
| METACOGNITION_JOURNAL_SAVED | srl_engagement | journal_count++. goal_active++ nếu có goal |

---

## 4.6 Feedback Engine — 3 Mode

| Mode | Trigger | Nội dung | Phase |
|------|---------|---------|-------|
| **Correction** | HS trả lời sai quiz/assignment | Giải thích lỗi cụ thể (error_type), bước đúng, quy tắc. Đề xuất Repair nếu count ≥ 3 | Phase 1: template. Phase 2+: Claude Haiku |
| **Encourage** | Score > 0.8 hoặc streak milestone | Ghi nhận điểm mạnh cụ thể. Gợi ý thử thách cao hơn | Phase 1: template đơn giản |
| **Socratic** | HS request giải thích hoặc GV enable | Hỏi lại bằng câu hỏi gợi mở. Max 5 turns, graceful end | **Phase 2+: Claude API bắt buộc** |

### Socratic Engine — Chi tiết

```python
SOCRATIC_SYSTEM_PROMPT = '''
Bạn là gia sư Toán/Tin dạy theo phương pháp Socratic.
1. KHÔNG BAO GIỜ cho đáp án trực tiếp
2. Đặt 1 câu hỏi gợi mở dẫn đến bước tiếp theo
3. Nếu HS bế tắc sau 3 câu hỏi → gợi ý xem lại [concept_name]
4. Sau 5 turns → kết thúc gracefully, gợi ý bài Repair
5. KHÔNG đề cập tên HS (PII protection — FR-41-05)
6. Giữ nguyên tiếng Việt, thân thiện, không phán xét
'''

class SocraticEngine:
    MAX_TURNS = 5

    def respond(self, learner_id, turn_history, current_message):
        if len(turn_history) >= self.MAX_TURNS:
            return self._graceful_end(learner_id)
        anon_context = self._anonymize(current_message, turn_history)
        response = claude_api.complete(
            system=SOCRATIC_SYSTEM_PROMPT,
            messages=anon_context,
            max_tokens=300
        )
        return response.text

    def _graceful_end(self, learner_id):
        repair = find_repair_lesson(get_learner_model(learner_id).error_patterns)
        return f'Hãy thử bài ôn tập {repair.title} để củng cố nền tảng nhé!'
```

### Correction Templates (Phase 1)

```python
TEMPLATES = {
    "arithmetic_sign_flip": {
        "title": "Lỗi chuyển vế đổi dấu",
        "explain": "Khi chuyển hạng tử sang vế khác phải đổi dấu.",
        "example": "3x - 6 = 9 → 3x = 9 + 6 = 15 → x = 5 (KHÔNG phải 9 - 6)",
        "rule": "Chuyển vế LUÔN đổi dấu hạng tử đó.",
        "repair": True,
    },
    "formula_misremembered": {
        "title": "Nhớ sai công thức",
        "explain": "Công thức bạn dùng chưa chính xác.",
        "rule": "Ôn lại flashcard công thức trước khi làm bài.",
        "repair": True,
    },
}
```

---

## 4.7 DPIA cho Learner Model

> **[BỔ SUNG v2.1]** Bắt buộc theo NĐ 13/2023 Điều 24 vì AI Agent thực hiện **xử lý DLCN tự động** (Điều 2.13).

| DPIA Section | Nội dung |
|-------------|---------|
| **Mục đích xử lý** | Cá nhân hoá lộ trình: chọn bài, điều chỉnh độ khó, feedback |
| **Loại DLCN** | Điểm quiz, thời gian học, error_patterns, engagement, bloom_profile |
| **Xử lý tự động** | Learner Model 17 fields + Rule Engine R01-R10 tự quyết định bài tiếp |
| **Rủi ro** | (1) Tái nhận dạng qua mastery_map pattern (2) Bias AI ưu tiên HS giỏi (3) PII leak qua Claude API |
| **Biện pháp** | (1) k-anonymity check (2) Fairness audit hàng tháng (3) PII filter FR-41-05 (4) On-premise VN |
| **Cơ sở pháp lý** | Đồng ý (Đ11), Giáo dục (Luật GD 2019), Nghiên cứu KH (Đ17.7) |

> **[BỔ SUNG v2.1]** Claude API Abstraction Layer: Ràng buộc C03 (không vendor lock-in) yêu cầu interface `FeedbackProvider` → `AnthropicProvider` implementation. Chuyển provider không cần thay đổi business logic.

---

## 4.8 Monitoring & Explainability

| Metric | Target | Alert khi | Dashboard |
|--------|--------|----------|-----------|
| Agent decision latency P95 | < 500ms | ≥ 1000ms | Grafana Agent panel |
| Rule engine: % quyết định có reason | 100% | < 100% | Agent Quality |
| AURA event processing lag | < 2s P95 | ≥ 5s | AURA Operations |
| AURA parse success rate | ≥ 95% | < 90% | AURA Quality |
| Exam grading time P95 | < 5s | ≥ 30s | Exam Operations |
| Flashcard due calculation accuracy | 100% | ≠ 100% | SRE panel |
| Socratic Engine API cost/day | < threshold | > threshold × 1.5 | Cost monitor |
| Error Pattern detection rate | ≥ 80% | — | Agent Quality |

---

## 4.9 UI Screens — AI Agent

### SCR-4A-01: Learner Model Viewer (Student + Teacher)

```
┌──────────────────────────────────────────────────┐
│ Hồ sơ học tập của tôi    [Cập nhật 14:23:01]    │
├──────────────────┬───────────────────────────────┤
│ MASTERY MAP      │ BLOOM PROFILE (1-6 bars)      │
│ Skill1  0.85 ██▓ │ [1] 82% ████████░            │
│ Skill2  0.72 ██░ │ [2] 78% ███████░░            │
│ ! Skill3 0.51 █░ │ [3] 61% ██████░░░            │
├──────────────────┴───────────────────────────────┤
│ STREAK 14d | PACE: Trung bình | SRL: ●●●○        │
├──────────────────────────────────────────────────┤
│ [!] arithmetic_sign_flip ×4  [Xem bài ôn →]     │
└──────────────────────────────────────────────────┘
```

### SCR-4A-02: Agent Decision Log (Teacher only)
- Bảng: Timestamp | Rule (R01-R10) | Vietnamese Reason | Lesson
- Expandable "Tại sao?" section
- Export CSV, Filter buttons

### SCR-4A-03: GV Override Interface (Teacher)
- Form: select replacement lesson, reason (≥20 chars), confirm
- R01/R02 buttons blocked với "Non-overridable" tooltip

### SCR-4B-01: Recommendation Card (Student)

```
┌──────────────────────────────────┐
│ BÀI HỌC TIẾP THEO                │
│ Hàm số nâng cao      [Bloom L4]  │
│ Estimated: 12 min | M₂ level     │
│ Lý do: Mastery > 0.85 (R03)      │
│ [Bắt đầu →]                      │
└──────────────────────────────────┘
```

### SCR-4B-02: Feedback Display (Student)
- Mode badge (Correction | Encourage | Socratic)
- Error badge + rule + explanation + related lesson link

### SCR-4B-03: Socratic Chat (Student, Phase 2)
- Bubble conversation UI. Turn counter "2/5"
- Graceful end message after turn 5
- Disabled nếu Claude API key not configured

---

## 4.10 Test Cases — Ch4

| TC | Module | Scenario | Expected | Sev |
|----|--------|----------|----------|-----|
| TC-4A-001 | Core Agent | mastery_score weighted decay correct | Score matches formula output | P0 |
| TC-4A-002 | Core Agent | R01 trigger khi error_count ≥ 3 | M6 Repair lesson selected | P0 |
| TC-4A-003 | Core Agent | R01 cannot be overridden | POST /override → 403 | P0 |
| TC-4A-004 | Core Agent | R01 beats R03 khi both trigger | R01 (P0) wins over R03 (P1) | P0 |
| TC-4A-005 | Core Agent | Determinism: 3× same input | Same output 3 lần | P0 |
| TC-4A-006 | Core Agent | Idempotency: 3× same event | LM chỉ update 1 lần | P0 |
| TC-4A-007 | Core Agent | Explainability: reason NOT NULL | reason ≥ 20 chars tiếng Việt | P0 |
| TC-4B-001 | Pipeline | quiz_submitted updates correct LM fields | mastery_map, bloom_profile, error_patterns updated | P0 |
| TC-4B-002 | Pipeline | EXAM_GRADED weight=0.3 | mastery = old×0.7 + exam_score×0.3 | P1 |
| TC-4B-003 | Pipeline | Feedback Correction template sign_flip | Template output đúng nội dung | P1 |
| TC-4B-004 | Pipeline | Socratic max 5 turns | Turn 6 → graceful end message | P1 |
| TC-4B-005 | Pipeline | Socratic PII anonymization | Claude API call không chứa learner name/email | P0 |

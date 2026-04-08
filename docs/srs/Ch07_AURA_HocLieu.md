# CHƯƠNG 7: MODULE AURA — QUẢN LÝ HỌC LIỆU ĐA ĐỊNH DẠNG — Consolidated v3.0

> **Mã tài liệu:** SRS-CH07 v3.0 · Tháng 4/2025
> **AURA:** Active-learning Unit Repository & Adapter
> **Consolidated từ:** Ch7 v3.0 Final + Ch7 v3.0 chi tiết (752 dòng) + UI_Ch7 + TEST_Ch7

---

## 7.1 Tổng quan Module AURA

GV nhận học liệu từ nhiều nguồn: Claude tạo HTML, Sở GD gửi PDF, GV quay video, Tổ Tin tạo Python script. **Vấn đề:** Agent không đọc được raw file — chỉ đọc Learner Model và Event Log chuẩn hoá.

**Giải pháp — AURA:** Layer trung gian nhận mọi định dạng, xử lý theo 4 mục tiêu, output 1 chuẩn duy nhất Agent tiêu thụ được.

### 7 Thành phần AURA

| Thành phần | Trách nhi���m | Công nghệ |
|-----------|-------------|-----------|
| **AURA Gateway** | Nhận upload, validate MIME/size/CSP, tạo job ID | FastAPI, python-magic |
| **AURA Parser Engine** | Phân tích nội dung: DOM (HTML), PDF extractor, JSON schema, AST (Python) | BeautifulSoup4, PyMuPDF, jsonschema, ast |
| **AURA AI Suggester** | Gợi ý lesson_id QĐ 791, bloom_level, lesson_model | Embeddings semantic search. P2: Claude |
| **AURA Serve Engine** | Phục vụ học liệu: iframe sandbox, PDF viewer, HLS stream | Nginx X-Accel-Redirect, HLS.js, PDF.js, Pyodide |
| **AURA Event Bridge** | Chuẩn hoá events → Event Log chuẩn | postMessage SDK, LTI 1.3, WebSocket |
| **AURA Version Manager** | Quản lý phiên bản, diff, rollback | MinIO versioning + aura_versions table |
| **AURA Editor** | UI cho GV chỉnh sửa không code | React rich-text, form builder, live preview |

---

## 7.2 Ma trận 5 Loại File × 4 Mục tiêu

| File Type | ① EMBED | ② PARSE | ③ STORE | ④ SYNC | Ghi chú |
|-----------|---------|---------|---------|--------|---------|
| **HTML interactive** | ✅ iframe CSP | ✅ BS4+meta | ✅ MinIO | ✅ postMessage | Pyodide WASM cho Python trong HTML. AURA SDK inject |
| **PDF tài liệu** | ✅ PDF.js embed | ✅ PyMuPDF | ✅ MinIO | ❌ (view only) | Tracking: time on page. Không download nếu restrict=true |
| **Video HLS** | ✅ Video.js+HLS | ❌ (metadata) | ✅ MinIO+transcode | ✅ milestone events | ffmpeg → 360p/720p/1080p. AURA_VIDEO_MILESTONE |
| **Quiz JSON** | ✅ iframe renderer | ✅ jsonschema | ✅ MinIO | ✅ quiz events | Format chuẩn AURA Quiz Schema |
| **Python Script** | ✅ Pyodide WASM | ✅ ast.parse | ✅ MinIO | ✅ exec events | Sandbox: no network, no fs, RAM 256MB, timeout 30s |

### 4 Mục tiêu chi tiết

| # | Mục tiêu | Mô tả kỹ thuật |
|---|---------|---------------|
| ① | **EMBED** | Nhúng iframe sandbox CSP nghiêm: `default-src 'self'; script-src 'self'`. Không allow-popups, allow-top-nav |
| ② | **PARSE** | Trích xuất metadata: grade, subject, bloom, has_quiz, has_exit_ticket. Index cho search |
| ③ | **STORE** | Lưu MinIO: `aura/{type}/{sha256}.{ext}`. Version history, retention 36 tháng, presigned URL TTL 2h |
| ④ | **SYNC** | AURA Event Bridge chuẩn hoá events iframe → Event Bus qua postMessage. NormalizedEvent + idempotency_key |

---

## 7.3 AURA Universal Pipeline

```
Bước 1: GV Upload (Drag-drop hoặc API)
  POST /aura/upload → detect MIME → route parser → store raw MinIO
  → Create aura_lessons record: status='aura_uploading'

Bước 2: Parse (tự động, ~5-30s tuỳ loại)
  HTML  → DOM parser → AURALessonDraft
  PDF   → PyMuPDF ��� text blocks + images → AURALessonDraft
  Video → thumbnail + duration + chapter markers → AURALessonDraft
  Quiz  → JSON schema validate → questions[] → AURALessonDraft
  Python→ AST → function signatures + test_cases → AURALessonDraft

Bước 3: AI Suggest (tự động, ~10s)
  Semantic search → top 3 lesson_id QĐ 791
  Bloom inference: quiz complexity + theory keywords
  Model inference: has_interactive? → lesson_model hint

Bước 4: GV Review (UI)
  Confirm: lesson_id, subject, grade, bloom_level, ĐVKT
  Chọn: exploit_mode (embed | extract | store | sync_all)

Bước 5: Configure (tự động sau confirm)
  EMBED → inject AURA SDK / setup PDF viewer / HLS
  PARSE → import questions DB / index text search
  STORE → MinIO versioning / checksum / retention
  SYNC  → register event hooks / webhook / LTI callback

Bước 6: Approve (Tổ trưởng)
  Checklist 12 điểm → Approve → status='active'
  Lesson vào catalog → Agent dùng được
```

---

## 7.4 AURA SDK — postMessage Bridge

```javascript
// aura-bridge.js — inject vào <head> mọi HTML AURA
(function() {
  const LESSON_ID = document.querySelector('[name=aura:lesson-id]')?.content;
  if (!LESSON_ID) { console.warn('AURA: missing lesson-id meta'); return; }

  function emit(event_type, payload) {
    window.parent.postMessage({
      source: 'aura-bridge', event_type, lesson_id: LESSON_ID,
      payload, idempotency_key: crypto.randomUUID(), ts: Date.now()
    }, '*');
  }

  window.checkAnswer = function(q_idx, chosen, correct, time_ms) {
    emit('AURA_HTML_QUIZ_ANSWER', { q_idx, chosen, correct, time_ms });
  };
  window.quizComplete = function(score, total) {
    emit('AURA_HTML_QUIZ_COMPLETE', { score, total });
  };
  window.submitTicket = function(answers) {
    emit('AURA_EXIT_TICKET_SUBMITTED', { answers });
  };
  window.startTimer = function(label) {
    emit('AURA_TIMER_START', { label, ts: Date.now() });
  };
  emit('AURA_LESSON_LOADED', { lesson_id: LESSON_ID });
})();
```

---

## 7.5 QA Checklist — A01-A12

Mọi file phải pass QA trước khi activate. **A01 FAIL = block hoàn toàn.**

| ID | Level | Kiểm tra | Tool | Fail action |
|----|-------|---------|------|------------|
| A01 | P0 | `<meta name='aura:lesson-id'>` tồn tại và valid QĐ 791 | Regex | Block: không cho activate |
| A02 | P0 | File hash chưa tồn tại (tránh duplicate) | SHA-256 | Block: báo duplicate |
| A03 | P0 | File size ≤ 5MB (HTML) / 2GB (video) | stat | Block: yêu cầu nén |
| A04 | P0 | Không có external fetch/XHR (CSP check) | AST scan | Block: XSS risk |
| A05 | P1 | AURA SDK inject thành công | DOM check | Warn: không có events → Agent không học |
| A06 | P1 | Không có `contenteditable='true'` | DOM check | Warn: GV đang test mode |
| A07 | P1 | PDF không encrypted | PyMuPDF | Warn: cần GV bỏ password |
| A08 | P1 | Quiz có ≥ 1 correct answer | JSON check | Warn: không chấm được |
| A09 | P2 | Bloom level inference consistent | AI suggest | Info only |
| A10 | P2 | Theory text ≥ 100 chars | Text extract | Info: bài quá ngắn |
| A11 | P2 | Video duration ≤ 20 phút | ffprobe | Info: bài quá dài |
| A12 | P2 | Python code pass syntax check | ast.parse | Warn: syntax error |

---

## 7.6 Version Management & Storage

### MinIO Bucket Structure

| Loại | Path | Versioning | Retention |
|------|------|-----------|-----------|
| HTML | `aura/html/{lesson_id}/v{n}.html` | Max 20 versions. Diff riêng | Active: vô hạn. Archived: 2 năm |
| PDF | `aura/pdf/{lesson_id}/{hash}.pdf` | Immutable (hash-based deduplicate) | Vô hạn — QĐ 791 |
| Video | `aura/video/{lesson_id}/hls/*.m3u8` | Original immutable. HLS re-transcode | Original: vô hạn. HLS cache: 30 ngày |
| Quiz | `aura/quiz/{lesson_id}/v{n}.json` | Versioned. Diff câu hỏi | Active: vô hạn. Old: 1 năm |
| Python | `aura/python/{lesson_id}/solution.py` | Versioned. Test spec update độc lập | Vô hạn — tài sản GD |

---

## 7.7 UI Screens — AURA

| Screen | Route | Mô tả |
|--------|-------|-------|
| SCR-7-01 | /aura | AURA Studio: Upload drag-drop, pipeline status, QA checklist 12 điểm |
| SCR-7-02 | /aura/:id | Chi tiết AURA lesson: versions, events, analytics |
| SCR-7-03 | /aura/gap | Bloom Gap Analysis: heatmap theo môn × lớp × Bloom |

---

## 7.8 Test Cases — Ch7

| TC | Scenario | Expected | Sev |
|----|----------|----------|-----|
| TC-7-001 | Upload HTML chuẩn → parse + activate | qa_status=pass. HS có thể học | P0 |
| TC-7-002 | Upload HTML thiếu lesson_id meta | A01 FAIL. Block activate | P0 |
| TC-7-003 | iframe CSP block external script | `<script src='evil.com'>` bị chặn | P0 |
| TC-7-004 | AURA SDK postMessage quiz answer | Event AURA_HTML_QUIZ_ANSWER trong Redis < 2s | P0 |
| TC-7-005 | Video HLS transcode 700MB | m3u8 + 3 quality < 5 phút | P1 |
| TC-7-006 | Version rollback | Rollback v2 → v1, HS thấy v1 | P1 |
| TC-7-007 | Bloom gap detection | Alert khi gap > 5pp | P2 |

> **[BỔ SUNG v2.1]** Gaps 7.1 (PDF Sync): Hiện PDF chỉ view-only tracking. GV muốn tạo quiz từ PDF content → dùng OCR Import (Ch8 §8.1.4) hoặc tạo Quiz JSON riêng link vào lesson.
> **[BỔ SUNG v2.1]** Gaps 7.2 (Video chapter): Whisper transcript = P2. P1: GV tag chapter markers thủ công qua AURA Editor.

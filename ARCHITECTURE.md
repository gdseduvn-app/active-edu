# ARCHITECTURE SPECIFICATION — AURA LMS
## Adaptive Unplugged Responsive Architecture

> **Phiên bản:** 1.0.0
> **Ngày cập nhật:** 2026-04-04
> **Trạng thái:** Draft — Internal Review
> **Tác giả:** AURA Engineering Team

---

## MỤC LỤC

1. [Executive Summary](#1-executive-summary)
2. [Canvas LMS vs AURA — Bảng So Sánh](#2-canvas-lms-vs-aura--bảng-so-sánh)
3. [System Architecture Diagram](#3-system-architecture-diagram)
4. [AI Agent Specifications](#4-ai-agent-specifications)
5. [Data Models & Schemas](#5-data-models--schemas)
6. [API Contracts](#6-api-contracts)
7. [Implementation Roadmap](#7-implementation-roadmap)
8. [Tech Stack Decisions](#8-tech-stack-decisions)
9. [Security & Privacy Design](#9-security--privacy-design)

---

## 1. EXECUTIVE SUMMARY

### 1.1 Bối cảnh & Vấn đề

ActiveEdu hiện tại (v2.0) là một nền tảng LMS tối giản chạy trên GitHub Pages + NocoDB, đủ để triển khai nhanh nhưng thiếu hàng loạt tính năng mà một LMS thế hệ mới đòi hỏi. Hệ thống đang hoạt động đúng như Canvas LMS năm 2010 — nội dung tĩnh, không có AI, không có adaptive learning, không có real-time analytics.

**AURA** (Adaptive Unplugged Responsive Architecture) là bản nâng cấp chiến lược, giải quyết 10 điểm yếu cốt lõi của Canvas LMS đồng thời xây dựng nền tảng AI-native từ đầu.

### 1.2 Tầm nhìn kiến trúc

AURA không phải là "Canvas với AI thêm vào." AURA được thiết kế theo nguyên lý **AI-first, offline-capable, real-time adaptive** — nơi mọi hành vi học tập đều được thu thập, phân tích và phản hồi tức thời.

### 1.3 Bốn trụ cột AURA

```
┌─────────────────────────────────────────────────────────────────┐
│                     AURA — 4 PILLARS                            │
├──────────────┬──────────────┬──────────────┬───────────────────┤
│  [A]DAPTIVE  │  [U]NPLUGGED │  [R]ESPONSIVE│  [A]RCHITECTURE   │
│              │              │              │      CORE          │
│ DAG Knowledge│ AI-with-     │ Real-time    │ Headless LMS       │
│ Graph (Neo4j)│ Guardrails   │ Radar        │ Microservices      │
│ Skill Trees  │ Zero-draft   │ xAPI Events  │ Polyglot           │
│ Dynamic      │ Socratic AI  │ O2O Blended  │ Persistence        │
│ Routing      │ Unplugged    │ Kafka/WS     │                    │
│              │ Checkpoints  │              │                    │
└──────────────┴──────────────┴──────────────┴───────────────────┘
```

### 1.4 Các con số mục tiêu

| Metric | Hiện tại (v2.0) | Mục tiêu (AURA) |
|--------|-----------------|-----------------|
| Time-to-first-lesson | ~3s | < 800ms |
| Adaptive path coverage | 0% | 85%+ |
| AI-assisted interactions | 0 | 100% sessions |
| Offline capability | 0% | 60% content |
| Real-time alert latency | N/A | < 5 seconds |
| xAPI event capture | 0 | 100% interactions |

---

## 2. CANVAS LMS VS AURA — BẢNG SO SÁNH

### 2.1 Điểm yếu của Canvas LMS và giải pháp AURA

| # | Điểm yếu Canvas LMS | Mô tả chi tiết | Giải pháp AURA |
|---|---------------------|----------------|----------------|
| 1 | **Linear module structure** | Module chỉ là danh sách thẳng, không có nhánh điều kiện hay adaptive path | DAG Knowledge Graph (Neo4j) — mỗi skill node có prerequisite, learner được route động theo mastery level |
| 2 | **No AI layer** | Không có bất kỳ tính năng ML/AI nào trong thiết kế gốc (2021) | 5 AI Agent chuyên biệt (Curriculum, Assessment, Coaching, Analytics, Content) chạy trên Claude Haiku |
| 3 | **Passive data** | Chỉ lưu điểm cuối, không có behavioral analytics, engagement signal | xAPI event stream — capture toàn bộ hành vi học tập (thời gian đọc, scroll depth, video pause, re-attempt) |
| 4 | **O2O disconnect** | Không nhận biết hoạt động ngoại tuyến hay lớp học thực | Unplugged Checkpoints — QR check-in, offline progress sync, O2O attendance bridge |
| 5 | **Static gradebook** | Giảng viên không có real-time alert, gradebook chỉ update khi nộp bài | Real-time Instructor Radar — WebSocket dashboard, tự động alert khi học sinh có dấu hiệu stuck/dropout |
| 6 | **LTI fragmentation** | Tool bên thứ ba kết nối qua LTI nhưng trải nghiệm rời rạc, không đồng nhất UX | Native integration layer — mỗi tool bên ngoài được wrap trong AURA UI shell, context chia sẻ qua token |
| 7 | **Course conclude irreversible** | Một khi course kết thúc, không thể mở lại dễ dàng | Soft-archive model — course có state machine (draft → active → archived → restored), không xóa cứng |
| 8 | **Rubric not linked to master** | Rubric bị copy vào từng assignment, không đồng bộ khi thay đổi master | Rubric Registry — rubric lưu tập trung, assignment reference bằng ID, thay đổi master propagate tức thì |
| 9 | **Annotations không trigger notification** | Giáo viên annotate bài nộp nhưng học sinh không nhận thông báo | Annotation Event Bus — mọi annotation đều emit event, học sinh nhận notification real-time qua WebSocket |
| 10 | **Collaborations limited to Google Docs** | Tính năng Collaborations chỉ hỗ trợ Google Docs | Collaboration Hub — tích hợp Google Docs, Figma, Miro, Notion, GitHub Codespaces thông qua một abstraction layer |

### 2.2 Feature Matrix So Sánh

| Feature | Canvas LMS | AURA v1 (Phase 1) | AURA v2 (Phase 2) | AURA v3 (Phase 3) |
|---------|-----------|-------------------|-------------------|-------------------|
| Course builder | ✅ Static | ✅ Static + templates | ✅ AI-assisted | ✅ AI-generated DAG |
| Assessment | ✅ Manual | ✅ Manual + auto-grade | ✅ AI auto-gen | ✅ Adaptive testing |
| Analytics | ✅ Basic | ✅ Behavioral events | ✅ Predictive alerts | ✅ Prescriptive AI |
| AI Tutor | ❌ None | ⚡ Socratic chatbot | ✅ Context-aware | ✅ Personalized |
| Offline | ❌ None | ⚡ PWA caching | ✅ Full offline mode | ✅ O2O sync |
| Real-time | ❌ None | ✅ WebSocket | ✅ Kafka streams | ✅ Edge streaming |
| Rubric sync | ❌ Copy only | ✅ Registry | ✅ Registry + AI suggest | ✅ Auto-rubric |
| Notifications | ✅ Basic | ✅ + Annotation alerts | ✅ Predictive | ✅ Personalized |

---

## 3. SYSTEM ARCHITECTURE DIAGRAM

### 3.1 Tổng quan hệ thống (High-Level)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           CLIENT LAYER                                  │
│                                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────┐  │
│  │  Student App  │  │  Teacher App │  │  Admin Panel │  │ Mobile PWA │  │
│  │ (GitHub Pages)│  │(GitHub Pages)│  │(GitHub Pages)│  │  (Offline) │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └─────┬──────┘  │
│         │                 │                  │                │         │
│         └─────────────────┴──────────────────┴────────────────┘         │
│                                    │                                    │
└────────────────────────────────────┼────────────────────────────────────┘
                                     │ HTTPS / WebSocket
┌────────────────────────────────────┼────────────────────────────────────┐
│                        API GATEWAY LAYER                                │
│                                                                         │
│              ┌──────────────────────────────────┐                      │
│              │   Cloudflare Worker (API Gateway) │                      │
│              │   api.gds.edu.vn/*                │                      │
│              │                                   │                      │
│              │  • JWT validation                 │                      │
│              │  • Rate limiting (KV store)        │                      │
│              │  • Request routing                 │                      │
│              │  • Idempotency-Key deduplication   │                      │
│              │  • CORS enforcement                │                      │
│              └────────────┬─────────────────────┘                      │
│                           │                                             │
└───────────────────────────┼─────────────────────────────────────────────┘
                            │
┌───────────────────────────┼─────────────────────────────────────────────┐
│                    MICROSERVICES LAYER                                  │
│                                                                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐  │
│  │  Auth       │  │  Course     │  │  Assessment │  │  Analytics   │  │
│  │  Service    │  │  Service    │  │  Service    │  │  Service     │  │
│  │             │  │             │  │             │  │              │  │
│  │ JWT issue   │  │ CRUD course │  │ Quizzes     │  │ xAPI events  │  │
│  │ Refresh     │  │ Module DAG  │  │ Submissions │  │ Real-time WS │  │
│  │ RBAC        │  │ Enrollment  │  │ Auto-grade  │  │ Alerts       │  │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬───────┘  │
│         │                │                 │                │          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐  │
│  │  Content    │  │  AI Agents  │  │  Notif.     │  │  O2O/Sync    │  │
│  │  Service    │  │  Orchestr.  │  │  Service    │  │  Service     │  │
│  │             │  │             │  │             │  │              │  │
│  │ Lessons     │  │ Multi-agent │  │ WebSocket   │  │ QR check-in  │  │
│  │ Rubrics     │  │ routing     │  │ Push/Email  │  │ Offline sync │  │
│  │ Media       │  │ Claude API  │  │ Annotation  │  │ Attendance   │  │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬───────┘  │
│         │                │                 │                │          │
└─────────┼────────────────┼─────────────────┼────────────────┼──────────┘
          │                │                 │                │
┌─────────┼────────────────┼─────────────────┼────────────────┼──────────┐
│                       PERSISTENCE LAYER (Polyglot)                     │
│                                                                         │
│  ┌──────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  │
│  │   NocoDB     │  │   Neo4j     │  │   Redis     │  │  Cloudflare │  │
│  │  (MySQL)     │  │  Aura Free  │  │  (Upstash)  │  │     KV      │  │
│  │              │  │             │  │             │  │             │  │
│  │ Users        │  │ Knowledge   │  │ Session     │  │ Rate limits │  │
│  │ Courses      │  │ Graph DAG   │  │ Cache       │  │ Idempotency │  │
│  │ Submissions  │  │ Skill Trees │  │ Real-time   │  │ Config      │  │
│  │ Analytics    │  │ Learning    │  │ Leaderboard │  │             │  │
│  │ Assessments  │  │ Paths       │  │             │  │             │  │
│  └──────────────┘  └─────────────┘  └─────────────┘  └─────────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.2 AI Agent Orchestration Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    AI AGENT ORCHESTRATOR                        │
│              (Cloudflare Worker + Claude API)                   │
│                                                                 │
│  ┌────────────────────────────────────────────────────────┐    │
│  │                   Router / Dispatcher                  │    │
│  │    Intent Detection → Agent Selection → Context Load   │    │
│  └──────────────────────────┬─────────────────────────────┘    │
│                             │                                   │
│    ┌────────────┬───────────┼───────────┬────────────┐         │
│    ▼            ▼           ▼           ▼            ▼         │
│ ┌──────┐  ┌──────────┐ ┌────────┐ ┌─────────┐ ┌─────────┐    │
│ │Curr. │  │Assess.   │ │Coach.  │ │Analytics│ │Content  │    │
│ │Agent │  │Agent     │ │Agent   │ │Agent    │ │Agent    │    │
│ └──┬───┘  └────┬─────┘ └───┬────┘ └────┬────┘ └────┬────┘    │
│    │           │            │           │           │          │
│    └───────────┴────────────┴───────────┴───────────┘          │
│                             │                                   │
│                    ┌────────┴─────────┐                        │
│                    │  Shared Context  │                        │
│                    │  Memory Store    │                        │
│                    │  (Redis/KV)      │                        │
│                    └──────────────────┘                        │
│                                                                 │
│  External: Anthropic Claude API (claude-haiku-4-5)             │
└─────────────────────────────────────────────────────────────────┘
```

### 3.3 Real-time Event Flow (xAPI + WebSocket)

```
Student Action
     │
     ▼
┌─────────────┐     xAPI Event      ┌──────────────┐
│  Frontend   │ ─────────────────── │  Analytics   │
│  (Browser)  │                     │  Service     │
└─────────────┘                     └──────┬───────┘
                                           │
                                   Event Processing
                                           │
                              ┌────────────┴──────────────┐
                              │                           │
                    ┌─────────▼───────┐       ┌──────────▼──────┐
                    │  NocoDB Store   │       │  Analytics Agent│
                    │  (Persist)      │       │  (Analyze)      │
                    └─────────────────┘       └──────────┬──────┘
                                                         │
                                                  Alert Triggered?
                                                         │
                                              ┌──────────▼──────────┐
                                              │  Notification Svc   │
                                              │  WebSocket Push     │
                                              │  → Teacher Dashboard│
                                              └─────────────────────┘
```

### 3.4 O2O (Online-to-Offline) Bridge

```
┌──────────────────────┐          ┌──────────────────────┐
│   ONLINE (LMS)       │          │   OFFLINE (Class)    │
│                      │          │                      │
│  Course Content      │◄────────►│  QR Code Session     │
│  Pre-class assign.   │          │  Attendance Check-in │
│  Video lectures      │          │  In-class Activity   │
│                      │          │  Paper Worksheets    │
└──────────┬───────────┘          └──────────┬───────────┘
           │                                 │
           └──────────┬──────────────────────┘
                      │
                ┌─────▼──────┐
                │  O2O Sync  │
                │  Service   │
                │            │
                │ Merge data │
                │ Build full │
                │ learner    │
                │ profile    │
                └────────────┘
```

---

## 4. AI AGENT SPECIFICATIONS

### 4.1 Agent Architecture Overview

Mỗi AI Agent là một stateless Cloudflare Worker function, nhận context từ shared memory store (Redis/KV) và gọi Claude API. Các agent giao tiếp qua event-driven architecture — không gọi trực tiếp lẫn nhau mà publish/subscribe event thông qua event bus.

```
Agent Base Interface:
  Input:  { userId, courseId, context: AgentContext, trigger: string }
  Output: { action: string, data: any, confidence: float, reasoning: string }
  Tools:  Tool[] (xem từng agent)
  Model:  claude-haiku-4-5 (fast, cost-effective for frequent calls)
```

### 4.2 Curriculum Agent — Xây dựng & Điều chỉnh DAG

**Mục đích:** Xây dựng và liên tục điều chỉnh course DAG (Directed Acyclic Graph) từ yêu cầu của giảng viên và dữ liệu học tập thực tế.

**Trigger events:**
- Giảng viên tạo/cập nhật course
- Student hoàn thành một module node
- Student stuck tại một node quá N phút
- Admin yêu cầu restructure curriculum

**Input Schema:**
```json
{
  "userId": "string",
  "courseId": "string",
  "trigger": "node_completed | node_stuck | instructor_prompt | curriculum_review",
  "context": {
    "currentNode": "string",
    "masteryLevel": 0.0,
    "learningHistory": [],
    "instructorPrompt": "string | null",
    "courseObjectives": []
  }
}
```

**Output Schema:**
```json
{
  "action": "suggest_next_node | restructure_path | add_remediation | unlock_advanced",
  "data": {
    "recommendedPath": ["nodeId1", "nodeId2"],
    "newNodes": [],
    "removedNodes": [],
    "reasoning": "string"
  },
  "confidence": 0.85,
  "requiresApproval": true
}
```

**Tools:**
| Tool | Mô tả |
|------|-------|
| `get_knowledge_graph` | Lấy toàn bộ DAG của course từ Neo4j |
| `get_student_mastery` | Lấy mastery level cho từng skill node |
| `update_dag_edge` | Thêm/xóa edge trong DAG |
| `create_remediation_node` | Tạo node bổ trợ khi student gặp khó khăn |
| `analyze_cohort_patterns` | Phân tích pattern của cả cohort để tối ưu structure |

**System Prompt:**
```
Bạn là Curriculum Agent của AURA LMS. Nhiệm vụ của bạn là phân tích
knowledge graph hiện tại và dữ liệu học tập để đề xuất điều chỉnh cấu
trúc khóa học.

Nguyên tắc:
1. Luôn đề xuất, không tự ý thay đổi — mọi structural change cần instructor approval
2. Ưu tiên learning efficiency: minimize prerequisite gaps, maximize flow state
3. Khi học sinh stuck > 20 phút, tự động đề xuất remediation path
4. Khi 30%+ cohort gặp khó khăn tại một node, đánh dấu node đó cần review
5. Không xóa node đã có submission — chỉ archive và tạo replacement

Luôn kèm reasoning ngắn gọn (tối đa 3 câu) cho mọi đề xuất.
```

### 4.3 Assessment Agent — Tạo Quiz & Chấm Bài Tự Động

**Mục đích:** Tự động sinh câu hỏi từ nội dung bài học, tạo rubric cho essay, và chấm điểm tự động.

**Trigger events:**
- Giảng viên yêu cầu generate quiz
- Student nộp essay/short answer
- Scheduled: tạo practice quiz hàng tuần

**Input Schema:**
```json
{
  "trigger": "generate_quiz | grade_submission | create_rubric",
  "context": {
    "lessonContent": "string (markdown)",
    "learningObjectives": [],
    "questionCount": 5,
    "difficulty": "beginner | intermediate | advanced | adaptive",
    "questionTypes": ["mcq", "true_false", "short_answer", "essay"],
    "submission": {
      "content": "string",
      "rubric": {},
      "maxScore": 100
    }
  }
}
```

**Output Schema — Quiz Generation:**
```json
{
  "questions": [
    {
      "id": "q_001",
      "type": "mcq",
      "content": "string",
      "options": ["A", "B", "C", "D"],
      "correctAnswer": "A",
      "explanation": "string",
      "bloomLevel": "remember | understand | apply | analyze | evaluate | create",
      "difficulty": 0.6,
      "tags": ["concept_name"]
    }
  ],
  "estimatedTime": 15,
  "totalPoints": 50
}
```

**Output Schema — Essay Grading:**
```json
{
  "score": 78,
  "maxScore": 100,
  "rubricScores": {
    "content_accuracy": { "score": 20, "max": 25, "feedback": "string" },
    "critical_thinking": { "score": 18, "max": 25, "feedback": "string" },
    "clarity": { "score": 22, "max": 25, "feedback": "string" },
    "evidence": { "score": 18, "max": 25, "feedback": "string" }
  },
  "overallFeedback": "string",
  "strengthAreas": [],
  "improvementAreas": [],
  "requiresHumanReview": false
}
```

**Tools:**
| Tool | Mô tả |
|------|-------|
| `parse_lesson_content` | Trích xuất key concepts từ nội dung bài học |
| `get_rubric_registry` | Lấy rubric từ Rubric Registry |
| `check_question_bank` | Kiểm tra trùng lặp với Question Bank hiện có |
| `save_to_question_bank` | Lưu câu hỏi mới vào bank |
| `submit_grade` | Ghi điểm vào gradebook với audit trail |

**Guardrail:** Essay với điểm < 50 hoặc > 95 sẽ tự động flag `requiresHumanReview: true`. Điểm do AI không thay thế điểm giảng viên mà là điểm gợi ý.

### 4.4 Coaching Agent — Socratic AI Tutor

**Mục đích:** Hướng dẫn học sinh theo phương pháp Socratic — không bao giờ đưa ra đáp án trực tiếp, chỉ đặt câu hỏi dẫn dắt.

**Nguyên tắc Socratic:**
1. Khi học sinh hỏi "đáp án là gì?" → Hỏi lại "Em đã thử cách nào rồi?"
2. Khi học sinh stuck → Chia nhỏ vấn đề thành bước nhỏ hơn
3. Khi học sinh sai → Không nói sai ngay, hỏi "Em có thể giải thích tại sao em chọn cách này không?"
4. Khi học sinh đúng → Củng cố bằng câu hỏi mở rộng

**Input Schema:**
```json
{
  "sessionId": "string",
  "userId": "string",
  "message": "string",
  "context": {
    "currentLesson": { "id": "string", "title": "string", "content": "string" },
    "currentExercise": {},
    "conversationHistory": [],
    "attemptCount": 2,
    "timeOnTask": 840,
    "knownMisconceptions": []
  }
}
```

**Output Schema:**
```json
{
  "response": "string",
  "responseType": "question | hint | encouragement | clarification",
  "hintLevel": 1,
  "suggestedNextStep": "string | null",
  "detectMisconception": "string | null",
  "escalateToInstructor": false,
  "sessionInsight": {
    "engagementLevel": "low | medium | high",
    "understandingSignal": 0.7,
    "frustrationSignal": 0.2
  }
}
```

**Tools:**
| Tool | Mô tả |
|------|-------|
| `get_lesson_context` | Lấy full context bài học đang học |
| `get_hint_library` | Lấy gợi ý được chuẩn bị sẵn cho concept |
| `log_misconception` | Ghi nhận misconception để Analytics Agent theo dõi |
| `check_time_on_task` | Kiểm tra thời gian học để điều chỉnh response |
| `escalate_to_instructor` | Tạo alert cho giảng viên khi học sinh cần hỗ trợ |

**System Prompt:**
```
Bạn là Coaching Agent của AURA LMS — một gia sư AI theo phong cách Socratic.

QUY TẮC TUYỆT ĐỐI:
1. KHÔNG BAO GIỜ đưa ra đáp án trực tiếp, dù học sinh yêu cầu rõ ràng
2. KHÔNG BAO GIỜ nói "đáp án là..." hay "kết quả là..."
3. Luôn trả lời bằng câu hỏi dẫn dắt hoặc gợi ý từng bước nhỏ
4. Nếu học sinh frustrated (đã hỏi > 3 lần cùng chủ đề), cung cấp hint rõ ràng hơn
   nhưng vẫn không cho đáp án — hướng học sinh đến process, không phải result
5. Ngôn ngữ: Thân thiện, khuyến khích, không phán xét

PHÁT HIỆN FRUSTRATION: Nếu học sinh dùng từ "không hiểu gì hết", "bỏ cuộc",
"vô dụng" → tăng empathy, giảm socratic depth, escalate nếu cần.

Response luôn < 150 từ. Kết thúc bằng một câu hỏi.
```

**Zero-draft Mode:** Khi học sinh bắt đầu bài viết, Coaching Agent không gợi ý nội dung — chỉ hỗ trợ về structure, argument clarity. Mục tiêu: bài nộp là 100% của học sinh.

### 4.5 Analytics Agent — Real-time Instructor Radar

**Mục đích:** Liên tục phân tích xAPI event stream, phát hiện pattern nguy hiểm và trigger instructor alerts.

**Trigger events:**
- xAPI event mới (real-time, < 2 giây)
- Scheduled digest (mỗi 4 giờ)
- Instructor yêu cầu cohort report

**Alert Types:**
| Alert | Điều kiện | Priority |
|-------|-----------|---------|
| `at_risk_dropout` | Không hoạt động > 7 ngày trong course active | HIGH |
| `stuck_on_concept` | Thời gian trên một node > 2x trung bình cohort | MEDIUM |
| `rapid_clicking` | Click qua quiz < 30 giây/câu | HIGH (cheating signal) |
| `score_drop` | Điểm giảm 20%+ qua 3 bài liên tiếp | MEDIUM |
| `high_performer` | Điểm trung bình > 90%, hoàn thành sớm | LOW (stretch content) |
| `engagement_spike` | Học sinh inactive đột ngột active nhiều | INFO |

**Input Schema:**
```json
{
  "trigger": "xapi_event | scheduled_digest | instructor_query",
  "event": {
    "actor": { "userId": "string" },
    "verb": "completed | attempted | experienced | passed | failed",
    "object": { "type": "lesson | quiz | video", "id": "string" },
    "result": { "score": 0.8, "duration": 1200, "completion": true },
    "timestamp": "ISO8601"
  },
  "query": "string | null"
}
```

**Output Schema:**
```json
{
  "alerts": [
    {
      "type": "at_risk_dropout",
      "userId": "string",
      "userName": "string",
      "severity": "high | medium | low",
      "message": "Học sinh Nguyễn Văn A không hoạt động 8 ngày",
      "suggestedAction": "Gửi nhắc nhở cá nhân",
      "dataPoints": {}
    }
  ],
  "cohortInsights": {
    "avgEngagement": 0.72,
    "atRiskCount": 3,
    "topPerformers": [],
    "conceptStruggle": ["Chương 3 - Bài 2"]
  }
}
```

**Tools:**
| Tool | Mô tả |
|------|-------|
| `query_xapi_events` | Query event store với time range và filters |
| `compute_engagement_score` | Tính engagement score từ behavioral signals |
| `get_cohort_benchmark` | Lấy benchmark của cohort để so sánh cá nhân |
| `send_alert` | Gửi alert qua WebSocket đến instructor dashboard |
| `send_email_notification` | Gửi email digest qua Resend API |

### 4.6 Content Agent — Hỗ Trợ Tạo Nội Dung

**Mục đích:** Giúp giảng viên tạo và cải thiện nội dung khóa học — slide deck, lesson text, video script, practice exercises.

**Trigger events:**
- Giảng viên mở Content Editor
- Giảng viên request "improve this section"
- Scheduled: weekly content quality scan

**Input Schema:**
```json
{
  "trigger": "create | improve | review | generate_exercise",
  "context": {
    "existingContent": "string | null",
    "targetAudience": "beginner | intermediate | advanced",
    "learningObjective": "string",
    "contentType": "lesson | video_script | slide | exercise | rubric",
    "subjectArea": "string",
    "languageStyle": "formal | conversational",
    "lengthTarget": "short | medium | long"
  }
}
```

**Output Schema:**
```json
{
  "content": "string (markdown)",
  "suggestions": [
    {
      "type": "clarity | engagement | coverage | structure",
      "location": "paragraph 2",
      "original": "string",
      "suggested": "string",
      "reasoning": "string"
    }
  ],
  "readabilityScore": 72,
  "estimatedReadTime": 8,
  "keywords": [],
  "relatedResources": []
}
```

**Tools:**
| Tool | Mô tả |
|------|-------|
| `check_curriculum_alignment` | Kiểm tra nội dung có align với learning objectives không |
| `suggest_media` | Gợi ý hình ảnh, video, diagram phù hợp |
| `check_accessibility` | Kiểm tra readability score, alt text, heading structure |
| `generate_exercises` | Tạo bài tập thực hành từ concept |
| `search_existing_content` | Tìm nội dung tương tự đã có trong hệ thống |

---

## 5. DATA MODELS & SCHEMAS

### 5.1 Core Tables (NocoDB / MySQL)

#### Table: `Users`
```sql
CREATE TABLE Users (
  id            VARCHAR(36) PRIMARY KEY,  -- UUID v4
  name          VARCHAR(255) NOT NULL,
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role          ENUM('student','teacher','admin') DEFAULT 'student',
  status        ENUM('active','inactive','suspended') DEFAULT 'active',
  avatar_url    TEXT,
  phone         VARCHAR(20),
  bio           TEXT,
  locale        VARCHAR(10) DEFAULT 'vi',
  timezone      VARCHAR(50) DEFAULT 'Asia/Ho_Chi_Minh',
  last_seen_at  DATETIME,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

#### Table: `Courses`
```sql
CREATE TABLE Courses (
  id              VARCHAR(36) PRIMARY KEY,
  title           VARCHAR(500) NOT NULL,
  slug            VARCHAR(255) UNIQUE,
  description     TEXT,
  instructor_id   VARCHAR(36) REFERENCES Users(id),
  status          ENUM('draft','active','archived','restored') DEFAULT 'draft',
  visibility      ENUM('public','private','invite_only') DEFAULT 'private',
  cover_image     TEXT,
  objectives      JSON,         -- learning objectives array
  tags            JSON,
  start_date      DATE,
  end_date        DATE,
  estimated_hours INT,
  language        VARCHAR(10) DEFAULT 'vi',
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  archived_at     DATETIME      -- soft archive timestamp
);
```

#### Table: `Modules`
```sql
CREATE TABLE Modules (
  id          VARCHAR(36) PRIMARY KEY,
  course_id   VARCHAR(36) REFERENCES Courses(id),
  title       VARCHAR(500) NOT NULL,
  description TEXT,
  position    INT NOT NULL DEFAULT 0,
  unlock_at   DATETIME,
  require_sequential BOOLEAN DEFAULT FALSE,
  status      ENUM('active','locked','completed') DEFAULT 'active',
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

#### Table: `Lessons` (Articles)
```sql
CREATE TABLE Lessons (
  id           VARCHAR(36) PRIMARY KEY,
  module_id    VARCHAR(36) REFERENCES Modules(id),
  course_id    VARCHAR(36) REFERENCES Courses(id),
  title        VARCHAR(500) NOT NULL,
  path         VARCHAR(255),
  content      LONGTEXT,
  content_type ENUM('text','video','interactive','external') DEFAULT 'text',
  access       ENUM('public','private') DEFAULT 'private',
  position     INT DEFAULT 0,
  est_minutes  INT DEFAULT 10,
  xp_reward    INT DEFAULT 10,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

#### Table: `Enrollments`
```sql
CREATE TABLE Enrollments (
  id             VARCHAR(36) PRIMARY KEY,
  user_id        VARCHAR(36) REFERENCES Users(id),
  course_id      VARCHAR(36) REFERENCES Courses(id),
  role           ENUM('student','ta','observer') DEFAULT 'student',
  status         ENUM('active','completed','dropped','invited') DEFAULT 'active',
  progress_pct   FLOAT DEFAULT 0.0,
  last_active_at DATETIME,
  enrolled_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at   DATETIME,
  UNIQUE KEY uq_user_course (user_id, course_id)
);
```

#### Table: `Assessments`
```sql
CREATE TABLE Assessments (
  id               VARCHAR(36) PRIMARY KEY,
  course_id        VARCHAR(36) REFERENCES Courses(id),
  module_id        VARCHAR(36) REFERENCES Modules(id),
  title            VARCHAR(500) NOT NULL,
  type             ENUM('quiz','survey','exam','assignment') NOT NULL,
  instructions     TEXT,
  time_limit_mins  INT,
  max_attempts     INT DEFAULT 1,
  passing_score    FLOAT DEFAULT 0.6,
  shuffle_questions BOOLEAN DEFAULT FALSE,
  show_feedback    ENUM('immediately','after_due','never') DEFAULT 'immediately',
  due_date         DATETIME,
  available_from   DATETIME,
  available_until  DATETIME,
  ai_generated     BOOLEAN DEFAULT FALSE,
  status           ENUM('draft','published','closed') DEFAULT 'draft',
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

#### Table: `Questions` (Question Bank)
```sql
CREATE TABLE Questions (
  id           VARCHAR(36) PRIMARY KEY,
  bank_id      VARCHAR(36),              -- logical grouping
  course_id    VARCHAR(36) REFERENCES Courses(id),
  content      TEXT NOT NULL,
  type         ENUM('mcq','true_false','short_answer','essay','matching','ordering'),
  options      JSON,                     -- for MCQ
  correct_answer JSON,
  explanation  TEXT,
  rubric_id    VARCHAR(36),              -- for essay questions
  bloom_level  ENUM('remember','understand','apply','analyze','evaluate','create'),
  difficulty   FLOAT DEFAULT 0.5,       -- 0.0 = easy, 1.0 = very hard
  tags         JSON,
  ai_generated BOOLEAN DEFAULT FALSE,
  times_used   INT DEFAULT 0,
  avg_score    FLOAT,
  created_by   VARCHAR(36) REFERENCES Users(id),
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

#### Table: `Submissions`
```sql
CREATE TABLE Submissions (
  id              VARCHAR(36) PRIMARY KEY,
  assessment_id   VARCHAR(36) REFERENCES Assessments(id),
  user_id         VARCHAR(36) REFERENCES Users(id),
  attempt_number  INT DEFAULT 1,
  status          ENUM('in_progress','submitted','graded','returned') DEFAULT 'in_progress',
  score           FLOAT,
  max_score       FLOAT,
  time_spent_secs INT,
  submitted_at    DATETIME,
  graded_at       DATETIME,
  graded_by       VARCHAR(36),     -- userId or 'ai_agent'
  ai_score        FLOAT,           -- AI suggested score
  ai_feedback     TEXT,
  instructor_score FLOAT,          -- final score (overrides AI)
  instructor_feedback TEXT,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

#### Table: `Rubrics`
```sql
CREATE TABLE Rubrics (
  id          VARCHAR(36) PRIMARY KEY,
  title       VARCHAR(500) NOT NULL,
  course_id   VARCHAR(36),             -- null = global rubric
  criteria    JSON NOT NULL,           -- array of {name, description, levels[]}
  max_score   FLOAT NOT NULL,
  version     INT DEFAULT 1,
  is_master   BOOLEAN DEFAULT TRUE,    -- master = linked, not copied
  created_by  VARCHAR(36) REFERENCES Users(id),
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
-- Questions reference rubrics by ID, never copy
```

#### Table: `xapi_Events`
```sql
CREATE TABLE xapi_Events (
  id          VARCHAR(36) PRIMARY KEY,
  actor_id    VARCHAR(36) REFERENCES Users(id),
  verb        VARCHAR(100) NOT NULL,   -- xAPI verb IRI
  object_type VARCHAR(50),
  object_id   VARCHAR(36),
  context_id  VARCHAR(36),            -- course or module
  result_score FLOAT,
  result_completion BOOLEAN,
  result_duration INT,                -- seconds
  extensions  JSON,                   -- custom data (scroll_depth, focus_time, etc.)
  timestamp   DATETIME NOT NULL,
  INDEX idx_actor (actor_id),
  INDEX idx_object (object_id),
  INDEX idx_timestamp (timestamp)
);
```

#### Table: `Annotations`
```sql
CREATE TABLE Annotations (
  id           VARCHAR(36) PRIMARY KEY,
  submission_id VARCHAR(36) REFERENCES Submissions(id),
  author_id    VARCHAR(36) REFERENCES Users(id),
  target_type  ENUM('text_range','paragraph','whole') DEFAULT 'text_range',
  target_data  JSON,                  -- {start, end, selectedText}
  content      TEXT NOT NULL,
  type         ENUM('comment','suggestion','correction','praise') DEFAULT 'comment',
  resolved     BOOLEAN DEFAULT FALSE,
  notified     BOOLEAN DEFAULT FALSE, -- fix: annotations now trigger notifications
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

#### Table: `AuditLog`
```sql
CREATE TABLE AuditLog (
  id         VARCHAR(36) PRIMARY KEY,
  user_id    VARCHAR(36),
  action     VARCHAR(100) NOT NULL,
  resource   VARCHAR(100),
  resource_id VARCHAR(36),
  old_value  JSON,
  new_value  JSON,
  ip_address VARCHAR(45),
  user_agent TEXT,
  timestamp  DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user (user_id),
  INDEX idx_resource (resource, resource_id)
);
```

### 5.2 Graph Schema (Neo4j Aura)

#### Knowledge Graph Nodes

```cypher
// Skill Node — đơn vị kiến thức
CREATE (:Skill {
  id: "skill_001",
  title: "Phương trình bậc 2",
  description: "string",
  courseId: "course_001",
  estimatedMinutes: 45,
  masteryThreshold: 0.75,   // score cần đạt để mastered
  xpReward: 50
})

// Module Node — nhóm skills
CREATE (:Module {
  id: "mod_001",
  title: "Đại số cơ bản",
  courseId: "course_001"
})

// Assessment Node — gắn với skill
CREATE (:Assessment {
  id: "assess_001",
  title: "Quiz Phương trình bậc 2",
  skillId: "skill_001"
})
```

#### Knowledge Graph Relationships

```cypher
// REQUIRES: prerequisite relationship
(:Skill {id: "skill_002"})-[:REQUIRES {strength: 1.0}]->(:Skill {id: "skill_001"})

// PART_OF: skill belongs to module
(:Skill {id: "skill_001"})-[:PART_OF]->(:Module {id: "mod_001"})

// HAS_ASSESSMENT: skill has assessment
(:Skill {id: "skill_001"})-[:HAS_ASSESSMENT]->(:Assessment {id: "assess_001"})

// MASTERED_BY: student mastery record
(:Student {id: "user_001"})-[:MASTERED_BY {
  masteryLevel: 0.82,
  lastAttempt: "2026-04-01",
  attemptCount: 3
}]->(:Skill {id: "skill_001"})

// RECOMMENDED_NEXT: AI-generated recommendation
(:Student {id: "user_001"})-[:RECOMMENDED_NEXT {
  confidence: 0.9,
  reason: "prerequisites met",
  generatedAt: "2026-04-04"
}]->(:Skill {id: "skill_003"})
```

### 5.3 Cache Schema (Redis / Upstash)

```
# Session token
session:{userId}           → { token, role, courseIds[], expiresAt }  TTL: 24h

# Real-time engagement
engagement:{courseId}:{userId}  → { lastSeen, currentLesson, score, streak }  TTL: 1h

# Agent context memory
agent_ctx:{sessionId}      → { history[], lessonCtx, misconceptions[] }  TTL: 4h

# Leaderboard (Sorted Set)
leaderboard:{courseId}     → ZADD userId score  TTL: 7d

# Rate limiting
ratelimit:{ip}:{endpoint}  → counter  TTL: 1min

# Notification queue
notif_queue:{userId}       → List of pending notifications  TTL: 48h
```

---

## 6. API CONTRACTS

### 6.1 Authentication API

```
POST /auth/login
Body: { email, password }
Response: { token, refreshToken, user: { id, name, role } }

POST /auth/refresh
Body: { refreshToken }
Response: { token }

POST /auth/logout
Headers: Authorization: Bearer {token}
Response: { success: true }

POST /auth/forgot-password
Body: { email }
Response: { message: "Email sent" }

POST /auth/reset-password
Body: { token, newPassword }
Response: { success: true }
```

### 6.2 Course API

```
GET    /courses                   → List courses (paginated, filterable)
POST   /courses                   → Create course
GET    /courses/:id               → Get course detail
PUT    /courses/:id               → Update course
DELETE /courses/:id               → Soft-delete (archive)
POST   /courses/:id/restore       → Restore archived course
POST   /courses/:id/enroll        → Enroll student
GET    /courses/:id/students      → List enrolled students

GET    /courses/:id/dag           → Get knowledge graph
POST   /courses/:id/dag/nodes     → Add skill node
PUT    /courses/:id/dag/nodes/:nodeId → Update skill node
POST   /courses/:id/dag/edges     → Add edge (prerequisite)
DELETE /courses/:id/dag/edges/:edgeId → Remove edge
```

### 6.3 Assessment API

```
GET    /assessments/:id           → Get assessment detail
POST   /assessments               → Create assessment
PUT    /assessments/:id           → Update assessment
POST   /assessments/:id/generate  → AI-generate questions
POST   /assessments/:id/publish   → Publish assessment

POST   /submissions               → Start submission (attempt)
GET    /submissions/:id           → Get submission
PUT    /submissions/:id           → Save in-progress answers
POST   /submissions/:id/submit    → Submit for grading
GET    /submissions/:id/feedback  → Get graded feedback

GET    /question-bank             → List questions (filterable)
POST   /question-bank             → Add question
PUT    /question-bank/:id         → Update question
DELETE /question-bank/:id         → Delete question

GET    /rubrics                   → List rubrics (registry)
POST   /rubrics                   → Create master rubric
PUT    /rubrics/:id               → Update master rubric (propagates to all linked)
```

### 6.4 AI Agent API

```
POST /ai/curriculum/suggest-path
Body: { userId, courseId, currentNodeId }
Response: { recommendedPath, reasoning, confidence }

POST /ai/assessment/generate-quiz
Body: { lessonId, count, difficulty, types }
Response: { questions[], estimatedTime }

POST /ai/assessment/grade-essay
Body: { submissionId, rubricId }
Response: { score, rubricScores, feedback, requiresHumanReview }

POST /ai/coaching/chat
Body: { sessionId, userId, message, context }
Response: { response, responseType, hintLevel, sessionInsight }

GET  /ai/analytics/alerts/:courseId
Response: { alerts[], cohortInsights }

POST /ai/content/improve
Body: { content, learningObjective, contentType }
Response: { improved, suggestions[], readabilityScore }
```

### 6.5 Analytics & xAPI API

```
POST /xapi/statements            → Submit xAPI statement
GET  /xapi/statements            → Query statements (filters: actor, verb, object, time)

GET  /analytics/course/:courseId/overview → Cohort overview
GET  /analytics/course/:courseId/at-risk  → At-risk students
GET  /analytics/student/:userId   → Individual student analytics
GET  /analytics/lesson/:lessonId  → Lesson engagement stats

WS   /ws/instructor/:courseId     → Real-time instructor radar feed
WS   /ws/student/:userId          → Student notification stream
```

### 6.6 O2O / Offline API

```
POST /o2o/sessions                → Create offline class session
POST /o2o/sessions/:id/qr         → Generate QR for attendance
POST /o2o/sessions/:id/checkin    → QR check-in endpoint
GET  /o2o/sessions/:id/attendance → Attendance report

POST /sync/offline-progress       → Sync offline progress from PWA
Body: { userId, events: xAPIEvent[], timestamp }
Response: { merged, conflicts[] }
```

### 6.7 Notification API

```
GET    /notifications             → List user notifications
PUT    /notifications/:id/read    → Mark as read
DELETE /notifications/:id         → Dismiss notification
POST   /notifications/subscribe   → Subscribe to push notifications
```

### 6.8 API Response Format (Standard)

```json
// Success
{
  "success": true,
  "data": {},
  "meta": {
    "page": 1,
    "total": 100,
    "limit": 20
  }
}

// Error
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Email đã được sử dụng",
    "details": {}
  }
}
```

**HTTP Status Codes:**
| Code | Tình huống |
|------|-----------|
| 200 | Thành công |
| 201 | Tạo mới thành công |
| 400 | Request không hợp lệ |
| 401 | Chưa xác thực |
| 403 | Không có quyền |
| 404 | Không tìm thấy |
| 409 | Conflict (duplicate) |
| 422 | Validation error |
| 429 | Rate limit exceeded |
| 500 | Server error |

---

## 7. IMPLEMENTATION ROADMAP

### Phase 1 — Foundation & Core LMS (Tháng 1-3)

**Mục tiêu:** Nâng cấp ActiveEdu v2.0 thành full-featured LMS, fix 10 Canvas weaknesses cơ bản.

**Sprint 1 (Tuần 1-2): Auth & Data Model**
- [ ] Migrate schema sang chuẩn mới (UUID, timestamps, soft-delete)
- [ ] JWT refresh token + secure httpOnly cookies
- [ ] RBAC middleware (student / teacher / admin)
- [ ] Password reset via Resend API
- [ ] AuditLog cho tất cả write operations

**Sprint 2 (Tuần 3-4): Course & Module**
- [ ] Course CRUD với state machine (draft → active → archived → restored)
- [ ] Module builder với sequential unlock
- [ ] Enrollment management
- [ ] Course visibility (public / private / invite-only)
- [ ] Rubric Registry (centralized, không copy)

**Sprint 3 (Tuần 5-6): Assessment**
- [ ] Question Bank module
- [ ] Quiz builder (MCQ, True/False, Short Answer)
- [ ] Submission engine với attempt tracking
- [ ] Auto-grade MCQ và True/False
- [ ] Gradebook real-time update

**Sprint 4 (Tuần 7-8): Notifications & Annotations**
- [ ] WebSocket server (Cloudflare Durable Objects)
- [ ] Annotation system với event bus → notifications
- [ ] In-app notification center
- [ ] Email digest via Resend

**Sprint 5 (Tuần 9-10): xAPI & Basic Analytics**
- [ ] xAPI statement capture frontend
- [ ] xAPI API endpoint
- [ ] Basic engagement dashboard cho instructor
- [ ] Behavioral events: scroll depth, video pause, time-on-task

**Sprint 6 (Tuần 11-12): PWA & O2O Foundation**
- [ ] Service Worker cho offline caching
- [ ] Offline progress queue (sync khi có mạng)
- [ ] QR check-in cho O2O attendance
- [ ] Collaboration Hub (Google Docs + iframe với context sharing)

**Phase 1 Deliverables:**
- Full LMS thay thế Canvas cho use case cơ bản
- Fix tất cả 10 Canvas weaknesses
- xAPI events flowing
- WebSocket notifications hoạt động

### Phase 2 — AI Integration & Adaptive Learning (Tháng 4-6)

**Mục tiêu:** Tích hợp AI Agents và bắt đầu adaptive learning.

**Sprint 7-8: AI Agent Infrastructure**
- [ ] Agent Orchestrator (Cloudflare Worker)
- [ ] Shared context memory (Redis/Upstash)
- [ ] Claude API integration với error handling & fallback
- [ ] Agent rate limiting và cost monitoring
- [ ] Coaching Agent v1 (basic Socratic chat)

**Sprint 9-10: Assessment Agent**
- [ ] Auto-generate quiz từ lesson content
- [ ] Essay auto-grading với rubric
- [ ] Human-review flag workflow
- [ ] Question Bank AI tagging (Bloom's level, difficulty)

**Sprint 11-12: Analytics Agent & Radar**
- [ ] Real-time alert engine
- [ ] At-risk student detection (7 điều kiện)
- [ ] Instructor Radar dashboard (WebSocket)
- [ ] Predictive engagement score
- [ ] Email alerts via Resend

**Sprint 13-14: Knowledge Graph (Neo4j)**
- [ ] Setup Neo4j Aura Free
- [ ] Migrate course structure sang Knowledge Graph
- [ ] DAG editor UI cho instructor
- [ ] Basic path recommendation (prerequisite-based)
- [ ] Mastery tracking per skill node

**Sprint 15-16: Curriculum Agent & Content Agent**
- [ ] Curriculum Agent: suggest adaptive paths
- [ ] Auto-remediation path khi student stuck
- [ ] Content Agent: basic content improvement suggestions
- [ ] Zero-draft enforcement in essay assignments

**Phase 2 Deliverables:**
- 5 AI Agents hoạt động
- Knowledge Graph với adaptive routing
- Instructor Radar real-time
- AI-assisted grading

### Phase 3 — Advanced Adaptive & Scale (Tháng 7-12)

**Mục tiêu:** Fully adaptive learning, scale to production, advanced analytics.

**Sprint 17-20: Advanced Adaptive Learning**
- [ ] Spaced repetition engine (SM-2 algorithm)
- [ ] Skill tree visualization (student view)
- [ ] Adaptive assessment (difficulty điều chỉnh real-time)
- [ ] Personalized learning path per student
- [ ] Cohort-based curriculum optimization

**Sprint 21-24: Advanced AI Capabilities**
- [ ] Coaching Agent v2: multi-turn Socratic dialogue với memory
- [ ] Content Agent: full lesson generation từ outline
- [ ] Multi-language support (vi / en)
- [ ] AI confidence scoring và explainability
- [ ] Teacher AI copilot (bulk operations, course design assistant)

**Sprint 25-28: O2O Advanced & Integrations**
- [ ] Full offline mode (60% content available offline)
- [ ] O2O sync với conflict resolution
- [ ] Figma, Miro, GitHub Codespaces integration
- [ ] LTI 1.3 compatibility layer
- [ ] SCORM/xAPI content import

**Sprint 29-32: Scale & Production Hardening**
- [ ] Performance optimization (< 800ms TTFL)
- [ ] Database sharding strategy
- [ ] CDN setup cho media content
- [ ] Chaos engineering & load testing
- [ ] GDPR/compliance review
- [ ] Production monitoring (Sentry, Datadog)

**Phase 3 Deliverables:**
- Fully adaptive LMS
- Production-ready at 10,000+ concurrent users
- Full O2O integration
- Advanced analytics với predictive modeling

---

## 8. TECH STACK DECISIONS

### 8.1 Current Stack (Giữ nguyên & Tối ưu)

| Component | Technology | Lý do giữ |
|-----------|-----------|-----------|
| Frontend Hosting | GitHub Pages | Zero cost, global CDN, đủ cho static assets |
| API Gateway | Cloudflare Workers | Edge computing, global PoP, built-in KV, Durable Objects |
| Primary Database | NocoDB (MySQL) | Existing data, REST API sẵn, admin UI cho non-dev |
| Auth | JWT (HS256) | Stateless, compatible với edge workers |
| Email | Resend API | Đã tích hợp, developer-friendly |

### 8.2 New Additions (Phase 1-2)

| Component | Technology | Lý do chọn |
|-----------|-----------|-----------|
| Graph Database | Neo4j Aura Free | Knowledge graph, Cypher query, free tier đủ cho prototype |
| Cache / Real-time | Upstash Redis | Serverless Redis, compatible với Cloudflare Workers, free tier |
| WebSocket | Cloudflare Durable Objects | Native với Workers, persistent connections, no extra infra |
| AI Model | Anthropic Claude Haiku | Fast (< 1s), cheap ($0.25/MTok), sufficient cho agent tasks |
| Offline Sync | Service Worker + IndexedDB | Browser-native, no extra service needed |
| Monitoring | Cloudflare Analytics + Sentry | Free tier đủ dùng, Workers integration sẵn có |

### 8.3 Rejected Alternatives & Lý do

| Alternative | Tại sao không chọn |
|-------------|-------------------|
| AWS Lambda | Cold start > 1s, phức tạp config hơn Cloudflare Workers |
| Firebase Firestore | Vendor lock-in, cost unpredictable khi scale |
| Supabase | Tốt hơn NocoDB nhưng migration cost cao, không cần thiết ở phase 1 |
| OpenAI GPT-4 | Đắt hơn 10x so với Claude Haiku, không cần GPT-4 level cho agent tasks |
| Kafka (managed) | Overkill ở phase 1-2, Cloudflare Queues đủ dùng |
| Kubernetes | Không có backend server để orchestrate, Workers là serverless |

### 8.4 Tech Stack Decision Matrix

```
Tiêu chí đánh giá: Cost / Performance / DevEx / Scalability / Existing fit

NocoDB MySQL:      ★★★★☆ / ★★★☆☆ / ★★★★☆ / ★★★☆☆ / ★★★★★
Neo4j Aura:        ★★★★☆ / ★★★★★ / ★★★★☆ / ★★★★☆ / ★★★☆☆
Upstash Redis:     ★★★★★ / ★★★★★ / ★★★★★ / ★★★★☆ / ★★★★☆
Cloudflare Workers: ★★★★★ / ★★★★★ / ★★★★☆ / ★★★★★ / ★★★★★
Claude Haiku:      ★★★★☆ / ★★★★★ / ★★★★★ / ★★★★☆ / ★★★☆☆
```

### 8.5 Infrastructure Cost Estimate

| Service | Free Tier | Paid (Est. 1000 users) |
|---------|-----------|----------------------|
| GitHub Pages | ✅ Free | ✅ Free |
| Cloudflare Workers | 100k req/day free | ~$5/month |
| NocoDB Cloud | Free (limited) | $15/month |
| Neo4j Aura Free | 200MB free | $65/month (AuraDB Pro) |
| Upstash Redis | 10k cmd/day free | $10/month |
| Resend Email | 3k emails/month | $20/month |
| Anthropic Claude | Pay per use | ~$30-50/month (estimate) |
| **Total** | **$0** | **~$150-200/month** |

---

## 9. SECURITY & PRIVACY DESIGN

### 9.1 Authentication & Authorization

**JWT Security:**
```
Algorithm: HS256 (HMAC-SHA256)
Access Token TTL: 1 giờ
Refresh Token TTL: 30 ngày
Secret: 256-bit random (wrangler secret put TOKEN_SECRET)
Payload: { sub: userId, role, courseIds[], iat, exp }
```

**RBAC Matrix:**
| Resource | student | teacher | admin |
|----------|---------|---------|-------|
| View enrolled courses | ✅ | ✅ | ✅ |
| Create course | ❌ | ✅ | ✅ |
| Delete course | ❌ | Own only | ✅ |
| View own grades | ✅ | N/A | ✅ |
| View all grades | ❌ | Own courses | ✅ |
| Manage users | ❌ | ❌ | ✅ |
| AI agent (coaching) | ✅ | ✅ | ✅ |
| AI agent (generate quiz) | ❌ | ✅ | ✅ |
| xAPI submission | ✅ (own) | ✅ (own) | ✅ |
| View analytics | Own only | Own courses | ✅ |

### 9.2 Data Security

**Sensitive Data Handling:**
```
Passwords: bcrypt hash, cost factor 12, never stored plaintext
PII at rest: NocoDB + MySQL with encryption at rest (InnoDB)
PII in transit: HTTPS/TLS 1.3 enforced by Cloudflare
API Tokens: wrangler secrets (encrypted, never in code)
JWT Secret: wrangler secrets (rotated quarterly)
Student data: FERPA-aligned data handling
```

**Input Validation:**
- Tất cả input qua Worker phải pass JSON schema validation
- Content HTML phải qua DOMPurify sanitization trước khi lưu
- SQL injection: NocoDB REST API parameterized queries
- File upload: type allowlist (image/*, video/*, application/pdf), max 50MB

### 9.3 AI Safety & Guardrails

**Coaching Agent Guardrails:**
```
1. System prompt được hardcode server-side — không nhận system prompt từ user
2. Content filtering: không trả lời nội dung không liên quan đến học tập
3. Jailbreak detection: pattern matching cho prompt injection attempts
4. Output scanning: response phải chứa giáo dục content signal
5. Conversation history giới hạn 20 turns (context window management)
6. PII trong chat: học sinh không được share thông tin cá nhân của người khác
```

**Assessment Agent Guardrails:**
```
1. AI grade chỉ là SUGGESTION — instructor luôn có final say
2. Score outlier detection: score < 50 hoặc > 95 → required human review
3. Audit trail: mọi AI grading action đều ghi vào AuditLog
4. Grade override: instructor có thể override AI score bất kỳ lúc nào
5. Bias detection: monitor AI scoring distribution theo demographics
```

**Cost Control:**
```
1. Per-request token limit: 2000 tokens input, 1000 tokens output
2. Daily budget cap per course: $5 (configurable)
3. Student rate limit: 20 AI requests/hour
4. Circuit breaker: nếu error rate > 20%, fallback sang rule-based responses
```

### 9.4 Privacy Design

**Data Minimization:**
- xAPI events chỉ capture hành vi học tập — không capture device fingerprint, location (ngoài O2O check-in có consent)
- Analytics aggregate trước khi hiển thị cho teacher — không expose raw behavioral data
- AI conversation history: auto-delete sau 90 ngày
- Inactive user data: soft-delete sau 2 năm, hard-delete sau 5 năm

**Consent & Transparency:**
- Học sinh được thông báo rõ về dữ liệu nào được thu thập khi đăng ký
- AI grading: học sinh biết bài của mình được AI chấm (hiển thị badge)
- Data export: học sinh có thể export toàn bộ data của mình (GDPR-aligned)
- AI coaching: chat history thuộc về học sinh, không dùng để train model

**Data Residency:**
- NocoDB tự host → data ở Việt Nam (tuân thủ Nghị định 13/2023/NĐ-CP về PDPD)
- Cloudflare Workers xử lý tại edge node gần nhất, không persist data
- Neo4j Aura: có thể chọn region Asia-Pacific

### 9.5 Rate Limiting Strategy

```
Endpoint tiers:
- Public (no auth):     10 req/min per IP
- Authenticated:        100 req/min per user
- AI endpoints:         20 req/hour per user
- Admin endpoints:      300 req/min per admin
- WebSocket connections: 5 concurrent per user
- xAPI submission:      1000 events/hour per user

Implementation: Cloudflare Workers KV + sliding window algorithm
Response on limit: HTTP 429 + Retry-After header
```

### 9.6 Security Headers

```
Cloudflare Worker phải set headers cho mọi response:

Content-Security-Policy: default-src 'self'; script-src 'self' 'nonce-{random}';
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: geolocation=(), microphone=(), camera=()
```

### 9.7 Incident Response

**Security Incident Tiers:**
| Tier | Định nghĩa | SLA Response |
|------|-----------|-------------|
| P0 Critical | Data breach, auth bypass | 1 giờ |
| P1 High | AI jailbreak, score tampering | 4 giờ |
| P2 Medium | Rate limit bypass, DoS attempt | 24 giờ |
| P3 Low | Anomalous access patterns | 72 giờ |

**Monitoring Alerts (Cloudflare + Sentry):**
- Tỷ lệ lỗi 5xx > 1% → alert ngay
- JWT decode failure spike → possible token forgery attempt
- AI response latency > 5s → circuit breaker check
- Database connection pool exhaustion → scale trigger

---

## APPENDIX A — Glossary

| Thuật ngữ | Định nghĩa |
|-----------|-----------|
| DAG | Directed Acyclic Graph — đồ thị có hướng không có chu trình, dùng để mô hình hóa prerequisite giữa các skill |
| xAPI | Experience API (Tin Can) — chuẩn mở để ghi nhận learning experiences |
| RBAC | Role-Based Access Control |
| O2O | Online-to-Offline — tích hợp giữa học trực tuyến và học trực tiếp |
| Mastery Level | Mức độ thành thạo một skill, đo bằng float 0.0-1.0 |
| Socratic Method | Phương pháp dạy học qua đặt câu hỏi, không cung cấp đáp án trực tiếp |
| Zero-draft | Chế độ bảo vệ tính nguyên bản: AI không gợi ý nội dung cho bài viết |
| LTI | Learning Tools Interoperability — chuẩn tích hợp tool bên thứ ba vào LMS |
| FERPA | Family Educational Rights and Privacy Act — luật bảo vệ dữ liệu học sinh (US) |
| PDPD | Personal Data Protection Decree — Nghị định 13/2023/NĐ-CP (VN) |

---

## APPENDIX B — File Structure Target (Phase 1)

```
active-edu/
├── index.html                    # Student learning app
├── index.css
├── index.js
├── quiz.html                     # Assessment player
├── ARCHITECTURE.md               # This document
├── README.md
│
├── admin/
│   ├── index.html                # Login
│   ├── dashboard.html            # Admin dashboard
│   ├── dashboard.js
│   ├── dashboard.css
│   └── modules/                  # Feature modules
│       ├── courses.js            # Course management
│       ├── modules.js            # Module builder
│       ├── qbank.js              # Question bank
│       ├── assessments.js        # Assessment builder
│       ├── analytics.js          # Radar dashboard
│       ├── rubrics.js            # Rubric registry
│       └── ai-coach-config.js    # AI settings
│
├── worker/
│   ├── index.js                  # Main router
│   ├── wrangler.toml
│   └── src/
│       ├── routes/
│       │   ├── auth.js
│       │   ├── courses.js
│       │   ├── assessments.js
│       │   ├── analytics.js
│       │   ├── ai.js             # AI agent endpoints
│       │   ├── xapi.js
│       │   ├── notifications.js
│       │   └── o2o.js
│       ├── agents/
│       │   ├── orchestrator.js
│       │   ├── curriculum.js
│       │   ├── assessment.js
│       │   ├── coaching.js
│       │   ├── analytics.js
│       │   └── content.js
│       ├── middleware/
│       │   ├── auth.js
│       │   ├── rateLimit.js
│       │   └── validation.js
│       └── lib/
│           ├── noco.js           # NocoDB client
│           ├── neo4j.js          # Neo4j client
│           ├── redis.js          # Upstash client
│           └── claude.js         # Anthropic client
│
└── content/
    └── index.json
```

---

*Document version 1.0.0 — AURA Architecture Specification*
*Được tạo: 2026-04-04 | Cập nhật tiếp theo: Sau Phase 1 Sprint 6*

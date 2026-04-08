# CHƯƠNG 1: GIỚI THIỆU VÀ PHẠM VI — Consolidated v3.1

> **Consolidated từ:** SRS-CH01 v1.0, v2.0, v3.0 + NĐ 13/2023 compliance supplement
> **Ngày:** Tháng 4/2025 · **Trạng thái:** Consolidated v3.1

---

## 1.1 Mục đích tài liệu

Tài liệu này là Software Requirements Specification (SRS) v2.0 cho hệ thống **AdaptLearn** — nền tảng học tập thích nghi tích hợp AI Agent, quản lý học liệu đa định dạng (AURA), ngân hàng đề, đánh giá đa chiều và hệ thống thúc đẩy tự học.

SRS phục vụ đồng thời 7 nhóm đọc giả:

| # | Nhóm | Chức danh | Chương cần đọc | Mục tiêu |
|---|------|----------|----------------|----------|
| 1 | Đội phát triển phần mềm | Backend/Frontend/DevOps | Tất cả — đặc biệt Ch2,4,5,6,7 | Implement đủ không cần hỏi thêm |
| 2 | Chuyên gia sư phạm | GV bộ môn, Tổ trưởng | Ch1,3,7,8 | Thiết kế và phê duyệt nội dung |
| 3 | Ban lãnh đạo nhà trường | Hiệu trưởng, PHT | Ch1,6 (lộ trình, KPIs) | Phê duyệt phạm vi và ngân sách |
| 4 | Project Manager | Trưởng dự án | Ch1,6 toàn bộ | Kế hoạch và quản lý rủi ro |
| 5 | QA Engineer | Test Lead | Ch2,4,5,6,7,8 | Xây test plan và test cases |
| 6 | Chuyên gia đánh giá GD | Psychometrician | Ch8 §8.2, §8.4 | Thiết kế ngân hàng đề chuẩn |
| 7 | NCS Khoa học Dữ liệu GD | Researcher | Ch9, Ch4 §Learner Model | Nghiên cứu EDM trên dữ liệu AdaptLearn |

> **[BỔ SUNG v3.1]** Nhóm 7 (NCS) là mới — tương ứng với Ch9 AI Agent Lab.

---

## 1.2 Phạm vi hệ thống

### 1.2.1 Tầm nhìn sản phẩm

> *"Xây dựng nền tảng học tập thích nghi toàn diện: mỗi học sinh có lộ trình riêng do AI thiết kế, mỗi giáo viên có công cụ xây dựng học liệu và đề kiểm tra chuyên nghiệp, mỗi nhà trường có hệ sinh thái đánh giá dựa trên dữ liệu."*

### 1.2.2 Bản đồ module — 9 Chương SRS

| Ch | Tên module | Nội dung chính | Phase | Trạng thái |
|----|-----------|---------------|-------|------------|
| Ch1 | Giới thiệu & Phạm vi | Mục đích, phạm vi, định nghĩa, stakeholders, giả định, NFR | P0 | ✅ v3.1 |
| Ch2 | Kiến trúc hệ thống | C4 Model, 10 services, DB Schema (22 bảng), Redis, CI/CD, ADR | P0 | ✅ v2.1 |
| Ch3 | Thiết kế bài học | 5 giai đoạn, 8 mô hình, Repair, bài mẫu Toán 8, quy trình GV | P0 | ✅ v2.0 |
| Ch4 | AI Agent | Learner Model 17 fields, 10 luật R01-R10, Feedback Engine 3 mode, Event Pipeline | P0 | ✅ v2.0 |
| Ch5 | API Contract | 15 nhóm API (~95+ endpoints), WebSocket, Grader, 32 error codes, OpenAPI | P0 | ✅ v2.1 |
| Ch6 | Triển khai & Vận hành | 3 Phase, 95 TC, Go-Live, Rollback, Risk Register 18 risks, 36 KPIs | P0 | ✅ v2.1 |
| Ch7 | Quản lý Học liệu AURA | 4 mục tiêu × 5 loại file, postMessage Bridge, AURA SDK, Version Mgmt | P0–P2 | ✅ v3.0 |
| Ch8 | Bài tập, Đề & Đánh giá | 9 dạng câu hỏi, Flashcard SRE, Ngân hàng Đề, Item Analysis, Gamification, SRL | P0–P3 | ✅ v2.0 |
| **Ch9** | **AI Agent Lab NCS** | **EDM framework, Experiment engine, Ethics/DPIA, Publication pipeline** | **P2–P3** | **✅ v1.0** |

> **[BỔ SUNG v3.1]** Ch9 là chương mới — module nghiên cứu khoa học chạy song song với LMS production.

### 1.2.3 In Scope vs Out of Scope

v2.0 bổ sung 2 nhóm lớn: Module AURA (Ch7) và Hệ thống đánh giá toàn diện (Ch8).

| # | ✅ IN SCOPE | ❌ OUT OF SCOPE |
|---|------------|----------------|
| 1 | LMS Core: user, content, event log, notification | Quản lý học phí, tài chính trường |
| 2 | AI Agent: Learner Model, Curriculum Planner (R01-R10), Feedback Engine | Livestream giảng trực tiếp |
| 3 | AURA: Quản lý học liệu HTML, PDF, Video, Quiz JSON, Python Script | Thi chính thức (tốt nghiệp, TS) — yêu cầu bảo mật đặc biệt |
| 4 | Ngân hàng câu hỏi: 9 dạng, tag đa chiều, Item Analysis | Blockchain chứng chỉ |
| 5 | Sinh đề tự động (Mathpit-style) + Thiết kế thủ công (Canvas-style) | AI nhận diện khuôn mặt / proctoring camera tự động |
| 6 | Import câu hỏi từ PDF/ảnh (OCR + Mathpix) | Thanh toán học phí online |
| 7 | Đề kiểm tra: vòng đời 8 trạng thái, phân phối, chấm, phân tích | ERP trường học (nhân sự, tài chính) |
| 8 | Đánh giá 5 chiều: Mastery, Bloom, Error, Velocity, Self-Regulation | Tích hợp SMAS/VNEM — có thể Phase 3 |
| 9 | Gamification: XP, Badges, Streak — dựa trên intrinsic motivation | Gamification phức tạp (NFT, marketplace) |
| 10 | Flashcard Spaced Repetition (SM-2 algorithm) | Audio/Speech recognition cho học Tiếng Anh — Phase 3+ |
| 11 | Socratic Engine (Claude API) [Phase 2+] | AR/VR learning environment |
| 12 | Metacognition Journal + SRL Dashboard | Social network giữa học sinh (chỉ academic peer review) |
| 13 | Parent Portal [Phase 2] | Tự động tạo bài giảng video bằng AI — Phase 3+ |

### 1.2.4 Ranh giới hệ thống — 11 Tích hợp bên ngoài

| # | Hệ thống ngoài | Hướng | Giao thức | Mục đích | Phase |
|---|---------------|-------|-----------|---------|-------|
| 1 | Email Server (SMTP) | LMS → Email | SMTP TLS | Thông báo, reset MK, digest | P0 |
| 2 | Object Storage MinIO | LMS ↔ S3 | HTTPS S3 | Media, AURA files, backup | P0 |
| 3 | Python Grader Service | LMS ↔ Grader | LTI 1.3 + REST | Chấm code Python | P0 |
| 4 | Anthropic Claude API | Agent → API | HTTPS REST | LLM Feedback Engine, Socratic Engine, Q-Generation | P2 |
| 5 | Mathpix API | AURA → API | HTTPS REST | OCR công thức toán từ ảnh/PDF | P1 |
| 6 | Tesseract OCR | AURA internal | Library | OCR text từ ảnh | P1 |
| 7 | SSO Provider | LMS ← SSO | OAuth 2.0/SAML | Đăng nhập 1 lần qua tài khoản trường | P1 |
| 8 | FCM / APNs | LMS → Mobile | HTTPS | Push notification mobile app | P1 |
| 9 | PDF.js (client) | Browser lib | CDN | Render PDF trong iframe | P1 |
| 10 | Video.js + HLS.js | Browser lib | CDN | Streaming video adaptive bitrate | P1 |
| 11 | Whisper API (OpenAI) | AURA → API | HTTPS REST | Transcript video tiếng Việt | P2 |

---

## 1.3 Định nghĩa và thuật ngữ

### 1.3.1 Thuật ngữ Giáo dục & Sư phạm

| Thuật ngữ | Định nghĩa | Trong hệ thống |
|-----------|-----------|----------------|
| YCCĐ | Yêu cầu Cần Đạt — chuẩn đầu ra tối thiểu theo Chương trình GDPT 2018 | Đơn vị học liệu nhỏ nhất. Mỗi YCCĐ = 1 lesson_id |
| Bloom's Taxonomy | 6 cấp tư duy: Nhận biết → Thông hiểu → Vận dụng → Phân tích → Đánh giá → Sáng tạo (Revised 2001) | Ký tự cuối lesson_id. bloom_profile trong Learner Model |
| Mastery Score | Điểm thành thạo [0.0–1.0] trên 1 YCCĐ. Tính bằng weighted_avg có decay theo thời gian | mastery_map trong Learner Model. Ngưỡng: <0.6/0.6-0.85/>0.85 |
| ZPD | Zone of Proximal Development — vùng phát triển gần (Vygotsky) | Agent chọn bài bloom = current_mastery + 0.5 level |
| Formative Assessment | Đánh giá liên tục trong quá trình học, dùng để điều chỉnh dạy-học ngay | Quiz checkpoint, Grader, Peer Review — tất cả là formative |
| Spaced Repetition | Ôn tập theo khoảng cách tăng dần dựa trên đường cong quên Ebbinghaus | SM-2 algorithm trong Flashcard module Ch8 |
| Growth Mindset | Niềm tin năng lực phát triển qua nỗ lực (Carol Dweck) | Gamification messaging, SRL scaffolding Ch8 |
| Self-Regulated Learning | Tự lập kế hoạch, theo dõi và điều chỉnh quá trình học | SRL Dashboard Ch8. Goal Tracker, Error Portfolio |
| Metacognition | Khả năng nhìn lại và điều chỉnh quá trình tư duy (Flavell, 1979) | GĐ4 Phản chiếu Ch3. Metacognition Journal Ch8 |
| Socratic Method | Dạy học bằng câu hỏi dẫn dắt, không cho đáp án | Socratic Engine Ch8. Claude API, max 5 turns |

### 1.3.2 Thuật ngữ Module AURA (Ch7)

| Thuật ngữ | Định nghĩa | Trong hệ thống |
|-----------|-----------|----------------|
| AURA | Active-learning Unit Repository & Adapter — module chuẩn hoá học liệu đa định dạng | Module trung tâm Ch7. 4 mục tiêu: Embed, Parse, Store, Sync |
| AURA SDK | JavaScript library inject vào HTML học liệu, chuẩn hoá events qua postMessage | aura-bridge.js. Hook checkAnswer(), submitTicket() |
| AURA Template | Template HTML chuẩn với `<meta name='aura:*'>` tags | GV dùng làm prompt cho Claude khi tạo bài |
| Exploit Mode | Chế độ khai thác: Embed \| Extract \| Store \| Hybrid | exploit_mode trong aura_lessons. Default: hybrid |
| postMessage Bridge | Giao tiếp iframe → LMS qua window.parent.postMessage() | AURA_QUIZ_ANSWER → quiz_submitted event |
| Bloom Gap | Khoảng thiếu trong phân phối Bloom của kho học liệu | gap_analysis.py. Alert khi gap > 5pp |
| OCR | Optical Character Recognition — nhận dạng ký tự từ ảnh/PDF scan | Import bài tập Ch8. Tesseract + Mathpix |

### 1.3.3 Thuật ngữ Ngân hàng Đề & Đánh giá (Ch8)

| Thuật ngữ | Định nghĩa | Trong hệ thống |
|-----------|-----------|----------------|
| Blueprint (đề) | Mẫu thiết kế đề: phân phối Bloom, độ khó, số câu, YCCĐ target | exam_blueprints table. Auto-generation Mathpit-style |
| D-index | Chỉ số phân biệt: D = p_high − p_low. D > 0.3 tốt | Item Analysis. discrimination_idx trong questions |
| p-value (câu) | Chỉ số độ khó: p = đúng/tổng. p ∈ [0.3, 0.7] cho đề phân loại | difficulty_p trong questions. Tính sau mỗi đợt thi |
| Cronbach α | Chỉ số độ tin cậy nội bộ bài kiểm tra. α ≥ 0.7 chấp nhận | Item Analysis toàn bài. Đo sau N ≥ 50 submissions |
| SM-2 Algorithm | SuperMemo 2: I(n) = I(n-1) × EF, EF ∈ [1.3, 2.5] | Flashcard module. EF khởi tạo từ mastery_score |
| Question Bank | Kho câu hỏi dùng chung, tag đa chiều: YCCĐ, Bloom, độ khó, topic | questions table. review_status: draft→approved |
| Gamification | Ứng dụng cơ chế game vào học tập: XP, badges, streak | Module 5 Ch8. Leaderboard mặc định ẩn |
| XP | Experience Points — điểm kinh nghiệm reward hành vi học tập đúng | bloom_multiplier: Bloom 6 = 2×. Không reward điểm số |

### 1.3.4 Thuật ngữ Pháp lý — NĐ 13/2023

> **[BỔ SUNG v3.1]**

| Thuật ngữ | Định nghĩa (theo NĐ 13/2023) | Áp dụng AdaptLearn |
|-----------|------------------------------|-------------------|
| Dữ liệu cá nhân (DLCN) | Thông tin gắn liền với một con người cụ thể (Đ2.1) | Tên, email, điểm, lịch sử học, learner_model |
| DLCN nhạy cảm | DLCN gắn liền với quyền riêng tư, khi bị xâm phạm gây ảnh hưởng trực tiếp (Đ2.4) | Metacognition journals (riêng tư), error_patterns |
| Chủ thể dữ liệu | Cá nhân được DLCN phản ánh (Đ2.6) | Học sinh, giáo viên, phụ huynh |
| Bên Kiểm soát và xử lý | Tổ chức quyết định mục đích và trực tiếp xử lý DLCN (Đ2.11) | Nhà trường (THPT Thủ Thiêm) — vận hành AdaptLearn |
| Xử lý tự động | Xử lý DLCN bằng phương tiện điện tử nhằm đánh giá, phân tích, dự đoán (Đ2.13) | AI Agent: Learner Model, Rule Engine, Feedback |
| DPIA | Đánh giá tác động xử lý dữ liệu cá nhân (Đ24) | Bắt buộc trước Go-Live vì có xử lý tự động |
| Consent | Sự đồng ý rõ ràng, tự nguyện của chủ thể dữ liệu (Đ2.8) | Popup consent HS + email consent PH |

---

## 1.4 Các bên liên quan

### Bảng stakeholder đầy đủ

| Stakeholder | Vai trò | Mong đợi chính | Rủi ro nếu không đáp ứng | Ảnh hưởng |
|------------|---------|---------------|--------------------------|-----------|
| Ban Giám hiệu | Sponsor | Hệ thống ổn định, HS tiến bộ đo được, không phiền toái GV | Dừng ngân sách | **QUYẾT ĐỊNH** |
| Tổ trưởng Tin học | Product Owner | Triết lý sư phạm đúng, GV kiểm soát AI, báo cáo chính xác | Thay đổi thiết kế lớn | **RẤT CAO** |
| Giáo viên bộ môn | Content Creator + User | Upload dễ, xem tiến trình HS real-time, Agent đề xuất đúng | Không upload → Agent không hoạt động | **RẤT CAO** |
| Học sinh THPT | End User (Primary) | Học mượt mà, phản hồi tức thì, cảm thấy tiến bộ | Không dùng → hệ thống vô nghĩa | **RẤT CAO** |
| Sở GD&ĐT | Regulatory | Tuân thủ QĐ 791, dữ liệu chuẩn, khả năng nhân rộng | Không nhân rộng | **CAO** |
| Đội phát triển | Builder | Yêu cầu rõ, không scope creep, môi trường dev đủ | Trễ deadline | **CAO** |
| CG đo lường GD | Psychometric Advisor | Item Analysis chuẩn, D-index, p-value, Cronbach α đúng | Ngân hàng đề kém chất lượng | **CAO** |
| Phụ huynh | Indirect User [P2] | Xem tiến trình con, so với chuẩn chương trình | Phàn nàn BGH | **TRUNG BÌNH** |
| Vận hành IT | Operator | Dễ deploy, monitor, backup, tài liệu đầy đủ | Downtime | **TRUNG BÌNH** |
| **NCS/Researcher** | **Research User [P2]** | **Dữ liệu anonymized, experiment tools, publication pipeline** | **Thiếu data cho nghiên cứu** | **CAO — MỚI** |

> **[BỔ SUNG v3.1]** NCS/Researcher là stakeholder mới — Ch9 AI Agent Lab.

---

## 1.5 Giả định và Ràng buộc

### 1.5.1 Giả định A01–A12

**A01–A08 (v2.0):**

| ID | Giả định | Hệ quả nếu sai | Xác suất đúng |
|----|---------|----------------|---------------|
| A01 | GV sẽ upload đủ nội dung bài học (video, bài tập) trước khi go-live | Cần kế hoạch onboarding GV rõ ràng, có deadline cứng | Trung bình — cần incentive |
| A02 | HS có thiết bị và internet tối thiểu 2Mbps. P1 không hỗ trợ offline | Khảo sát hạ tầng trước P1. Bổ sung offline mode P2 | Cao — TP.HCM |
| A03 | Server đủ tài nguyên: tối thiểu 4 vCPU, 8GB RAM, 200GB SSD cho P1 | Renegotiate IT hoặc chuyển cloud | Cao — cần xác nhận IT |
| A04 | Mã định danh QĐ 791 không thay đổi trong 2 năm | Cần migration script nếu Sở cập nhật | Rất cao — QĐ mới ban hành |
| A05 | Python Grader hiện có sẽ refactor expose REST API theo Ch5 | Nếu không refactor → xây mới (~4 tuần) | Cao — đã có codebase |
| A06 | GV chấp nhận AI Agent đề xuất, chỉ override <20% quyết định | Cần training và giải thích logic Agent | Trung bình — cần change management |
| A07 | P1 không cần SSO. HS tạo tài khoản bằng email trường | Nếu Sở yêu cầu SSO → bổ sung 3 tuần | Cao cho P1 |
| A08 | Dữ liệu HS on-premise. Không gửi cloud nước ngoài | Dùng cloud → thẩm định pháp lý | **Bắt buộc** — NĐ 13/2023 |

**A09–A12 (v3.0 bổ sung):**

| ID | Giả định | Hệ quả nếu sai | Xác suất đúng |
|----|---------|----------------|---------------|
| A09 | GV sẵn sàng upload học liệu HTML từ AI (Claude, ChatGPT) vào AURA. Không cần biết code | Cần workshop. AURA Template giảm barrier | Cao — GV Tổ Tin đã quen AI |
| A10 | Mathpix API OCR đúng công thức toán tiếng Việt ≥ 75% | Cần GV review. Tăng thời gian import 5→15 phút/đề | Cao — Mathpix tốt với LaTeX |
| A11 | GV chấp nhận dùng hệ thống sinh đề tự động sau training | Resistance to change → cần demo kết quả cụ thể | Trung bình — cần change management |
| A12 | HS Phase 1 (lớp 9-12) có thiết bị và internet ≥ 5Mbps để chạy AURA HTML + video | Cần khảo sát. Bổ sung offline mode [P2] | Cao tại TP.HCM |

**Giả định rủi ro nhất:** A01 (GV upload) + A11 (sinh đề tự động) + A10 (OCR accuracy) — cần training và demo.

### 1.5.2 Ràng buộc kỹ thuật nền tảng (v2.0 — 14 ràng buộc)

| Loại | Ràng buộc | Giá trị |
|------|----------|---------|
| Server OS | Ubuntu 22.04 LTS | Bắt buộc — hỗ trợ đến 2027 |
| Database | PostgreSQL 15+ | JSONB, partitioning, full-text search tiếng Việt |
| Cache | Redis 7+ | Streams API cho Event Bus, TTL management |
| Backend | Python 3.11+ (Agent) · Node.js 20+ (LMS API) | Polyglot |
| Frontend | TypeScript 5+ | Bắt buộc — type safety |
| Container | Docker 24+ · Docker Compose v2 | Portable environment |
| API | REST JSON · OpenAPI 3.0 | Auto-generate client SDK |
| Auth | JWT RS256 · OAuth 2.0 · LTI 1.3 | Stateless, LTI cho Grader |
| Encoding | UTF-8 toàn bộ | Hỗ trợ tiếng Việt có dấu |
| Timezone | UTC trong DB · Asia/Ho_Chi_Minh ở UI | Tránh lỗi DST |
| Browser | Chrome/Edge/Firefox 100+, Safari 15+ | Không hỗ trợ IE |
| HTTPS | TLS 1.2+ bắt buộc, TLS 1.3 ưu tiên | Bảo vệ dữ liệu HS |
| Offline | P1: không hỗ trợ · P2: PWA offline-first | Giảm complexity P1 |
| Accessibility | WCAG 2.1 Level AA | Ưu tiên, không bắt buộc P1 |

### 1.5.3 Ràng buộc bổ sung (v3.0 — 7 ràng buộc)

| Loại | Ràng buộc | Giá trị | Lý do |
|------|----------|---------|-------|
| AURA HTML | File size | ≤ 5MB sau nén. Scripts external bị block bởi CSP | Tránh load chậm và XSS |
| AURA Video | Codec & Size | H.264/H.265. Max 2GB. HLS transcode bắt buộc | Tương thích mọi browser |
| AURA OCR | API cost | Mathpix: ≤ 1000 req/tháng free tier | Budget control. Cache kết quả |
| LLM API | PII protection | Anonymize learner_id trước khi gửi prompt | Tuân thủ NĐ 13/2023 |
| LLM API | Cost cap | Alert khi chi phí Claude API > X VND/tháng | Tránh overrun ngân sách |
| Gamification | Leaderboard | Tắt mặc định. GV phải bật thủ công | Tránh demotivation (SDT) |
| Pyodide | Sandbox | Không network, không filesystem, PID 50, RAM 256MB | HS không thể abuse |

---

## 1.6 Yêu cầu phi chức năng

### 1.6.1 Performance

| Chỉ số | Target Phase 1 | Target Phase 2 | Đo bằng |
|--------|---------------|---------------|---------|
| Thời gian tải trang đầu tiên (FCP) | < 2s | < 1.5s | Lighthouse, WebPageTest |
| API response time P95 | < 1s | < 800ms | Prometheus, Grafana |
| Agent decision latency P95 | < 500ms | < 300ms | Custom metric |
| Python Grader turnaround P95 | < 10s | < 8s | Grader service metric |
| Event processing throughput | > 100 events/s | > 1000 events/s | Redis Streams lag monitor |
| AURA HTML parse time P95 | < 10s | < 5s | AURA service metric |
| AURA video HLS transcode | < 5 phút/GB | < 3 phút/GB | ffmpeg pipeline metric |
| Sinh đề tự động (40 câu) | < 2s | < 1s | Blueprint generation benchmark |
| Quiz render (100 câu) | < 300ms | < 150ms | Lighthouse / React profiler |
| OCR import 1 trang PDF | < 30s | < 15s | Mathpix + Tesseract benchmark |
| Flashcard review deck load | < 500ms | < 300ms | Lighthouse |
| Database query time P99 | < 100ms | < 50ms | pg_stat_statements |
| Concurrent users | 200 (pilot) | 2000 (full school) | k6 load test |
| **Uptime SLA** | **≥ 99.5%** | **≥ 99.9%** | UptimeRobot |

### 1.6.2 Security

| Yêu cầu bảo mật | Đặc tả chi tiết | Implement trong |
|-----------------|----------------|----------------|
| Xác thực (Authentication) | JWT RS256. Access token TTL 15 phút. Refresh token TTL 7 ngày với rotation. Blacklist sau logout | Auth Service · Redis · PostgreSQL |
| Phân quyền (Authorization) | RBAC: student, teacher, admin, super_admin. Check tại middleware. HS CHỈ xem dữ liệu chính mình | Middleware · Policy module · Row-level security |
| Bảo vệ truyền tải | HTTPS/TLS 1.2+ bắt buộc. HSTS header. Certificate auto-renew | Nginx · Certbot |
| Mã hóa dữ liệu | Mật khẩu: bcrypt cost factor 12+. Không lưu plaintext | Auth Service · Hashing middleware |
| Bảo vệ API | Rate limiting 100 req/min/user. Input validation. SQL injection prevention. XSS prevention | API Gateway · Validation middleware |
| Audit Log | Ghi log mọi truy cập Learner Model, mọi quyết định Agent, mọi GV override. Append-only | PostgreSQL audit tables |
| Bảo vệ DLCN (Privacy) | Không gửi PII ra ngoài. Analytics chỉ dùng learner_id UUID. Export cần admin confirm | Data layer · Privacy middleware |
| Sandbox Grader | Python code HS chạy trong Docker cô lập: CPU 0.5, Memory 128MB, Disk 50MB, Network OFF, Timeout 10s | Python Grader · Docker seccomp |
| Penetration Testing | OWASP Top 10 trước go-live. Phase 2+: thuê bên thứ ba | Pre-launch checklist · CI/CD scan |
| AURA HTML sandbox | iframe CSP: `default-src 'self'; script-src 'self'`. Block external fetch | Nginx X-Accel-Redirect |
| LLM PII anonymization | Không gửi tên HS, learner_id thật lên Claude API. Dùng hash ngắn | PII filter trước Anthropic API |
| OCR content security | File upload: validate MIME type, max size, scan virus (ClamAV [P2]) | AURA Gateway · python-magic |
| Exam integrity | Answers không expose trong API trước khi submit. correct_answer ẩn khi status ≠ 'graded' | Exam API |
| Gamification server-side | XP calculation phía server. Client không POST XP trực tiếp | Backend calculate XP |

### 1.6.3 Scalability, Maintainability, Reliability

| Thuộc tính | Chỉ số mục tiêu | Phương án kỹ thuật |
|-----------|-----------------|-------------------|
| Scalability | 10x users không đổi kiến trúc | Stateless API, Redis session, DB read replicas, CDN, consumer group scale-out |
| Maintainability | Onboard dev mới < 2 ngày | Monorepo, OpenAPI tự sinh, Conventional Commits, unit test > 80% |
| Reliability | MTTR < 30 phút | Health check mọi service, graceful shutdown, circuit breaker, retry exponential backoff |
| Observability | Phát hiện lỗi < 5 phút | Structured logging JSON, OpenTelemetry, Prometheus+Grafana, Sentry |
| Data Durability | RPO < 1 giờ, RTO < 2 giờ | PostgreSQL WAL archiving, backup hàng ngày, test restore hàng tháng |
| Testability | CI pipeline < 10 phút | Jest + pytest + Testcontainers + Playwright |

---

## 1.7 Cơ sở pháp lý

| Văn bản | Cơ quan | Nội dung liên quan |
|---------|--------|-------------------|
| QĐ 791/QĐ-SGDĐT (28/3/2025) | Sở GD&ĐT TP.HCM | Danh mục mã định danh học liệu 12 môn, 784 YCCĐ Toán |
| Thông tư 32/2018/TT-BGDĐT | Bộ GD&ĐT | Chương trình GDPT 2018, chuẩn đầu ra YCCĐ |
| Luật Giáo dục 2019 | Quốc hội | Quyền học tập cá nhân hóa — cơ sở pháp lý cho mô hình thích nghi |
| **Nghị định 13/2023/NĐ-CP** | **Chính phủ** | **Bảo vệ dữ liệu cá nhân. HS dưới 18 tuổi = trẻ em (Đ20) → cần đồng ý PH** |
| Thông tư 09/2021/TT-BGDĐT | Bộ GD&ĐT | Dạy và học trực tuyến — căn cứ pháp lý cho LMS |

---

## 1.8 Tuân thủ Nghị định 13/2023/NĐ-CP — Bảo vệ Dữ liệu Cá nhân

> **[BỔ SUNG v3.1]** — Section hoàn toàn mới. AdaptLearn xử lý DLCN của học sinh THPT (phần lớn dưới 18 = trẻ em theo Điều 20 NĐ 13/2023). Hệ thống là Bên Kiểm soát và xử lý DLCN (Đ2.11) vì vừa quyết định mục đích (giáo dục thích nghi) vừa trực tiếp xử lý (AI Agent tự động).

### 1.8.1 Phạm vi áp dụng

Dữ liệu cá nhân trong AdaptLearn:

| Loại | Ví dụ | Phân loại NĐ 13 |
|------|-------|-----------------|
| DLCN cơ bản | Họ tên, email, lớp, lịch sử hoạt động trên LMS | Đ2.3 |
| DLCN từ xử lý tự động | Learner Model 17 fields: mastery_map, bloom_profile, error_patterns, engagement | Đ2.13 — bắt buộc DPIA |
| DLCN nhạy cảm tiềm năng | Metacognition journals (phản chiếu cá nhân), error_patterns (mô hình lỗi) | Cần đánh giá theo Đ2.4 |

### 1.8.2 Consent Framework — Đồng ý xử lý DLCN

**Nguyên tắc:**
- Đ11: Đồng ý phải rõ ràng, tự nguyện, bằng văn bản/điện tử
- Đ11.6: Im lặng hoặc không phản hồi **KHÔNG** được coi là đồng ý
- Đ20: Xử lý DLCN trẻ em → cha mẹ/người giám hộ phải đồng ý

**Consent kép trong AdaptLearn:**

```
HS đăng nhập lần đầu
  → Popup consent (tiếng Việt, ngôn ngữ phù hợp lứa tuổi)
  → Checkbox KHÔNG pre-checked
  → HS click "Đồng ý" (assent)
  → Hệ thống gửi email PH (link consent form riêng)
  → PH click "Đồng ý" (consent)
  → CẢ HAI phải đồng ý → HS mới được track vào LMS đầy đủ
  → Bất kỳ lúc nào: HS/PH rút lại → API trả 403 CONSENT_REQUIRED
```

**Schema DB:**

```sql
CREATE TABLE consent_records (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id),
    consent_version VARCHAR(10) NOT NULL,     -- 'v1.0', 'v2.0'
    consent_type    VARCHAR(20) NOT NULL,     -- 'student_assent'|'parent_consent'
    purpose         TEXT[] NOT NULL,           -- ['learning_analytics','ai_agent','research']
    granted         BOOLEAN NOT NULL,
    granted_at      TIMESTAMPTZ DEFAULT NOW(),
    withdrawn_at    TIMESTAMPTZ,              -- quyền rút lại (Đ12)
    ip_hash         VARCHAR(64),              -- hash IP, không lưu IP thật
    evidence_url    TEXT,                     -- screenshot/PDF lưu MinIO
    legal_basis     TEXT                      -- 'Đ11 NĐ13/2023'
);
```

### 1.8.3 Data Retention Policy

| Loại dữ liệu | Retention | Sau đó | Legal basis |
|--------------|-----------|--------|-------------|
| users (PII: tên, email) | Đến khi HS ra trường + 2 năm | Anonymize (hash tên, xóa email) | Đ7 NĐ 13 |
| learner_models | Đến khi HS ra trường + 2 năm | Anonymize → aggregate | Đ7 NĐ 13 |
| lesson_sessions raw | 36 tháng | Anonymize | Đ11 NĐ 13 — nghiên cứu học tập |
| metacognition_journals | 12 tháng | **Xóa hẳn** (dữ liệu nhạy cảm) | Tối thiểu hóa DLCN |
| events (quiz, AURA) | 36 tháng | Anonymize | Đ11 NĐ 13 |
| audit_logs | 5 năm | Giữ nguyên (compliance) | Đ26 NĐ 13 |
| lesson_analytics aggregate | Vô thời hạn (đã anonymize) | Ngay khi tính | Aggregate = không còn PII |

### 1.8.4 Quyền xóa dữ liệu — Right to Erasure (Đ16)

- HS/PH yêu cầu xóa → xử lý trong **72 giờ** (Đ16.5)
- API: `POST /users/:id/request-deletion` → admin approve → deletion job
- Cascade: users → learner_models → events → quiz_attempts → flashcard_cards → journals → agent_decisions
- Xóa = anonymize (hash PII, giữ aggregate analytics)
- **Ngoại lệ** (Đ16.2): audit_logs KHÔNG xóa (pháp luật yêu cầu giữ)
- Ngoại lệ: dữ liệu cần cho phòng chống tội phạm (Đ16.2đ)

### 1.8.5 Breach Notification (Đ23)

Khi phát hiện vi phạm bảo vệ DLCN:

1. Thông báo **Bộ Công an** (Cục An ninh mạng — A05) trong **72 giờ**
2. Nội dung thông báo (Đ23.3): mô tả tính chất vi phạm, loại DLCN, số lượng, hậu quả, biện pháp khắc phục
3. Thông báo HS/PH bị ảnh hưởng
4. Lập **Biên bản xác nhận** (Đ23.5)
5. Phối hợp Bộ Công an xử lý

### 1.8.6 DPIA — Đánh giá tác động xử lý DLCN (Đ24)

Bắt buộc DPIA trước Go-Live vì AI Agent thực hiện **xử lý DLCN tự động** (Đ2.13):

| DPIA Section | Nội dung cho AdaptLearn |
|-------------|----------------------|
| Mục đích xử lý | Cá nhân hóa lộ trình: chọn bài, điều chỉnh độ khó, feedback |
| Loại DLCN | Điểm quiz, thời gian học, error_patterns, engagement, bloom_profile |
| Xử lý tự động | Learner Model 17 fields + Rule Engine R01-R10 tự quyết định |
| Rủi ro | (1) Tái nhận dạng qua mastery_map pattern (2) Bias AI ưu tiên HS giỏi (3) PII leak qua Claude API |
| Biện pháp giảm thiểu | (1) k-anonymity check (2) Fairness audit hàng tháng (3) PII filter trước API (4) On-premise VN |
| Thời gian lưu | Xem §1.8.3 Data Retention Policy |
| Cơ sở pháp lý | Đồng ý (Đ11), Nghiên cứu KH (Đ17.7), Giáo dục (Luật GD 2019) |

**Nộp DPIA cho Bộ Công an trong 60 ngày từ Go-Live.**

### 1.8.7 Checklist tuân thủ NĐ 13/2023

| # | Yêu cầu | Điều NĐ 13 | Đã implement? |
|---|---------|------------|---------------|
| 1 | Consent form HS + PH | Đ11, Đ20 | ✅ §1.8.2 |
| 2 | Privacy notice trước thu thập | Đ13 | ✅ GET /privacy/notice |
| 3 | Quyền xóa 72h | Đ16.5 | ✅ §1.8.4 |
| 4 | Quyền rút consent | Đ12 | ✅ POST /auth/consent/withdraw |
| 5 | DPIA cho AI Agent | Đ24 | ✅ §1.8.6 |
| 6 | Anonymize trước Claude API | Đ25 | ✅ PII filter |
| 7 | Data residency VN | Đ25, A08 | ✅ On-premise |
| 8 | Breach notification | Đ23 | ✅ §1.8.5 |
| 9 | Audit log append-only | Đ26 | ✅ privacy_audit_log |
| 10 | Data retention policy | Đ7 | ✅ §1.8.3 |

---

## 1.9 Lịch sử phiên bản SRS

| Phiên bản | Ngày | Tác giả | Thay đổi chính | Trạng thái |
|-----------|------|--------|----------------|-----------|
| v0.1 | 01/04/2025 | Tổ trưởng Tin học | Outline 6 chương ban đầu | Draft nội bộ |
| v1.0 | 05/04/2025 | Tổ trưởng Tin học | Hoàn thiện Ch1–Ch6: kiến trúc, AI Agent, API, triển khai | Review vòng 1 |
| v1.5 | 06/04/2025 | Tổ trưởng Tin học | Thêm Ch7 AURA v2.0: quản lý học liệu HTML đa định dạng | Review vòng 2 |
| v2.0 | 07/04/2025 | Tổ trưởng Tin học | Thêm Ch8: ngân hàng đề, quiz, flashcard, gamification, SRL. Cập nhật Ch1–Ch6. 3 Phụ lục | Draft v2.0 |
| v3.0 | 08/04/2025 | Tổ trưởng Tin học | Bổ sung Ch7 AURA v3.0, Ch8 scope mở rộng, A09-A12, NFR AURA | Draft v3.0 |
| **v3.1** | **09/04/2025** | **Technical Lead** | **Consolidated 37 files. Thêm §1.8 NĐ 13/2023 compliance. Ch9 vào module map. 30 gaps resolved.** | **Consolidated** |

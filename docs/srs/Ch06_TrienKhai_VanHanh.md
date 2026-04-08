# CHƯƠNG 6: TRIỂN KHAI & VẬN HÀNH — Consolidated v2.1

> **Mã tài liệu:** SRS-CH06 v2.1 · Tháng 4/2025
> **Consolidated từ:** Ch6 v2.0 + Ch6A Triển khai v1.0 + Ch6B Vận hành KPIs v1.0 + UI_Ch6 + TEST_Ch6
> **Phụ thuộc:** Ch1-Ch5 (toàn bộ specs)

---

## 6.1 Lộ trình 3 Phase

| Phase | Thời gian | Module triển khai | Done criteria |
|-------|----------|------------------|---------------|
| **P0** | Tháng 1-4 | Core LMS + Auth + AI Agent (R01-R10) + AURA (HTML/Video/PDF) + QBank cơ bản + Exam (manual) + Grader + Notification | 95 TC pass. Go-Live checklist. SLA 99.5% |
| **P1** | Tháng 5-8 | Flashcard SM-2 + Gamification (XP/Badge/Streak) + OCR import + AURA Quiz JSON + Parent Portal + SSO + Mobile push | P1 TC pass. AURA upload ≥ 100 bài. Flashcard ≥ 500 cards |
| **P2** | Tháng 9-12 | Claude API Feedback + Socratic Engine + Item Analysis full + Auto-generate exam + Whisper video + Kubernetes migration | LLM cost < budget. Item Analysis N≥50 submissions |
| **P3** | Năm 2 | FSRS algorithm (nâng SM-2) + AR/VR (khảo sát) + SMAS integration + Advanced analytics + Multi-school | TBD theo kết quả P2 |

---

## 6.2 Ch6A — Triển khai: Go-Live Plan

### Go-Live Timeline T-7 → T+48h

| Thời điểm | Hoạt động | Người thực hiện | Rollback trigger |
|-----------|----------|-----------------|-----------------|
| T-7 ngày | Freeze code. Final staging test | Dev Lead | — |
| T-5 ngày | Unit + Integration 100% pass. OWASP scan 0 High | Dev + Security | Fail → delay 1 tuần |
| T-3 ngày | E2E Playwright 10 journeys pass. k6 200 VUs pass | QA Lead + DevOps | Fail → delay |
| T-2 ngày | GV UAT sign-off (≥ 3 GV) | PM | GV reject → fix + retest |
| T-1 ngày | BGH approval. DNS cutover prep | PM + DevOps | — |
| **T=0** | **Deploy production. DNS switch. Smoke test** | **DevOps** | **Error >5% 5 phút → rollback** |
| T+2h | Smoke test 10 critical paths | QA | Error rate check |
| T+24h | Full monitoring review. Fix P1 issues | Dev + DevOps | — |
| T+48h | Stabilization complete. Handover operations | PM | — |

### Rollback Plan

- Rollback < 30 phút: Docker image tag previous. `docker compose down && docker compose up -d`
- DB rollback: Migration reverse script. Tested monthly
- DNS rollback: TTL 60s → switch back trong 1 phút

---

## 6.3 Ch6B — Vận hành: Test Cases & KPIs

### Test Cases v2.1 — 95 TCs (60 gốc + 25 AURA/Ch8 + 10 Privacy)

**TC61-TC70 — AURA:**

| TC | Tên | Expected |
|----|-----|----------|
| TC61 | AURA upload HTML chuẩn | qa_status=pass, parsed_grade/bloom đúng |
| TC62 | AURA parse phát hiện quiz | has_quiz=true, quiz_count=5 |
| TC63 | AURA upload thiếu lesson_id | qa_status=fail, A01=fail, block activate |
| TC64 | AURA video HLS transcode | HLS m3u8 + 3 quality tracks trong 5 phút |
| TC65 | AURA iframe CSP block | `<script src='evil.com'>` bị block |
| TC66 | AURA event postMessage | AURA_HTML_QUIZ_ANSWER trong events:main < 2s |
| TC67 | AURA version control | aura_versions version_num=2, v1 accessible |
| TC68 | AURA gap analysis Bloom 5 | gap=true khi thiếu Bloom 5 lớp 9 |
| TC69 | AURA PDF embed | PDF render iframe, không download được |
| TC70 | AURA Quiz JSON | has_quiz=true, events khi HS trả lời |

**TC71-TC75 — Gamification:**

| TC | Tên | Expected |
|----|-----|----------|
| TC71 | XP reward Bloom 6 | XP = base × 2.0 (bloom_multiplier) |
| TC72 | Badge 'First Mastery' | Badge awarded khi mastery > 0.85 lần đầu |
| TC73 | Streak 7 ngày | current_streak=7, Badge trigger, R04 check |
| TC74 | Leaderboard opt-out | show_leaderboard=false → 401 cho HS đó |
| TC75 | XP server-side only | Client POST XP → 403 Forbidden |

**TC76-TC80 — Exam:**

| TC | Tên | Expected |
|----|-----|----------|
| TC76 | Exam answers hidden | GET exam khi active → no correct_answer |
| TC77 | Sinh đề auto blueprint | 40 câu đúng phân phối Bloom, không trùng 3 đề gần nhất |
| TC78 | Exam time limit | Hết giờ → auto-submit, câu chưa làm = wrong |
| TC79 | Item analysis sau thi | p_value, d_index, point_biserial đúng (N≥50) |
| TC80 | Bloom analysis sau thi | LM exam_history update, mastery_map ×0.3 |

> **[BỔ SUNG v2.1]** TC86-TC95 — Privacy & Consent:

| TC | Tên | Expected | Sev |
|----|-----|----------|-----|
| TC86 | Consent popup lần đầu | HS login → popup trước dashboard | P0 |
| TC87 | Im lặng ≠ đồng ý | HS đóng popup → 403 CONSENT_REQUIRED | P0 |
| TC88 | Parent consent email | HS consent → email PH link | P0 |
| TC89 | Parent consent ghi DB | PH click → consent_records parent_consent=true | P0 |
| TC90 | Withdrawal flow | HS rút → withdrawn_at set, 403 mọi API | P0 |
| TC91 | Deletion request 72h | POST deletion → request created, sla=72h | P0 |
| TC92 | Deletion cascade | Admin approve → email null, LM anonymized, journals deleted | P0 |
| TC93 | Audit log truy cập | View LM → privacy_audit_log INSERT | P1 |
| TC94 | PII filter Claude | Socratic call → no learner name/email | P0 |
| TC95 | Re-consent sau withdraw | HS muốn dùng lại → new popup, version+1 | P1 |

### Risk Register v2.1 — 18 risks

| R | Rủi ro | XS | Tác động | Biện pháp | Owner |
|---|--------|-----|---------|----------|-------|
| R01 | GV không upload đủ học liệu | Cao | Cao | Workshop + AURA Template + demo | Tổ trưởng |
| R02 | Agent đề xuất sai | TB | Cao | Fallback curriculum thủ công. GV override | Tech Lead |
| R03 | Server down giữa giờ KT | Thấp | Rất cao | Multi-instance. Auto-save 30s. Rollback < 30' | DevOps |
| R04 | HS lạm dụng Socratic | TB | TB | Max 5 turns. Rate limit 10 sessions/ngày | Tech Lead |
| R05 | Claude API cost vượt ngân sách | TB | Cao | Cost alert + cap. Fallback template | PM |
| R13 | OCR accuracy thấp | Cao | Cao | GV review 100% câu AI-import | Tech Lead |
| R14 | LLM API cost overrun | TB | Cao | Daily cost alert. Monthly cap cứng | PM |
| R15 | GV từ chối sinh đề tự động | Cao | TB | Demo: tiết kiệm 80% thời gian. Luôn cho edit | Tổ trưởng |
| R16 | HS gian lận bài KT | TB | Cao | Shuffle câu + đáp án. Exam window ngắn. IP tracking | Tech Lead |
| **R17** | **PH không consent → HS không dùng LMS** | **TB** | **Cao** | **Consent drive đầu năm. GV gọi PH. Deadline cứng** | **PM** |
| **R18** | **Deletion request flood** | **Thấp** | **TB** | **Rate limit 1 req/user/7 ngày. Admin approval** | **DevOps** |

### KPIs v2.1 — 36 chỉ số (trích)

| KPI | Target P1 | Target P2 | Đo bằng | Nhóm |
|-----|----------|----------|---------|------|
| Tỉ lệ HS đạt mastery > 0.7 | ≥ 60% | ≥ 75% | Dashboard | Học tập |
| Bloom 5-6 coverage kho học liệu | ≥ 10% | ≥ 15% | AURA gap analysis | Học liệu |
| Agent decision accuracy (GV đánh giá) | ≥ 80% | ≥ 90% | Weekly GV survey | AI Agent |
| Số bài AURA HTML live | ≥ 50 | ≥ 200 | aura_lessons count | AURA |
| AURA QA pass rate | ≥ 80% | ≥ 90% | qa_status stats | AURA |
| Đề thi có D-index > 0.3 | — | ≥ 60% | Item Analysis | Exam |
| Cronbach α trung bình | — | ≥ 0.75 | Item Analysis | Exam |
| Tỉ lệ HS streak ≥ 7 ngày | ≥ 20% | ≥ 35% | gamification_profiles | Gamification |
| Flashcard review rate (cards/HS/tuần) | ≥ 10 | ≥ 20 | flashcard_cards stats | Flashcard |

### Privacy Go-Live Checklist

> **[BỔ SUNG v2.1]**

| # | Hạng mục | Pass criteria | Người ký |
|---|---------|--------------|---------|
| PV01 | DPIA hoàn thành | File PDF signed by PM + advisor | PM |
| PV02 | DPIA nộp Bộ Công an | Biên nhận trong 60 ngày | PM |
| PV03 | Privacy Notice tiếng Việt | /privacy/notice → 200 + content check | Dev |
| PV04 | Consent UI hoạt động | HS login → popup consent | QA |
| PV05 | Parent consent flow | Email PH → consent → DB | QA |
| PV06 | Consent block API | Chưa consent → 403 | QA |
| PV07 | Deletion pipeline | POST deletion → 72h → anonymized | DevOps |
| PV08 | Audit log đầy đủ | View LM → audit_log INSERT | QA |
| PV09 | PII not in Claude API | Grep agent logs → no name/email | Security |
| PV10 | Data residency VN | Server IP → VN datacenter | DevOps |

---

## 6.4 UI Screens — Operations

| Screen | Route | Mô tả |
|--------|-------|-------|
| SCR-6-01 | /admin/golive | Go-Live Dashboard: Checklist T-7→T+48h, rollback controls |
| SCR-6-02 | /admin/monitoring | Monitoring: 12 metrics, alert rules, incident log |

---

## 6.5 Monitoring Stack

| Tool | Vai trò | Metrics |
|------|---------|---------|
| Prometheus | Metrics collection | API latency, throughput, error rate |
| Grafana | Dashboards | 12 panels: per-service health, DB, Redis, Agent |
| Sentry | Error tracking | Exception capture, stack traces, breadcrumbs |
| UptimeRobot | Uptime monitoring | /health endpoint every 60s |
| Loki | Log aggregation | Structured JSON logs, search by request_id |
| Telegram Bot | Alerting | P0 alert → Telegram group within 1 minute |

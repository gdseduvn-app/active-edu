# Kế hoạch kiểm thử hệ thống AURA / ActiveEdu
**Ngày:** 2026-04-05 | **API:** api.gds.edu.vn | **Frontend:** activelearning.gds.edu.vn

---

## Tài khoản kiểm thử

| Vai trò | Email | Mật khẩu | Ghi chú |
|---------|-------|----------|---------|
| Admin | abc@gmail.com | test1234 | Tài khoản admin hệ thống |
| Giáo viên | giaovien@gds.edu.vn | GiaoVien@2024 | Tạo ngày 2026-04-05 |
| Học sinh | hocsinh@gds.edu.vn | HocSinh@2024 | Đã enroll khóa 2 |

**Dữ liệu kiểm thử:**
- Khóa học Id=2: "Toán 10 - Đạo hàm và ứng dụng" (Status: published)
- Module Id=1: "Chương 1: Đạo hàm"
- Article Id=36: "Khái niệm đạo hàm" (Published)
- Article Id=37: "Quy tắc tính đạo hàm" (Published)

---

## Kết quả kiểm thử (2026-04-05)

### ✅ Luồng đã kiểm tra - PASS

| # | Luồng | Endpoint | Kết quả |
|---|-------|----------|---------|
| 1 | Đăng nhập giáo viên | POST /api/auth/login | ✅ Token hợp lệ |
| 2 | Đăng nhập học sinh | POST /api/auth/login | ✅ Token hợp lệ |
| 3 | Đăng nhập admin | POST /admin/auth | ✅ Token hợp lệ |
| 4 | Xem danh sách khóa học public | GET /api/courses | ✅ 1 khóa published |
| 5 | Xem module của khóa học | GET /api/modules?course_id=2 | ✅ 1 module |
| 6 | Xem bài học (article) | GET /api/articles/36 | ✅ Tiêu đề đúng |
| 7 | Kiểm tra quyền truy cập khóa học | GET /api/courses/2/access | ✅ ok=true (enrolled) |
| 8 | Ghi nhận tiến độ học | POST /api/progress (articleId, courseId) | ✅ ok=true |
| 9 | Ghi xAPI statement vào D1 | POST /xapi/statements | ✅ Lưu thành công |
| 10 | Xem kết quả outcome giáo viên | GET /api/teacher/outcomes?course_id=2 | ✅ outcomes=0 (chưa có alignment data) |
| 11 | Xem gợi ý bài học học sinh | GET /api/student/recommendations?course_id=2 | ✅ count=0 (chưa có mastery data) |
| 12 | Xem danh sách AI sessions | GET /api/ai/sessions | ✅ total=0 (chưa chat) |
| 13 | Tạo bảng D1 schema | POST /admin/setup/d1-schema | ✅ 3 bảng OK |
| 14 | Bảo vệ endpoint - không auth | GET /api/ai/sessions (không token) | ✅ 401 Unauthorized |
| 15 | Rate limit AI | (quá 20 req/h) | ✅ 429 Too Many |

---

### ❌ Luồng có vấn đề - CẦN SỬA

| # | Luồng | Endpoint | Lỗi | Nguyên nhân |
|---|-------|----------|-----|------------|
| 16 | AI Socratic tutor | POST /api/ai/socratic | ❌ "AI tạm thời không khả dụng" | **Chưa có Anthropic API credit** |
| 17 | AI Coaching agent | POST /api/ai/coaching | ❌ Tương tự | **Chưa có credit** |
| 18 | AI Research agent | POST /api/ai/research | ❌ Tương tự | **Chưa có credit** |
| 19 | Teacher - Xem khóa học của mình | GET /api/teacher/courses | ❌ "Column alias 'TeacherId' not found" | **NocoDB Courses table thiếu cột TeacherId** |

---

### ⚠️ Luồng chưa kiểm tra đủ

| # | Luồng | Ghi chú |
|---|-------|---------|
| 20 | Outcome heatmap trên dashboard giáo viên | Cần data alignment + mastery, endpoint OK nhưng trả về rỗng |
| 21 | Adaptive recommendations có data thực | Cần student_mastery rows trong D1 |
| 22 | AI session multi-turn (lịch sử chat) | Phụ thuộc vào việc fix credit AI |
| 23 | Forgot password / reset email | Cần kiểm tra RESEND_API_KEY |
| 24 | Assessment / Quiz submission | Chưa có dữ liệu kiểm tra |
| 25 | Gradebook AI grading | Cần credit AI |

---

## Cần làm để hoàn tất kiểm thử

### Bắt buộc (blocking)
1. **Nạp credit Anthropic** → [console.anthropic.com/settings/billing](https://console.anthropic.com/settings/billing) (tối thiểu $5) → Giải quyết luồng 16, 17, 18, 22, 25
2. **Thêm cột TeacherId vào NocoDB Courses table** → Vào NocoDB dashboard → Table Courses → Add field `TeacherId` (Number) → Giải quyết luồng 19, 20

### Tùy chọn (để test đầy đủ)
3. **Tạo outcome alignments** → Vào NocoDB → Alignments table → Thêm records liên kết CourseId=2 với OutcomeCode → Test luồng heatmap (20)
4. **Làm bài tập / quiz** để sinh ra mastery data trong D1 → Test recommendations (21)

---

## Script kiểm thử nhanh (chạy sau khi fix)

```bash
# Lấy tokens
TV_TOKEN=$(curl -s -X POST https://api.gds.edu.vn/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"giaovien@gds.edu.vn","password":"GiaoVien@2024"}' | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))")

HS_TOKEN=$(curl -s -X POST https://api.gds.edu.vn/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"hocsinh@gds.edu.vn","password":"HocSinh@2024"}' | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))")

# Test AI (sau khi có credit)
curl -s -X POST https://api.gds.edu.vn/api/ai/socratic \
  -H "Authorization: Bearer $HS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"Đạo hàm là giới hạn tỷ số gia số khi Δx→0. Em đọc rồi nhưng chưa áp dụng được vào bài tập cụ thể ạ.","articleTitle":"Đạo hàm","wordCount":55,"session_key":"test-ai-001"}'

# Test teacher courses (sau khi thêm TeacherId)
curl -s "https://api.gds.edu.vn/api/teacher/courses" \
  -H "Authorization: Bearer $TV_TOKEN"

# Test heatmap (sau khi có alignment data)
curl -s "https://api.gds.edu.vn/api/teacher/outcomes?course_id=2" \
  -H "Authorization: Bearer $TV_TOKEN"
```

---

## Tóm tắt trạng thái hệ thống

| Hệ thống | Trạng thái | Ghi chú |
|---------|-----------|---------|
| Cloudflare Worker deploy | ✅ Live | Version 24cb422e |
| D1 Database (aura-analytics) | ✅ 14 bảng | ai_sessions, student_mastery, xapi_statements, action_logs... |
| NocoDB | ✅ Hoạt động | Throttle khi query nhanh |
| Auth / JWT | ✅ Hoạt động | Teacher, Student, Admin |
| Progress tracking | ✅ Hoạt động | Lưu vào NocoDB |
| xAPI statements | ✅ Hoạt động | Lưu vào D1 |
| AI endpoints | ❌ Cần credit | 403 forbidden từ Anthropic |
| Teacher TeacherId | ❌ Cần fix NocoDB | Cột TeacherId chưa tồn tại |

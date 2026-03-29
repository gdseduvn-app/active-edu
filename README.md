# 🎓 ActiveEdu

> Nền tảng học tập trực tuyến — Tự host trên GitHub Pages + NocoDB

## ✨ Tính năng

| Tính năng | Mô tả |
|-----------|-------|
| 📚 **Trang học tập** | Giao diện đọc bài sạch đẹp, menu tự động từ NocoDB |
| 🗂 **Quản lý tệp** | Tạo thư mục, tạo bài viết từ giao diện Admin |
| ✏️ **Visual Editor** | Soạn thảo WYSIWYG render đầy đủ HTML/CSS/JS (như Canvas LMS) |
| 👁 **Xem trước** | Preview bài viết ngay trong Admin |
| 🔐 **Bảo mật** | Đăng nhập Admin + học sinh qua NocoDB Users |
| 🗄️ **NocoDB** | Lưu toàn bộ nội dung bài học vào database |
| 🚀 **Deploy dễ dàng** | Không cần server backend, chạy trên GitHub Pages |
| 📱 **Responsive** | Tương thích mobile |

## 🚀 Deploy lên GitHub Pages

1. **Fork hoặc tạo repo mới** trên GitHub
2. **Upload toàn bộ file** dự án lên repo
3. Vào **Settings → Pages** → Source: `main` branch, folder `/`
4. Nhấn **Save** → Site live sau ~1 phút

URL: `https://[username].github.io/[repo-name]`

## 📁 Cấu trúc dự án

```
ActiveEdu/
├── index.html          # Trang học tập chính (load từ NocoDB)
├── admin/
│   ├── index.html      # Trang đăng nhập Admin
│   └── dashboard.html  # Bảng quản trị toàn diện
├── assets/             # Tài nguyên tĩnh
└── README.md
```

> **Lưu ý:** Nội dung bài học được lưu trong **NocoDB**, không lưu file HTML trên GitHub nữa.

## 🗄️ Cấu hình NocoDB

### Bảng Articles (bài học)
| Cột | Kiểu | Mô tả |
|-----|------|-------|
| Title | Single line text | Tên bài học |
| Path | Single line text | Đường dẫn duy nhất |
| Folder | Single line text | Thư mục chứa bài |
| Description | Long text | Mô tả ngắn |
| Content | Long text | Nội dung HTML đầy đủ |
| Updated | Single line text | Ngày cập nhật |
| NgayTao | Single line text | Ngày tạo |
| NgayCapNhat | Single line text | Ngày cập nhật |

### Bảng Users (học sinh)
| Cột | Kiểu | Mô tả |
|-----|------|-------|
| Name / HoTen | Single line text | Họ tên |
| Email | Email | Tài khoản đăng nhập |
| Password / MatKhau | Single line text | Mật khẩu |
| Role / VaiTro | Single line text | student / admin |
| Status / TrangThai | Single line text | active / inactive |

## 🔐 Đăng nhập Admin

- URL: `/admin/index.html`
- Mặc định: `admin` / `activeedu2024`
- Đổi mật khẩu trong **Admin → Cài đặt**

## 📝 Thêm bài học

1. Truy cập `/admin/index.html` → Đăng nhập
2. Vào **Soạn thảo** → nhập tiêu đề, chọn thư mục
3. Chọn chế độ **Visual** (WYSIWYG) hoặc **HTML** để soạn nội dung
4. Nhấn **Lưu vào NocoDB**

## 🛠 Phát triển

Dự án sử dụng 100% HTML/CSS/JS thuần — không cần build tools, không cần npm.

---

Made with ❤️ for educators | ActiveEdu v2.0 — NocoDB Edition

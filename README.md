# 🎓 ActiveEdu

> Nền tảng học tập trực tuyến — Tự host trên GitHub Pages

## ✨ Tính năng

| Tính năng | Mô tả |
|-----------|-------|
| 📚 **Trang học tập** | Giao diện đọc bài sạch đẹp, menu tự động từ cấu trúc thư mục |
| 🗂 **Quản lý tệp** | Tạo thư mục, tạo bài viết từ giao diện Admin |
| ✏️ **Soạn thảo HTML** | Editor HTML trực tiếp với toolbar, templates có sẵn |
| 👁 **Xem trước** | Preview bài viết ngay trong Admin |
| 🔐 **Bảo mật** | Đăng nhập Admin với username/password |
| 🚀 **Deploy dễ dàng** | Không cần server, chạy 100% trên GitHub Pages |
| 📱 **Responsive** | Tương thích mobile |

## 🚀 Deploy lên GitHub Pages

1. **Fork hoặc tạo repo mới** trên GitHub
2. **Upload toàn bộ file** dự án này lên repo
3. Vào **Settings → Pages**
4. Source: chọn `main` branch, folder `/` (root)
5. Nhấn **Save** → Site live sau ~1 phút

URL: `https://[username].github.io/[repo-name]`

## 📁 Cấu trúc dự án

```
ActiveEdu/
├── index.html              # Trang học tập chính
├── admin/
│   └── index.html          # Giao diện quản trị
├── content/
│   ├── index.json          # Cây thư mục (tự động tạo)
│   ├── huong-dan-su-dung.html
│   ├── Lập trình cơ bản/
│   │   ├── bai-1-gioi-thieu-html.html
│   │   └── bai-2-css-can-ban.html
│   └── JavaScript/
│       └── bien-va-kieu-du-lieu.html
└── README.md
```

## 🔐 Đăng nhập Admin

- URL: `/admin/index.html`
- Mặc định: `admin` / `activeedu2024`
- Đổi mật khẩu trong **Admin → Cài đặt**

> ⚠️ **Lưu ý bảo mật**: Dữ liệu lưu trong `localStorage`. Để bảo mật cao hơn, đổi mật khẩu mặc định ngay sau khi cài đặt.

## 📝 Thêm bài học

### Cách 1: Qua Admin Panel
1. Truy cập `/admin/index.html`
2. Đăng nhập → **Soạn thảo**
3. Nhập tiêu đề, chọn thư mục, viết nội dung HTML
4. Nhấn **Lưu bài**

### Cách 2: Thêm file thủ công
1. Tạo file `.html` trong thư mục `content/`
2. Cập nhật `content/index.json` theo cấu trúc:
```json
{
  "type": "file",
  "name": "Tên bài học",
  "path": "ten-thu-muc/ten-file.html",
  "folder": "ten-thu-muc",
  "description": "Mô tả ngắn",
  "updated": "28/03/2026"
}
```

## 🛠 Phát triển

Dự án sử dụng 100% HTML/CSS/JS thuần — không cần build tools, không cần npm.

---

Made with ❤️ for educators | ActiveEdu v1.0

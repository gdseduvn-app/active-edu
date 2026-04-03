# 🎓 ActiveEdu v2.0

> Nền tảng học tập trực tuyến — GitHub Pages + NocoDB

---

## ✨ Tính năng

| Tính năng | Mô tả |
|-----------|-------|
| 📚 **Trang học tập** | Menu tự động từ NocoDB, load bài học đầy đủ HTML/CSS/JS |
| 🔐 **Phân quyền** | Public/Private theo Thư mục và Bài học, gán quyền từng user |
| 👤 **Quản lý User** | Thêm/sửa/xóa, đổi mật khẩu, phân quyền nội dung |
| 🙍 **Hồ sơ cá nhân** | Đổi thông tin, avatar, mật khẩu từ trang học |
| ✏️ **Visual Editor** | Soạn thảo WYSIWYG + CodeMirror HTML editor có số dòng |
| 🗄️ **NocoDB** | Lưu toàn bộ nội dung, thư mục, user, phân quyền |
| 📱 **Responsive** | Tương thích mobile |
| ⚙️ **Export/Import Config** | Backup và khôi phục cấu hình JSON |

---

## 🚀 Cài đặt

### Bước 1 — Deploy GitHub Pages
1. Tạo repo GitHub mới
2. Upload toàn bộ file dự án lên repo
3. Vào **Settings → Pages** → Source: `main` branch, folder `/`
4. Nhấn **Save** → Site live sau ~1 phút

### Bước 2 — Tạo tài khoản NocoDB
1. Đăng ký tại [app.nocodb.com](https://app.nocodb.com)
2. Tạo Workspace mới (vd: `ActiveEdu`)
3. Tạo một **Base** mới bên trong Workspace

### Bước 3 — Tạo các bảng NocoDB

#### 📋 Bảng `Articles` (bài học)
| Cột | Kiểu | Bắt buộc |
|-----|------|----------|
| `Title` | Single line text | ✓ |
| `Path` | Single line text | ✓ |
| `Folder` | Single line text | |
| `Description` | Long text | |
| `Content` | Long text | ✓ |
| `Access` | Single line text | (`public`/`private`) |
| `Updated` | Single line text | |
| `NgayTao` | Single line text | |
| `NgayCapNhat` | Single line text | |

#### 👥 Bảng `Users` (học sinh)
| Cột | Kiểu | Bắt buộc |
|-----|------|----------|
| `Name` | Single line text | ✓ |
| `Email` | Email | ✓ |
| `Password` | Single line text | ✓ |
| `Role` | Single line text | (`student`/`teacher`/`admin`) |
| `Status` | Single line text | (`active`/`inactive`) |
| `Phone` | Single line text | |
| `Bio` | Long text | |
| `NgayTao` | Single line text | |
| `NgayCapNhat` | Single line text | |

#### 📁 Bảng `Folders` (thư mục)
| Cột | Kiểu | Bắt buộc |
|-----|------|----------|
| `Name` | Single line text | ✓ |
| `Path` | Single line text | ✓ (vd: `Toán 9/Ôn tập`) |
| `Parent` | Single line text | |
| `Access` | Single line text | (`public`/`private`) |

#### 🔒 Bảng `Permissions` (phân quyền)
| Cột | Kiểu | Mô tả |
|-----|------|-------|
| `UserId` | Single line text | ID của user trong bảng Users |
| `Type` | Single line text | `folder` hoặc `article` |
| `TargetId` | Single line text | ID của bài/thư mục |
| `TargetPath` | Single line text | Path của bài/thư mục |

### Bước 4 — Lấy thông tin kết nối NocoDB
- **NocoDB URL**: `https://app.nocodb.com`
- **API Token**: NocoDB → **Team & Settings → API Tokens → Add Token**
- **Base ID**: URL khi mở Base → phần `pwwk6ld3...` sau workspace ID
- **Table ID**: URL khi mở bảng → phần `mmd5n4it...`

### Bước 5 — Cấu hình Admin
1. Mở `https://[your-site]/admin/`
2. Đăng nhập: `admin` / `activeedu2024`
3. Vào **Cài đặt** → điền thông tin NocoDB
4. Nhấn **Kiểm tra & Lưu**
5. Đổi mật khẩu Admin trong **Cài đặt → Bảo mật**

---

## 📁 Cấu trúc dự án

```
active-edu/
├── index.html          # Trang học tập (học sinh)
├── README.md
├── admin/
│   ├── index.html      # Trang đăng nhập Admin
│   └── dashboard.html  # Bảng quản trị
└── content/
    └── index.json      # [] — bài học lưu trong NocoDB
```

---

## 🔐 Phân quyền

### Mô hình phân quyền
```
Thư mục [Public/Private]
  └── Bài học [Public/Private]
```

- **Public**: mọi người đều xem được
- **Private**: chỉ user được phân quyền mới xem
- Quyền thư mục = quyền mặc định cho tất cả bài bên trong

### Phân quyền cho User
1. Vào **NocoDB → tab Người dùng**
2. Nhấn nút 🛡️ bên cạnh user cần phân quyền
3. Tích chọn thư mục/bài được phép xem
4. Nhấn **Lưu phân quyền**

---

## 📝 Thêm bài học

1. Vào **Soạn thảo** trong Admin
2. Nhập tiêu đề, chọn thư mục
3. Soạn nội dung bằng **Visual Editor** hoặc **HTML Editor**
4. Nhấn **Lưu vào NocoDB** (`Ctrl+S`)

---

## 👤 Hồ sơ cá nhân (Học sinh)

Click vào **tên/avatar** góc trên phải để:
- Đổi thông tin (tên, email, SĐT, giới thiệu)
- Upload ảnh đại diện
- Đổi mật khẩu (cần nhập mật khẩu cũ)
- Đăng xuất

---

## ⚙️ Backup & Restore Config

- **Export**: Cài đặt → **Export config** → lưu file JSON
- **Import**: Cài đặt → **Import config** → chọn file JSON đã lưu

> ⚠️ File config chứa token nhạy cảm — giữ kỹ, không chia sẻ!

---

## 🗄️ Cấu trúc Config (localStorage key: `ae_cfg`)

```json
{
  "nocoUrl":         "https://app.nocodb.com",
  "nocoToken":       "your-api-token",
  "nocoTable":       "table-id-articles",
  "nocoBase":        "base-id",
  "nocoUserTable":   "table-id-users",
  "nocoFolderTable": "table-id-folders",
  "nocoPermTable":   "table-id-permissions",
  "adminUser":       "admin",
  "adminPass":       "your-password",
  "title":           "ActiveEdu"
}
```

---

Made with ❤️ for educators | ActiveEdu v2.0 — NocoDB Edition

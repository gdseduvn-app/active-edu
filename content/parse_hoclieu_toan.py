"""
Parser: Danh mục Mã Định Danh Học Liệu – Môn Toán
Sở GD&ĐT TP.HCM (QĐ 791/QĐ-SGDĐT ngày 28/3/2025)

Output: JSON với schema đầy đủ cho AI Agent định tuyến bài học thích nghi.
"""

import json
import re
import pdfplumber
from pathlib import Path


PDF_PATH = "/mnt/user-data/uploads/791_8_Phu__lu_c_VIII_-_Toa_n.pdf"
OUT_PATH = "/mnt/user-data/outputs/hoclieu_toan.json"

# ── Bảng tra cứu ──────────────────────────────────────────────────────────────

BLOOM_MAP = {
    "1": {"level": 1, "label_vi": "Nhận biết",  "label_en": "Remember"},
    "2": {"level": 2, "label_vi": "Thông hiểu", "label_en": "Understand"},
    "3": {"level": 3, "label_vi": "Vận dụng",   "label_en": "Apply"},
    "4": {"level": 4, "label_vi": "Phân tích",  "label_en": "Analyze"},
    "5": {"level": 5, "label_vi": "Đánh giá",   "label_en": "Evaluate"},
    "6": {"level": 6, "label_vi": "Sáng tạo",   "label_en": "Create"},
}

# Bloom → gợi ý mô hình bài học mặc định (giáo viên có thể ghi đè)
BLOOM_TO_MODEL = {
    1: ["scaffold"],
    2: ["scaffold", "practice"],
    3: ["practice", "case"],
    4: ["case", "project"],
    5: ["teach", "reflect"],
    6: ["project", "explore"],
}

# Bloom → mức năng lực khuyến nghị
BLOOM_TO_LEVEL = {
    1: "nen_tang",
    2: "nen_tang",
    3: "mo_rong",
    4: "mo_rong",
    5: "chuyen_sau",
    6: "chuyen_sau",
}


# ── Hàm giải mã mã định danh ──────────────────────────────────────────────────

def decode_id(ma: str) -> dict:
    """
    Giải mã mã định danh dạng 020101.0101a1
    
    Cấu trúc:
      02   = cấp học (02=Tiểu học, 03=THCS, 04=THPT)
      01   = môn học (01=Toán, 02=Tiếng Việt, ...)
      01   = lớp
      .0101 = ĐVKT1+ĐVKT2 index
      a    = thứ tự yêu cầu trong ĐVKT2
      1    = cấp độ Bloom
    """
    ma = ma.strip().replace("\n", "").replace(" ", "")
    
    # Pattern: 6 số . 4 số + 1 chữ + 1 số
    m = re.match(r"(\d{2})(\d{2})(\d{2})\.(\d{2})(\d{2})([a-z])(\d)", ma)
    if not m:
        return {}
    
    cap_hoc_code = m.group(1)
    mon_code     = m.group(2)
    lop          = int(m.group(3))
    dvkt1_idx    = m.group(4)
    dvkt2_idx    = m.group(5)
    req_order    = m.group(6)
    bloom_raw    = m.group(7)
    
    if lop <= 5:
        cap_hoc = "tieu_hoc"
    elif lop <= 9:
        cap_hoc = "thcs"
    else:
        cap_hoc = "thpt"
    
    bloom_info  = BLOOM_MAP.get(bloom_raw, {"level": 0, "label_vi": "?", "label_en": "?"})
    bloom_level = bloom_info["level"]
    
    return {
        "cap_hoc":       cap_hoc,
        "cap_hoc_code":  cap_hoc_code,
        "mon":           "toan",
        "lop":           lop,
        "dvkt1_idx":     dvkt1_idx,
        "dvkt2_idx":     dvkt2_idx,
        "req_order":     req_order,
        "bloom":         bloom_info,
        "bloom_raw":     bloom_raw,
        "lesson_model_default": BLOOM_TO_MODEL.get(bloom_level, ["scaffold"]),
        "level_default": BLOOM_TO_LEVEL.get(bloom_level, "nen_tang"),
    }


# ── Parse PDF ─────────────────────────────────────────────────────────────────

def clean(text: str) -> str:
    if not text:
        return ""
    return " ".join(text.replace("\n", " ").split())


def find_ma_and_fields(row: list) -> tuple[str, str, str, str]:
    """
    Trả về (dvkt1, dvkt2, yeu_cau, ma) từ row có thể 4 hoặc 8 cột.
    Tìm mã định danh ở cột cuối hoặc cột có pattern phù hợp.
    """
    id_pat = re.compile(r"\d{6}\.\d{4}[a-z]\d")
    
    # Tìm mã trong các cột
    ma = ""
    for cell in reversed(row):
        if cell:
            c = clean(cell)
            if id_pat.fullmatch(c):
                ma = c
                break
    
    if not ma:
        return "", "", "", ""
    
    n = len(row)
    if n >= 7:
        # Layout 8 cột: DVKT1(0) _ DVKT2(2) YEU_CAU(3+4) _ MA(6) _
        dvkt1   = clean(row[0] or "")
        dvkt2   = clean(row[2] or "")
        # Yêu cầu có thể trải qua cột 3, 4
        yeu_cau = clean(" ".join(str(c) for c in [row[3], row[4]] if c))
    else:
        # Layout 4 cột: DVKT1(0) DVKT2(1) YEU_CAU(2) MA(3)
        dvkt1   = clean(row[0] or "")
        dvkt2   = clean(row[1] or "")
        yeu_cau = clean(row[2] or "")
    
    return dvkt1, dvkt2, yeu_cau, ma


def parse_pdf(pdf_path: str) -> list[dict]:
    records = []
    
    current_grade   = None
    current_dvkt1   = None
    current_dvkt2   = None
    
    id_pattern = re.compile(r"\d{6}\.\d{4}[a-z]\d")
    
    with pdfplumber.open(pdf_path) as pdf:
        for page_num, page in enumerate(pdf.pages):
            tables = page.extract_tables()
            
            for table in tables:
                for row in table:
                    if not row:
                        continue
                    
                    # Bỏ header
                    if any(c in ["ĐVKT1", "YÊU CẦU CẦN ĐẠT"] for c in row if c):
                        continue
                    
                    # Detect dòng tiêu đề lớp
                    raw_text = " ".join(str(c) for c in row if c)
                    grade_match = re.search(r"TOÁN\s+(\d+)", raw_text)
                    if grade_match and not id_pattern.search(raw_text):
                        current_grade = f"toan_{grade_match.group(1)}"
                        current_dvkt1 = None
                        current_dvkt2 = None
                        continue
                    
                    dvkt1, dvkt2, yeu_cau, ma = find_ma_and_fields(row)
                    
                    if not ma:
                        continue
                    
                    # Cập nhật DVKT1, DVKT2 — giữ giá trị cuối cùng không rỗng
                    if dvkt1:
                        current_dvkt1 = dvkt1
                    if dvkt2:
                        current_dvkt2 = dvkt2
                    
                    # Giải mã mã định danh
                    decoded = decode_id(ma)
                    if not decoded:
                        continue
                    
                    record = {
                        # ── Định danh gốc ──────────────────────────────
                        "lesson_id":    ma,
                        "subject":      "toan",
                        "grade":        current_grade or decoded.get("lop"),
                        "grade_num":    decoded.get("lop"),
                        "cap_hoc":      decoded.get("cap_hoc"),
                        
                        # ── Nội dung học liệu ──────────────────────────
                        "unit_l1":      current_dvkt1,
                        "unit_l2":      current_dvkt2,
                        "requirement":  yeu_cau,
                        
                        # ── Phân loại tự động ──────────────────────────
                        "bloom_level":  decoded["bloom"]["level"],
                        "bloom_vi":     decoded["bloom"]["label_vi"],
                        "bloom_en":     decoded["bloom"]["label_en"],
                        
                        # ── Gợi ý cho AI Agent ─────────────────────────
                        "lesson_model_default": decoded["lesson_model_default"],
                        "level_default":        decoded["level_default"],
                        
                        # ── Trường giáo viên điền thêm (để trống) ─────
                        "lesson_model":   None,   # scaffold/practice/case/teach/explore/repair/project/reflect
                        "duration_avg":   None,   # phút
                        "media_url":      None,   # link video/tài liệu
                        "quiz_ids":       [],     # danh sách câu hỏi
                        "next_if_pass":   None,   # lesson_id tiếp theo nếu đạt
                        "next_if_fail":   None,   # lesson_id tiếp theo nếu chưa đạt
                        "tags":           [],     # nhãn tự do
                        "notes":          "",     # ghi chú giáo viên
                        
                        # ── Meta ───────────────────────────────────────
                        "source":       "791_QD-SGDDT_2025",
                        "page_pdf":     page_num + 1,
                        "status":       "draft",  # draft / ready / active
                    }
                    
                    records.append(record)
    
    return records


# ── Tạo quan hệ next_if_pass tự động ─────────────────────────────────────────

def auto_link(records: list[dict]) -> list[dict]:
    """
    Gắn next_if_pass = lesson_id tiếp theo trong cùng lớp (theo thứ tự mã).
    Giáo viên có thể ghi đè sau.
    """
    by_grade = {}
    for r in records:
        g = r["grade"]
        by_grade.setdefault(g, []).append(r)
    
    for grade, items in by_grade.items():
        for i, item in enumerate(items):
            if item["next_if_pass"] is None and i + 1 < len(items):
                item["next_if_pass"] = items[i + 1]["lesson_id"]
            # next_if_fail = quay về bài trước (repair)
            if item["next_if_fail"] is None and i > 0:
                item["next_if_fail"] = items[i - 1]["lesson_id"]
    
    return records


# ── Tạo summary statistics ────────────────────────────────────────────────────

def make_summary(records: list[dict]) -> dict:
    from collections import Counter
    
    bloom_counter = Counter(r["bloom_vi"] for r in records)
    grade_counter = Counter(r["grade"] for r in records)
    level_counter = Counter(r["level_default"] for r in records)
    
    return {
        "total_records":    len(records),
        "by_grade":         dict(sorted(grade_counter.items())),
        "by_bloom":         dict(bloom_counter.most_common()),
        "by_level":         dict(level_counter.most_common()),
        "source_file":      "791_8_Phu__lu_c_VIII_-_Toa_n.pdf",
        "source_decision":  "791/QĐ-SGDĐT ngày 28/3/2025",
        "generated_by":     "parse_hoclieu_toan.py",
    }


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print("Đang parse PDF...")
    records = parse_pdf(PDF_PATH)
    print(f"  Tìm thấy {len(records)} yêu cầu cần đạt")
    
    print("Đang tạo quan hệ next_if_pass...")
    records = auto_link(records)
    
    summary = make_summary(records)
    
    output = {
        "schema_version": "1.0",
        "subject":        "toan",
        "description":    "Danh mục mã định danh học liệu môn Toán lớp 1-12",
        "summary":        summary,
        "lessons":        records,
    }
    
    Path(OUT_PATH).parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    
    print(f"\n✓ Xuất: {OUT_PATH}")
    print(f"\nTóm tắt:")
    print(f"  Tổng học liệu : {summary['total_records']}")
    print(f"  Phân bổ Bloom : {summary['by_bloom']}")
    print(f"  Phân bổ lớp   :")
    for k, v in summary['by_grade'].items():
        print(f"    {k:12s}: {v:3d} yêu cầu")
    
    print(f"\nVí dụ 3 record đầu:")
    for r in records[:3]:
        print(f"  {r['lesson_id']} | Lớp {r['grade_num']} | Bloom {r['bloom_level']} {r['bloom_vi']}")
        print(f"    ĐVKT1: {r['unit_l1']}")
        print(f"    ĐVKT2: {r['unit_l2']}")
        print(f"    Yêu cầu: {r['requirement'][:80]}...")
        print()

if __name__ == "__main__":
    main()

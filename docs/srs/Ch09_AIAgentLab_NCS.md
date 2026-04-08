# CHƯƠNG 9: AI AGENT LAB CHO NCS KHOA HỌC DỮ LIỆU GIÁO DỤC — Consolidated v1.1

> **Mã tài liệu:** SRS-CH09 v1.1 · Tháng 4/2025
> **Consolidated từ:** Ch9 v1.0 (624 dòng) + UI_Ch9 + TEST_Ch9
> **Phụ thuộc:** Ch4 (AI Agent), Ch8 (Assessment data)

---

## 9.1 Tổng quan

Ch9 là module **nghiên cứu khoa học** chạy **song song** với LMS production. NCS đọc dữ liệu read-only từ AdaptLearn qua research schema riêng. Mọi dữ liệu đã anonymize trước khi NCS truy cập.

---

## 9.2 EDM Experiment Framework — pyKT

### Knowledge Tracing Models

| Model | Kiến trúc | AUC (ASSIST09) | Complexity | Khuyến nghị |
|-------|----------|---------------|-----------|------------|
| BKT | HMM 4 params | ~0.68-0.75 | Very Low | Baseline + interpretability demo cho GV |
| DKT | LSTM | ~0.74-0.83 | Low | Baseline deep learning. pyKT chuẩn |
| **simpleKT** | Dot-product Attn + Rasch | **~0.77-0.86** | Low | **★ Khuyến nghị bắt đầu — ICLR 2023** |
| AKT | Monotonic Attn + Rasch | ~0.77-0.87 | Medium | Khi cần model forgetting curve |
| DTransformer | Contrastive + Diagnostic | ~0.78-0.87 | Medium | Stable knowledge states |
| SAINT+ | Enc-Dec Transformer | ~0.75-0.85 | High | Khi có temporal features |

```python
# pyKT pipeline tích hợp AdaptLearn Gold data
from pykt.datasets import init_dataset4train
from pykt.models import simpleKT
import mlflow

df = load_from_gold_layer()
dataset, cfg = init_dataset4train(df, 'simplekt', seq_len=200, train_ratio=0.7)

with mlflow.start_run(run_name='simplekt_v1'):
    model = simpleKT(num_q=cfg.num_q, num_c=cfg.num_c)
    results = trainer.train(dataset)
    mlflow.log_metrics({'auc': results['auc'], 'rmse': results['rmse']})
```

### Dropout & At-Risk Prediction

| Feature Group | Features | Importance | Tool |
|-------------|----------|-----------|------|
| Behavioral | login_freq, avg_session_min, days_since_login, late_submission_rate | ⭐⭐⭐⭐⭐ | pandas |
| Performance | avg_quiz_score, mastery_slope, bloom_level_reached, error_rate | ⭐⭐⭐⭐ | pyKT |
| Engagement | aura_events_count, video_completion_pct, exit_ticket_rate | ⭐⭐⭐ | AURA Event Log |
| Temporal | day_of_week, week_of_semester, approaching_exam | ⭐⭐ | dim_time |

Model: **XGBoost + SHAP**. Alert: P(dropout) > 0.6 → notify GV. Target: AUC ≥ 0.80, F1 ≥ 0.70 tại week 4.

---

## 9.3 Quasi-Experiment Engine

### Design phù hợp THPT Việt Nam

**Vấn đề:** Không thể random assignment cá nhân (lớp cố định → contamination).
**Giải pháp:** Cluster assignment (toàn lớp = 1 đơn vị).

| Design | Mô tả | Statistical Analysis |
|--------|-------|---------------------|
| **Pre-Post NEGD** | Pretest → Intervention → Posttest. Control cùng trường | **★ ANCOVA** (pre-test covariate). Cohen's d, Hedges' g |
| DiD | Nhiều thời điểm. So sánh trend treatment vs control | β₃ trong Y = β₀ + β₁T + β₂Post + β₃(T×Post) |
| PSM | Match HS/lớp tương đương propensity score | MatchIt R. Check SMD < 0.1 |
| HLM | Two-level: HS (L1) trong lớp (L2). Xử lý ICC | lme4 + lmerTest (R). statsmodels MixedLM (Python) |

### Sample Size Calculator

```python
def calc_sample_size_ancova(effect_size=0.5, alpha=0.05, power=0.80,
                            icc=0.15, cluster_size=35):
    design_effect = 1 + (cluster_size - 1) * icc  # ICC=0.15, cluster=35 → DE=6.1
    n_basic = 2 * ((norm.ppf(1-alpha/2) + norm.ppf(power))**2 / effect_size**2)
    n_adjusted = n_basic * design_effect
    n_clusters = math.ceil(n_adjusted / cluster_size)
    return {
        'n_per_group_basic': round(n_basic),     # 128
        'design_effect': round(design_effect, 2), # 6.1
        'n_per_group_adjusted': round(n_adjusted), # 781
        'clusters_needed_per_group': n_clusters,   # 12 lớp/nhóm
        'total_clusters': n_clusters * 2,          # 24 lớp
        'total_students': n_clusters * 2 * cluster_size  # ~840 HS
    }
```

---

## 9.4 Publication Pipeline — 4 Papers / 3 năm

| Paper | Tên | Target venue | Năm |
|-------|-----|-------------|-----|
| P1 | System & Infrastructure | JEDM hoặc EDM Workshop | Năm 1 Q4 |
| P2 | Knowledge Tracing & LA | AIED hoặc EDM Full | Năm 2 Q3 |
| P3 | At-Risk Prediction + XAI | C&E hoặc BJET | Năm 2 Q4 |
| P4 | Framework & Survey | IJAIED hoặc C&E | Năm 3 Q2 |

---

## 9.5 Ethics & Compliance Layer

> ⚠ **QUAN TRỌNG:** Tuân thủ NĐ 13/2023 — bắt buộc trước khi thu thập bất kỳ dữ liệu nào.

### 9.5.1 Consent Management System

```sql
CREATE TABLE research.consent_records (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    anon_student_key VARCHAR(64) NOT NULL,
    consent_version VARCHAR(10) NOT NULL,
    consent_type    VARCHAR(20) NOT NULL,  -- 'student'|'parent'
    research_purpose TEXT[] NOT NULL,
    granted         BOOLEAN NOT NULL,
    granted_at      TIMESTAMPTZ DEFAULT NOW(),
    ip_hash         VARCHAR(64),
    withdrawn_at    TIMESTAMPTZ,
    legal_basis     TEXT  -- 'Điều 11 NĐ13/2023: nghiên cứu KH'
);
```

Workflow: HS login → popup consent (tiếng Việt) → PH email consent → Cả 2 đồng ý → track vào research pipeline. Bất kỳ lúc nào rút → pseudonymize tăng cường.

> **[BỔ SUNG v1.1]** Consent framework trong Ch9 cần được **generalize cho toàn LMS** (không chỉ research). Bảng `consent_records` ở Ch2 §2.3.4 đã mở rộng scope cho product consent.

### 9.5.2 DPIA Checklist

| Yêu cầu (Đ24 NĐ 13) | Cách thực hiện |
|----------------------|---------------|
| Mô tả mục đích xử lý | Section 'Purpose' trong research proposal |
| Đánh giá tỷ lệ dữ liệu | Data minimization: chỉ thu thập fields cần thiết |
| Đánh giá rủi ro tái nhận dạng | k-anonymity analysis + linkage attack test (ARX) |
| Biện pháp bảo vệ kỹ thuật | Pseudonymization, AES-256 at rest, TLS 1.3 in transit |
| Biện pháp tổ chức | Access control: chỉ NCS + advisor. Audit log |
| Kế hoạch xóa dữ liệu | Retention 36 tháng. Xóa: overwrite 7× + certificate |

### IRB Workflow

| Bước | Hoạt động | Timeline |
|------|----------|---------|
| 1 | Xác định IRB institution | Tháng 1 năm NCS |
| 2 | DPIA (bắt buộc NĐ 13) | 4 tuần |
| 3 | Phiếu đồng ý HS (assent) + PH (consent) | 1 tuần |
| 4 | Nộp IRB: Protocol + DPIA + Consent + Data mgmt plan | 4-8 tuần chờ |
| 5 | Nộp DPIA Bộ Công an (60 ngày) | Song song IRB |
| 6 | Thu thập dữ liệu sau approval | Sau duyệt |

---

## 9.6 Tech Stack — AI Agent Lab

| Layer | Tool | Version | Vai trò |
|-------|------|---------|---------|
| Data Store | DuckDB | 1.4.x | Analytical DB — Bronze/Silver |
| OLAP | PostgreSQL | 16.x | Gold layer — star schema |
| Transform | dbt-core + dbt-duckdb | 1.8.x | SQL transformations |
| Orchestration | Apache Airflow | 2.9.x | DAG scheduling ETL |
| KT Models | pyKT-toolkit | 0.0.37 | BKT, DKT, simpleKT, AKT |
| ML | scikit-learn + PyTorch | 1.5 / 2.3 | Dropout prediction |
| XAI | SHAP | 0.47.x | Feature importance, waterfall |
| Experiment | MLflow | 2.14.x | Log params, metrics, models |
| Agent Framework | CrewAI | 0.80.x | Literature/Hypothesis/Analysis/Writing Agents |
| RAG | LlamaIndex + ChromaDB | 0.11 / 0.5 | Paper Q&A, vector search |
| Anonymization | ARX + IBM diffprivlib | 3.9 / 0.6 | k-anonymity, differential privacy |
| Dashboard | Streamlit | 1.36.x | Research dashboard cho NCS |
| LLM | Claude Sonnet (Anthropic) | API | Literature synthesis, writing assist |

### Chi phí ước tính: **< $120/tháng**

| Thành phần | Chi phí | Ghi chú |
|-----------|---------|---------|
| VPS VN (4 vCPU, 8GB RAM) | ~500K-1.2M VNĐ | Data localization |
| GPU (training KT) | ~$10-50 | Colab Pro + RunPod spot |
| Claude API | ~$15-30 | 500 papers summarize + 50K words |
| Object storage | $0-5 | Backblaze B2 free tier |

---

## 9.7 Lộ trình 3 năm NCS

| Năm | Quý | Milestone | Output | KPI |
|-----|-----|----------|--------|-----|
| 1 | Q1 | Setup stack. IRB. DPIA. Consent. DVC init | Infrastructure | Stack 100% |
| 1 | Q2 | Literature review 200+ papers. RAG knowledge base. Research gaps | Literature doc | 200 papers indexed |
| 1 | Q3 | Pilot data 2 lớp ~70 HS. Baseline KT models (BKT, DKT) | Pilot dataset | AUC > 0.75 |
| 1 | Q4 | **Paper 1** submit (JEDM/EDM) | P1 submitted | Submit trước tháng 12 |
| 2 | Q1 | Design thực nghiệm chính 16-24 lớp. G*Power sample size | Experiment design | N đủ |
| 2 | Q2 | Intervention semester. Thu thập xAPI events | Rich dataset | Completeness > 90% |
| 2 | Q3 | Post-test. ANCOVA/HLM. simpleKT+AKT. SHAP. Effect size | Analysis results | Paper 2 draft |
| 2 | Q4 | **Paper 2** submit (AIED). **Paper 3** draft (C&E) | 2 papers submitted | P2 under review |
| 3 | Q1 | **Paper 3** submit. Dissertation ch1-3 | Dissertation 40% | P3 submitted |
| 3 | Q2 | **Paper 4** draft. Dissertation ch4-5 | Dissertation 70% | P4 submitted |
| 3 | Q3 | Open-source tools. Anonymized dataset release | Tools public | GitHub stars > 50 |
| 3 | Q4 | Defense. All papers: ≥2 accepted, ≥1 published | **PhD Defended** | ≥2 papers accepted |

---

## 9.8 UI Screens — Research

| Screen | Route | Mô tả |
|--------|-------|-------|
| SCR-9-01 | /lab | Research Dashboard: 5 widgets (Pipeline Health, Experiment Tracker, Sample Progress, Publication, AI Agent Log) |
| SCR-9-02 | /lab/experiments | Experiment Manager: MLflow runs, compare, launch new |
| SCR-9-03 | /lab/data | Data Explorer: Bronze/Silver/Gold row counts, quality metrics |

---

## 9.9 Test Cases — Ch9

| TC | Scenario | Expected | Sev |
|----|----------|----------|-----|
| TC-9-001 | Research DB read-only from LMS | INSERT/UPDATE/DELETE → permission denied | P0 |
| TC-9-002 | Anonymization pipeline | No real name/email in research schema | P0 |
| TC-9-003 | Consent required before data access | No consent → empty result set | P0 |
| TC-9-004 | DPIA document exists | PDF file verified before data collection | P1 |
| TC-9-005 | pyKT model training | AUC ≥ 0.75 on pilot data | P2 |

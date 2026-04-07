"""
Question Bank AI Generator — LLM-assisted question generation
Source: SRS-CH08 §8.6

Uses Anthropic Claude API to generate questions from lesson content, returning
structured dicts that match the `questions` table schema.

Supports Bloom's Taxonomy levels 1–6 and the following question types:
  mcq, true_false, fill_blank, short_answer, ordering, matching
"""
from __future__ import annotations

import json
import logging
from typing import Optional

from anthropic import AsyncAnthropic

logger = logging.getLogger(__name__)


# ─── Prompt building blocks ───────────────────────────────────────────────────

QUESTION_TYPE_PROMPTS: dict[str, str] = {
    "mcq":          "4 lựa chọn (A/B/C/D), chỉ 1 đúng, đánh dấu is_correct=true trong options",
    "true_false":   "mệnh đề đúng hoặc sai, correct_answer là 'true' hoặc 'false'",
    "fill_blank":   "điền vào chỗ trống, correct_answer là từ/cụm từ cần điền",
    "short_answer": "câu hỏi ngắn yêu cầu câu trả lời vài câu, kèm rubric chấm điểm trong explanation",
    "ordering":     "sắp xếp các bước/sự kiện theo thứ tự đúng, options là các mục cần sắp xếp",
    "matching":     "ghép cột trái với cột phải, options gồm left_items và right_items",
}

BLOOM_VERBS: dict[int, str] = {
    1: "nhận biết, liệt kê, nhớ lại",
    2: "giải thích, mô tả, tóm tắt",
    3: "áp dụng, tính toán, giải quyết",
    4: "phân tích, so sánh, phân loại",
    5: "đánh giá, nhận xét, phê bình",
    6: "sáng tạo, thiết kế, đề xuất",
}

# Default Claude model for question generation (cost-effective)
_DEFAULT_MODEL = "claude-haiku-4-5-20251001"

# Maximum lesson content characters sent to the model
_MAX_CONTENT_CHARS = 3000


# ─── Question generation ──────────────────────────────────────────────────────

async def generate_questions(
    lesson_content: str,
    lesson_title: str,
    bloom_level: int,
    question_type: str,
    count: int = 3,
    api_key: Optional[str] = None,
    model: str = _DEFAULT_MODEL,
) -> list[dict]:
    """
    Generate `count` questions from lesson content using Claude.

    Args:
        lesson_content: Raw text of the lesson (will be truncated to 3000 chars).
        lesson_title:   Lesson display title.
        bloom_level:    1–6 Bloom's Taxonomy level.
        question_type:  One of 'mcq', 'true_false', 'fill_blank',
                        'short_answer', 'ordering', 'matching'.
        count:          Number of questions to generate (1–10).
        api_key:        Anthropic API key (falls back to ANTHROPIC_API_KEY env var).
        model:          Claude model identifier.

    Returns:
        List of question dicts with keys: stem, bloom_level, difficulty,
        points, options, correct_answer, explanation, hints, question_type.
    """
    if not (1 <= bloom_level <= 6):
        raise ValueError(f"bloom_level must be 1–6, got {bloom_level}")
    count = max(1, min(count, 10))

    type_instruction = QUESTION_TYPE_PROMPTS.get(question_type, "câu hỏi tự luận ngắn")
    bloom_verbs = BLOOM_VERBS.get(bloom_level, "")
    content_snippet = lesson_content[:_MAX_CONTENT_CHARS]

    prompt = f"""Bạn là giáo viên THPT Thủ Thiêm đang xây dựng ngân hàng câu hỏi.
Tạo ĐÚNG {count} câu hỏi loại "{question_type}" ({type_instruction}) về bài học sau.

Tiêu đề bài học: {lesson_title}
Mức Bloom: {bloom_level} — kỹ năng: {bloom_verbs}

Nội dung bài học:
{content_snippet}

Trả về JSON hợp lệ theo cấu trúc sau (không có text ngoài JSON):
{{
  "questions": [
    {{
      "stem": "Nội dung câu hỏi (có thể dùng LaTeX $...$)",
      "bloom_level": {bloom_level},
      "difficulty": "easy|medium|hard",
      "points": 10,
      "options": [
        {{"label": "A", "text": "...", "is_correct": false}},
        {{"label": "B", "text": "...", "is_correct": true}},
        {{"label": "C", "text": "...", "is_correct": false}},
        {{"label": "D", "text": "...", "is_correct": false}}
      ],
      "correct_answer": "B",
      "explanation": "Giải thích đáp án đúng...",
      "hints": ["Gợi ý 1", "Gợi ý 2"]
    }}
  ]
}}

Lưu ý:
- Với true_false: options có 2 phần tử (True/False), correct_answer là "true" hoặc "false".
- Với fill_blank: không cần options, correct_answer là cụm từ chính xác cần điền.
- Với short_answer: explanation chứa rubric chấm điểm chi tiết.
- Với ordering: options là list {{"step": 1, "text": "..."}} theo thứ tự đúng.
- Với matching: options là {{"left": [...], "right": [...]}} với pairs.
- Chỉ trả về JSON, tuyệt đối không thêm text bên ngoài."""

    client = AsyncAnthropic(api_key=api_key)
    try:
        response = await client.messages.create(
            model=model,
            max_tokens=2000,
            temperature=0.7,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = response.content[0].text.strip()

        # Strip markdown code fences if present
        if raw.startswith("```"):
            raw = raw.split("```", 2)[1]
            if raw.startswith("json"):
                raw = raw[4:]
            raw = raw.rsplit("```", 1)[0].strip()

        data = json.loads(raw)
        questions = data.get("questions", [])

        # Normalize: add question_type, ensure required fields
        result: list[dict] = []
        for q in questions:
            q.setdefault("question_type", question_type)
            q.setdefault("options", [])
            q.setdefault("hints", [])
            q.setdefault("difficulty", "medium")
            q.setdefault("points", 10)
            q.setdefault("bloom_level", bloom_level)
            result.append(q)

        logger.info(
            "generated %d/%d questions lesson=%r bloom=%d type=%s",
            len(result), count, lesson_title, bloom_level, question_type,
        )
        return result

    except (json.JSONDecodeError, KeyError, IndexError) as exc:
        logger.error("question generation parse error: %s", exc)
        return []
    except Exception as exc:
        logger.error("question generation API error: %s", exc)
        return []


# ─── Exam blueprint ───────────────────────────────────────────────────────────

async def generate_exam_blueprint(
    lesson_ids: list[str],
    total_questions: int,
    total_points: int,
    bloom_distribution: dict[int, float],
    db,
) -> dict:
    """
    Auto-generate an exam blueprint from the question bank.

    Selects questions from the DB by Bloom level using the supplied distribution.
    Each section represents one Bloom level.

    Args:
        lesson_ids:          UUIDs of lessons to draw questions from.
        total_questions:     Target total question count.
        total_points:        Target total points.
        bloom_distribution:  {bloom_level_int: fraction_float} — must sum to 1.0.
        db:                  asyncpg Pool.

    Returns a dict with:
        sections:          List of {bloom_level, question_count, points, questions}.
        total_questions:   Actual total questions selected.
        total_points:      Actual total points allocated.
        bloom_coverage:    {bloom_level_str: actual_count}.
    """
    blueprint: dict = {
        "sections": [],
        "total_questions": 0,
        "total_points": 0,
        "bloom_coverage": {},
    }

    for bloom, fraction in bloom_distribution.items():
        n = max(0, round(total_questions * fraction))
        pts = max(0, round(total_points * fraction))

        rows = await db.fetch(
            """
            SELECT id, stem, bloom_level, difficulty, points, question_type
            FROM questions
            WHERE lesson_id = ANY($1::uuid[])
              AND bloom_level = $2
              AND status = 'published'
            ORDER BY RANDOM()
            LIMIT $3
            """,
            lesson_ids,
            int(bloom),
            n,
        )

        section_questions = [dict(r) for r in rows]
        actual_pts = sum(q.get("points", 0) for q in section_questions) or pts

        blueprint["sections"].append({
            "bloom_level": int(bloom),
            "question_count": len(section_questions),
            "points": actual_pts,
            "questions": section_questions,
        })
        blueprint["bloom_coverage"][str(bloom)] = len(section_questions)
        blueprint["total_questions"] += len(section_questions)
        blueprint["total_points"] += actual_pts

    return blueprint


# ─── Single question save ─────────────────────────────────────────────────────

async def save_generated_questions(
    lesson_id: str,
    questions: list[dict],
    created_by: str,
    db,
) -> list[str]:
    """
    Persist a list of generated questions to the `questions` table.
    Returns the list of newly created question UUIDs.
    """
    import uuid as _uuid

    ids: list[str] = []
    for q in questions:
        qid = str(_uuid.uuid4())
        await db.execute(
            """
            INSERT INTO questions
                (id, lesson_id, stem, question_type, bloom_level, difficulty,
                 points, options, correct_answer, explanation, hints,
                 status, created_by, created_at)
            VALUES
                ($1,  $2,        $3,   $4,            $5,          $6,
                 $7,     $8::jsonb, $9,             $10,         $11::jsonb,
                 'draft', $12,        NOW())
            """,
            qid,
            lesson_id,
            q.get("stem", ""),
            q.get("question_type", "short_answer"),
            int(q.get("bloom_level", 1)),
            q.get("difficulty", "medium"),
            int(q.get("points", 10)),
            json.dumps(q.get("options", []), ensure_ascii=False),
            q.get("correct_answer", ""),
            q.get("explanation", ""),
            json.dumps(q.get("hints", []), ensure_ascii=False),
            created_by,
        )
        ids.append(qid)

    logger.info("saved %d generated questions to lesson=%s", len(ids), lesson_id)
    return ids

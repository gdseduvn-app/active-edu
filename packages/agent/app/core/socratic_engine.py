"""
Socratic Questioning Engine
Source: SRS-CH08 §8.5

Guides students toward answers through Socratic dialogue instead of giving
direct answers.  The engine:

  1. Adapts question depth to the student's mastery level.
  2. Maintains a 6-turn context window (3 exchange pairs).
  3. Returns a structured response with hint_level, is_correct_path flag,
     and an encouragement message.
  4. Never reveals the answer directly — it only asks guiding questions.
"""
from __future__ import annotations

import logging
from typing import Optional

from anthropic import AsyncAnthropic

logger = logging.getLogger(__name__)

# ─── System prompt (Vietnamese) ───────────────────────────────────────────────

SOCRATIC_SYSTEM_PROMPT = """Bạn là gia sư AI Socratic của trường THPT Thủ Thiêm.
Nhiệm vụ: Hướng dẫn học sinh tìm ra câu trả lời qua câu hỏi gợi mở, KHÔNG đưa đáp án trực tiếp.

Nguyên tắc Socratic:
1. Khi học sinh bị kẹt: Hỏi "Em đã biết gì về...?" để khai thác kiến thức nền.
2. Khi học sinh sai: Không nói "sai", hỏi "Em có thể giải thích tại sao lại như vậy?"
3. Dùng phép loại trừ: "Nếu A không đúng, thì điều gì có thể xảy ra?"
4. Kết nối kiến thức cũ: "Điều này có giống với bài... mà em đã học không?"
5. Khuyến khích metacognition: "Em đang nghĩ gì khi làm bước này?"
6. Mỗi lượt chỉ đặt ĐÚNG MỘT câu hỏi để không áp đảo học sinh.
7. Câu hỏi phải ngắn gọn, rõ ràng, không quá 2 câu.
8. Luôn dùng Tiếng Việt, giọng thân thiện, khuyến khích.
9. TUYỆT ĐỐI không đưa đáp án, kể cả khi học sinh xin trực tiếp.
10. Nếu học sinh đã đúng: xác nhận và hỏi câu nâng cao hơn."""

# ─── Response generation ──────────────────────────────────────────────────────

async def get_socratic_response(
    conversation_history: list[dict],
    student_message: str,
    lesson_context: dict,
    api_key: str,
    mastery_level: float = 0.5,
    model: str = "claude-haiku-4-5-20251001",
) -> dict:
    """
    Generate a Socratic response to a student question.

    Args:
        conversation_history: List of prior {"role": "user"|"assistant", "content": str} turns.
                              The function uses the last 6 turns (3 exchange pairs).
        student_message:      The student's current message.
        lesson_context:       Dict with keys: title, bloom_level, summary, lesson_code.
        api_key:              Anthropic API key.
        mastery_level:        0.0–1.0 float from the learner model.
        model:                Claude model identifier.

    Returns:
        {
            "response":       str,   — Socratic question/prompt
            "hint_level":     int,   — 0=no hint, 1=light, 2=medium, 3=direct
            "is_correct_path": bool, — True if student appears to be converging
            "encouragement":  str,   — Brief encouragement phrase
        }
    """
    # ── Mastery-adapted instruction ───────────────────────────────────────────
    if mastery_level < 0.3:
        depth_instruction = (
            "Học sinh đang gặp khó khăn. Đặt câu hỏi dẫn dắt rất cơ bản, "
            "gần với kiến thức nền nhất, từng bước nhỏ."
        )
        hint_level = 2
    elif mastery_level >= 0.7:
        depth_instruction = (
            "Học sinh có nền tảng tốt. Đặt câu hỏi thách thức hơn, "
            "hướng đến tư duy phân tích và tổng hợp."
        )
        hint_level = 0
    else:
        depth_instruction = "Đặt câu hỏi Socratic chuẩn để hướng dẫn suy nghĩ."
        hint_level = 1

    # ── Build context block ───────────────────────────────────────────────────
    context_block = (
        f"Bài học: {lesson_context.get('title', '')}\n"
        f"Bloom target: {lesson_context.get('bloom_level', 3)}\n"
        f"Tóm tắt nội dung: {str(lesson_context.get('summary', ''))[:400]}\n"
        f"Mastery hiện tại: {mastery_level:.0%}\n"
        f"{depth_instruction}"
    )

    # ── Build messages list ───────────────────────────────────────────────────
    # Structure: context injected as first user turn (not visible to student),
    # followed by actual conversation history, then current student message.
    messages: list[dict] = []

    # Last 6 turns of history
    for turn in conversation_history[-6:]:
        if turn.get("role") in ("user", "assistant") and turn.get("content"):
            messages.append({"role": turn["role"], "content": str(turn["content"])})

    # Current student message with context prefix
    full_message = context_block + "\n\n---\nCâu hỏi của học sinh: " + student_message
    messages.append({"role": "user", "content": full_message})

    # ── Call Claude ───────────────────────────────────────────────────────────
    client = AsyncAnthropic(api_key=api_key)
    try:
        api_response = await client.messages.create(
            model=model,
            max_tokens=450,
            system=SOCRATIC_SYSTEM_PROMPT,
            messages=messages,
        )
        response_text = api_response.content[0].text.strip()
    except Exception as exc:
        logger.error("socratic engine API error: %s", exc)
        response_text = "Em có thể cho thầy/cô biết em đang suy nghĩ đến đâu rồi không? 🤔"

    return {
        "response": response_text,
        "hint_level": hint_level,
        "is_correct_path": True,   # Phase 2: NLP-based convergence detection
        "encouragement": _get_encouragement(mastery_level),
    }


# ─── Metacognition prompt ─────────────────────────────────────────────────────

async def get_metacognition_prompt(
    student_answer: str,
    correct_answer: str,
    lesson_context: dict,
    api_key: str,
    model: str = "claude-haiku-4-5-20251001",
) -> str:
    """
    After a student submits an answer (right or wrong), generate a
    metacognitive reflection prompt ("What made you choose this answer?",
    "How confident were you?", etc.).

    This supports SRS-CH08 §8.5.3 (metacognition layer).
    """
    is_correct = student_answer.strip().lower() == correct_answer.strip().lower()
    status = "đúng" if is_correct else "chưa đúng"

    prompt = (
        f"Học sinh vừa trả lời câu hỏi về bài '{lesson_context.get('title', '')}'.\n"
        f"Câu trả lời của học sinh: {student_answer}\n"
        f"Kết quả: {status}.\n\n"
        "Hãy đặt 1 câu hỏi ngắn (≤2 câu) giúp học sinh phản tư quá trình suy nghĩ của mình "
        "(metacognition), không tiết lộ đáp án đúng. Dùng tiếng Việt, thân thiện."
    )

    client = AsyncAnthropic(api_key=api_key)
    try:
        response = await client.messages.create(
            model=model,
            max_tokens=200,
            system=SOCRATIC_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": prompt}],
        )
        return response.content[0].text.strip()
    except Exception as exc:
        logger.error("metacognition prompt error: %s", exc)
        return "Em đã nghĩ như thế nào khi trả lời câu này?"


# ─── Encouragement helpers ────────────────────────────────────────────────────

def _get_encouragement(mastery: float) -> str:
    """Return a short Vietnamese encouragement phrase based on mastery level."""
    if mastery < 0.3:
        return "Cứ từ từ nhé, em đang làm rất tốt! 💪"
    if mastery < 0.6:
        return "Em đang đi đúng hướng! 🌟"
    return "Tư duy sắc sảo! Tiếp tục phát huy! 🚀"


def build_conversation_turn(role: str, content: str) -> dict:
    """Helper to construct a well-typed conversation turn dict."""
    if role not in ("user", "assistant"):
        raise ValueError(f"role must be 'user' or 'assistant', got '{role}'")
    return {"role": role, "content": content}

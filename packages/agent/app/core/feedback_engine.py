"""
Feedback Engine — AURA AdaptLearn
Source: SRS-CH04 §4.4

Phase 1: Template-based feedback in Vietnamese
Phase 2+: Anthropic Claude API integration
"""
from __future__ import annotations
from typing import Any
import random


FEEDBACK_TEMPLATES = {
    # score < 0.5: encouragement + specific help
    'low': [
        "Em đã cố gắng! Điểm chưa cao vì {error_summary}. Thử lại phần {weak_topic} nhé.",
        "Chưa đạt lần này, nhưng đừng nản! {error_summary}. Gợi ý: {hint}.",
        "Phần {weak_topic} cần ôn thêm. Em hãy xem lại {review_link} trước khi thử lại.",
    ],
    # 0.5–0.8: acknowledge progress + push higher
    'medium': [
        "Khá tốt! Em đạt {score_pct}%. {correct_note}. Để lên mức tiếp theo, chú ý {improvement}.",
        "Tiến bộ đó! Điểm mạnh: {strength}. Cần cải thiện: {improvement}.",
        "Em hiểu đúng {correct_count}/{total} câu. {improvement} sẽ giúp em đạt điểm cao hơn.",
    ],
    # >= 0.8: celebrate + stretch
    'high': [
        "Xuất sắc! {score_pct}% — {praise}. Thử thách tiếp theo: {next_challenge}.",
        "Tuyệt vời! Em nắm vững {topic}. {stretch_question}",
        "Hoàn hảo! Em sẵn sàng cho bài khó hơn. {next_challenge}",
    ],
    # repair mode: specific error correction
    'repair': [
        "Em hay mắc lỗi {error_type}. Ví dụ: {example}. Cách sửa: {fix_method}.",
        "Lỗi phổ biến nhất của em là {error_type}. Hãy nhớ: {rule}.",
    ],
    # threshold concept: extra support
    'threshold': [
        "Đây là khái niệm cốt lõi — cần thật vững mới tiến tiếp được. {concept_explanation}.",
        "Khái niệm {topic} rất quan trọng. Khi hiểu rõ, mọi bài sau sẽ dễ hơn nhiều. {support}.",
    ],
}

ERROR_EXPLANATIONS = {
    'arithmetic': 'tính toán số học (nhầm dấu, sai phép tính cơ bản)',
    'sign_error': 'nhầm dấu âm/dương',
    'formula_wrong': 'dùng sai công thức',
    'setup_error': 'đặt bài sai từ đầu',
    'incomplete': 'trả lời chưa đầy đủ',
    'direction': 'nhầm hướng tính (xuôi/ngược)',
}


def generate_feedback(
    score: float,
    max_score: float,
    error_tags: list[str],
    topic: str,
    lesson_model: str,
    is_threshold: bool = False,
    language: str = 'vi',
) -> str:
    """
    Phase 1: Generate template-based feedback.
    Phase 2+: Replace with LLM call.
    """
    score_pct = int((score / max_score * 100) if max_score > 0 else 0)
    error_summary = _summarize_errors(error_tags)

    context = {
        'score_pct': f'{score_pct}%',
        'error_summary': error_summary or 'một số lỗi nhỏ',
        'weak_topic': topic,
        'topic': topic,
        'hint': 'xem lại phần lý thuyết cơ bản',
        'review_link': f'bài ôn tập {topic}',
        'correct_note': f'Em trả lời đúng những phần quan trọng' if score_pct >= 60 else '',
        'correct_count': int(score),
        'total': int(max_score),
        'improvement': error_summary or 'chú ý đọc kỹ đề hơn',
        'strength': f'hiểu đúng về {topic}' if score_pct >= 50 else 'cố gắng hoàn thành bài',
        'praise': 'Em hiểu rất sâu chủ đề này',
        'next_challenge': f'thử bài {topic} ở mức nâng cao hơn',
        'stretch_question': 'Thử suy nghĩ: kiến thức này áp dụng được ở đâu trong thực tế?',
        'error_type': error_tags[0] if error_tags else 'tính toán',
        'example': 'ví dụ cụ thể sẽ được bổ sung',
        'fix_method': 'kiểm tra lại từng bước',
        'rule': 'đọc kỹ yêu cầu bài trước khi làm',
        'concept_explanation': f'{topic} là nền tảng của nhiều bài sau',
        'support': 'hỏi giáo viên nếu còn thắc mắc',
    }

    # Select template category
    if is_threshold and score_pct < 70:
        category = 'threshold'
    elif lesson_model == 'repair':
        category = 'repair'
    elif score_pct < 50:
        category = 'low'
    elif score_pct < 80:
        category = 'medium'
    else:
        category = 'high'

    template = random.choice(FEEDBACK_TEMPLATES[category])
    return template.format(**context)


def _summarize_errors(error_tags: list[str]) -> str:
    if not error_tags:
        return ''
    explanations = [ERROR_EXPLANATIONS.get(tag, tag) for tag in error_tags[:2]]
    return ' và '.join(explanations)


# Phase 2+: LLM Integration stub
async def generate_feedback_llm(
    context: dict[str, Any],
    anthropic_client: Any = None,  # anthropic.AsyncAnthropic
) -> str:
    """
    Phase 2+: Generate natural Vietnamese feedback via Claude API.
    PII must be masked before sending to API.
    """
    if anthropic_client is None:
        # Fallback to template
        return generate_feedback(
            context['score'], context['max_score'],
            context.get('error_tags', []), context.get('topic', ''),
            context.get('lesson_model', 'scaffold'),
        )

    # Mask PII
    masked_context = {k: v for k, v in context.items()
                      if k not in ('user_id', 'full_name', 'email', 'class_id')}

    prompt = f"""Bạn là giáo viên Toán THPT đang viết phản hồi cho học sinh sau khi làm bài.
Ngữ cảnh: {masked_context}

Yêu cầu:
- Tiếng Việt, thân thiện, khuyến khích
- Cụ thể về lỗi (nếu có), không chung chung
- Đề xuất hành động tiếp theo rõ ràng
- Tối đa 3 câu
- KHÔNG đề cập tên học sinh hay thông tin cá nhân

Phản hồi:"""

    # Actual API call (Phase 2+)
    # response = await anthropic_client.messages.create(
    #     model="claude-haiku-4-5-20251001",
    #     max_tokens=200,
    #     messages=[{"role": "user", "content": prompt}]
    # )
    # return response.content[0].text

    return generate_feedback(
        context['score'], context['max_score'],
        context.get('error_tags', []), context.get('topic', ''),
        context.get('lesson_model', 'scaffold'),
    )

"""
Learner Model Service — AURA AdaptLearn
Source: SRS-CH04 v1.0 §4.2 (THPT Thủ Thiêm)

Responsibilities:
- Calculate and update mastery_score with time decay
- Detect error patterns
- Maintain SOLO profile
- AI Literacy tracking (Southworth)
"""
from __future__ import annotations
from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
from typing import Any
import math
import json


@dataclass
class QuizAttempt:
    score: float           # 0.0 – 1.0
    submitted_at: datetime
    attempt_number: int
    error_tags: list[str] = field(default_factory=list)
    time_taken_sec: int = 0


@dataclass
class MasteryResult:
    score: float           # 0.0 – 1.0
    confidence: float      # 0.0 – 1.0 (low when few attempts)
    attempt_count: int
    last_attempt_at: datetime | None = None
    trend: str = 'stable'  # 'improving' | 'declining' | 'stable'


def calculate_mastery(
    attempts: list[QuizAttempt],
    decay_factor: float = 0.9,        # recent attempts weight higher
    time_decay_days: float = 30.0,    # after 30d, weight reduces (forgetting)
    min_attempts_for_confident: int = 3,
) -> MasteryResult:
    """
    Calculate mastery_score with weighted average.
    Weights: (1) recency — later attempts weigh more, (2) time decay — old attempts decay.

    Returns MasteryResult with score, confidence, trend.
    """
    if not attempts:
        return MasteryResult(score=0.0, confidence=0.0, attempt_count=0)

    sorted_attempts = sorted(attempts, key=lambda x: x.submitted_at)
    now = datetime.now(timezone.utc)

    weighted_sum = 0.0
    weight_total = 0.0

    for i, attempt in enumerate(sorted_attempts):
        # Weight 1: recency (later attempts weight more)
        recency_weight = (decay_factor ** (len(sorted_attempts) - 1 - i))

        # Weight 2: time decay (old results less relevant — student may have forgotten)
        days_ago = (now - attempt.submitted_at).total_seconds() / 86400
        time_weight = math.exp(-days_ago / time_decay_days)

        combined_weight = recency_weight * time_weight
        weighted_sum += attempt.score * combined_weight
        weight_total += combined_weight

    score = weighted_sum / weight_total if weight_total > 0 else 0.0
    score = max(0.0, min(1.0, score))  # clamp to [0,1]

    # Confidence: low when few attempts
    confidence = min(1.0, len(attempts) / min_attempts_for_confident)

    # Trend: compare last 2 vs previous
    trend = 'stable'
    if len(sorted_attempts) >= 3:
        recent_avg = sum(a.score for a in sorted_attempts[-2:]) / 2
        older_avg = sum(a.score for a in sorted_attempts[:-2]) / max(len(sorted_attempts) - 2, 1)
        if recent_avg > older_avg + 0.1:
            trend = 'improving'
        elif recent_avg < older_avg - 0.1:
            trend = 'declining'

    return MasteryResult(
        score=round(score, 4),
        confidence=round(confidence, 4),
        attempt_count=len(attempts),
        last_attempt_at=sorted_attempts[-1].submitted_at if sorted_attempts else None,
        trend=trend,
    )


def detect_error_patterns(attempts: list[QuizAttempt]) -> dict[str, int]:
    """
    Aggregate error tags from recent attempts.
    Returns: {error_tag: frequency_count}
    Only consider last 5 attempts for recency.
    """
    recent = sorted(attempts, key=lambda x: x.submitted_at)[-5:]
    counts: dict[str, int] = {}
    for attempt in recent:
        for tag in attempt.error_tags:
            counts[tag] = counts.get(tag, 0) + 1
    return dict(sorted(counts.items(), key=lambda x: -x[1]))


def assess_solo_level(
    score: float,
    hint_count: int,
    time_ratio: float,   # actual_time / expected_time
    error_tags: list[str],
) -> int:
    """
    Auto-assess SOLO level from quiz performance indicators.
    1=Prestructural, 2=Unistructural, 3=Multistructural, 4=Relational, 5=Extended Abstract
    """
    if score < 0.2:
        return 1  # Prestructural: completely wrong/off-topic
    if score < 0.45 or hint_count >= 3:
        return 2  # Unistructural: knows one aspect, needs lots of hints
    if score < 0.65:
        return 3  # Multistructural: knows multiple aspects but not connected
    if score < 0.85:
        return 4  # Relational: connects ideas, applies in context
    # Extended Abstract: fast, accurate, generalizes
    if score >= 0.85 and time_ratio < 0.7 and hint_count == 0:
        return 5
    return 4


def update_bloom_profile(
    current_profile: dict[str, float],
    bloom_level: int,
    score: float,
    alpha: float = 0.3,  # exponential moving average alpha
) -> dict[str, float]:
    """
    Update Bloom profile with exponential moving average.
    profile[level] = alpha * new_score + (1-alpha) * old_score
    """
    profile = dict(current_profile)
    key = str(bloom_level)
    old = profile.get(key, 0.0)
    profile[key] = round(alpha * score + (1 - alpha) * old, 4)
    return profile


def should_trigger_rule(
    lm: dict[str, Any],
    lesson: dict[str, Any],
) -> tuple[str, str]:
    """
    Evaluate all rules R01–R10 in priority order.
    Returns (rule_code, reason_vi) — first matching rule.
    """
    consecutive_fail = lm.get('consecutive_fail', 0)
    consecutive_pass = lm.get('consecutive_pass', 0)
    mastery = lm.get('mastery_map', {}).get(lesson.get('lesson_code', ''), 0.0)
    level = lm.get('current_level', 'nen_tang')
    engagement = lm.get('engagement_score', 0.5)
    last_session = lm.get('last_session_at')
    tags = lm.get('tags', [])
    bloom_profile = lm.get('bloom_profile', {})
    is_threshold = lesson.get('threshold_concept', False)

    # R01: Repair
    if consecutive_fail >= 3:
        return 'R01', f'Học sinh thất bại {consecutive_fail} lần liên tiếp. Cần ôn tập lại từ đầu.'
    if is_threshold and mastery < 0.6:
        return 'R01', f'Đây là Threshold Concept. Học sinh chưa vượt qua (mastery={mastery:.0%}).'

    # R02: Downgrade
    if consecutive_fail >= 2 and level != 'nen_tang':
        new_level = 'nen_tang' if level == 'mo_rong' else 'mo_rong'
        return 'R02', f'Thất bại {consecutive_fail} lần. Giảm xuống mức {new_level}.'

    # R03: Upgrade
    if consecutive_pass >= 3 and mastery >= 0.85 and level != 'chuyen_sau':
        new_level = 'chuyen_sau' if level == 'mo_rong' else 'mo_rong'
        return 'R03', f'Xuất sắc {consecutive_pass} lần liên tiếp (mastery={mastery:.0%}). Nâng lên mức {new_level}.'

    # R04: Dormant
    if last_session:
        if isinstance(last_session, str):
            last_session = datetime.fromisoformat(last_session.replace('Z', '+00:00'))
        hours_since = (datetime.now(timezone.utc) - last_session).total_seconds() / 3600
        if hours_since >= 48:
            return 'R04', f'Học sinh không học trong {hours_since:.0f} giờ. Ôn tập kiến thức cũ.'

    # R05: Bloom Gap
    low_bloom = float(bloom_profile.get('1', 0)) > 0.8 and float(bloom_profile.get('2', 0)) > 0.8
    weak_apply = float(bloom_profile.get('3', 0)) < 0.5 and float(bloom_profile.get('4', 0)) < 0.5
    if low_bloom and weak_apply:
        return 'R05', 'Học sinh nhớ/hiểu tốt nhưng còn yếu kỹ năng vận dụng. Cần bài tập thực hành.'

    # R06: Engagement Drop
    if engagement < 0.35:
        return 'R06', f'Engagement thấp ({engagement:.0%}). Chuyển sang format học sinh yêu thích.'

    # R07: Peer Expert
    if consecutive_pass >= 5 and mastery >= 0.9 and 'peer_expert' not in tags:
        return 'R07', f'Học sinh xuất sắc (mastery={mastery:.0%}). Gợi ý vai trò Peer Expert.'

    # R10: At-Risk Alert (high priority warning)
    if consecutive_fail >= 5 or (mastery < 0.3 and consecutive_fail >= 3) or engagement < 0.2:
        return 'R10', 'CẢNH BÁO: Học sinh có nguy cơ cao. Cần giáo viên can thiệp trực tiếp.'

    return 'DEFAULT', 'Tiếp tục lộ trình học tập bình thường.'

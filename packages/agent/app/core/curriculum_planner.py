"""
Curriculum Planner — AURA AdaptLearn
Source: SRS-CH04 §4.3 (10 Rules + DEFAULT)

Deterministic Rule Engine (Phase 1).
Every decision is auditable and explainable in Vietnamese.
"""
from __future__ import annotations
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
import uuid

from .learner_model import should_trigger_rule, calculate_mastery, QuizAttempt


@dataclass
class PlannerDecision:
    rule_fired: str          # R01..R10 | DEFAULT
    next_lesson_id: str | None
    reason: str              # Vietnamese explanation
    confidence: float        # 0.0–1.0
    action: str              # 'continue' | 'repair' | 'downgrade' | 'upgrade' | 'alert'
    metadata: dict[str, Any]


async def plan_next_lesson(
    learner_model: dict[str, Any],
    current_lesson: dict[str, Any],
    lesson_catalog: list[dict[str, Any]],
    db,  # database connection
) -> PlannerDecision:
    """
    Core planning function. Evaluates R01–R10 in priority order.
    Returns decision with next_lesson_id and Vietnamese reason.

    Algorithm:
    1. Evaluate rules R01–R10 in priority order
    2. First matching rule wins
    3. If no rule matches → DEFAULT (continue path)
    4. Fetch appropriate lesson from catalog
    5. Write to agent_decisions table
    """
    rule_code, reason = should_trigger_rule(learner_model, current_lesson)

    next_lesson = None
    action = 'continue'
    confidence = 0.9

    match rule_code:
        case 'R01':
            # Insert Repair lesson before next
            next_lesson = await _find_repair_lesson(current_lesson, learner_model, lesson_catalog, db)
            action = 'repair'
            confidence = 0.95

        case 'R02':
            # Downgrade level
            new_level = _downgrade_level(learner_model['current_level'])
            next_lesson = await _find_lesson_at_level(current_lesson, new_level, lesson_catalog, db)
            action = 'downgrade'

        case 'R03':
            # Upgrade level
            new_level = _upgrade_level(learner_model['current_level'])
            next_lesson = await _find_lesson_at_level(current_lesson, new_level, lesson_catalog, db)
            action = 'upgrade'

        case 'R04':
            # Spaced repetition review
            next_lesson = await _find_review_lesson(learner_model, lesson_catalog, db)
            action = 'review'

        case 'R05' | 'R06' | 'R07' | 'R09':
            # Continue with model preference change
            next_lesson = await _find_next_lesson(current_lesson, lesson_catalog, db)
            action = 'continue'
            confidence = 0.75

        case 'R10':
            # At-risk: do NOT auto-change — alert teacher
            next_lesson = None  # Wait for teacher override
            action = 'alert'
            confidence = 1.0

        case _:  # DEFAULT
            next_lesson = await _find_next_lesson(current_lesson, lesson_catalog, db)
            action = 'continue'
            confidence = 0.85

    return PlannerDecision(
        rule_fired=rule_code,
        next_lesson_id=next_lesson.get('id') if next_lesson else None,
        reason=reason,
        confidence=confidence,
        action=action,
        metadata={
            'current_level': learner_model.get('current_level'),
            'mastery': learner_model.get('mastery_map', {}).get(
                current_lesson.get('lesson_code', ''), 0.0),
            'rule_evaluated_at': datetime.now(timezone.utc).isoformat(),
        }
    )


def _downgrade_level(current: str) -> str:
    return {'chuyen_sau': 'mo_rong', 'mo_rong': 'nen_tang'}.get(current, 'nen_tang')

def _upgrade_level(current: str) -> str:
    return {'nen_tang': 'mo_rong', 'mo_rong': 'chuyen_sau'}.get(current, 'chuyen_sau')

async def _find_repair_lesson(current, lm, catalog, db):
    """Find or create Repair lesson for current topic."""
    # Look for existing repair lesson with same lesson_code prefix
    code_prefix = current.get('lesson_code', '')[:10]
    for lesson in catalog:
        if lesson.get('lesson_model') == 'repair' and \
           lesson.get('lesson_code', '').startswith(code_prefix):
            return lesson
    # Fallback: use current lesson at lower level
    return current

async def _find_lesson_at_level(current, level, catalog, db):
    """Find same lesson_code at different difficulty level."""
    code = current.get('lesson_code', '')
    for lesson in catalog:
        if lesson.get('lesson_code') == code and lesson.get('difficulty_level') == level:
            return lesson
    return current

async def _find_review_lesson(lm, catalog, db):
    """Find highest-priority spaced repetition review lesson."""
    mastery_map = lm.get('mastery_map', {})
    # Find lesson with lowest mastery from last 7 days
    candidates = [(code, score) for code, score in mastery_map.items() if score < 0.8]
    if not candidates:
        return None
    worst_code = min(candidates, key=lambda x: x[1])[0]
    for lesson in catalog:
        if lesson.get('lesson_code') == worst_code:
            return lesson
    return None

async def _find_next_lesson(current, catalog, db):
    """Find next lesson based on next_if_pass or sequential order."""
    next_code = current.get('next_if_pass')
    if next_code:
        for lesson in catalog:
            if lesson.get('lesson_code') == next_code:
                return lesson
    return None

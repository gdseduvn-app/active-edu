"""
Event Handlers — 13 handlers for Event Processor
Source: SRS-CH04B §4B.1

Each handler:
1. Validates event payload
2. Updates Learner Model fields
3. Runs Rule Engine if needed
4. Emits feedback/notifications
"""
from __future__ import annotations
from typing import Any, Dict, Optional
from datetime import datetime, timezone
import logging

logger = logging.getLogger(__name__)


async def handle_quiz_submitted(event: Dict[str, Any], db, redis) -> None:
    """LM: mastery_map, bloom_profile, error_patterns, consecutive"""
    payload = event.get('payload', {})
    user_id = event['learner_id']
    lesson_id = event.get('lesson_id')
    score_pct = payload.get('score_percent', 0)
    error_tags = payload.get('error_tags', [])
    bloom_level = payload.get('bloom_level', 1)

    # Update mastery_map
    await db.execute(
        """UPDATE learner_models SET
            mastery_map = jsonb_set(mastery_map, $2, $3::jsonb),
            bloom_profile = jsonb_set(bloom_profile, $4, $5::jsonb),
            consecutive_pass = CASE WHEN $6 >= 60 THEN consecutive_pass + 1 ELSE 0 END,
            consecutive_fail = CASE WHEN $6 < 60 THEN consecutive_fail + 1 ELSE 0 END,
            updated_at = NOW()
        WHERE user_id = $1""",
        user_id,
        '{' + str(lesson_id) + '}', str(score_pct / 100),
        '{' + str(bloom_level) + '}', str(score_pct / 100),
        score_pct
    )

    # Update error patterns
    for tag in error_tags:
        await _increment_error_pattern(db, user_id, tag, lesson_id)

    logger.info(f"quiz_submitted: user={user_id} score={score_pct}% bloom={bloom_level}")


async def handle_assignment_submitted(event: Dict[str, Any], db, redis) -> None:
    """LM: mastery_map, error_patterns, preferred_model"""
    payload = event.get('payload', {})
    user_id = event['learner_id']
    score = payload.get('score', 0)
    error_types = payload.get('error_types', [])

    for et in error_types:
        await _increment_error_pattern(db, user_id, et, event.get('lesson_id'))

    logger.info(f"assignment_submitted: user={user_id} score={score}")


async def handle_session_started(event: Dict[str, Any], db, redis) -> None:
    """LM: last_session_at, session_count, engagement. Check R04."""
    user_id = event['learner_id']
    await db.execute(
        """UPDATE learner_models SET
            last_session_at = NOW(),
            total_study_minutes = total_study_minutes + 0,
            updated_at = NOW()
        WHERE user_id = $1""",
        user_id
    )
    logger.info(f"session_started: user={user_id}")


async def handle_session_ended(event: Dict[str, Any], db, redis) -> None:
    """LM: total_session_time, engagement. Snapshot LM."""
    user_id = event['learner_id']
    duration_min = event.get('payload', {}).get('duration_min', 0)

    await db.execute(
        """UPDATE learner_models SET
            total_study_minutes = total_study_minutes + $2,
            updated_at = NOW()
        WHERE user_id = $1""",
        user_id, duration_min
    )

    # Snapshot LM
    await db.execute(
        """INSERT INTO learner_model_snapshots (user_id, snapshot, trigger_event)
        SELECT user_id, row_to_json(lm), 'session_ended'
        FROM learner_models lm WHERE user_id = $1""",
        user_id
    )
    logger.info(f"session_ended: user={user_id} duration={duration_min}min")


async def handle_lesson_completed(event: Dict[str, Any], db, redis) -> None:
    """LM: mastery_map, consecutive_pass, last_lesson_id. RUN RULE ENGINE."""
    user_id = event['learner_id']
    lesson_id = event.get('lesson_id')
    score = event.get('payload', {}).get('final_score', 0)

    await db.execute(
        """UPDATE learner_models SET
            last_lesson_id = (SELECT id FROM lessons WHERE lesson_code = $2 LIMIT 1),
            consecutive_pass = CASE WHEN $3 >= 0.6 THEN consecutive_pass + 1 ELSE 0 END,
            consecutive_fail = CASE WHEN $3 < 0.6 THEN consecutive_fail + 1 ELSE 0 END,
            updated_at = NOW()
        WHERE user_id = $1""",
        user_id, lesson_id, score
    )
    logger.info(f"lesson_completed: user={user_id} lesson={lesson_id} score={score}")
    # TODO: Trigger Rule Engine R01-R10 here


async def handle_aura_quiz_answer(event: Dict[str, Any], db, redis) -> None:
    """LM: error_patterns, engagement. From AURA HTML iframe."""
    user_id = event['learner_id']
    payload = event.get('payload', {})
    correct = payload.get('correct', False)

    if not correct:
        error_type = payload.get('error_type', 'unknown')
        await _increment_error_pattern(db, user_id, error_type, event.get('lesson_id'))

    # Positive engagement signal (still in lesson)
    await db.execute(
        """UPDATE learner_models SET
            engagement_score = LEAST(1.0, engagement_score + 0.02),
            updated_at = NOW()
        WHERE user_id = $1""",
        user_id
    )
    logger.info(f"aura_quiz_answer: user={user_id} correct={correct}")


async def handle_exit_ticket(event: Dict[str, Any], db, redis) -> None:
    """LM: engagement += 0.1. Notify teacher if confusion detected."""
    user_id = event['learner_id']
    confusion = event.get('payload', {}).get('confusion_detected', False)

    await db.execute(
        """UPDATE learner_models SET
            engagement_score = LEAST(1.0, engagement_score + 0.1),
            updated_at = NOW()
        WHERE user_id = $1""",
        user_id
    )

    if confusion:
        logger.warning(f"exit_ticket: user={user_id} CONFUSION detected — notifying teacher")
        # TODO: Send notification to teacher

    logger.info(f"exit_ticket: user={user_id} confusion={confusion}")


async def handle_video_milestone(event: Dict[str, Any], db, redis) -> None:
    """LM: engagement += 0.05 when 100% complete."""
    user_id = event['learner_id']
    pct = event.get('payload', {}).get('percentage', 0)

    if pct >= 100:
        await db.execute(
            """UPDATE learner_models SET
                engagement_score = LEAST(1.0, engagement_score + 0.05),
                updated_at = NOW()
            WHERE user_id = $1""",
            user_id
        )
    logger.info(f"video_milestone: user={user_id} pct={pct}")


async def handle_exam_graded(event: Dict[str, Any], db, redis) -> None:
    """LM: exam_history, mastery weight=0.3 (nhẹ hơn quiz=0.7 vì thi có áp lực)."""
    user_id = event['learner_id']
    payload = event.get('payload', {})
    score_pct = payload.get('score_pct', 0)
    exam_id = payload.get('exam_id')

    # Mastery update with weight=0.3
    # mastery_new = mastery_old * 0.7 + exam_score * 0.3
    lesson_scores = payload.get('lesson_scores', {})
    for lesson_code, score in lesson_scores.items():
        await db.execute(
            """UPDATE learner_models SET
                mastery_map = jsonb_set(
                    mastery_map, $2,
                    ((COALESCE((mastery_map->>$3)::float, 0.5) * 0.7 + $4 * 0.3)::text)::jsonb
                ),
                updated_at = NOW()
            WHERE user_id = $1""",
            user_id, '{' + lesson_code + '}', lesson_code, score
        )

    logger.info(f"exam_graded: user={user_id} exam={exam_id} score={score_pct}%")


async def handle_flashcard_deck_mastered(event: Dict[str, Any], db, redis) -> None:
    """LM: srl_engagement.goal_done++. Badge check."""
    user_id = event['learner_id']

    # Check badge: flashcard_champion if mastered >= 5 decks
    # For now just log
    logger.info(f"flashcard_deck_mastered: user={user_id}")


async def handle_badge_earned(event: Dict[str, Any], db, redis) -> None:
    """LM: tags append badge_type."""
    user_id = event['learner_id']
    badge_type = event.get('payload', {}).get('badge_type', '')

    await db.execute(
        """UPDATE learner_models SET
            tags = array_append(tags, $2),
            updated_at = NOW()
        WHERE user_id = $1 AND NOT ($2 = ANY(tags))""",
        user_id, badge_type
    )
    logger.info(f"badge_earned: user={user_id} badge={badge_type}")


async def handle_streak_milestone(event: Dict[str, Any], db, redis) -> None:
    """LM: consecutive_pass, tags. Streak 7d/30d check."""
    user_id = event['learner_id']
    streak_days = event.get('payload', {}).get('streak_days', 0)

    if streak_days >= 30:
        await db.execute(
            """UPDATE learner_models SET tags = array_append(tags, 'fast_learner')
            WHERE user_id = $1 AND NOT ('fast_learner' = ANY(tags))""",
            user_id
        )
    logger.info(f"streak_milestone: user={user_id} days={streak_days}")


async def handle_journal_saved(event: Dict[str, Any], db, redis) -> None:
    """LM: srl_engagement.journal_count++."""
    user_id = event['learner_id']
    # Agent reads metadata only (word_count), NOT content (privacy)
    word_count = event.get('payload', {}).get('word_count', 0)
    logger.info(f"journal_saved: user={user_id} words={word_count}")


# ── Handler Registry ──────────────────────────────────────────────────────────

HANDLERS: Dict[str, Any] = {
    'quiz_submitted': handle_quiz_submitted,
    'assignment_submitted': handle_assignment_submitted,
    'session_started': handle_session_started,
    'session_ended': handle_session_ended,
    'lesson_completed': handle_lesson_completed,
    'AURA_HTML_QUIZ_ANSWER': handle_aura_quiz_answer,
    'AURA_EXIT_TICKET_SUBMITTED': handle_exit_ticket,
    'AURA_VIDEO_MILESTONE': handle_video_milestone,
    'EXAM_GRADED': handle_exam_graded,
    'FLASHCARD_DECK_MASTERED': handle_flashcard_deck_mastered,
    'BADGE_EARNED': handle_badge_earned,
    'STREAK_MILESTONE': handle_streak_milestone,
    'METACOGNITION_JOURNAL_SAVED': handle_journal_saved,
}


async def process_event(event: Dict[str, Any], db, redis) -> bool:
    """
    Main entry point. Routes event to correct handler.
    Returns True if processed, False if unknown type.
    Idempotency enforced by caller via Redis SET.
    """
    event_type = event.get('event_type', '')
    handler = HANDLERS.get(event_type)
    if not handler:
        logger.warning(f"Unknown event type: {event_type}")
        return False

    try:
        await handler(event, db, redis)
        return True
    except Exception as e:
        logger.error(f"Error processing {event_type}: {e}", exc_info=True)
        raise


# ── Helper ────────────────────────────────────────────────────────────────────

async def _increment_error_pattern(
    db, user_id: str, error_type: str, lesson_id: Optional[str] = None
) -> None:
    """Increment error_patterns count for a specific error type."""
    # This is a simplified version — production would use JSONB path operations
    await db.execute(
        """UPDATE learner_models SET
            error_patterns = error_patterns || jsonb_build_object(
                $2, COALESCE((error_patterns->>$2)::int, 0) + 1
            ),
            updated_at = NOW()
        WHERE user_id = $1""",
        user_id, error_type
    )

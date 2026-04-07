"""
Event Processor — Redis Streams Consumer
Source: SRS-CH04 §4.5.2
Consumes events from Redis Stream → updates Learner Model → triggers Curriculum Planner
"""
import asyncio
import json
import logging
from datetime import datetime, timezone

import aioredis
import asyncpg

from ..core.learner_model import (
    calculate_mastery, detect_error_patterns, assess_solo_level,
    update_bloom_profile, QuizAttempt
)
from ..core.curriculum_planner import plan_next_lesson

logger = logging.getLogger(__name__)

STREAM_KEY = 'stream:events'
CONSUMER_GROUP = 'agent-processor'
CONSUMER_NAME = 'event-processor-1'


async def process_quiz_submitted(user_id: str, payload: dict, db, redis):
    """
    Handle quiz_submitted event:
    1. Fetch existing attempts
    2. Recalculate mastery_score
    3. Update error_patterns
    4. Update bloom_profile
    5. Assess SOLO level
    6. Run Curriculum Planner
    7. Store agent_decision
    8. Notify via Redis pub/sub
    """
    lesson_id = payload.get('lesson_id')
    score = float(payload.get('score', 0))
    max_score = float(payload.get('max_score', 1))
    error_tags = payload.get('error_tags', [])
    hint_count = int(payload.get('hint_count', 0))
    time_taken_sec = int(payload.get('time_taken_sec', 0))
    bloom_level = int(payload.get('bloom_level', 3))

    score_ratio = score / max_score if max_score > 0 else 0.0

    # 1. Fetch all attempts for this lesson
    rows = await db.fetch(
        """SELECT score / max_score as ratio, submitted_at, attempt_number, error_tags
           FROM quiz_attempts WHERE user_id = $1 AND lesson_id = $2
           ORDER BY submitted_at""",
        user_id, lesson_id
    )
    attempts = [
        QuizAttempt(
            score=float(r['ratio']),
            submitted_at=r['submitted_at'],
            attempt_number=r['attempt_number'],
            error_tags=r['error_tags'] or [],
        ) for r in rows
    ]
    # Add current attempt
    attempts.append(QuizAttempt(
        score=score_ratio,
        submitted_at=datetime.now(timezone.utc),
        attempt_number=len(attempts) + 1,
        error_tags=error_tags,
        time_taken_sec=time_taken_sec,
    ))

    # 2. Calculate mastery
    mastery = calculate_mastery(attempts)
    # 3. Error patterns
    errors = detect_error_patterns(attempts)
    # 4. SOLO level
    expected_time = 300  # default 5 min
    time_ratio = time_taken_sec / expected_time if expected_time > 0 else 1.0
    solo = assess_solo_level(score_ratio, hint_count, time_ratio, error_tags)

    # 5. Update Learner Model in DB
    lm = await db.fetchrow('SELECT * FROM learner_models WHERE user_id = $1', user_id)
    if not lm:
        await db.execute(
            'INSERT INTO learner_models (user_id) VALUES ($1) ON CONFLICT DO NOTHING', user_id)
        lm = await db.fetchrow('SELECT * FROM learner_models WHERE user_id = $1', user_id)

    lm_dict = dict(lm)
    mastery_map = json.loads(lm_dict.get('mastery_map') or '{}')
    lesson_code = payload.get('lesson_code', '')
    mastery_map[lesson_code] = mastery.score

    bloom_profile = json.loads(lm_dict.get('bloom_profile') or '{}')
    bloom_profile = update_bloom_profile(bloom_profile, bloom_level, score_ratio)

    solo_profile = json.loads(lm_dict.get('solo_profile') or '{}')
    solo_profile[lesson_code] = {'achieved': solo, 'target': payload.get('solo_target', 4)}

    new_consec_pass = (lm_dict['consecutive_pass'] + 1) if score_ratio >= 0.7 else 0
    new_consec_fail = (lm_dict['consecutive_fail'] + 1) if score_ratio < 0.5 else 0

    await db.execute(
        """UPDATE learner_models SET
           mastery_map = $1, bloom_profile = $2, solo_profile = $3,
           error_patterns = $4, consecutive_pass = $5, consecutive_fail = $6,
           last_lesson_id = $7, updated_at = NOW()
           WHERE user_id = $8""",
        json.dumps(mastery_map), json.dumps(bloom_profile), json.dumps(solo_profile),
        json.dumps(errors), new_consec_pass, new_consec_fail,
        lesson_id, user_id
    )

    # 6. Invalidate Redis cache
    await redis.delete(f'learner_model:{user_id}')

    # 7. Curriculum Planner
    updated_lm = dict(await db.fetchrow('SELECT * FROM learner_models WHERE user_id = $1', user_id))
    lesson = dict(await db.fetchrow('SELECT * FROM lessons WHERE id = $1', lesson_id) or {})
    catalog = [dict(r) for r in await db.fetch('SELECT * FROM lessons WHERE status = $1', 'published')]

    decision = await plan_next_lesson(updated_lm, lesson, catalog, db)

    # 8. Store decision
    await db.execute(
        """INSERT INTO agent_decisions
           (user_id, trigger_event_id, rule_fired, next_lesson_id, reason, confidence, learner_model_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)""",
        user_id, payload.get('event_id'), decision.rule_fired,
        decision.next_lesson_id, decision.reason, decision.confidence,
        json.dumps(updated_lm)
    )

    # 9. Notify via pub/sub → SSE to frontend
    await redis.publish(f'user:{user_id}:events', json.dumps({
        'type': 'recommendation',
        'rule': decision.rule_fired,
        'next_lesson_id': decision.next_lesson_id,
        'reason': decision.reason,
        'action': decision.action,
    }))

    logger.info(f"Processed quiz_submitted for {user_id}: mastery={mastery.score:.2f} rule={decision.rule_fired}")


async def consume_events():
    """Main consumer loop — Redis Streams with consumer group."""
    redis = await aioredis.from_url(
        'redis://redis:6379',
        password=__import__('os').getenv('REDIS_PASSWORD', ''),
        decode_responses=True,
    )
    db = await asyncpg.connect(__import__('os').getenv('DATABASE_URL'))

    # Create consumer group if not exists
    try:
        await redis.xgroup_create(STREAM_KEY, CONSUMER_GROUP, id='0', mkstream=True)
    except Exception:
        pass  # Already exists

    logger.info(f"Event Processor started: group={CONSUMER_GROUP}")

    while True:
        try:
            messages = await redis.xreadgroup(
                CONSUMER_GROUP, CONSUMER_NAME,
                {STREAM_KEY: '>'},
                count=10, block=5000,
            )
            for stream, events in (messages or []):
                for event_id, data in events:
                    try:
                        event_type = data.get('event_type')
                        user_id = data.get('user_id')
                        payload = json.loads(data.get('payload', '{}'))
                        payload['event_id'] = event_id

                        if event_type == 'quiz_submitted':
                            await process_quiz_submitted(user_id, payload, db, redis)
                        # Add more event handlers here

                        await redis.xack(STREAM_KEY, CONSUMER_GROUP, event_id)

                    except Exception as e:
                        logger.error(f"Error processing event {event_id}: {e}")
                        # Dead-letter queue
                        await redis.xadd('stream:events:dead', {'original_id': event_id, 'error': str(e)})
                        await redis.xack(STREAM_KEY, CONSUMER_GROUP, event_id)

        except Exception as e:
            logger.error(f"Consumer loop error: {e}")
            await asyncio.sleep(5)


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    asyncio.run(consume_events())

"""
Spaced Repetition Engine — SM-2 Algorithm
Source: SRS-CH08 §8.4 Flashcard Review Schedule

SM-2 algorithm: https://www.supermemo.com/en/archives1990-2015/english/ol/sm2
Intervals are capped at 365 days; EF is clamped to [1.3, 2.5].
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

import asyncpg

logger = logging.getLogger(__name__)


# ─── Data model ──────────────────────────────────────────────────────────────

@dataclass
class SM2State:
    """Mutable SM-2 scheduling state for a single flashcard–student pair."""
    ease_factor: float = 2.5    # EF range [1.3, 2.5], default 2.5
    interval_days: float = 1.0  # Days until next review
    repetitions: int = 0        # Consecutive successful reviews


# ─── Core algorithm ──────────────────────────────────────────────────────────

def sm2_update(state: SM2State, quality: int) -> tuple[SM2State, datetime]:
    """
    Apply one SM-2 review step and return (new_state, next_review_at).

    quality: 0–5
        0 — complete blackout
        1 — incorrect; correct answer was easy to recall
        2 — incorrect; but correct answer seemed easy when revealed
        3 — correct with serious difficulty
        4 — correct after hesitation
        5 — perfect response

    Algorithm (per Wozniak 1987):
    - If quality < 3: reset repetitions to 0, re-schedule in 1 day (relearn).
    - Otherwise:
        rep=0 → interval=1
        rep=1 → interval=6
        rep≥2 → interval = round(prev_interval × EF)
      EF' = EF + (0.1 − (5−q)·(0.08 + (5−q)·0.02))
      EF' = clamp(EF', 1.3, 2.5)
      interval = min(interval, 365)
    """
    if not (0 <= quality <= 5):
        raise ValueError(f"quality must be 0–5, got {quality}")

    new_ef = state.ease_factor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02))
    new_ef = max(1.3, min(2.5, new_ef))

    if quality < 3:
        new_state = SM2State(
            ease_factor=new_ef,
            interval_days=1.0,
            repetitions=0,
        )
        next_review = datetime.now(timezone.utc) + timedelta(days=1)
        return new_state, next_review

    # Successful recall — advance interval
    if state.repetitions == 0:
        new_interval = 1.0
    elif state.repetitions == 1:
        new_interval = 6.0
    else:
        new_interval = round(state.interval_days * state.ease_factor)

    new_interval = min(float(new_interval), 365.0)

    new_state = SM2State(
        ease_factor=new_ef,
        interval_days=new_interval,
        repetitions=state.repetitions + 1,
    )
    next_review = datetime.now(timezone.utc) + timedelta(days=new_interval)
    return new_state, next_review


# ─── Database helpers ────────────────────────────────────────────────────────

async def get_due_flashcards(
    user_id: str,
    db: asyncpg.Pool,
    limit: int = 20,
) -> list[dict]:
    """
    Return flashcards due for review today (next_review_at <= NOW()).

    Ordering:
        1. Overdue first (NULL next_review_at = never reviewed = highest priority).
        2. Ties broken by how many days overdue (most overdue first).

    Returns a list of plain dicts matching the flashcards / flashcard_reviews schema.
    """
    rows = await db.fetch(
        """
        SELECT
            f.id,
            f.lesson_id,
            f.front,
            f.back,
            f.difficulty,
            f.tags,
            fr.ease_factor,
            fr.interval_days,
            fr.repetitions,
            fr.next_review_at,
            fr.quality AS last_quality
        FROM flashcards f
        LEFT JOIN flashcard_reviews fr
               ON fr.flashcard_id = f.id
              AND fr.user_id      = $1
        WHERE (fr.next_review_at IS NULL OR fr.next_review_at <= NOW())
        ORDER BY fr.next_review_at ASC NULLS FIRST
        LIMIT $2
        """,
        user_id,
        limit,
    )
    return [dict(r) for r in rows]


async def process_review(
    user_id: str,
    flashcard_id: str,
    quality: int,
    db: asyncpg.Pool,
) -> dict:
    """
    Process a single flashcard review:
        1. Fetch the student's latest SM-2 state for this card.
        2. Apply sm2_update().
        3. Persist the new state (INSERT — keeps full review history).
        4. Return a summary dict with next_review_at and updated SM-2 fields.
    """
    if not (0 <= quality <= 5):
        raise ValueError(f"quality must be 0–5, got {quality}")

    row = await db.fetchrow(
        """
        SELECT ease_factor, interval_days, repetitions
        FROM flashcard_reviews
        WHERE user_id = $1 AND flashcard_id = $2
        ORDER BY reviewed_at DESC
        LIMIT 1
        """,
        user_id,
        flashcard_id,
    )

    current = SM2State(
        ease_factor=float(row["ease_factor"]) if row else 2.5,
        interval_days=float(row["interval_days"]) if row else 1.0,
        repetitions=int(row["repetitions"]) if row else 0,
    )

    new_state, next_review = sm2_update(current, quality)

    await db.execute(
        """
        INSERT INTO flashcard_reviews
            (user_id, flashcard_id, quality, ease_factor, interval_days,
             repetitions, next_review_at, reviewed_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        """,
        user_id,
        flashcard_id,
        quality,
        new_state.ease_factor,
        new_state.interval_days,
        new_state.repetitions,
        next_review,
    )

    logger.debug(
        "review processed user=%s card=%s quality=%d interval=%.1fd next=%s",
        user_id, flashcard_id, quality, new_state.interval_days, next_review.isoformat(),
    )

    return {
        "next_review_at": next_review.isoformat(),
        "interval_days": new_state.interval_days,
        "ease_factor": round(new_state.ease_factor, 4),
        "repetitions": new_state.repetitions,
        "mastered": new_state.repetitions >= 5,
    }


async def get_review_stats(user_id: str, db: asyncpg.Pool) -> dict:
    """
    Aggregate spaced-repetition stats for a user:
        - total cards ever reviewed
        - cards due today
        - cards mastered (repetitions >= 5)
        - average ease factor
    """
    row = await db.fetchrow(
        """
        SELECT
            COUNT(DISTINCT flashcard_id)                         AS total_reviewed,
            SUM(CASE WHEN next_review_at <= NOW() THEN 1 ELSE 0 END) AS due_today,
            SUM(CASE WHEN repetitions >= 5 THEN 1 ELSE 0 END)   AS mastered,
            ROUND(AVG(ease_factor)::numeric, 4)                  AS avg_ease_factor
        FROM (
            SELECT DISTINCT ON (flashcard_id)
                flashcard_id,
                repetitions,
                ease_factor,
                next_review_at
            FROM flashcard_reviews
            WHERE user_id = $1
            ORDER BY flashcard_id, reviewed_at DESC
        ) latest
        """,
        user_id,
    )
    if not row:
        return {"total_reviewed": 0, "due_today": 0, "mastered": 0, "avg_ease_factor": 2.5}
    return dict(row)

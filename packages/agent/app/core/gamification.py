"""
Gamification Engine — XP, Levels, Badges, Streaks
Source: SRS-CH08 §8.7

Design decisions:
- XP is event-driven: callers fire award_xp() with a reason key.
- Level thresholds are hard-coded (LEVELS table); no DB round-trip needed.
- Badges are checked deterministically from trigger → badge mapping.
- All writes are idempotent-safe (ON CONFLICT for student_xp row).
- Badge earned_at is stored in JSONB alongside badge metadata.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone, date
from typing import Optional

import asyncpg

logger = logging.getLogger(__name__)


# ─── XP reward table (SRS-CH08 §8.7.2) ──────────────────────────────────────

XP_REWARDS: dict[str, int] = {
    "quiz_passed":          50,
    "quiz_perfect":         100,   # 100 % score
    "quiz_first_try":       25,    # extra bonus for first-attempt pass
    "lesson_completed":     30,
    "streak_3_days":        20,
    "streak_7_days":        50,
    "streak_30_days":       200,
    "flashcard_review":     5,
    "flashcard_mastered":   20,    # repetitions >= 5
    "peer_expert":          150,   # teach-back role awarded by teacher
    "journal_entry":        10,
    "threshold_passed":     75,    # passes a threshold concept assessment
    "deep_learning":        15,    # completes a deep-learning activity
}


# ─── Level thresholds (cumulative XP) ────────────────────────────────────────
#
# Each entry: (min_xp, level_number, level_name_vi)
# Levels are evaluated in reverse order (highest first) for efficiency.

LEVELS: list[tuple[int, int, str]] = [
    (0,    1,  "Người mới bắt đầu"),
    (100,  2,  "Học viên"),
    (300,  3,  "Người khám phá"),
    (600,  4,  "Người học tích cực"),
    (1000, 5,  "Nhà tư duy"),
    (1500, 6,  "Học giả"),
    (2200, 7,  "Chuyên gia trẻ"),
    (3000, 8,  "Nhà nghiên cứu"),
    (4000, 9,  "Bậc thầy"),
    (5500, 10, "Thiên tài"),
]

_LEVELS_DESC = sorted(LEVELS, key=lambda t: t[0], reverse=True)


# ─── Badge registry (SRS-CH08 §8.7.3) ────────────────────────────────────────

BADGES: dict[str, dict] = {
    "first_quiz":       {"name": "Bài thi đầu tiên",       "icon": "🎯", "condition": "first_quiz_submitted"},
    "perfect_score":    {"name": "Điểm tuyệt đối",         "icon": "💯", "condition": "quiz_perfect"},
    "week_streak":      {"name": "Kiên trì 7 ngày",        "icon": "🔥", "condition": "streak_7_days"},
    "month_streak":     {"name": "Bền bỉ 30 ngày",         "icon": "⚡", "condition": "streak_30_days"},
    "flashcard_50":     {"name": "Ôn tập 50 thẻ",          "icon": "📚", "condition": "flashcard_50_reviewed"},
    "peer_expert":      {"name": "Chuyên gia đồng học",    "icon": "🏆", "condition": "peer_expert_role"},
    "deep_learner":     {"name": "Tư duy sâu",             "icon": "🧠", "condition": "deep_learning_approach_10"},
    "threshold_passed": {"name": "Vượt ngưỡng khái niệm", "icon": "🚀", "condition": "threshold_concept_passed"},
    "three_day_streak": {"name": "Khởi đầu tốt",          "icon": "✨", "condition": "streak_3_days"},
}

# Maps XP-reason → list of badge IDs that can be unlocked by that reason
_BADGE_TRIGGERS: dict[str, list[str]] = {
    "quiz_passed":       ["first_quiz"],
    "quiz_perfect":      ["perfect_score"],
    "streak_3_days":     ["three_day_streak"],
    "streak_7_days":     ["week_streak"],
    "streak_30_days":    ["month_streak"],
    "peer_expert":       ["peer_expert"],
    "threshold_passed":  ["threshold_passed"],
    "deep_learning":     ["deep_learner"],
}


# ─── Level helpers ────────────────────────────────────────────────────────────

def get_level_for_xp(total_xp: int) -> tuple[int, str, int]:
    """
    Return (level_number, level_name, xp_to_next_level) for a given cumulative XP.
    xp_to_next_level is 0 when the student has reached the maximum level.
    """
    for min_xp, level_num, level_name in _LEVELS_DESC:
        if total_xp >= min_xp:
            # Find next level
            idx = LEVELS.index((min_xp, level_num, level_name))
            if idx + 1 < len(LEVELS):
                xp_to_next = LEVELS[idx + 1][0] - total_xp
            else:
                xp_to_next = 0  # max level
            return level_num, level_name, max(0, xp_to_next)

    # Fallback: below first threshold
    return 1, "Người mới bắt đầu", max(0, 100 - total_xp)


# ─── Streak management ───────────────────────────────────────────────────────

async def update_streak(user_id: str, db: asyncpg.Pool) -> dict:
    """
    Record daily activity for streak tracking.
    Returns updated streak info and any streak-milestone reasons to award XP for.
    Should be called once per day per user on any meaningful learning activity.
    """
    row = await db.fetchrow(
        """
        SELECT current_streak, longest_streak, last_activity_date
        FROM student_xp
        WHERE user_id = $1
        """,
        user_id,
    )

    today = date.today()
    xp_reasons: list[str] = []

    if row is None:
        new_streak = 1
        longest_streak = 1
    else:
        last: Optional[date] = row["last_activity_date"]
        current = int(row["current_streak"] or 0)
        longest = int(row["longest_streak"] or 0)

        if last is None:
            new_streak = 1
        elif (today - last).days == 0:
            # Already checked in today — no change
            return {
                "current_streak": current,
                "longest_streak": longest,
                "xp_reasons": [],
            }
        elif (today - last).days == 1:
            new_streak = current + 1
        else:
            # Gap in streak — reset
            new_streak = 1

        longest_streak = max(new_streak, longest)

    # Check milestone thresholds
    if new_streak == 3:
        xp_reasons.append("streak_3_days")
    if new_streak == 7:
        xp_reasons.append("streak_7_days")
    if new_streak == 30:
        xp_reasons.append("streak_30_days")

    # Persist updated streak fields (upsert handled in award_xp / caller)
    await db.execute(
        """
        INSERT INTO student_xp (user_id, total_xp, level, level_name, badges,
                                current_streak, longest_streak, last_activity_date, updated_at)
        VALUES ($1, 0, 1, 'Người mới bắt đầu', '[]'::jsonb, $2, $3, $4, NOW())
        ON CONFLICT (user_id) DO UPDATE SET
            current_streak    = $2,
            longest_streak    = $3,
            last_activity_date = $4,
            updated_at        = NOW()
        """,
        user_id,
        new_streak,
        longest_streak,
        today,
    )

    return {
        "current_streak": new_streak,
        "longest_streak": longest_streak,
        "xp_reasons": xp_reasons,
    }


# ─── Badge helpers ────────────────────────────────────────────────────────────

def _check_new_badges(
    trigger: str,
    existing_badge_ids: set[str],
    db_extra_check: Optional[dict] = None,
) -> list[dict]:
    """
    Pure function: return list of newly earned badge dicts for a given trigger.
    db_extra_check can carry pre-fetched counts (e.g. total flashcards reviewed).
    """
    new: list[dict] = []
    now_iso = datetime.now(timezone.utc).isoformat()

    for badge_id in _BADGE_TRIGGERS.get(trigger, []):
        if badge_id not in existing_badge_ids:
            badge = BADGES[badge_id].copy()
            badge["id"] = badge_id
            badge["earned_at"] = now_iso
            new.append(badge)

    # Special case: flashcard_50 badge — needs count check from caller
    if trigger == "flashcard_mastered" and "flashcard_50" not in existing_badge_ids:
        count = (db_extra_check or {}).get("total_flashcard_reviews", 0)
        if count >= 50:
            badge = BADGES["flashcard_50"].copy()
            badge["id"] = "flashcard_50"
            badge["earned_at"] = now_iso
            new.append(badge)

    return new


# ─── Core XP award ───────────────────────────────────────────────────────────

async def award_xp(
    user_id: str,
    reason: str,
    ref_id: Optional[str],
    db: asyncpg.Pool,
    extra_check: Optional[dict] = None,
) -> dict:
    """
    Award XP to a student for a named reason.

    Steps:
        1. Look up XP amount from XP_REWARDS.
        2. Insert an xp_transactions row.
        3. Upsert student_xp with new totals.
        4. Determine level-up and new badges.
        5. Return event summary.

    Args:
        user_id:     Student UUID.
        reason:      Key from XP_REWARDS (e.g. "quiz_passed").
        ref_id:      Optional reference UUID (quiz_attempt_id, flashcard_id, …).
        db:          asyncpg Pool.
        extra_check: Optional pre-fetched context used by badge checks
                     (e.g. {"total_flashcard_reviews": 52}).

    Returns dict with keys:
        xp_awarded, total_xp, level, level_name, xp_to_next,
        level_up, new_level (if level_up), new_badges (list)
    """
    amount = XP_REWARDS.get(reason, 0)
    if amount == 0:
        logger.warning("award_xp called with unknown reason=%s for user=%s", reason, user_id)
        return {"xp_awarded": 0, "level_up": False, "new_badges": []}

    # 1. Record transaction
    await db.execute(
        """
        INSERT INTO xp_transactions (user_id, amount, reason, ref_id, created_at)
        VALUES ($1, $2, $3, $4, NOW())
        """,
        user_id,
        amount,
        reason,
        ref_id,
    )

    # 2. Fetch current state
    row = await db.fetchrow(
        "SELECT total_xp, level, badges, current_streak, longest_streak FROM student_xp WHERE user_id = $1",
        user_id,
    )
    old_xp = int(row["total_xp"]) if row else 0
    old_level = int(row["level"]) if row else 1
    old_badges_raw = row["badges"] if row else "[]"

    # Deserialize badges — stored as JSONB (list of badge dicts)
    if isinstance(old_badges_raw, list):
        old_badges: list[dict] = old_badges_raw
    elif isinstance(old_badges_raw, str):
        try:
            old_badges = json.loads(old_badges_raw)
        except json.JSONDecodeError:
            old_badges = []
    else:
        old_badges = []

    existing_badge_ids: set[str] = {
        b["id"] if isinstance(b, dict) else b for b in old_badges
    }

    # 3. Compute new XP and level
    new_xp = old_xp + amount
    new_level_num, new_level_name, xp_to_next = get_level_for_xp(new_xp)

    # 4. Check badge unlocks
    new_badges = _check_new_badges(reason, existing_badge_ids, extra_check)
    all_badges = old_badges + new_badges

    # 5. Upsert student_xp
    await db.execute(
        """
        INSERT INTO student_xp
            (user_id, total_xp, level, level_name, badges,
             current_streak, longest_streak, last_activity_date, updated_at)
        VALUES ($1, $2, $3, $4, $5::jsonb, 0, 0, CURRENT_DATE, NOW())
        ON CONFLICT (user_id) DO UPDATE SET
            total_xp   = $2,
            level      = $3,
            level_name = $4,
            badges     = $5::jsonb,
            updated_at = NOW()
        """,
        user_id,
        new_xp,
        new_level_num,
        new_level_name,
        json.dumps(all_badges, ensure_ascii=False),
    )

    level_up = new_level_num > old_level
    logger.info(
        "xp awarded user=%s reason=%s amount=%d total=%d level=%d level_up=%s badges=%s",
        user_id, reason, amount, new_xp, new_level_num, level_up,
        [b["id"] for b in new_badges],
    )

    return {
        "xp_awarded": amount,
        "total_xp": new_xp,
        "level": new_level_num,
        "level_name": new_level_name,
        "xp_to_next": xp_to_next,
        "level_up": level_up,
        "new_level": new_level_name if level_up else None,
        "new_badges": new_badges,
    }


async def get_leaderboard(
    db: asyncpg.Pool,
    class_id: Optional[str] = None,
    limit: int = 20,
) -> list[dict]:
    """
    Return top students by total XP.
    Optionally filter by class membership.
    """
    if class_id:
        rows = await db.fetch(
            """
            SELECT
                sx.user_id,
                u.name,
                u.avatar_url,
                sx.total_xp,
                sx.level,
                sx.level_name,
                sx.current_streak,
                RANK() OVER (ORDER BY sx.total_xp DESC) AS rank
            FROM student_xp sx
            JOIN users u ON u.id = sx.user_id
            JOIN class_memberships cm ON cm.student_id = sx.user_id
            WHERE cm.class_id = $1
              AND u.is_active = true
            ORDER BY sx.total_xp DESC
            LIMIT $2
            """,
            class_id,
            limit,
        )
    else:
        rows = await db.fetch(
            """
            SELECT
                sx.user_id,
                u.name,
                u.avatar_url,
                sx.total_xp,
                sx.level,
                sx.level_name,
                sx.current_streak,
                RANK() OVER (ORDER BY sx.total_xp DESC) AS rank
            FROM student_xp sx
            JOIN users u ON u.id = sx.user_id
            WHERE u.is_active = true AND u.role = 'student'
            ORDER BY sx.total_xp DESC
            LIMIT $1
            """,
            limit,
        )
    return [dict(r) for r in rows]


async def get_xp_history(
    user_id: str,
    db: asyncpg.Pool,
    page: int = 1,
    page_size: int = 20,
) -> dict:
    """
    Return paginated XP transaction history for a user.
    """
    offset = (page - 1) * page_size
    rows = await db.fetch(
        """
        SELECT id, amount, reason, ref_id, created_at
        FROM xp_transactions
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
        """,
        user_id,
        page_size,
        offset,
    )
    total = await db.fetchval(
        "SELECT COUNT(*) FROM xp_transactions WHERE user_id = $1",
        user_id,
    )
    return {
        "items": [dict(r) for r in rows],
        "total": int(total or 0),
        "page": page,
        "page_size": page_size,
    }

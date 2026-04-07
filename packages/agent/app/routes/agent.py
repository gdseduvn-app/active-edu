"""
AURA AdaptLearn — AI Agent Routes
Source: SRS-CH05 §5.6, SRS-CH08

Base prefix (registered in main.py): /api/v1/agent

Endpoints:
  GET  /flashcards/due              — Due flashcards for review (SM-2)
  POST /flashcards/review           — Submit a flashcard review (SM-2 quality 0–5)
  GET  /flashcards/stats            — Review stats for the current user
  POST /socratic                    — Socratic tutoring chat
  POST /metacognition               — Post-answer metacognitive reflection prompt
  POST /questions/generate          — AI-generate questions from lesson content
  POST /questions/save              — Save AI-generated questions to question bank
  POST /exam/blueprint              — Auto-select questions by Bloom distribution
  GET  /gamification/leaderboard    — Class leaderboard by XP
  GET  /gamification/profile        — XP / level / badges / streak for a user
  GET  /gamification/xp-history     — Paginated XP transaction history
  POST /xp/award                    — Manually award XP (teacher / admin)
  POST /chat                        — General AI tutor chat (Socratic wrapper)
  POST /adapt                       — Trigger adaptive lesson recommendation
  GET  /sessions/{session_id}       — Retrieve conversation history
"""
from __future__ import annotations

import json
import logging
from typing import Optional
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field, UUID4

from app.config import get_settings
from app.dependencies import get_current_user, get_db, get_redis
from app.core.spaced_repetition import (
    get_due_flashcards,
    process_review,
    get_review_stats,
)
from app.core.gamification import (
    award_xp,
    get_leaderboard,
    get_xp_history,
)
from app.core.socratic_engine import (
    get_socratic_response,
    get_metacognition_prompt,
    build_conversation_turn,
)
from app.core.question_generator import (
    generate_questions,
    generate_exam_blueprint,
    save_generated_questions,
)
from app.core.curriculum_planner import plan_next_lesson
from app.core.learner_model import calculate_mastery

logger = logging.getLogger(__name__)

router = APIRouter()


# ─── Pydantic schemas ─────────────────────────────────────────────────────────

class ReviewRequest(BaseModel):
    flashcard_id: UUID4
    quality: int = Field(..., ge=0, le=5, description="SM-2 quality rating 0–5")


class SocraticRequest(BaseModel):
    lesson_id: UUID4
    message: str = Field(..., min_length=1, max_length=4000)
    conversation_history: list[dict] = Field(default_factory=list)


class MetacognitionRequest(BaseModel):
    lesson_id: UUID4
    student_answer: str = Field(..., max_length=2000)
    correct_answer: str = Field(..., max_length=2000)


class GenerateQuestionsRequest(BaseModel):
    lesson_id: UUID4
    question_type: str = Field(..., description="mcq|true_false|fill_blank|short_answer|ordering|matching")
    bloom_level: int = Field(..., ge=1, le=6)
    count: int = Field(default=3, ge=1, le=10)
    save_to_bank: bool = Field(default=False, description="Persist generated questions as drafts")


class ExamBlueprintRequest(BaseModel):
    lesson_ids: list[UUID4]
    total_questions: int = Field(default=20, ge=1, le=100)
    total_points: int = Field(default=100, ge=1)
    bloom_distribution: dict[str, float] = Field(
        default={"1": 0.1, "2": 0.2, "3": 0.3, "4": 0.2, "5": 0.1, "6": 0.1},
        description="Bloom level → fraction (values must sum to ~1.0)",
    )


class AwardXpRequest(BaseModel):
    user_id: str = Field(..., description="Target student UUID")
    reason: str = Field(..., description="XP reason key (see XP_REWARDS)")
    ref_id: Optional[str] = Field(None, description="Optional reference entity UUID")


class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=4000)
    lesson_id: Optional[str] = Field(None)
    context_window: int = Field(default=10, ge=1, le=50)


class AdaptRequest(BaseModel):
    student_id: str
    lesson_id: str
    performance_data: dict


# ─── Dependency helpers ───────────────────────────────────────────────────────

async def _get_settings(request: Request):
    return get_settings()


async def _require_teacher_or_admin(current_user: dict = Depends(get_current_user)):
    role = current_user.get("role", "")
    if role not in ("teacher", "admin"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Teacher or admin role required",
        )
    return current_user


# ─── Flashcard / Spaced Repetition endpoints ─────────────────────────────────

@router.get(
    "/flashcards/due",
    summary="Get flashcards due for review today (SM-2)",
    status_code=status.HTTP_200_OK,
)
async def get_due_cards(
    limit: int = Query(default=20, ge=1, le=50),
    current_user: dict = Depends(get_current_user),
    db=Depends(get_db),
) -> dict:
    """Return up to `limit` flashcards whose next_review_at <= NOW()."""
    user_id: str = current_user["sub"]
    cards = await get_due_flashcards(user_id, db, limit=limit)
    return {"data": cards, "count": len(cards)}


@router.post(
    "/flashcards/review",
    summary="Submit a flashcard review (SM-2 quality 0–5)",
    status_code=status.HTTP_200_OK,
)
async def review_flashcard(
    body: ReviewRequest,
    current_user: dict = Depends(get_current_user),
    db=Depends(get_db),
) -> dict:
    """
    Process a review for the authenticated student.
    Updates SM-2 state and returns next_review_at + updated scheduling fields.
    """
    user_id: str = current_user["sub"]
    result = await process_review(user_id, str(body.flashcard_id), body.quality, db)

    # Award XP: 5 XP per review, 20 XP when mastered
    xp_reason = "flashcard_mastered" if result.get("mastered") else "flashcard_review"
    await award_xp(user_id, xp_reason, str(body.flashcard_id), db)

    return {"data": result}


@router.get(
    "/flashcards/stats",
    summary="Get spaced-repetition stats for the current user",
    status_code=status.HTTP_200_OK,
)
async def flashcard_stats(
    current_user: dict = Depends(get_current_user),
    db=Depends(get_db),
) -> dict:
    stats = await get_review_stats(current_user["sub"], db)
    return {"data": stats}


# ─── Socratic / Metacognition endpoints ──────────────────────────────────────

@router.post(
    "/socratic",
    summary="Socratic tutoring: guided questioning without direct answers",
    status_code=status.HTTP_200_OK,
)
async def socratic_chat(
    body: SocraticRequest,
    request: Request,
    current_user: dict = Depends(get_current_user),
    db=Depends(get_db),
    settings=Depends(_get_settings),
) -> dict:
    """
    Accept a student question and return a Socratic guiding question.
    Adapts depth to the student's mastery level for this lesson.
    """
    user_id: str = current_user["sub"]

    lesson = await db.fetchrow("SELECT * FROM lessons WHERE id = $1", str(body.lesson_id))
    if not lesson:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Lesson not found")

    # Fetch mastery from learner model
    lm_row = await db.fetchrow(
        "SELECT mastery_map FROM learner_models WHERE user_id = $1",
        user_id,
    )
    mastery = 0.5
    if lm_row and lm_row["mastery_map"]:
        mastery_map = lm_row["mastery_map"]
        if isinstance(mastery_map, str):
            mastery_map = json.loads(mastery_map)
        lesson_code = lesson.get("lesson_code") or str(body.lesson_id)
        mastery = float(mastery_map.get(lesson_code, 0.5))

    response = await get_socratic_response(
        conversation_history=body.conversation_history,
        student_message=body.message,
        lesson_context=dict(lesson),
        api_key=settings.ANTHROPIC_API_KEY,
        mastery_level=mastery,
    )

    # Persist conversation turn in Redis (keyed by user:lesson)
    redis = request.app.state.redis
    session_key = f"socratic:{user_id}:{body.lesson_id}"
    try:
        history = await redis.get(session_key)
        hist_list: list[dict] = json.loads(history) if history else []
        hist_list.append(build_conversation_turn("user", body.message))
        hist_list.append(build_conversation_turn("assistant", response["response"]))
        # Keep last 20 turns
        await redis.setex(session_key, 3600, json.dumps(hist_list[-20:], ensure_ascii=False))
    except Exception as exc:
        logger.warning("redis socratic history write failed: %s", exc)

    return {"data": response}


@router.post(
    "/metacognition",
    summary="Generate metacognitive reflection prompt after a student answer",
    status_code=status.HTTP_200_OK,
)
async def metacognition_prompt(
    body: MetacognitionRequest,
    current_user: dict = Depends(get_current_user),
    db=Depends(get_db),
    settings=Depends(_get_settings),
) -> dict:
    lesson = await db.fetchrow("SELECT title, bloom_level FROM lessons WHERE id = $1", str(body.lesson_id))
    if not lesson:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Lesson not found")

    prompt = await get_metacognition_prompt(
        student_answer=body.student_answer,
        correct_answer=body.correct_answer,
        lesson_context=dict(lesson),
        api_key=settings.ANTHROPIC_API_KEY,
    )
    return {"data": {"prompt": prompt}}


# ─── Question generation endpoints ───────────────────────────────────────────

@router.post(
    "/questions/generate",
    summary="AI-generate questions from lesson content (teacher/admin)",
    status_code=status.HTTP_200_OK,
)
async def generate_qs(
    body: GenerateQuestionsRequest,
    current_user: dict = Depends(_require_teacher_or_admin),
    db=Depends(get_db),
    settings=Depends(_get_settings),
) -> dict:
    """
    Generate questions using Claude from the lesson's parsed content.
    Optionally persists them as draft questions in the question bank.
    """
    lesson = await db.fetchrow(
        """
        SELECT l.id, l.title, l.lesson_code, l.bloom_level,
               lm.parsed_content
        FROM lessons l
        LEFT JOIN learning_materials lm ON lm.lesson_id = l.id AND lm.is_current = true
        WHERE l.id = $1
        """,
        str(body.lesson_id),
    )
    if not lesson:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Lesson not found")

    # Extract text from parsed_content JSONB
    content = ""
    if lesson["parsed_content"]:
        raw = lesson["parsed_content"]
        if isinstance(raw, str):
            raw = json.loads(raw)
        content = raw.get("text", "") if isinstance(raw, dict) else ""

    questions = await generate_questions(
        lesson_content=content,
        lesson_title=lesson["title"],
        bloom_level=body.bloom_level,
        question_type=body.question_type,
        count=body.count,
        api_key=settings.ANTHROPIC_API_KEY,
    )

    saved_ids: list[str] = []
    if body.save_to_bank and questions:
        saved_ids = await save_generated_questions(
            lesson_id=str(body.lesson_id),
            questions=questions,
            created_by=current_user["sub"],
            db=db,
        )

    return {
        "data": questions,
        "count": len(questions),
        "saved_ids": saved_ids,
    }


@router.post(
    "/exam/blueprint",
    summary="Auto-select exam questions by Bloom level distribution",
    status_code=status.HTTP_200_OK,
)
async def exam_blueprint(
    body: ExamBlueprintRequest,
    current_user: dict = Depends(_require_teacher_or_admin),
    db=Depends(get_db),
) -> dict:
    lesson_ids = [str(lid) for lid in body.lesson_ids]
    bloom_dist = {int(k): float(v) for k, v in body.bloom_distribution.items()}

    blueprint = await generate_exam_blueprint(
        lesson_ids=lesson_ids,
        total_questions=body.total_questions,
        total_points=body.total_points,
        bloom_distribution=bloom_dist,
        db=db,
    )
    return {"data": blueprint}


# ─── Gamification endpoints ───────────────────────────────────────────────────

@router.get(
    "/gamification/leaderboard",
    summary="Class leaderboard — top students by XP",
    status_code=status.HTTP_200_OK,
)
async def leaderboard(
    class_id: Optional[str] = Query(None, description="Filter by class UUID"),
    limit: int = Query(default=20, ge=1, le=100),
    current_user: dict = Depends(get_current_user),
    db=Depends(get_db),
) -> dict:
    rows = await get_leaderboard(db, class_id=class_id, limit=limit)
    return {"data": rows}


@router.get(
    "/gamification/profile",
    summary="XP / level / badges / streak for the current user",
    status_code=status.HTTP_200_OK,
)
async def gamification_profile(
    user_id: Optional[str] = Query(None, description="Student UUID — defaults to self"),
    current_user: dict = Depends(get_current_user),
    db=Depends(get_db),
) -> dict:
    target_id = user_id or current_user["sub"]

    # Non-admin students may only view their own profile
    if target_id != current_user["sub"] and current_user.get("role") not in ("teacher", "admin"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    row = await db.fetchrow(
        """
        SELECT sx.user_id, u.name, u.avatar_url,
               sx.total_xp, sx.level, sx.level_name, sx.badges,
               sx.current_streak, sx.longest_streak, sx.last_activity_date
        FROM student_xp sx
        JOIN users u ON u.id = sx.user_id
        WHERE sx.user_id = $1
        """,
        target_id,
    )

    if not row:
        return {
            "data": {
                "user_id": target_id,
                "total_xp": 0,
                "level": 1,
                "level_name": "Người mới bắt đầu",
                "badges": [],
                "current_streak": 0,
                "longest_streak": 0,
            }
        }

    profile = dict(row)
    # Deserialize badges JSONB
    badges_raw = profile.get("badges", "[]")
    if isinstance(badges_raw, str):
        try:
            profile["badges"] = json.loads(badges_raw)
        except json.JSONDecodeError:
            profile["badges"] = []

    return {"data": profile}


@router.get(
    "/gamification/xp-history",
    summary="Paginated XP transaction history",
    status_code=status.HTTP_200_OK,
)
async def xp_history(
    user_id: Optional[str] = Query(None, description="Student UUID — defaults to self"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    current_user: dict = Depends(get_current_user),
    db=Depends(get_db),
) -> dict:
    target_id = user_id or current_user["sub"]
    if target_id != current_user["sub"] and current_user.get("role") not in ("teacher", "admin"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    result = await get_xp_history(target_id, db, page=page, page_size=page_size)
    return {"data": result}


@router.post(
    "/xp/award",
    summary="Manually award XP to a student (teacher/admin only)",
    status_code=status.HTTP_200_OK,
)
async def award_xp_endpoint(
    body: AwardXpRequest,
    current_user: dict = Depends(_require_teacher_or_admin),
    db=Depends(get_db),
) -> dict:
    result = await award_xp(body.user_id, body.reason, body.ref_id, db)
    return {"data": result}


# ─── General AI chat + adaptive planning ─────────────────────────────────────

@router.post(
    "/chat",
    summary="Send a message to the AI tutor (Socratic mode)",
    status_code=status.HTTP_200_OK,
)
async def chat(
    body: ChatRequest,
    request: Request,
    current_user: dict = Depends(get_current_user),
    db=Depends(get_db),
    redis=Depends(get_redis),
    settings=Depends(_get_settings),
) -> dict:
    """
    General-purpose Socratic chat endpoint.
    Maintains per-session conversation history in Redis (TTL 1 h).
    If lesson_id is provided, fetches lesson context and mastery.
    """
    user_id: str = current_user["sub"]
    session_id = f"{user_id}:{body.lesson_id or 'general'}"
    redis_key = f"chat:{session_id}"

    # Load history from Redis
    try:
        raw = await redis.get(redis_key)
        history: list[dict] = json.loads(raw) if raw else []
    except Exception:
        history = []

    lesson_context: dict = {"title": "Học tổng quát", "bloom_level": 3, "summary": ""}
    mastery = 0.5

    if body.lesson_id:
        lesson_row = await db.fetchrow("SELECT * FROM lessons WHERE id = $1", body.lesson_id)
        if lesson_row:
            lesson_context = dict(lesson_row)
            lm_row = await db.fetchrow(
                "SELECT mastery_map FROM learner_models WHERE user_id = $1", user_id
            )
            if lm_row and lm_row["mastery_map"]:
                mastery_map = lm_row["mastery_map"]
                if isinstance(mastery_map, str):
                    mastery_map = json.loads(mastery_map)
                mastery = float(mastery_map.get(lesson_context.get("lesson_code", ""), 0.5))

    response = await get_socratic_response(
        conversation_history=history[-body.context_window * 2:],
        student_message=body.message,
        lesson_context=lesson_context,
        api_key=settings.ANTHROPIC_API_KEY,
        mastery_level=mastery,
    )

    # Persist updated history
    history.append(build_conversation_turn("user", body.message))
    history.append(build_conversation_turn("assistant", response["response"]))
    try:
        await redis.setex(redis_key, 3600, json.dumps(history[-40:], ensure_ascii=False))
    except Exception as exc:
        logger.warning("redis chat history write failed: %s", exc)

    return {
        "reply": response["response"],
        "session_id": session_id,
        "hint_level": response.get("hint_level"),
        "encouragement": response.get("encouragement"),
    }


@router.post(
    "/adapt",
    summary="Trigger adaptive lesson recommendation for a student",
    status_code=status.HTTP_202_ACCEPTED,
)
async def adapt(
    body: AdaptRequest,
    request: Request,
    current_user: dict = Depends(get_current_user),
    db=Depends(get_db),
) -> dict:
    """
    Analyse student performance data and return adaptive lesson recommendation.
    Uses the deterministic rule engine (curriculum_planner.py R01–R10).
    """
    learner_row = await db.fetchrow(
        "SELECT * FROM learner_models WHERE user_id = $1",
        body.student_id,
    )
    if not learner_row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Learner model not found")

    current_lesson = await db.fetchrow(
        "SELECT * FROM lessons WHERE id = $1",
        body.lesson_id,
    )
    if not current_lesson:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Lesson not found")

    lesson_catalog = [
        dict(r)
        for r in await db.fetch(
            "SELECT * FROM lessons WHERE course_id = $1 AND status = 'published' ORDER BY sequence_order",
            current_lesson["course_id"],
        )
    ]

    decision = await plan_next_lesson(
        learner_model=dict(learner_row),
        current_lesson=dict(current_lesson),
        lesson_catalog=lesson_catalog,
        db=db,
    )

    return {
        "rule_fired": decision.rule_fired,
        "next_lesson_id": decision.next_lesson_id,
        "reason": decision.reason,
        "action": decision.action,
        "confidence": decision.confidence,
    }


@router.get(
    "/sessions/{session_id}",
    summary="Retrieve conversation history for a session",
    status_code=status.HTTP_200_OK,
)
async def get_session(
    session_id: str,
    current_user: dict = Depends(get_current_user),
    redis=Depends(get_redis),
) -> dict:
    """Return the cached Socratic conversation history for the given session ID."""
    user_id: str = current_user["sub"]

    # Enforce ownership: session_id must start with the user's own UUID
    if not session_id.startswith(user_id) and current_user.get("role") not in ("teacher", "admin"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    try:
        raw = await redis.get(f"chat:{session_id}")
    except Exception as exc:
        logger.error("redis session get error: %s", exc)
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Cache unavailable")

    if raw is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found or expired")

    history = json.loads(raw)
    return {"session_id": session_id, "turns": history, "count": len(history)}

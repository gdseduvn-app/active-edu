"""
AURA AdaptLearn — Internal Routes
Service-to-service endpoints protected by INTERNAL_KEY header.
Not exposed to the public internet (Nginx blocks /api/v1/internal from outside).
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from pydantic import BaseModel

from app.config import get_settings
from app.dependencies import get_db, get_redis

logger = logging.getLogger(__name__)

router = APIRouter()


# ─── Auth dependency ─────────────────────────────────────────────────────────

def verify_internal_key(x_internal_key: str = Header(..., alias="X-Internal-Key")) -> None:
    settings = get_settings()
    if x_internal_key != settings.INTERNAL_KEY:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid internal key",
        )


# ─── Schemas ─────────────────────────────────────────────────────────────────

class EventPayload(BaseModel):
    event_type: str
    student_id: str
    payload: dict


class RecommendationRequest(BaseModel):
    student_id: str
    subject: str
    limit: int = 5


# ─── Endpoints ────────────────────────────────────────────────────────────────

@router.post(
    "/events",
    summary="Ingest a learning event (internal use only)",
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[Depends(verify_internal_key)],
)
async def ingest_event(
    body: EventPayload,
    request: Request,
    db=Depends(get_db),
    redis=Depends(get_redis),
) -> dict:
    """
    Accept a learning event from lms-api, persist to Redis Streams,
    and trigger any real-time adaptive logic.
    """
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        detail="Event ingestion not yet implemented",
    )


@router.post(
    "/recommendations",
    summary="Generate lesson recommendations for a student (internal)",
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(verify_internal_key)],
)
async def get_recommendations(
    body: RecommendationRequest,
    request: Request,
    db=Depends(get_db),
) -> dict:
    """Return AI-generated lesson recommendations for a student."""
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        detail="Recommendations not yet implemented",
    )

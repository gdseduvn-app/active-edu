"""
AURA AdaptLearn — FastAPI dependencies
Reusable dependency functions injected into route handlers.
"""
from __future__ import annotations

import logging

import asyncpg
import redis.asyncio as aioredis
from fastapi import Depends, Header, HTTPException, Request, status
from jose import JWTError, jwt

from app.config import get_settings

logger = logging.getLogger(__name__)


# ─── Database ────────────────────────────────────────────────────────────────

async def get_db(request: Request) -> asyncpg.Pool:
    """Yield the asyncpg connection pool attached to app.state."""
    pool: asyncpg.Pool = request.app.state.db
    return pool


# ─── Redis ───────────────────────────────────────────────────────────────────

async def get_redis(request: Request) -> aioredis.Redis:
    """Yield the Redis client attached to app.state."""
    return request.app.state.redis  # type: ignore[no-any-return]


# ─── Authentication ───────────────────────────────────────────────────────────

def get_current_user(
    authorization: str = Header(...),
) -> dict:
    """
    Validate the Bearer JWT token from the Authorization header.
    Returns the decoded token payload as a dict.
    """
    settings = get_settings()
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )

    if not authorization.startswith("Bearer "):
        raise credentials_exception

    token = authorization[len("Bearer "):]

    try:
        payload = jwt.decode(
            token,
            settings.JWT_SECRET,
            algorithms=[settings.JWT_ALGORITHM],
        )
        user_id: str | None = payload.get("sub")
        if user_id is None:
            raise credentials_exception
        return payload
    except JWTError:
        raise credentials_exception

"""
AURA AdaptLearn — Agent Service
FastAPI application entrypoint with lifespan management.
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

import asyncpg
import redis.asyncio as aioredis
from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.routes import agent as agent_router
from app.routes import internal as internal_router

logger = logging.getLogger(__name__)


# ─── Lifespan ────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """
    Manage application-level resources (DB pool, Redis pool).
    Startup runs before first request; shutdown runs on SIGTERM.
    """
    settings = get_settings()
    logger.info("Starting AURA Agent service …")

    # ── PostgreSQL connection pool ──────────────────────────────────────────
    db_pool: asyncpg.Pool = await asyncpg.create_pool(
        dsn=settings.DATABASE_URL,
        min_size=2,
        max_size=10,
        command_timeout=30,
        server_settings={"application_name": "aura-agent"},
    )
    app.state.db = db_pool
    logger.info("PostgreSQL pool ready (min=2, max=10)")

    # ── Redis connection pool ───────────────────────────────────────────────
    redis_pool = aioredis.from_url(
        settings.REDIS_URL,
        encoding="utf-8",
        decode_responses=True,
        max_connections=20,
        socket_timeout=5,
        socket_connect_timeout=5,
        health_check_interval=30,
    )
    app.state.redis = redis_pool
    logger.info("Redis pool ready")

    try:
        yield  # ← application runs here
    finally:
        logger.info("Shutting down AURA Agent service …")
        await redis_pool.aclose()
        await db_pool.close()
        logger.info("Connections closed cleanly")


# ─── Application factory ─────────────────────────────────────────────────────

def create_app() -> FastAPI:
    settings = get_settings()

    application = FastAPI(
        title="AURA AdaptLearn — Agent API",
        description="AI-powered adaptive learning agent for THPT Thủ Thiêm",
        version="1.0.0",
        docs_url="/agent/docs" if settings.NODE_ENV != "production" else None,
        redoc_url="/agent/redoc" if settings.NODE_ENV != "production" else None,
        openapi_url="/agent/openapi.json" if settings.NODE_ENV != "production" else None,
        lifespan=lifespan,
    )

    # ── CORS ─────────────────────────────────────────────────────────────────
    origins = [o.strip() for o in settings.CORS_ORIGINS.split(",") if o.strip()]
    application.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-Internal-Key"],
    )

    # ── Global exception handler ──────────────────────────────────────────────
    @application.exception_handler(Exception)
    async def unhandled_exception_handler(
        request: Request, exc: Exception
    ) -> JSONResponse:
        logger.exception("Unhandled exception on %s %s", request.method, request.url.path)
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"error": "internal_server_error", "message": "An unexpected error occurred"},
        )

    # ── Routers ───────────────────────────────────────────────────────────────
    application.include_router(agent_router.router, prefix="/api/v1/agent", tags=["agent"])
    application.include_router(internal_router.router, prefix="/api/v1/internal", tags=["internal"])

    # ── Health endpoint ───────────────────────────────────────────────────────
    @application.get(
        "/health",
        tags=["health"],
        summary="Service health check",
        response_description="Service status",
    )
    async def health_check() -> dict[str, str]:
        return {"status": "ok", "service": "agent", "version": "1.0.0"}

    return application


app = create_app()

"""
AURA AdaptLearn — Agent Service Configuration
All settings are read from environment variables (12-factor app).
"""
from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
        extra="ignore",
    )

    # ── Database ──────────────────────────────────────────────────────────────
    DATABASE_URL: str

    # ── Cache / messaging ─────────────────────────────────────────────────────
    REDIS_URL: str = "redis://redis:6379"

    # ── Object storage ────────────────────────────────────────────────────────
    MINIO_ENDPOINT: str = "minio:9000"
    MINIO_ACCESS_KEY: str
    MINIO_SECRET_KEY: str
    MINIO_USE_SSL: bool = False
    MINIO_BUCKET_CONTENT: str = "content"
    MINIO_BUCKET_UPLOADS: str = "uploads"

    # ── Auth ──────────────────────────────────────────────────────────────────
    JWT_SECRET: str
    JWT_PUBLIC_KEY: str = ""
    JWT_ALGORITHM: str = "HS256"
    INTERNAL_KEY: str

    # ── AI provider ───────────────────────────────────────────────────────────
    ANTHROPIC_API_KEY: str
    ANTHROPIC_MODEL: str = "claude-3-5-sonnet-20241022"

    # ── CORS ──────────────────────────────────────────────────────────────────
    CORS_ORIGINS: str = "https://learn.thuthiem.edu.vn"

    # ── Runtime ───────────────────────────────────────────────────────────────
    NODE_ENV: str = "production"
    LOG_LEVEL: str = "INFO"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return a cached Settings singleton."""
    return Settings()  # type: ignore[call-arg]

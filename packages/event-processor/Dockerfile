# ─── Stage 1: Builder ────────────────────────────────────────────────────────
FROM python:3.11-slim AS builder

# Build deps for native extensions
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libffi-dev \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Reuse the shared requirements.txt from the agent package.
# In Docker Compose the build context is set to the repo root so that
# both packages/ paths are accessible.
COPY packages/agent/requirements.txt ./requirements.txt

# Install into a prefix for clean copy
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# ─── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM python:3.11-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

# Non-root user
RUN groupadd -r processor && useradd -r -g processor processor

WORKDIR /app

# Copy installed packages
COPY --from=builder /install /usr/local

# Copy the full packages/agent source (contains app/ with shared core logic)
# and event-processor source
COPY --chown=processor:processor packages/agent/app ./app
COPY --chown=processor:processor packages/event-processor/app ./app/processors_ext

USER processor

# No HTTP port — this service only consumes Redis Streams
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD python -c "import redis; r=redis.from_url('${REDIS_URL:-redis://redis:6379}'); r.ping()" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["python", "-m", "app.processors.event_consumer"]

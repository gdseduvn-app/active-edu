# ─── Stage 1: Builder ────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

# Install build tools required for native addons (bcrypt, pg)
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy dependency manifests first for better layer caching
COPY package*.json ./

# Install all dependencies (including devDependencies for tsc)
RUN npm ci --ignore-scripts

# Copy source and TypeScript config
COPY tsconfig.json ./
COPY src/ ./src/

# Compile TypeScript → JavaScript
RUN npm run build

# Prune dev dependencies; keep only production deps
RUN npm prune --production

# ─── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# Security: install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create a non-root user
RUN addgroup -S adaptlearn && adduser -S adaptlearn -G adaptlearn

WORKDIR /app

# Copy compiled output and production node_modules from builder
COPY --from=builder --chown=adaptlearn:adaptlearn /app/dist ./dist
COPY --from=builder --chown=adaptlearn:adaptlearn /app/node_modules ./node_modules
COPY --from=builder --chown=adaptlearn:adaptlearn /app/package.json ./package.json

# Switch to non-root user
USER adaptlearn

EXPOSE 3000

# Healthcheck — curl not available in alpine by default; use wget
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

# Use dumb-init to handle PID 1 and forward signals correctly
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "dist/index.js"]

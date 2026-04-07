/**
 * AURA AdaptLearn — Fastify API Server
 * Entry point: registers plugins, decorators, and routes.
 */

import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import fastifyCors from '@fastify/cors'
import fastifyHelmet from '@fastify/helmet'
import fastifyRateLimit from '@fastify/rate-limit'
import fastifyMultipart from '@fastify/multipart'
import { Pool } from 'pg'
import Redis from 'ioredis'

// ── Route imports ─────────────────────────────────────────────────────────────
// NOTE: Each route module must export a FastifyPlugin as its default or named export.
// Stub modules will be created alongside this file; replace with full implementations.
import { agentRoutes } from './routes/agent'
import { authRoutes } from './routes/auth'
import { userRoutes } from './routes/users'
import { lessonRoutes } from './routes/lessons'
import { questionRoutes } from './routes/questions'
import { quizRoutes } from './routes/quiz'
import { eventsRoutes } from './routes/events'
import { flashcardRoutes } from './routes/flashcards'
import { gamificationRoutes } from './routes/gamification'
import { analyticsRoutes } from './routes/analytics'
import { notificationsRoutes } from './routes/notifications'

// ─────────────────────────────────────────────────────────────────────────────
// Type augmentation — extend FastifyInstance with custom decorators
// ─────────────────────────────────────────────────────────────────────────────
declare module 'fastify' {
  interface FastifyInstance {
    db: Pool
    redis: Redis
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
    authorizeRole: (...roles: string[]) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>
    authorizeTeacherOrSelf: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
  interface FastifyRequest {
    user: JwtPayload
  }
}

interface JwtPayload {
  sub:      string                                           // user UUID
  role:     'student' | 'teacher' | 'admin' | 'observer'
  username: string                                           // login name
  email?:   string                                           // included in older tokens
  iat:      number
  exp:      number
}

// ─────────────────────────────────────────────────────────────────────────────
// Environment helpers
// ─────────────────────────────────────────────────────────────────────────────
function requireEnv(key: string): string {
  const value = process.env[key]
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`)
  }
  return value
}

// ─────────────────────────────────────────────────────────────────────────────
// Build app factory (testable — does not call listen)
// ─────────────────────────────────────────────────────────────────────────────
export async function buildApp(): Promise<FastifyInstance> {
  const isProduction = process.env['NODE_ENV'] === 'production'

  const app = Fastify({
    logger: {
      level: process.env['LOG_LEVEL'] ?? (isProduction ? 'info' : 'debug'),
      ...(isProduction
        ? {}
        : {
            transport: {
              target: 'pino-pretty',
              options: { colorize: true },
            },
          }),
    },
    trustProxy: true,
    // Reject payloads > 10 MB (multipart has its own limit)
    bodyLimit: 10 * 1024 * 1024,
    ajv: {
      customOptions: {
        removeAdditional: 'all',
        coerceTypes: true,
        useDefaults: true,
      },
    },
  })

  // ── PostgreSQL pool ─────────────────────────────────────────────────────────
  const db = new Pool({
    connectionString: requireEnv('DATABASE_URL'),
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: isProduction ? { rejectUnauthorized: false } : false,
  })

  db.on('error', (err) => {
    app.log.error({ err }, 'Unexpected PostgreSQL pool error')
  })

  // Verify DB connectivity at startup
  await db.query('SELECT 1')
  app.log.info('PostgreSQL pool connected')

  // ── Redis client ────────────────────────────────────────────────────────────
  const redis = new Redis(requireEnv('REDIS_URL'), {
    maxRetriesPerRequest: 3,
    lazyConnect: false,
    enableReadyCheck: true,
    connectTimeout: 5_000,
    commandTimeout: 5_000,
  })

  redis.on('error', (err) => {
    app.log.error({ err }, 'Redis client error')
  })

  await redis.ping()
  app.log.info('Redis connected')

  // ── Decorators ──────────────────────────────────────────────────────────────
  app.decorate('db', db)
  app.decorate('redis', redis)

  // ── Plugin: Helmet (security headers) ──────────────────────────────────────
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    hsts: {
      maxAge: 63_072_000,
      includeSubDomains: true,
      preload: true,
    },
  })

  // ── Plugin: CORS ────────────────────────────────────────────────────────────
  const corsOrigins = (process.env['CORS_ORIGINS'] ?? 'https://learn.thuthiem.edu.vn')
    .split(',')
    .map((o) => o.trim())

  await app.register(fastifyCors, {
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Internal-Key'],
  })

  // ── Plugin: Rate Limit ──────────────────────────────────────────────────────
  await app.register(fastifyRateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    redis,
    keyGenerator: (req) =>
      (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
      req.ip,
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Retry after ${context.after}.`,
    }),
  })

  // ── Plugin: JWT ─────────────────────────────────────────────────────────────
  await app.register(fastifyJwt, {
    secret: requireEnv('JWT_SECRET'),
    sign: {
      expiresIn: parseInt(process.env['JWT_ACCESS_TTL'] ?? '900', 10),
    },
  })

  // ── Plugin: Multipart (file uploads) ───────────────────────────────────────
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: 100 * 1024 * 1024,   // 100 MB per file
      files: 10,
      fields: 20,
    },
  })

  // ── authenticate decorator ──────────────────────────────────────────────────
  app.decorate(
    'authenticate',
    async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
      try {
        await request.jwtVerify()
      } catch (err) {
        reply.status(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Invalid or missing authentication token',
        })
      }
    },
  )

  // ── authorizeRole decorator ─────────────────────────────────────────────────
  app.decorate(
    'authorizeRole',
    function authorizeRole(...roles: string[]) {
      return async function (request: FastifyRequest, reply: FastifyReply): Promise<void> {
        await request.jwtVerify()
        if (!roles.includes(request.user.role)) {
          reply.status(403).send({
            statusCode: 403,
            error: 'Forbidden',
            message: `Role '${request.user.role}' is not authorized for this resource`,
          })
        }
      }
    },
  )

  // ── authorizeTeacherOrSelf decorator ───────────────────────────────────────
  // Allows access when the caller is a teacher/admin, OR when they are the
  // resource owner (userId in params or body matches the JWT sub).
  app.decorate(
    'authorizeTeacherOrSelf',
    async function authorizeTeacherOrSelf(
      request: FastifyRequest,
      reply: FastifyReply,
    ): Promise<void> {
      await request.jwtVerify()

      const { role, sub } = request.user
      if (role === 'teacher' || role === 'admin') return

      // Attempt to resolve the target userId from route params or body
      const params = request.params as Record<string, string> | undefined
      const body = request.body as Record<string, string> | undefined
      const targetId: string | undefined =
        params?.['userId'] ?? params?.['id'] ?? body?.['userId']

      if (!targetId || targetId !== sub) {
        reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'You may only access your own resources',
        })
      }
    },
  )

  // ── Health check ────────────────────────────────────────────────────────────
  app.get(
    '/api/health',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              version: { type: 'string' },
              timestamp: { type: 'string' },
            },
          },
        },
      },
    },
    async (_request, _reply) => ({
      status: 'ok',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
    }),
  )

  // ── Route registration ──────────────────────────────────────────────────────
  await app.register(authRoutes,         { prefix: '/api/v1/auth' })
  await app.register(userRoutes,         { prefix: '/api/v1/users' })
  await app.register(lessonRoutes,       { prefix: '/api/v1/lessons' })
  await app.register(questionRoutes,     { prefix: '/api/v1/questions' })
  await app.register(quizRoutes,         { prefix: '/api/v1/quiz' })
  await app.register(agentRoutes,        { prefix: '/api/v1/agent' })
  await app.register(eventsRoutes,       { prefix: '/api/v1/events' })
  await app.register(flashcardRoutes,    { prefix: '/api/v1/flashcards' })
  await app.register(gamificationRoutes, { prefix: '/api/v1/gamification' })
  await app.register(analyticsRoutes,       { prefix: '/api/v1/analytics' })
  await app.register(notificationsRoutes,   { prefix: '/api/v1/notifications' })

  app.log.info('All routes registered')

  return app
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entrypoint
// ─────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const app = await buildApp()

  const host = process.env['HOST'] ?? '0.0.0.0'
  const port = parseInt(process.env['PORT'] ?? '3000', 10)

  // ── Graceful shutdown ───────────────────────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'Received shutdown signal, closing server …')
    try {
      await app.close()
      app.log.info('Server closed cleanly')
      process.exit(0)
    } catch (err) {
      app.log.error({ err }, 'Error during shutdown')
      process.exit(1)
    }
  }

  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGINT',  () => void shutdown('SIGINT'))

  // ── Unhandled rejection guard ───────────────────────────────────────────────
  process.on('unhandledRejection', (reason) => {
    app.log.error({ reason }, 'Unhandled promise rejection')
    process.exit(1)
  })

  await app.listen({ host, port })
  app.log.info(`AURA AdaptLearn API listening on http://${host}:${port}`)
}

main().catch((err) => {
  // Use process.stderr directly here — Fastify logger may not be initialised
  console.error('Fatal error during startup:', err)
  process.exit(1)
})

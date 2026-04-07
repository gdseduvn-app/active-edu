/**
 * AURA AdaptLearn — Auth Routes
 * Source: SRS-CH05 §5.4 Auth APIs
 * Base prefix: /api/v1/auth
 *
 * POST /register  — Admin only: create a new user
 * POST /login     — Authenticate with username or email
 * POST /refresh   — Rotate refresh token (opaque 64-byte hex, stored in Redis)
 * POST /logout    — Revoke refresh token
 * GET  /me        — Return authenticated user's full profile
 */

import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify'
import bcrypt from 'bcrypt'
import crypto from 'crypto'
import { z } from 'zod'

// ── Zod schemas ───────────────────────────────────────────────────────────────

const RegisterBody = z.object({
  username:  z.string().min(3).max(50).regex(/^[a-zA-Z0-9_.-]+$/, 'Username may only contain letters, digits, _, . or -'),
  email:     z.string().email(),
  password:  z.string().min(8).max(128),
  full_name: z.string().min(1).max(255),
  role:      z.enum(['student', 'teacher', 'admin', 'observer']),
  class_id:  z.string().max(20).optional(),
  grade:     z.number().int().min(1).max(12).optional(),
})

const LoginBody = z.object({
  // Accept either username or email in the same field for UX convenience,
  // or separate username / email fields — we support both patterns.
  login:    z.string().min(1).optional(),  // username OR email
  username: z.string().min(1).optional(),
  email:    z.string().optional(),
  password: z.string().min(1),
}).refine(
  (d) => d.login ?? d.username ?? d.email,
  { message: 'Provide login, username, or email' },
)

const RefreshBody = z.object({
  refresh_token: z.string().min(1),
})

const LogoutBody = z.object({
  refresh_token: z.string().min(1),
})

// ── Constants ─────────────────────────────────────────────────────────────────

const BCRYPT_COST       = 12
const ACCESS_TTL_SEC    = 900         // 15 minutes
const REFRESH_TTL_SEC   = 7 * 24 * 3600  // 7 days
const REFRESH_TOKEN_BYTES = 64

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Generate a cryptographically-random opaque refresh token (128-char hex). */
function generateRefreshToken (): string {
  return crypto.randomBytes(REFRESH_TOKEN_BYTES).toString('hex')
}

/** Redis key for a refresh token. */
function refreshKey (token: string): string {
  return `refresh:${token}`
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export async function authRoutes (
  app: FastifyInstance,
  _opts: FastifyPluginOptions,
): Promise<void> {

  // ── POST /register ─────────────────────────────────────────────────────────
  // Admin-only: create a new user account.
  app.post(
    '/register',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      preHandler: [app.authenticate, app.authorizeRole('admin')],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = RegisterBody.parse(request.body)

      const passwordHash = await bcrypt.hash(body.password, BCRYPT_COST)

      let newUserId: string
      try {
        const result = await app.db.query<{ id: string; username: string; email: string; role: string }>(
          `INSERT INTO users
             (username, email, password_hash, full_name, role, class_id, grade, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
           RETURNING id, username, email, role`,
          [
            body.username,
            body.email.toLowerCase(),
            passwordHash,
            body.full_name,
            body.role,
            body.class_id ?? null,
            body.grade    ?? null,
          ],
        )
        const row = result.rows[0]
        if (!row) throw new Error('INSERT did not return a row')
        newUserId = row.id

        // Seed an empty learner_model for student accounts so the agent can
        // query it immediately without a LEFT JOIN miss.
        if (body.role === 'student') {
          await app.db.query(
            `INSERT INTO learner_models (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
            [newUserId],
          )
        }

        return reply.status(201).send({
          data: {
            id:       row.id,
            username: row.username,
            email:    row.email,
            role:     row.role,
          },
        })
      } catch (err: unknown) {
        const pgErr = err as { code?: string; constraint?: string }
        if (pgErr?.code === '23505') {
          const field = pgErr.constraint?.includes('email') ? 'email' : 'username'
          return reply.status(409).send({
            statusCode: 409,
            error: 'Conflict',
            message: `${field === 'email' ? 'Email' : 'Username'} đã được sử dụng`,
          })
        }
        throw err
      }
    },
  )

  // ── POST /login ────────────────────────────────────────────────────────────
  // Authenticate with username or email + password. Returns access token,
  // opaque refresh token, and minimal user info.
  app.post(
    '/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = LoginBody.parse(request.body)

      // Resolve the login identifier (accepts login / username / email)
      const identifier: string = (body.login ?? body.username ?? body.email ?? '').trim()

      const result = await app.db.query<{
        id: string
        username: string
        email: string
        password_hash: string
        full_name: string
        role: string
        is_active: boolean
      }>(
        `SELECT id, username, email, password_hash, full_name, role, is_active
         FROM users
         WHERE (username = $1 OR email = $1)
           AND deleted_at IS NULL
         LIMIT 1`,
        [identifier.toLowerCase()],
      )

      const user = result.rows[0]

      // Constant-time guard: always run bcrypt even when user is not found to
      // prevent username-enumeration via timing.
      const dummyHash = '$2b$12$00000000000000000000000000000000000000000000000000000000'
      const passwordMatch = await bcrypt.compare(
        body.password,
        user?.password_hash ?? dummyHash,
      )

      if (!user || !user.is_active || !passwordMatch) {
        return reply.status(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Tên đăng nhập hoặc mật khẩu không đúng',
        })
      }

      // Issue access token (JWT RS256, 15 min)
      const accessToken = app.jwt.sign(
        { sub: user.id, role: user.role, username: user.username },
        { expiresIn: ACCESS_TTL_SEC },
      )

      // Issue opaque refresh token and store in Redis
      const refreshToken = generateRefreshToken()
      await app.redis.setex(
        refreshKey(refreshToken),
        REFRESH_TTL_SEC,
        user.id,
      )

      // Update last_login_at (fire-and-forget — non-critical)
      app.db.query(
        `UPDATE users SET last_login_at = NOW() WHERE id = $1`,
        [user.id],
      ).catch((err: unknown) => app.log.error({ err }, 'Failed to update last_login_at'))

      return reply.send({
        data: {
          access_token:  accessToken,
          refresh_token: refreshToken,
          expires_in:    ACCESS_TTL_SEC,
          user: {
            id:        user.id,
            full_name: user.full_name,
            role:      user.role,
          },
        },
      })
    },
  )

  // ── POST /refresh ──────────────────────────────────────────────────────────
  // Rotate refresh token: verify old token in Redis, issue new pair, delete old key.
  app.post(
    '/refresh',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { refresh_token: oldToken } = RefreshBody.parse(request.body)

      const userId = await app.redis.get(refreshKey(oldToken))
      if (!userId) {
        return reply.status(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Refresh token không hợp lệ hoặc đã hết hạn',
        })
      }

      // Verify user still exists and is active
      const userResult = await app.db.query<{
        username: string; role: string; is_active: boolean
      }>(
        `SELECT username, role, is_active
         FROM users
         WHERE id = $1 AND deleted_at IS NULL`,
        [userId],
      )
      const user = userResult.rows[0]
      if (!user || !user.is_active) {
        await app.redis.del(refreshKey(oldToken))
        return reply.status(401).send({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Tài khoản không tồn tại hoặc đã bị vô hiệu',
        })
      }

      // Issue new access token
      const newAccessToken = app.jwt.sign(
        { sub: userId, role: user.role, username: user.username },
        { expiresIn: ACCESS_TTL_SEC },
      )

      // Issue new refresh token and rotate atomically via pipeline
      const newRefreshToken = generateRefreshToken()
      const pipeline = app.redis.pipeline()
      pipeline.del(refreshKey(oldToken))
      pipeline.setex(refreshKey(newRefreshToken), REFRESH_TTL_SEC, userId)
      await pipeline.exec()

      return reply.send({
        data: {
          access_token:  newAccessToken,
          refresh_token: newRefreshToken,
          expires_in:    ACCESS_TTL_SEC,
        },
      })
    },
  )

  // ── POST /logout ───────────────────────────────────────────────────────────
  // Revoke refresh token. Accepts the token in the request body.
  // The access token will naturally expire; we cannot revoke JWTs without a
  // blocklist, which is intentionally out of scope for this service.
  app.post(
    '/logout',
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      // Body is optional — be tolerant if client omits it
      let refreshToken: string | undefined
      try {
        const parsed = LogoutBody.safeParse(request.body)
        if (parsed.success) refreshToken = parsed.data.refresh_token
      } catch {
        // ignore parse errors on logout
      }

      if (refreshToken) {
        await app.redis.del(refreshKey(refreshToken))
      }

      return reply.send({
        data: { message: 'Đã đăng xuất' },
      })
    },
  )

  // ── GET /me ────────────────────────────────────────────────────────────────
  // Return full profile of the authenticated user (no password_hash).
  app.get(
    '/me',
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.user.sub

      const result = await app.db.query<{
        id: string; username: string; email: string; full_name: string
        role: string; class_id: string | null; grade: number | null
        is_active: boolean; avatar_url: string | null
        last_login_at: string | null; created_at: string
      }>(
        `SELECT id, username, email, full_name, role, class_id, grade,
                is_active, avatar_url, last_login_at, created_at
         FROM users
         WHERE id = $1 AND deleted_at IS NULL`,
        [userId],
      )

      const user = result.rows[0]
      if (!user) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Không tìm thấy tài khoản',
        })
      }

      return reply.send({ data: user })
    },
  )
}

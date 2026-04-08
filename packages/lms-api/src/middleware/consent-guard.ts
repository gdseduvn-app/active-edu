/**
 * Consent Guard Middleware — NĐ 13/2023/NĐ-CP Compliance
 *
 * Blocks all API access for students who haven't completed consent.
 * Students under 18 need BOTH student_assent AND parent_consent.
 *
 * Whitelisted routes (accessible without consent):
 * - /api/health
 * - /api/v1/auth/* (login, consent endpoints)
 * - /api/v1/privacy/* (privacy notice, consent management)
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'

// Routes that don't require consent
const CONSENT_EXEMPT_PREFIXES = [
  '/api/health',
  '/api/v1/auth/',
  '/api/v1/privacy/',
]

interface ConsentCheckResult {
  hasStudentAssent: boolean
  hasParentConsent: boolean
  fullyConsented: boolean
}

export async function consentGuardPlugin(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // Skip for exempt routes
    const url = request.url
    if (CONSENT_EXEMPT_PREFIXES.some(prefix => url.startsWith(prefix))) {
      return
    }

    // Skip if no user (unauthenticated — let auth middleware handle)
    if (!request.user?.sub) {
      return
    }

    const { sub: userId, role } = request.user

    // Teachers and admins don't need consent to access the system
    if (role === 'teacher' || role === 'admin' || role === 'observer') {
      return
    }

    // Check consent for students
    const consent = await checkConsent(app, userId)

    if (!consent.hasStudentAssent) {
      reply.code(403).send({
        error: {
          code: 'CONSENT_REQUIRED',
          message: 'Cần đồng ý điều khoản sử dụng trước khi truy cập hệ thống.',
          details: { redirect: '/consent' },
        },
      })
      return
    }

    if (!consent.hasParentConsent) {
      reply.code(403).send({
        error: {
          code: 'PARENT_CONSENT_REQUIRED',
          message: 'Cần sự đồng ý của phụ huynh để sử dụng hệ thống.',
          details: { redirect: '/consent/waiting' },
        },
      })
      return
    }
  })
}

async function checkConsent(app: FastifyInstance, userId: string): Promise<ConsentCheckResult> {
  // Check Redis cache first (TTL 5 minutes)
  const cacheKey = `consent:${userId}`
  const cached = await app.redis.get(cacheKey)
  if (cached) {
    return JSON.parse(cached)
  }

  // Query DB
  const result = await app.db.query(
    `SELECT consent_type, granted
     FROM consent_records
     WHERE user_id = $1
       AND granted = TRUE
       AND withdrawn_at IS NULL
     ORDER BY granted_at DESC`,
    [userId]
  )

  const hasStudentAssent = result.rows.some(
    (r: { consent_type: string }) => r.consent_type === 'student_assent'
  )
  const hasParentConsent = result.rows.some(
    (r: { consent_type: string }) => r.consent_type === 'parent_consent'
  )

  const consentStatus: ConsentCheckResult = {
    hasStudentAssent,
    hasParentConsent,
    fullyConsented: hasStudentAssent && hasParentConsent,
  }

  // Cache for 5 minutes
  await app.redis.set(cacheKey, JSON.stringify(consentStatus), 'EX', 300)

  return consentStatus
}

/**
 * Invalidate consent cache — call when consent changes
 */
export async function invalidateConsentCache(
  redis: { del: (key: string) => Promise<number> },
  userId: string
): Promise<void> {
  await redis.del(`consent:${userId}`)
}

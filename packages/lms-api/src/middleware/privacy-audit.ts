/**
 * Privacy Audit Middleware — NĐ 13/2023 Đ26, Đ27
 *
 * Logs all access to sensitive student data to privacy_audit_log.
 * Append-only — this table cannot be modified by application code.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import crypto from 'crypto'

// Routes that access PII and need audit logging
const AUDIT_ROUTES: { pattern: RegExp; action: string; resourceType: string }[] = [
  { pattern: /\/api\/v1\/agent\/learner\/[^/]+\/model/, action: 'view_learner_model', resourceType: 'learner_model' },
  { pattern: /\/api\/v1\/users\/[^/]+$/, action: 'view_student_profile', resourceType: 'user_profile' },
  { pattern: /\/api\/v1\/analytics\/learner\//, action: 'view_learner_model', resourceType: 'analytics' },
  { pattern: /\/api\/v1\/journals\//, action: 'access_journal_metadata', resourceType: 'journal' },
  { pattern: /\/api\/v1\/privacy\/deletion/, action: 'deletion_requested', resourceType: 'deletion' },
  { pattern: /\/api\/v1\/analytics\/reports\/generate/, action: 'export_data', resourceType: 'report' },
]

export async function privacyAuditPlugin(app: FastifyInstance): Promise<void> {
  app.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
    // Only log successful requests to sensitive routes
    if (reply.statusCode >= 400) return
    if (!request.user?.sub) return

    const matchedRoute = AUDIT_ROUTES.find(r => r.pattern.test(request.url))
    if (!matchedRoute) return

    // Extract target user ID from URL if present
    const targetMatch = request.url.match(/\/users\/([^/]+)|\/learner\/([^/]+)/)
    const targetUserId = targetMatch?.[1] || targetMatch?.[2] || null

    const ipHash = crypto
      .createHash('sha256')
      .update(request.ip || 'unknown')
      .digest('hex')
      .substring(0, 64)

    try {
      await app.db.query(
        `INSERT INTO privacy_audit_log
           (actor_id, actor_role, action, target_user_id, resource_type, details, ip_hash, request_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
        [
          request.user.sub,
          request.user.role,
          matchedRoute.action,
          targetUserId,
          matchedRoute.resourceType,
          JSON.stringify({
            method: request.method,
            url: request.url,
            status: reply.statusCode,
          }),
          ipHash,
          request.id,
        ]
      )
    } catch (err) {
      // Audit logging failure should not break the request
      app.log.error({ err }, 'Failed to write privacy audit log')
    }
  })
}

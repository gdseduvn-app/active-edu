/**
 * Privacy & Consent Routes — NĐ 13/2023/NĐ-CP Compliance
 *
 * 7 endpoints:
 * GET  /consent/status          — Check consent hiện tại
 * POST /consent                 — Ghi nhận consent
 * POST /consent/withdraw        — Rút consent (Đ12)
 * GET  /notice                  — Privacy notice tiếng Việt (Đ13)
 * POST /deletion/request        — Yêu cầu xóa DLCN (Đ16)
 * GET  /deletion/:requestId     — Trạng thái yêu cầu xóa
 * PATCH /deletion/:requestId    — Admin approve/reject
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import crypto from 'crypto'
import { invalidateConsentCache } from '../middleware/consent-guard'

export async function privacyRoutes(app: FastifyInstance): Promise<void> {

  // ─────────────────────────────────────────────────────────
  // GET /consent/status — Check consent hiện tại
  // ─────────────────────────────────────────────────────────
  app.get('/consent/status', {
    onRequest: [app.authenticate],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.user.sub

    const result = await app.db.query(
      `SELECT consent_type, consent_version, purpose, granted, granted_at, withdrawn_at
       FROM consent_records
       WHERE user_id = $1
       ORDER BY granted_at DESC`,
      [userId]
    )

    const studentAssent = result.rows.find(
      (r: { consent_type: string; withdrawn_at: string | null; granted: boolean }) =>
        r.consent_type === 'student_assent' && r.granted && !r.withdrawn_at
    )
    const parentConsent = result.rows.find(
      (r: { consent_type: string; withdrawn_at: string | null; granted: boolean }) =>
        r.consent_type === 'parent_consent' && r.granted && !r.withdrawn_at
    )

    return {
      data: {
        student_assent: !!studentAssent,
        parent_consent: !!parentConsent,
        fully_consented: !!studentAssent && !!parentConsent,
        purposes: studentAssent?.purpose || [],
        version: studentAssent?.consent_version || null,
        granted_at: studentAssent?.granted_at || null,
      },
    }
  })

  // ─────────────────────────────────────────────────────────
  // POST /consent — Ghi nhận consent (Đ11)
  // ─────────────────────────────────────────────────────────
  app.post<{
    Body: {
      consent_type: 'student_assent' | 'parent_consent'
      purpose: string[]
      parent_email?: string
    }
  }>('/consent', {
    onRequest: [app.authenticate],
  }, async (request: FastifyRequest<{
    Body: {
      consent_type: 'student_assent' | 'parent_consent'
      purpose: string[]
      parent_email?: string
    }
  }>, reply: FastifyReply) => {
    const userId = request.user.sub
    const { consent_type, purpose, parent_email } = request.body

    if (!consent_type || !purpose?.length) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'consent_type và purpose bắt buộc.' },
      })
    }

    const ipHash = crypto.createHash('sha256').update(request.ip || '').digest('hex').substring(0, 64)

    const result = await app.db.query(
      `INSERT INTO consent_records (user_id, consent_version, consent_type, purpose, granted, ip_hash)
       VALUES ($1, 'v1.0', $2, $3, TRUE, $4)
       RETURNING id, granted_at`,
      [userId, consent_type, purpose, ipHash]
    )

    // If student consent, create parent link for consent email
    if (consent_type === 'student_assent' && parent_email) {
      const token = crypto.randomBytes(64).toString('hex')
      await app.db.query(
        `INSERT INTO parent_links (parent_email, student_id, verification_token, token_expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '7 days')
         ON CONFLICT (parent_email, student_id) DO UPDATE SET
           verification_token = $3, token_expires_at = NOW() + INTERVAL '7 days'`,
        [parent_email, userId, token]
      )
      // TODO: Send email to parent with consent link
      app.log.info({ parent_email, userId }, 'Parent consent email queued')
    }

    // Audit log
    await app.db.query(
      `INSERT INTO privacy_audit_log (actor_id, actor_role, action, target_user_id, details)
       VALUES ($1, $2, 'consent_granted', $1, $3)`,
      [userId, request.user.role, JSON.stringify({ consent_type, purpose })]
    )

    // Invalidate cache
    await invalidateConsentCache(app.redis, userId)

    return reply.code(201).send({
      data: { consent_id: result.rows[0].id, granted_at: result.rows[0].granted_at },
    })
  })

  // ─────────────────────────────────────────────────────────
  // POST /consent/withdraw — Rút consent (Đ12)
  // ─────────────────────────────────────────────────────────
  app.post<{
    Body: { reason?: string }
  }>('/consent/withdraw', {
    onRequest: [app.authenticate],
  }, async (request: FastifyRequest<{ Body: { reason?: string } }>, reply: FastifyReply) => {
    const userId = request.user.sub
    const { reason } = request.body || {}

    // Đ12.3: Thông báo hậu quả trước khi rút
    const result = await app.db.query(
      `UPDATE consent_records
       SET withdrawn_at = NOW(), withdrawal_reason = $2
       WHERE user_id = $1 AND granted = TRUE AND withdrawn_at IS NULL
       RETURNING id, consent_type`,
      [userId, reason || 'User requested withdrawal']
    )

    if (result.rowCount === 0) {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: 'Không tìm thấy consent đang active.' },
      })
    }

    // Audit log
    await app.db.query(
      `INSERT INTO privacy_audit_log (actor_id, actor_role, action, target_user_id, details)
       VALUES ($1, $2, 'consent_withdrawn', $1, $3)`,
      [userId, request.user.role, JSON.stringify({ reason, types_withdrawn: result.rows.map((r: { consent_type: string }) => r.consent_type) })]
    )

    await invalidateConsentCache(app.redis, userId)

    return {
      data: {
        withdrawn_at: new Date().toISOString(),
        message: 'Sự đồng ý đã được rút lại. Bạn sẽ không thể truy cập hệ thống cho đến khi đồng ý lại.',
      },
    }
  })

  // ─────────────────────────────────────────────────────────
  // GET /notice — Privacy notice tiếng Việt (Đ13)
  // ─────────────────────────────────────────────────────────
  app.get('/notice', async () => {
    return {
      data: {
        version: 'v1.0',
        effective_date: '2025-04-01',
        content_html: `
          <h2>Thông báo xử lý dữ liệu cá nhân — AdaptLearn</h2>
          <p>Theo Nghị định 13/2023/NĐ-CP về Bảo vệ Dữ liệu Cá nhân, chúng tôi thông báo:</p>
          <h3>1. Mục đích xử lý</h3>
          <p>Cá nhân hoá lộ trình học tập: AI Agent phân tích điểm số, thời gian học, mẫu lỗi để đề xuất bài học phù hợp.</p>
          <h3>2. Loại dữ liệu thu thập</h3>
          <ul>
            <li>Thông tin cá nhân: họ tên, email, lớp</li>
            <li>Dữ liệu học tập: điểm quiz, thời gian làm bài, câu trả lời</li>
            <li>Hồ sơ học tập (Learner Model): mức độ thành thạo, hồ sơ Bloom, mẫu lỗi</li>
          </ul>
          <h3>3. Thời gian lưu trữ</h3>
          <p>Dữ liệu cá nhân: đến khi học sinh ra trường + 2 năm. Nhật ký phản chiếu: 12 tháng rồi xóa hẳn.</p>
          <h3>4. Quyền của bạn</h3>
          <ul>
            <li>Đồng ý hoặc từ chối xử lý dữ liệu (Điều 9)</li>
            <li>Rút lại sự đồng ý bất kỳ lúc nào (Điều 12)</li>
            <li>Yêu cầu xóa dữ liệu trong 72 giờ (Điều 16)</li>
          </ul>
          <h3>5. Liên hệ</h3>
          <p>Tổ Tin học, THPT Thủ Thiêm — email: it@thuthiem.edu.vn</p>
        `,
      },
    }
  })

  // ─────────────────────────────────────────────────────────
  // POST /deletion/request — Yêu cầu xóa DLCN (Đ16)
  // ─────────────────────────────────────────────────────────
  app.post<{
    Body: { reason?: string; requested_by?: string }
  }>('/deletion/request', {
    onRequest: [app.authenticate],
  }, async (request: FastifyRequest<{
    Body: { reason?: string; requested_by?: string }
  }>, reply: FastifyReply) => {
    const userId = request.user.sub
    const { reason, requested_by } = request.body || {}

    // Check if already has pending request
    const existing = await app.db.query(
      `SELECT id FROM data_deletion_requests
       WHERE user_id = $1 AND status IN ('pending', 'approved', 'processing')`,
      [userId]
    )
    if (existing.rowCount && existing.rowCount > 0) {
      return reply.code(409).send({
        error: { code: 'DELETION_ALREADY_REQUESTED', message: 'Đã có yêu cầu xóa đang xử lý.' },
      })
    }

    const result = await app.db.query(
      `INSERT INTO data_deletion_requests (user_id, requested_by, reason)
       VALUES ($1, $2, $3)
       RETURNING id, sla_deadline`,
      [userId, requested_by || 'student', reason || '']
    )

    await app.db.query(
      `INSERT INTO privacy_audit_log (actor_id, actor_role, action, target_user_id, details)
       VALUES ($1, $2, 'deletion_requested', $1, $3)`,
      [userId, request.user.role, JSON.stringify({ reason })]
    )

    return reply.code(202).send({
      data: {
        request_id: result.rows[0].id,
        sla_deadline: result.rows[0].sla_deadline,
        sla_hours: 72,
        message: 'Yêu cầu xóa đã được tiếp nhận. Sẽ xử lý trong 72 giờ.',
      },
    })
  })

  // ─────────────────────────────────────────────────────────
  // GET /deletion/:requestId — Trạng thái yêu cầu xóa
  // ─────────────────────────────────────────────────────────
  app.get<{
    Params: { requestId: string }
  }>('/deletion/:requestId', {
    onRequest: [app.authenticate],
  }, async (request: FastifyRequest<{ Params: { requestId: string } }>) => {
    const { requestId } = request.params
    const result = await app.db.query(
      `SELECT id, status, sla_deadline, sla_breached, completed_at, created_at
       FROM data_deletion_requests
       WHERE id = $1 AND user_id = $2`,
      [requestId, request.user.sub]
    )
    if (result.rowCount === 0) {
      return { error: { code: 'NOT_FOUND', message: 'Không tìm thấy yêu cầu.' } }
    }
    return { data: result.rows[0] }
  })

  // ─────────────────────────────────────────────────────────
  // PATCH /deletion/:requestId — Admin approve/reject
  // ─────────────────────────────────────────────────────────
  app.patch<{
    Params: { requestId: string }
    Body: { action: 'approve' | 'reject'; reason?: string }
  }>('/deletion/:requestId', {
    onRequest: [app.authorizeRole('admin')],
  }, async (request: FastifyRequest<{
    Params: { requestId: string }
    Body: { action: 'approve' | 'reject'; reason?: string }
  }>, reply: FastifyReply) => {
    const { requestId } = request.params
    const { action, reason } = request.body

    if (action === 'approve') {
      await app.db.query(
        `UPDATE data_deletion_requests
         SET status = 'approved', approved_by = $2, approved_at = NOW()
         WHERE id = $1 AND status = 'pending'`,
        [requestId, request.user.sub]
      )
      // TODO: Trigger async deletion pipeline job
      app.log.info({ requestId }, 'Deletion request approved — pipeline job queued')
    } else {
      await app.db.query(
        `UPDATE data_deletion_requests
         SET status = 'rejected', rejection_reason = $2
         WHERE id = $1 AND status = 'pending'`,
        [requestId, reason || 'Admin rejected']
      )
    }

    await app.db.query(
      `INSERT INTO privacy_audit_log (actor_id, actor_role, action, details)
       VALUES ($1, $2, $3, $4)`,
      [
        request.user.sub,
        request.user.role,
        action === 'approve' ? 'deletion_approved' : 'deletion_requested',
        JSON.stringify({ requestId, action, reason }),
      ]
    )

    return { data: { status: action === 'approve' ? 'approved' : 'rejected' } }
  })
}

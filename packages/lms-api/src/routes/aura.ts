/**
 * AURA API Routes — SRS-CH05 §5.9, CH07 Module AURA v3.0
 * 12 endpoints: upload, list, detail, qa, activate, versions, rollback,
 *               serve, gap-analysis, import, events, delete
 * Base: /api/v1/aura
 */
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'

export async function auraRoutes(app: FastifyInstance) {

  // POST /aura/upload — Upload file → AURA pipeline
  app.post('/upload', {
    preHandler: [app.authenticate, app.authorizeRole('teacher', 'admin')],
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { lesson_id, file_type, file_key, exploit_mode } = req.body as {
      lesson_id: string; file_type: string; file_key: string; exploit_mode?: string
    }

    if (!lesson_id || !file_type || !file_key) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'lesson_id, file_type, file_key bắt buộc' } })
    }

    // Check lesson exists
    const lesson = await app.db.query(
      `SELECT lesson_code FROM lessons WHERE id = $1 AND deleted_at IS NULL`, [lesson_id]
    )
    if (!lesson.rows[0]) {
      return reply.code(404).send({ error: { code: 'LESSON_NOT_FOUND', message: 'Bài học không tồn tại' } })
    }

    // Create aura_lessons record
    const result = await app.db.query(
      `INSERT INTO aura_lessons (lesson_id, file_type, original_url, exploit_mode, uploaded_by, qa_status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       ON CONFLICT (lesson_id) DO UPDATE SET
         file_type = $2, original_url = $3, exploit_mode = $4, qa_status = 'pending', updated_at = NOW()
       RETURNING lesson_id, file_type, qa_status`,
      [lesson.rows[0].lesson_code, file_type, file_key, exploit_mode || 'hybrid', req.user.sub]
    )

    // Queue AURA parse job
    await app.redis.xadd('aura:pipeline', '*',
      'lesson_id', lesson.rows[0].lesson_code,
      'file_type', file_type,
      'file_key', file_key,
      'action', 'parse'
    )

    return reply.code(202).send({
      data: { ...result.rows[0], message: 'Upload accepted. AURA pipeline đang xử lý.' },
    })
  })

  // GET /aura/lessons — Danh sách AURA lessons
  app.get('/lessons', {
    preHandler: [app.authenticate, app.authorizeRole('teacher', 'admin')],
  }, async (req) => {
    const { file_type, qa_status, limit = 50, offset = 0 } = req.query as any
    let sql = `SELECT al.*, l.title, l.grade, l.bloom_level
               FROM aura_lessons al JOIN lessons l ON l.lesson_code = al.lesson_id
               WHERE 1=1`
    const params: any[] = []
    let p = 1
    if (file_type) { sql += ` AND al.file_type = $${p++}`; params.push(file_type) }
    if (qa_status) { sql += ` AND al.qa_status = $${p++}`; params.push(qa_status) }
    sql += ` ORDER BY al.created_at DESC LIMIT $${p++} OFFSET $${p++}`
    params.push(limit, offset)
    const result = await app.db.query(sql, params)
    return { data: result.rows }
  })

  // GET /aura/lessons/:id — Chi tiết aura_lesson
  app.get<{ Params: { id: string } }>('/lessons/:id', {
    preHandler: [app.authenticate, app.authorizeRole('teacher', 'admin')],
  }, async (req, reply) => {
    const result = await app.db.query(
      `SELECT al.*, l.title, l.grade, l.bloom_level, l.html_content
       FROM aura_lessons al JOIN lessons l ON l.lesson_code = al.lesson_id
       WHERE al.lesson_id = $1`,
      [req.params.id]
    )
    if (!result.rows[0]) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'AURA lesson không tồn tại' } })
    return { data: result.rows[0] }
  })

  // GET /aura/lessons/:id/qa — QA checklist status (12 điểm A01-A12)
  app.get<{ Params: { id: string } }>('/lessons/:id/qa', {
    preHandler: [app.authenticate, app.authorizeRole('teacher', 'admin')],
  }, async (req) => {
    const result = await app.db.query(
      `SELECT qa_status, qa_checklist, parse_error FROM aura_lessons WHERE lesson_id = $1`,
      [req.params.id]
    )
    const checklist = result.rows[0]?.qa_checklist || {}
    const passed = result.rows[0]?.qa_status === 'pass'
    const blocked = checklist['A01'] === 'fail' || checklist['A02'] === 'fail'
    return { data: { qa_status: result.rows[0]?.qa_status, checklist, passed, blocked } }
  })

  // POST /aura/lessons/:id/activate — Activate lesson (sau QA pass)
  app.post<{ Params: { id: string } }>('/lessons/:id/activate', {
    preHandler: [app.authenticate, app.authorizeRole('teacher', 'admin')],
  }, async (req, reply) => {
    // Check QA pass
    const qa = await app.db.query(
      `SELECT qa_status FROM aura_lessons WHERE lesson_id = $1`, [req.params.id]
    )
    if (qa.rows[0]?.qa_status !== 'pass') {
      return reply.code(403).send({
        error: { code: 'QA_NOT_PASSED', message: 'AURA QA chưa pass. Không thể activate.' },
      })
    }
    // Update lesson status to published
    await app.db.query(
      `UPDATE lessons SET status = 'published', published_at = NOW()
       WHERE lesson_code = $1`, [req.params.id]
    )
    return { data: { status: 'active', lesson_id: req.params.id } }
  })

  // GET /aura/lessons/:id/versions — Lịch sử versions
  app.get<{ Params: { id: string } }>('/lessons/:id/versions', {
    preHandler: [app.authenticate, app.authorizeRole('teacher', 'admin')],
  }, async (req) => {
    const result = await app.db.query(
      `SELECT v.*, u.full_name as created_by_name
       FROM aura_versions v JOIN users u ON u.id = v.created_by
       WHERE v.lesson_id = $1 ORDER BY v.version_num DESC`,
      [req.params.id]
    )
    return { data: result.rows }
  })

  // POST /aura/lessons/:id/rollback/:version — Rollback to specific version
  app.post<{ Params: { id: string; version: string } }>('/lessons/:id/rollback/:version', {
    preHandler: [app.authenticate, app.authorizeRole('teacher', 'admin')],
  }, async (req, reply) => {
    const { id, version } = req.params
    const v = await app.db.query(
      `SELECT minio_path FROM aura_versions WHERE lesson_id = $1 AND version_num = $2`,
      [id, parseInt(version)]
    )
    if (!v.rows[0]) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Version không tồn tại' } })
    // Update aura_lessons to point to old version
    await app.db.query(
      `UPDATE aura_lessons SET original_url = $2, qa_status = 'pending', updated_at = NOW()
       WHERE lesson_id = $1`, [id, v.rows[0].minio_path]
    )
    return { data: { rolled_back_to: parseInt(version) } }
  })

  // GET /aura/serve/:id — Serve học liệu cho HS (iframe proxy)
  app.get<{ Params: { id: string } }>('/serve/:id', {
    preHandler: [app.authenticate],
  }, async (req, reply) => {
    const result = await app.db.query(
      `SELECT al.original_url, al.file_type, l.status
       FROM aura_lessons al JOIN lessons l ON l.lesson_code = al.lesson_id
       WHERE al.lesson_id = $1`, [req.params.id]
    )
    if (!result.rows[0]) return reply.code(404).send({ error: { code: 'NOT_FOUND' } })
    if (result.rows[0].status !== 'published') {
      return reply.code(403).send({ error: { code: 'LESSON_NOT_ACTIVE', message: 'Bài học chưa được publish' } })
    }
    // Return presigned URL for iframe embedding (Nginx X-Accel-Redirect in production)
    const minioEndpoint = process.env['MINIO_ENDPOINT'] || 'http://minio:9000'
    return { data: { serve_url: `${minioEndpoint}/adaptlearn/${result.rows[0].original_url}`, file_type: result.rows[0].file_type } }
  })

  // GET /aura/gap-analysis — Bloom gap analysis
  app.get('/gap-analysis', {
    preHandler: [app.authenticate, app.authorizeRole('teacher', 'admin')],
  }, async (req) => {
    const { grade, subject } = req.query as any
    const result = await app.db.query(
      `SELECT bloom_level, COUNT(*) as count
       FROM lessons WHERE deleted_at IS NULL AND status = 'published'
       ${grade ? `AND grade = ${parseInt(grade)}` : ''}
       ${subject ? `AND subject = '${subject}'` : ''}
       GROUP BY bloom_level ORDER BY bloom_level`,
    )
    // Calculate gaps
    const target = { 1: 0.10, 2: 0.20, 3: 0.30, 4: 0.20, 5: 0.10, 6: 0.10 }
    const total = result.rows.reduce((sum: number, r: any) => sum + parseInt(r.count), 0) || 1
    const gaps = Object.entries(target).map(([bloom, targetPct]) => {
      const actual = result.rows.find((r: any) => r.bloom_level === parseInt(bloom))
      const actualPct = actual ? parseInt(actual.count) / total : 0
      const gap = targetPct - actualPct
      return { bloom_level: parseInt(bloom), target_pct: targetPct, actual_pct: Math.round(actualPct * 100) / 100, gap: Math.round(gap * 100) / 100, has_gap: gap > 0.05 }
    })
    return { data: { total_lessons: total, bloom_distribution: result.rows, gaps } }
  })

  // POST /aura/import/questions — Import OCR → questions
  app.post('/import/questions', {
    preHandler: [app.authenticate, app.authorizeRole('teacher', 'admin')],
  }, async (req, reply) => {
    // Placeholder for OCR import pipeline (Tesseract + Mathpix)
    const { file_key, lesson_id } = req.body as any
    // Queue import job
    await app.redis.xadd('aura:import', '*',
      'file_key', file_key || '',
      'lesson_id', lesson_id || '',
      'user_id', req.user.sub
    )
    return reply.code(202).send({ data: { message: 'Import job queued. GV review sau khi xong.' } })
  })

  // GET /aura/lessons/:id/events — Events từ AURA Bridge
  app.get<{ Params: { id: string } }>('/lessons/:id/events', {
    preHandler: [app.authenticate, app.authorizeRole('teacher', 'admin')],
  }, async (req) => {
    const result = await app.db.query(
      `SELECT id, event_type, payload, created_at
       FROM events WHERE lesson_id = (SELECT id FROM lessons WHERE lesson_code = $1 LIMIT 1)
       AND event_type LIKE 'AURA_%'
       ORDER BY created_at DESC LIMIT 100`,
      [req.params.id]
    )
    return { data: result.rows }
  })

  // DELETE /aura/lessons/:id — Archive AURA lesson
  app.delete<{ Params: { id: string } }>('/lessons/:id', {
    preHandler: [app.authenticate, app.authorizeRole('teacher', 'admin')],
  }, async (req) => {
    await app.db.query(
      `UPDATE aura_lessons SET qa_status = 'fail', updated_at = NOW() WHERE lesson_id = $1`,
      [req.params.id]
    )
    await app.db.query(
      `UPDATE lessons SET status = 'archived' WHERE lesson_code = $1`, [req.params.id]
    )
    return { data: { success: true } }
  })
}

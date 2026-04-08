/**
 * File & Media API Routes — SRS-CH05 §5.4.3
 * Upload flow: (1) presign → (2) Client PUT MinIO direct → (3) confirm
 * Base: /api/v1/files
 */
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import crypto from 'crypto'

export async function fileRoutes(app: FastifyInstance) {

  // POST /files/presign — get presigned PUT URL for direct MinIO upload
  app.post('/presign', {
    preHandler: [app.authenticate, app.authorizeRole('teacher', 'admin')],
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { filename, content_type, file_size_bytes } = req.body as {
      filename: string; content_type: string; file_size_bytes: number
    }

    if (!filename || !content_type) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'filename và content_type bắt buộc' } })
    }
    if (file_size_bytes > 2 * 1024 * 1024 * 1024) { // 2GB max
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'File vượt quá 2GB' } })
    }

    const fileKey = `uploads/${Date.now()}_${crypto.randomBytes(8).toString('hex')}_${filename}`
    const ttl = file_size_bytes > 100 * 1024 * 1024 ? 7200 : 3600 // 2h cho file >100MB, 1h còn lại

    // In production: generate MinIO presigned URL
    // For now: return placeholder
    const minioEndpoint = process.env['MINIO_ENDPOINT'] || 'http://minio:9000'
    const uploadUrl = `${minioEndpoint}/adaptlearn/${fileKey}?X-Amz-Expires=${ttl}`

    return {
      data: {
        upload_url: uploadUrl,
        file_key: fileKey,
        expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
        method: 'PUT',
        headers: { 'Content-Type': content_type },
      },
    }
  })

  // POST /files/confirm — confirm upload completed, save metadata
  app.post('/confirm', {
    preHandler: [app.authenticate, app.authorizeRole('teacher', 'admin')],
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { file_key, lesson_id, media_type } = req.body as {
      file_key: string; lesson_id: string; media_type: string
    }

    if (!file_key) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'file_key bắt buộc' } })
    }

    const result = await app.db.query(
      `INSERT INTO learning_materials (lesson_id, material_type, minio_key, minio_bucket, uploaded_by, pipeline_status)
       VALUES ($1, $2, $3, 'adaptlearn', $4, 'ready')
       RETURNING id, minio_key`,
      [lesson_id || null, media_type || 'html', file_key, req.user.sub]
    )

    const minioEndpoint = process.env['MINIO_ENDPOINT'] || 'http://minio:9000'
    return {
      data: {
        media_id: result.rows[0].id,
        media_url_signed: `${minioEndpoint}/adaptlearn/${file_key}`,
      },
    }
  })

  // GET /files/:key/url — get presigned GET URL to view file
  app.get<{ Params: { key: string } }>('/:key/url', {
    preHandler: [app.authenticate],
  }, async (req) => {
    const minioEndpoint = process.env['MINIO_ENDPOINT'] || 'http://minio:9000'
    return {
      data: {
        url: `${minioEndpoint}/adaptlearn/${req.params.key}`,
        expires_at: new Date(Date.now() + 3600 * 1000).toISOString(), // 1h TTL
      },
    }
  })

  // GET /files/:key/metadata — file metadata without download
  app.get<{ Params: { key: string } }>('/:key/metadata', {
    preHandler: [app.authenticate, app.authorizeRole('teacher', 'admin')],
  }, async (req, reply) => {
    const result = await app.db.query(
      `SELECT id, material_type, minio_key, file_size_bytes, mime_type, created_at
       FROM learning_materials WHERE minio_key = $1`,
      [req.params.key]
    )
    if (!result.rows[0]) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'File không tồn tại' } })
    return { data: result.rows[0] }
  })

  // DELETE /files/:key — delete file (teacher+)
  app.delete<{ Params: { key: string } }>('/:key', {
    preHandler: [app.authenticate, app.authorizeRole('teacher', 'admin')],
  }, async (req, reply) => {
    await app.db.query(
      `DELETE FROM learning_materials WHERE minio_key = $1`, [req.params.key]
    )
    // TODO: Also delete from MinIO bucket
    return { data: { success: true } }
  })
}

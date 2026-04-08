/**
 * WebSocket Routes — SRS-CH05 §5.8
 * Real-time events: grader:result, agent:recommendation, agent:feedback,
 *                   notification:new, peer_review:received
 *
 * Uses Server-Sent Events (SSE) for Phase 1 (no socket.io dependency).
 * Upgrade to Socket.io in Phase 2 for bidirectional.
 *
 * Base: /api/v1/ws
 */
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'

// Active SSE connections by user ID
const connections = new Map<string, FastifyReply[]>()

/**
 * Send event to a specific user via SSE
 */
export function sendToUser(userId: string, event: string, data: unknown): void {
  const replies = connections.get(userId)
  if (!replies) return
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const reply of replies) {
    try {
      reply.raw.write(payload)
    } catch {
      // Connection closed — will be cleaned up
    }
  }
}

/**
 * Send event to all users in a class
 */
export function sendToClass(classCode: string, event: string, data: unknown): void {
  // In production: lookup class members from DB/cache
  // For now: broadcast to all connections
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  connections.forEach((replies) => {
    for (const reply of replies) {
      try {
        reply.raw.write(payload)
      } catch { /* ignore */ }
    }
  })
}

export async function websocketRoutes(app: FastifyInstance): Promise<void> {

  // GET /ws/events — SSE stream for authenticated user
  app.get('/events', {
    preHandler: [app.authenticate],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.user.sub

    // Set SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Nginx: disable buffering
    })

    // Send initial connection event
    reply.raw.write(`event: connected\ndata: ${JSON.stringify({ user_id: userId, ts: Date.now() })}\n\n`)

    // Register connection
    if (!connections.has(userId)) {
      connections.set(userId, [])
    }
    connections.get(userId)!.push(reply)

    app.log.info({ userId, total: connections.size }, 'SSE client connected')

    // Heartbeat every 30s to keep connection alive
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`)
      } catch {
        clearInterval(heartbeat)
      }
    }, 30000)

    // Cleanup on disconnect
    request.raw.on('close', () => {
      clearInterval(heartbeat)
      const userReplies = connections.get(userId)
      if (userReplies) {
        const idx = userReplies.indexOf(reply)
        if (idx >= 0) userReplies.splice(idx, 1)
        if (userReplies.length === 0) connections.delete(userId)
      }
      app.log.info({ userId, total: connections.size }, 'SSE client disconnected')
    })

    // Don't end the response — keep SSE stream open
    await new Promise(() => {}) // Never resolves — connection stays open
  })

  // POST /ws/emit — Internal: emit event to user (called by agent/grader)
  app.post('/emit', {
    preHandler: [app.authenticate],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    // Only internal services or admin
    const internalKey = request.headers['x-internal-key']
    if (!internalKey && request.user.role !== 'admin') {
      return reply.code(403).send({ error: { code: 'FORBIDDEN' } })
    }

    const { target_user_id, event, data } = request.body as {
      target_user_id: string; event: string; data: unknown
    }

    sendToUser(target_user_id, event, data)
    return { data: { sent: true, connections: connections.get(target_user_id)?.length || 0 } }
  })

  // GET /ws/stats — Admin: connection stats
  app.get('/stats', {
    preHandler: [app.authenticate, app.authorizeRole('admin')],
  }, async () => {
    return {
      data: {
        total_connections: Array.from(connections.values()).reduce((sum, r) => sum + r.length, 0),
        unique_users: connections.size,
      },
    }
  })

  // ── Redis subscriber for event routing ──────────────────────────────────
  // Listen to Redis pub/sub for events that need real-time delivery
  const sub = app.redis.duplicate()
  await sub.subscribe('ws:events')
  sub.on('message', (_channel: string, message: string) => {
    try {
      const { target_user_id, event, data } = JSON.parse(message)
      if (target_user_id) {
        sendToUser(target_user_id, event, data)
      }
    } catch (e) {
      app.log.error({ e }, 'Failed to parse ws:events message')
    }
  })
}

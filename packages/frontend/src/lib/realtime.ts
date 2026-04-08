'use client'
import { useEffect, useRef, useCallback, useState } from 'react'

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'https://learn.thuthiem.edu.vn/api/v1'

type EventHandler = (data: unknown) => void

/**
 * SSE Real-time Events Hook — SRS-CH05 §5.8
 * Phase 1: Server-Sent Events (no socket.io dependency)
 * Phase 2: Upgrade to Socket.io for bidirectional
 *
 * Events: grader:result, agent:recommendation, agent:feedback,
 *         notification:new, peer_review:received, heartbeat
 */
export function useRealtimeEvents(handlers: Record<string, EventHandler>) {
  const [connected, setConnected] = useState(false)
  const eventSourceRef = useRef<EventSource | null>(null)
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  const connect = useCallback(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('access_token') : null
    if (!token) return

    // Close existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
    }

    const es = new EventSource(`${API_BASE}/ws/events?token=${token}`)
    eventSourceRef.current = es

    es.onopen = () => setConnected(true)
    es.onerror = () => {
      setConnected(false)
      // Auto-reconnect after 5s
      setTimeout(() => connect(), 5000)
    }

    // Register event listeners
    const eventTypes = [
      'connected', 'heartbeat',
      'grader:result', 'agent:recommendation', 'agent:feedback',
      'notification:new', 'peer_review:received',
    ]

    for (const type of eventTypes) {
      es.addEventListener(type, (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data)
          const handler = handlersRef.current[type]
          if (handler) handler(data)
        } catch { /* ignore parse errors */ }
      })
    }
  }, [])

  useEffect(() => {
    connect()
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close()
        eventSourceRef.current = null
      }
    }
  }, [connect])

  return { connected }
}

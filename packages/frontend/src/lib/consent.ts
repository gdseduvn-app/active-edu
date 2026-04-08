'use client'
import { useEffect, useState } from 'react'
import { apiFetch } from './api'

interface ConsentStatus {
  student_assent: boolean
  parent_consent: boolean
  fully_consented: boolean
  purposes: string[]
  version: string | null
}

export function useConsent() {
  const [consent, setConsent] = useState<ConsentStatus | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    apiFetch<{ data: ConsentStatus }>('/privacy/consent/status')
      .then((r) => setConsent(r.data))
      .catch(() => setConsent(null))
      .finally(() => setLoading(false))
  }, [])

  const grantConsent = async (type: 'student_assent' | 'parent_consent', parentEmail?: string) => {
    await apiFetch('/privacy/consent', {
      method: 'POST',
      body: JSON.stringify({
        consent_type: type,
        purpose: ['learning_analytics', 'ai_agent', 'gamification'],
        parent_email: parentEmail,
      }),
    })
    // Refresh status
    const r = await apiFetch<{ data: ConsentStatus }>('/privacy/consent/status')
    setConsent(r.data)
  }

  const withdrawConsent = async (reason?: string) => {
    await apiFetch('/privacy/consent/withdraw', {
      method: 'POST',
      body: JSON.stringify({ reason }),
    })
    setConsent(null)
    window.location.href = '/login'
  }

  return { consent, loading, grantConsent, withdrawConsent }
}

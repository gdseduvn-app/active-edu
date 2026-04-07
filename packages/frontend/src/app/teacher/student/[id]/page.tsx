'use client'
/**
 * Teacher — Student Detail Page
 * Route: /teacher/student/[id]
 * Shows full learner model, SOLO profile, recent decisions, quiz history,
 * and allows teacher to override next lesson.
 */

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { apiFetch } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import toast from 'react-hot-toast'

interface LearnerModel {
  user_id: string
  mastery_map: Record<string, number>
  bloom_profile: Record<string, number>
  solo_profile: Record<string, number>
  declarative_mastery: number
  functioning_mastery: number
  current_level: string
  current_lesson_id: string | null
  error_patterns: Record<string, number>
  learning_approach: string
  streak_days: number
  updated_at: string
}

interface AgentDecision {
  id: string
  rule_fired: string
  reason: string
  confidence: number
  action: string
  next_lesson_title?: string
  created_at: string
}

interface UserProfile {
  id: string
  full_name: string
  username: string
  email: string
  class_id: string
  grade: number
  last_login_at: string
}

const SOLO_LABELS: Record<number, { label: string; color: string }> = {
  1: { label: 'Prestructural', color: 'bg-gray-100 text-gray-600' },
  2: { label: 'Unistructural', color: 'bg-blue-100 text-blue-700' },
  3: { label: 'Multistructural', color: 'bg-amber-100 text-amber-700' },
  4: { label: 'Relational', color: 'bg-green-100 text-green-700' },
  5: { label: 'Extended Abstract', color: 'bg-purple-100 text-purple-700' },
}

export default function StudentDetailPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const { user } = useAuth()

  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [lm, setLm] = useState<LearnerModel | null>(null)
  const [decisions, setDecisions] = useState<AgentDecision[]>([])
  const [loading, setLoading] = useState(true)
  const [overrideModal, setOverrideModal] = useState(false)
  const [overrideLessonId, setOverrideLessonId] = useState('')
  const [overrideReason, setOverrideReason] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!user || (user.role !== 'teacher' && user.role !== 'admin')) {
      router.push('/dashboard')
      return
    }

    Promise.allSettled([
      apiFetch<{ data: { user: UserProfile; learner_model: LearnerModel } }>(`/users/${id}`),
      apiFetch<{ data: AgentDecision[] }>(`/agent/recommendations/${id}`),
    ]).then(([profileRes, decisionsRes]) => {
      if (profileRes.status === 'fulfilled') {
        const d = (profileRes.value as any).data
        setProfile(d.user || d)
        setLm(d.learner_model || null)
      }
      if (decisionsRes.status === 'fulfilled') {
        setDecisions((decisionsRes.value as any).data || [])
      }
    }).finally(() => setLoading(false))
  }, [id, user, router])

  const handleOverride = async () => {
    if (!overrideLessonId || overrideReason.length < 10) {
      toast.error('Vui lòng nhập mã bài học và lý do (ít nhất 10 ký tự)')
      return
    }
    setSaving(true)
    try {
      await apiFetch('/agent/override', {
        method: 'POST',
        body: JSON.stringify({ user_id: id, next_lesson_id: overrideLessonId, reason: overrideReason })
      })
      toast.success('Đã ghi đè kế hoạch học tập')
      setOverrideModal(false)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Lỗi khi ghi đè')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-10 h-10 border-4 border-primary-500 border-t-transparent rounded-full animate-spin" />
    </div>
  )

  if (!profile) return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <p className="text-gray-500">Không tìm thấy học sinh</p>
    </div>
  )

  const soloAvg = lm?.solo_profile
    ? Math.round(Object.values(lm.solo_profile).reduce((a, b) => a + b, 0) / Math.max(Object.keys(lm.solo_profile).length, 1))
    : 3
  const soloInfo = SOLO_LABELS[soloAvg] || SOLO_LABELS[3]

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-5xl mx-auto">
        {/* Back */}
        <button onClick={() => router.push('/teacher')} className="flex items-center gap-2 text-gray-500 hover:text-gray-700 mb-6 text-sm">
          ← Quay lại Dashboard
        </button>

        {/* Student header */}
        <div className="bg-white rounded-2xl border border-gray-100 p-6 mb-6 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 bg-primary-100 rounded-2xl flex items-center justify-center text-primary-600 text-2xl font-bold">
              {profile.full_name.charAt(0)}
            </div>
            <div>
              <h1 className="text-xl font-bold text-gray-800">{profile.full_name}</h1>
              <p className="text-gray-500 text-sm">{profile.username} · Lớp {profile.class_id}</p>
              <p className="text-gray-400 text-xs mt-0.5">
                Đăng nhập lần cuối: {profile.last_login_at ? new Date(profile.last_login_at).toLocaleString('vi-VN') : 'Chưa đăng nhập'}
              </p>
            </div>
          </div>
          <button onClick={() => setOverrideModal(true)}
            className="flex items-center gap-2 bg-amber-500 text-white px-5 py-2.5 rounded-xl hover:bg-amber-600 transition font-medium">
            🔄 Ghi đè bài tiếp theo
          </button>
        </div>

        <div className="grid grid-cols-3 gap-6 mb-6">
          {/* Mastery stats */}
          <div className="bg-white rounded-2xl border border-gray-100 p-5">
            <h3 className="font-semibold text-gray-700 mb-4 text-sm uppercase tracking-wider">Mastery</h3>
            <div className="space-y-3">
              <StatRow label="Declarative" value={Math.round((lm?.declarative_mastery || 0) * 100)} unit="%" color="bg-blue-500" />
              <StatRow label="Functioning" value={Math.round((lm?.functioning_mastery || 0) * 100)} unit="%" color="bg-green-500" />
              <StatRow label="Streak" value={lm?.streak_days || 0} unit=" ngày" color="bg-amber-500" />
            </div>
          </div>

          {/* SOLO Profile */}
          <div className="bg-white rounded-2xl border border-gray-100 p-5">
            <h3 className="font-semibold text-gray-700 mb-4 text-sm uppercase tracking-wider">SOLO Taxonomy</h3>
            <div className="text-center">
              <div className={`inline-block px-4 py-1.5 rounded-full text-sm font-medium mb-2 ${soloInfo.color}`}>
                Level {soloAvg}: {soloInfo.label}
              </div>
              <div className="flex justify-center gap-1 mt-3">
                {[1, 2, 3, 4, 5].map(n => (
                  <div key={n} className={`w-8 h-8 rounded-lg text-xs font-bold flex items-center justify-center ${n <= soloAvg ? 'bg-primary-500 text-white' : 'bg-gray-100 text-gray-400'}`}>
                    {n}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Learning approach */}
          <div className="bg-white rounded-2xl border border-gray-100 p-5">
            <h3 className="font-semibold text-gray-700 mb-4 text-sm uppercase tracking-wider">Tiếp cận học tập</h3>
            <div className="text-center">
              <div className={`inline-block px-4 py-1.5 rounded-full text-sm font-medium mb-3 ${
                lm?.learning_approach === 'deep' ? 'bg-purple-100 text-purple-700' :
                lm?.learning_approach === 'surface' ? 'bg-orange-100 text-orange-700' :
                'bg-gray-100 text-gray-600'
              }`}>
                {lm?.learning_approach === 'deep' ? '🧠 Deep Learning' :
                 lm?.learning_approach === 'surface' ? '📖 Surface Learning' : '—'}
              </div>
              <p className="text-xs text-gray-400">Cấp độ hiện tại: {lm?.current_level || '—'}</p>
            </div>
          </div>
        </div>

        {/* Error patterns */}
        {lm?.error_patterns && Object.keys(lm.error_patterns).length > 0 && (
          <div className="bg-white rounded-2xl border border-gray-100 p-5 mb-6">
            <h3 className="font-semibold text-gray-700 mb-4 text-sm uppercase tracking-wider">Lỗi thường gặp</h3>
            <div className="flex flex-wrap gap-2">
              {Object.entries(lm.error_patterns).sort((a, b) => b[1] - a[1]).map(([pattern, count]) => (
                <span key={pattern} className="bg-red-50 border border-red-100 text-red-700 text-xs px-3 py-1 rounded-full">
                  {pattern} <strong>×{count}</strong>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Agent decisions */}
        <div className="bg-white rounded-2xl border border-gray-100 p-5">
          <h3 className="font-semibold text-gray-700 mb-4 text-sm uppercase tracking-wider">Quyết định AI gần đây</h3>
          {decisions.length === 0 ? (
            <p className="text-gray-400 text-sm text-center py-4">Chưa có quyết định nào</p>
          ) : (
            <div className="space-y-3">
              {decisions.map(d => (
                <div key={d.id} className="flex items-start gap-4 p-4 rounded-xl bg-gray-50">
                  <div className="shrink-0">
                    <span className={`text-xs font-bold px-2 py-1 rounded-lg ${
                      d.action === 'repair' ? 'bg-red-100 text-red-700' :
                      d.action === 'upgrade' ? 'bg-green-100 text-green-700' :
                      d.action === 'downgrade' ? 'bg-amber-100 text-amber-700' :
                      d.action === 'alert' ? 'bg-red-200 text-red-800' :
                      'bg-blue-100 text-blue-700'
                    }`}>
                      {d.rule_fired}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-700">{d.reason}</p>
                    {d.next_lesson_title && (
                      <p className="text-xs text-gray-500 mt-1">→ {d.next_lesson_title}</p>
                    )}
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-xs text-gray-400">{new Date(d.created_at).toLocaleString('vi-VN')}</p>
                    <p className="text-xs text-gray-400">Tin cậy: {Math.round(d.confidence * 100)}%</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Override modal */}
      {overrideModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6">
            <h3 className="text-lg font-bold text-gray-800 mb-1">Ghi đè kế hoạch học tập</h3>
            <p className="text-sm text-gray-500 mb-5">Chỉ định bài học tiếp theo thay cho gợi ý của AI</p>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">ID bài học tiếp theo</label>
                <input type="text" className="w-full border border-gray-300 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-primary-400"
                  placeholder="UUID của bài học"
                  value={overrideLessonId}
                  onChange={e => setOverrideLessonId(e.target.value)} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Lý do (bắt buộc)</label>
                <textarea rows={3} className="w-full border border-gray-300 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-primary-400 resize-none"
                  placeholder="Ví dụ: Học sinh đã hiểu bài, cần chuyển sang bài khó hơn…"
                  value={overrideReason}
                  onChange={e => setOverrideReason(e.target.value)} />
              </div>
            </div>
            <div className="flex gap-3 mt-5">
              <button onClick={() => setOverrideModal(false)} className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 text-gray-600 hover:bg-gray-50">
                Hủy
              </button>
              <button onClick={handleOverride} disabled={saving} className="flex-1 px-4 py-2.5 rounded-xl bg-amber-500 text-white font-medium hover:bg-amber-600 disabled:opacity-60">
                {saving ? 'Đang lưu…' : 'Xác nhận ghi đè'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function StatRow({ label, value, unit, color }: { label: string; value: number; unit: string; color: string }) {
  return (
    <div>
      <div className="flex justify-between text-sm mb-1">
        <span className="text-gray-600">{label}</span>
        <span className="font-semibold text-gray-800">{value}{unit}</span>
      </div>
      <div className="h-2 bg-gray-100 rounded-full">
        <div className={`h-2 rounded-full ${color} transition-all`} style={{ width: `${Math.min(value, 100)}%` }} />
      </div>
    </div>
  )
}

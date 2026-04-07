'use client'
/**
 * Teacher Dashboard
 * Source: SRS-CH03 §3.5 Teacher Tools
 * Route: /teacher
 *
 * Shows:
 * - Class overview (students, average mastery per lesson)
 * - At-risk students (R10 alerts from agent_decisions)
 * - Lesson management (link to create/edit lessons)
 * - Quick access to lesson studio
 */

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { apiFetch } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import Link from 'next/link'

interface StudentProgress {
  id: string
  full_name: string
  class_id: string
  current_level: string
  mastery_avg: number
  last_active: string
  alert: boolean
  alert_reason?: string
}

interface LessonStat {
  id: string
  title: string
  lesson_code: string
  attempt_count: number
  avg_score: number
  pass_rate: number
}

export default function TeacherDashboard() {
  const { user } = useAuth()
  const router = useRouter()
  const [students, setStudents] = useState<StudentProgress[]>([])
  const [lessons, setLessons] = useState<LessonStat[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'students' | 'lessons' | 'alerts'>('students')

  useEffect(() => {
    if (!user || (user.role !== 'teacher' && user.role !== 'admin')) {
      router.push('/dashboard')
      return
    }

    Promise.allSettled([
      apiFetch<{ data: StudentProgress[] }>('/users?role=student&limit=50'),
      apiFetch<{ data: LessonStat[] }>('/lessons?status=published&limit=30'),
    ]).then(([studRes, lessonRes]) => {
      if (studRes.status === 'fulfilled') setStudents((studRes.value as any).data || [])
      if (lessonRes.status === 'fulfilled') setLessons((lessonRes.value as any).data || [])
    }).finally(() => setLoading(false))
  }, [user, router])

  const alerts = students.filter(s => s.alert)
  const avgMastery = students.length
    ? Math.round(students.reduce((sum, s) => sum + (s.mastery_avg || 0), 0) / students.length * 100)
    : 0

  return (
    <div className="min-h-screen bg-gray-50 flex">
      {/* Sidebar */}
      <aside className="w-56 bg-sidebar text-white flex flex-col shrink-0">
        <div className="p-5 border-b border-white/10">
          <p className="text-xs text-white/60 uppercase tracking-widest mb-1">Giáo viên</p>
          <p className="font-bold text-lg leading-tight">{user?.full_name}</p>
        </div>
        <nav className="flex-1 p-3 space-y-1">
          {[
            { label: 'Tổng quan', href: '/teacher', icon: '📊' },
            { label: 'Lesson Studio', href: '/teacher/lessons', icon: '✏️' },
            { label: 'Ngân hàng câu hỏi', href: '/teacher/questions', icon: '📝' },
            { label: 'Báo cáo lớp', href: '/teacher/analytics', icon: '📈' },
            { label: 'Cài đặt', href: '/teacher/settings', icon: '⚙️' },
          ].map(item => (
            <Link key={item.href} href={item.href}
              className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-white/10 transition text-sm">
              <span>{item.icon}</span>
              <span>{item.label}</span>
            </Link>
          ))}
        </nav>
      </aside>

      {/* Main */}
      <div className="flex-1 p-8 overflow-auto">
        <div className="max-w-6xl mx-auto">
          {/* Header */}
          <div className="flex items-center justify-between mb-8">
            <div>
              <h1 className="text-2xl font-bold text-gray-800">Dashboard Giáo viên</h1>
              <p className="text-gray-500 text-sm mt-1">Xin chào, {user?.full_name} 👋</p>
            </div>
            <a
              href="https://learn.thuthiem.edu.vn/teacher/lesson-studio.html"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 bg-primary-500 text-white px-5 py-2.5 rounded-xl hover:bg-primary-600 transition font-medium"
            >
              <span>✨</span> Lesson Studio
            </a>
          </div>

          {/* Stat cards */}
          <div className="grid grid-cols-4 gap-4 mb-8">
            {[
              { label: 'Tổng học sinh', value: students.length, icon: '👥', color: 'bg-blue-50 text-blue-700' },
              { label: 'Mastery trung bình', value: `${avgMastery}%`, icon: '🎯', color: 'bg-green-50 text-green-700' },
              { label: 'Cần hỗ trợ', value: alerts.length, icon: '⚠️', color: alerts.length > 0 ? 'bg-red-50 text-red-700' : 'bg-gray-50 text-gray-600' },
              { label: 'Bài học đã xuất bản', value: lessons.length, icon: '📚', color: 'bg-purple-50 text-purple-700' },
            ].map(card => (
              <div key={card.label} className={`rounded-2xl p-5 ${card.color} border border-current/10`}>
                <div className="text-2xl mb-1">{card.icon}</div>
                <div className="text-3xl font-bold">{card.value}</div>
                <div className="text-sm mt-1 opacity-80">{card.label}</div>
              </div>
            ))}
          </div>

          {/* Alerts banner */}
          {alerts.length > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-2xl p-4 mb-6 flex items-start gap-3">
              <span className="text-red-500 text-xl mt-0.5">⚠️</span>
              <div>
                <p className="font-semibold text-red-700">{alerts.length} học sinh cần hỗ trợ ngay</p>
                <p className="text-sm text-red-600 mt-1">
                  {alerts.slice(0, 3).map(s => s.full_name).join(', ')}
                  {alerts.length > 3 && ` và ${alerts.length - 3} học sinh khác`}
                </p>
              </div>
              <button
                onClick={() => setTab('alerts')}
                className="ml-auto text-sm text-red-600 underline hover:no-underline shrink-0"
              >
                Xem chi tiết →
              </button>
            </div>
          )}

          {/* Tabs */}
          <div className="flex gap-1 bg-gray-100 rounded-xl p-1 mb-6 w-fit">
            {(['students', 'lessons', 'alerts'] as const).map(t => (
              <button key={t} onClick={() => setTab(t)}
                className={`px-5 py-2 rounded-lg text-sm font-medium transition ${tab === t ? 'bg-white shadow-sm text-gray-800' : 'text-gray-500 hover:text-gray-700'}`}>
                {t === 'students' ? `Học sinh (${students.length})` :
                 t === 'lessons' ? `Bài học (${lessons.length})` :
                 `Cảnh báo ${alerts.length > 0 ? `(${alerts.length})` : ''}`}
              </button>
            ))}
          </div>

          {/* Tab content */}
          {loading ? (
            <div className="bg-white rounded-2xl border border-gray-100 p-12 text-center">
              <div className="w-8 h-8 border-3 border-primary-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
              <p className="text-gray-400">Đang tải dữ liệu…</p>
            </div>
          ) : (
            <>
              {tab === 'students' && <StudentsTable students={students} />}
              {tab === 'lessons' && <LessonsTable lessons={lessons} />}
              {tab === 'alerts' && <AlertsPanel students={alerts} />}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function StudentsTable({ students }: { students: StudentProgress[] }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
      <table className="w-full">
        <thead className="bg-gray-50 text-xs uppercase tracking-wider text-gray-500">
          <tr>
            <th className="px-5 py-3 text-left">Học sinh</th>
            <th className="px-5 py-3 text-left">Lớp</th>
            <th className="px-5 py-3 text-left">Cấp độ hiện tại</th>
            <th className="px-5 py-3 text-center">Mastery TB</th>
            <th className="px-5 py-3 text-left">Hoạt động gần nhất</th>
            <th className="px-5 py-3 text-center">Trạng thái</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {students.map(s => (
            <tr key={s.id} className="hover:bg-gray-50 transition">
              <td className="px-5 py-3.5 font-medium text-gray-800">{s.full_name}</td>
              <td className="px-5 py-3.5 text-gray-600">{s.class_id}</td>
              <td className="px-5 py-3.5">
                <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">
                  {s.current_level || 'nen_tang'}
                </span>
              </td>
              <td className="px-5 py-3.5 text-center">
                <div className="flex items-center justify-center gap-2">
                  <div className="w-24 bg-gray-200 rounded-full h-2">
                    <div
                      className={`h-2 rounded-full ${(s.mastery_avg || 0) >= 0.8 ? 'bg-green-500' : (s.mastery_avg || 0) >= 0.5 ? 'bg-amber-400' : 'bg-red-400'}`}
                      style={{ width: `${Math.round((s.mastery_avg || 0) * 100)}%` }}
                    />
                  </div>
                  <span className="text-sm text-gray-600 w-10">{Math.round((s.mastery_avg || 0) * 100)}%</span>
                </div>
              </td>
              <td className="px-5 py-3.5 text-sm text-gray-500">
                {s.last_active ? new Date(s.last_active).toLocaleDateString('vi-VN') : '—'}
              </td>
              <td className="px-5 py-3.5 text-center">
                {s.alert ? (
                  <span className="text-xs bg-red-100 text-red-600 px-2 py-0.5 rounded-full font-medium">⚠️ Cần hỗ trợ</span>
                ) : (
                  <span className="text-xs bg-green-100 text-green-600 px-2 py-0.5 rounded-full">✓ Bình thường</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {students.length === 0 && (
        <div className="text-center py-12 text-gray-400">Chưa có dữ liệu học sinh</div>
      )}
    </div>
  )
}

function LessonsTable({ lessons }: { lessons: LessonStat[] }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
        <h3 className="font-semibold text-gray-800">Bài học đã xuất bản</h3>
        <a href="https://learn.thuthiem.edu.vn/teacher/lesson-studio.html" target="_blank"
          className="text-sm text-primary-600 hover:underline">
          + Tạo bài học mới
        </a>
      </div>
      <table className="w-full">
        <thead className="bg-gray-50 text-xs uppercase tracking-wider text-gray-500">
          <tr>
            <th className="px-5 py-3 text-left">Bài học</th>
            <th className="px-5 py-3 text-left">Mã</th>
            <th className="px-5 py-3 text-center">Lượt làm</th>
            <th className="px-5 py-3 text-center">Điểm TB</th>
            <th className="px-5 py-3 text-center">Tỷ lệ qua</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {lessons.map(l => (
            <tr key={l.id} className="hover:bg-gray-50 transition">
              <td className="px-5 py-3.5 font-medium text-gray-800">{l.title}</td>
              <td className="px-5 py-3.5 font-mono text-xs text-gray-500">{l.lesson_code}</td>
              <td className="px-5 py-3.5 text-center text-gray-600">{l.attempt_count || 0}</td>
              <td className="px-5 py-3.5 text-center text-gray-600">{Math.round(l.avg_score || 0)}%</td>
              <td className="px-5 py-3.5 text-center">
                <span className={`text-sm font-medium ${(l.pass_rate || 0) >= 0.7 ? 'text-green-600' : 'text-amber-600'}`}>
                  {Math.round((l.pass_rate || 0) * 100)}%
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {lessons.length === 0 && (
        <div className="text-center py-12 text-gray-400">Chưa có bài học nào được xuất bản</div>
      )}
    </div>
  )
}

function AlertsPanel({ students }: { students: StudentProgress[] }) {
  if (students.length === 0) {
    return (
      <div className="bg-white rounded-2xl border border-gray-100 p-12 text-center">
        <div className="text-5xl mb-4">✅</div>
        <p className="text-gray-600 font-medium">Tất cả học sinh đang tiến bộ tốt</p>
        <p className="text-gray-400 text-sm mt-1">Không có cảnh báo nào từ hệ thống AI</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {students.map(s => (
        <div key={s.id} className="bg-white rounded-2xl border border-red-100 p-5 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 bg-red-100 rounded-full flex items-center justify-center text-red-600 font-bold">
              {s.full_name.charAt(0)}
            </div>
            <div>
              <p className="font-semibold text-gray-800">{s.full_name}</p>
              <p className="text-sm text-gray-500">Lớp {s.class_id} · Mastery: {Math.round((s.mastery_avg || 0) * 100)}%</p>
              {s.alert_reason && (
                <p className="text-sm text-red-600 mt-0.5">⚠️ {s.alert_reason}</p>
              )}
            </div>
          </div>
          <Link href={`/teacher/student/${s.id}`}
            className="text-sm text-primary-600 hover:text-primary-700 border border-primary-200 px-4 py-2 rounded-xl hover:bg-primary-50 transition">
            Xem chi tiết →
          </Link>
        </div>
      ))}
    </div>
  )
}

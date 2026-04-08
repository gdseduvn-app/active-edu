'use client'
import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api'
import { useAuth } from '@/lib/auth'

/**
 * Admin Dashboard — User management, Audit log, System monitoring
 * Source: SRS-CH06, UI_Ch0 SCR-1-06
 */

interface SystemStats {
  total_users: number
  active_students: number
  total_lessons: number
  aura_lessons: number
  pending_deletions: number
  recent_decisions: number
}

interface AuditEntry {
  id: string
  actor_role: string
  action: string
  target_user_id: string | null
  created_at: string
}

interface DeletionRequest {
  id: string
  user_id: string
  requested_by: string
  status: string
  sla_deadline: string
  created_at: string
}

export default function AdminDashboardPage() {
  const { user } = useAuth()
  const [stats, setStats] = useState<SystemStats | null>(null)
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [deletions, setDeletions] = useState<DeletionRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'overview' | 'audit' | 'deletions' | 'users'>('overview')

  useEffect(() => {
    if (user?.role !== 'admin') return
    Promise.all([
      apiFetch<{ data: any }>('/analytics/class/overview').then(r => setStats(r.data)).catch(() => {}),
      apiFetch<{ data: AuditEntry[] }>('/analytics/agent/performance').catch(() => {}),
    ]).finally(() => setLoading(false))
  }, [user])

  if (user?.role !== 'admin') {
    return <div className="min-h-screen flex items-center justify-center">
      <p className="text-red-500">Chỉ admin mới truy cập được trang này.</p>
    </div>
  }

  const tabs = [
    { id: 'overview', label: 'Tổng quan' },
    { id: 'audit', label: 'Audit Log' },
    { id: 'deletions', label: 'Yêu cầu xóa dữ liệu' },
    { id: 'users', label: 'Quản lý Users' },
  ] as const

  return (
    <div className="min-h-screen bg-[#F5F5F2]">
      <div className="bg-white border-b px-6 py-4">
        <h1 className="text-2xl font-bold text-gray-800">Admin Dashboard</h1>
        <p className="text-sm text-gray-500">Quản trị hệ thống · Audit log · Privacy compliance</p>
      </div>

      {/* Tab Navigation */}
      <div className="bg-white border-b px-6">
        <div className="flex gap-1">
          {tabs.map(t => (
            <button key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors
                ${tab === t.id ? 'border-[#185EA5] text-[#185EA5]' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="max-w-6xl mx-auto p-6">
        {tab === 'overview' && (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <MetricCard label="Học sinh active" value={stats?.active_students || 0} color="blue" />
            <MetricCard label="Tổng bài học" value={stats?.total_lessons || 0} color="green" />
            <MetricCard label="Bài AURA" value={stats?.aura_lessons || 0} color="purple" />
            <MetricCard label="Yêu cầu xóa chờ" value={stats?.pending_deletions || 0} color="red" />
            <MetricCard label="Agent decisions (30d)" value={stats?.recent_decisions || 0} color="amber" />
            <MetricCard label="Tổng users" value={stats?.total_users || 0} color="gray" />
          </div>
        )}

        {tab === 'audit' && (
          <div className="bg-white rounded-xl shadow-sm p-6">
            <h2 className="font-semibold mb-4">Privacy Audit Log (gần nhất)</h2>
            <p className="text-sm text-gray-400 mb-4">Append-only — không thể xóa hoặc sửa (NĐ 13/2023 Đ26)</p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2 text-left">Thời gian</th>
                    <th className="px-4 py-2 text-left">Role</th>
                    <th className="px-4 py-2 text-left">Action</th>
                    <th className="px-4 py-2 text-left">Target</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.map(a => (
                    <tr key={a.id} className="border-b">
                      <td className="px-4 py-2 text-gray-500">{new Date(a.created_at).toLocaleString('vi-VN')}</td>
                      <td className="px-4 py-2">{a.actor_role}</td>
                      <td className="px-4 py-2">
                        <span className="px-2 py-0.5 rounded-full text-xs bg-blue-100 text-blue-800">{a.action}</span>
                      </td>
                      <td className="px-4 py-2 text-gray-500">{a.target_user_id || '—'}</td>
                    </tr>
                  ))}
                  {audit.length === 0 && (
                    <tr><td colSpan={4} className="px-4 py-8 text-center text-gray-400">Chưa có audit log</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === 'deletions' && (
          <div className="bg-white rounded-xl shadow-sm p-6">
            <h2 className="font-semibold mb-4">Yêu cầu xóa dữ liệu (NĐ 13/2023 Đ16 — SLA 72h)</h2>
            <div className="space-y-3">
              {deletions.map(d => (
                <div key={d.id} className="border rounded-lg p-4 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">User: {d.user_id.substring(0, 8)}...</p>
                    <p className="text-xs text-gray-500">
                      Yêu cầu bởi: {d.requested_by} · {new Date(d.created_at).toLocaleDateString('vi-VN')}
                    </p>
                    <p className="text-xs text-red-500">
                      SLA deadline: {new Date(d.sla_deadline).toLocaleString('vi-VN')}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    {d.status === 'pending' && (
                      <>
                        <button className="px-3 py-1.5 bg-green-500 text-white text-xs rounded-lg hover:bg-green-600">
                          Approve
                        </button>
                        <button className="px-3 py-1.5 bg-red-500 text-white text-xs rounded-lg hover:bg-red-600">
                          Reject
                        </button>
                      </>
                    )}
                    <span className={`px-2 py-1 rounded-full text-xs font-medium
                      ${d.status === 'completed' ? 'bg-green-100 text-green-800' :
                        d.status === 'pending' ? 'bg-amber-100 text-amber-800' :
                        'bg-gray-100 text-gray-600'}`}>
                      {d.status}
                    </span>
                  </div>
                </div>
              ))}
              {deletions.length === 0 && (
                <p className="text-center text-gray-400 py-8">Không có yêu cầu xóa nào</p>
              )}
            </div>
          </div>
        )}

        {tab === 'users' && (
          <div className="bg-white rounded-xl shadow-sm p-6">
            <h2 className="font-semibold mb-4">Quản lý Users</h2>
            <p className="text-sm text-gray-400">Coming in Sprint 8 — User CRUD, bulk import, role management</p>
          </div>
        )}
      </div>
    </div>
  )
}

function MetricCard({ label, value, color }: { label: string; value: number; color: string }) {
  const colors: Record<string, string> = {
    blue: 'bg-blue-50 text-blue-700 border-blue-200',
    green: 'bg-green-50 text-green-700 border-green-200',
    purple: 'bg-purple-50 text-purple-700 border-purple-200',
    red: 'bg-red-50 text-red-700 border-red-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
    gray: 'bg-gray-50 text-gray-700 border-gray-200',
  }
  return (
    <div className={`rounded-xl border p-5 ${colors[color] || colors.gray}`}>
      <p className="text-3xl font-bold">{value.toLocaleString()}</p>
      <p className="text-sm opacity-80 mt-1">{label}</p>
    </div>
  )
}

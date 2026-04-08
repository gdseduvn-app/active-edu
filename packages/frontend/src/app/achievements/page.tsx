'use client'
import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api'

/**
 * Gamification Hub — XP, Badges, Streak, Leaderboard
 * Source: SRS-CH08 §8.5, UI_Ch8, SCR-8-03
 * Triết lý: reward hành vi học tập đúng, KHÔNG reward điểm số cao
 */

interface GamificationProfile {
  total_xp: number
  level: number
  level_name: string
  streak_days: number
  streak_max: number
  badges: Badge[]
}

interface Badge {
  id: string
  name: string
  icon: string
  description: string
  earned_at: string | null
}

interface XPTransaction {
  id: string
  amount: number
  reason: string
  created_at: string
}

const LEVEL_NAMES = [
  { level: 1, name: 'Người mới bắt đầu', xp: 0 },
  { level: 2, name: 'Học viên', xp: 100 },
  { level: 3, name: 'Người khám phá', xp: 300 },
  { level: 4, name: 'Người học tích cực', xp: 600 },
  { level: 5, name: 'Nhà tư duy', xp: 1000 },
  { level: 6, name: 'Học giả', xp: 1500 },
  { level: 7, name: 'Chuyên gia trẻ', xp: 2200 },
  { level: 8, name: 'Nhà nghiên cứu', xp: 3000 },
  { level: 9, name: 'Bậc thầy', xp: 4000 },
  { level: 10, name: 'Thiên tài', xp: 5500 },
]

const BADGE_DEFS: Badge[] = [
  { id: 'streak_7', name: '🔥 Streak 7 ngày', icon: '🔥', description: 'Học đều đặn 7 ngày liên tiếp', earned_at: null },
  { id: 'bloom_4', name: '🧠 Tư duy bậc cao', icon: '🧠', description: 'Lần đầu đúng bài Bloom ≥ 4', earned_at: null },
  { id: 'repair_first', name: '🔧 Sửa lỗi thần tốc', icon: '🔧', description: 'Pass Repair ngay lần đầu', earned_at: null },
  { id: 'mentor', name: '👥 Mentor', icon: '👥', description: 'Peer review 5★ từ 3 bạn', earned_at: null },
  { id: 'yccđ_master', name: '📚 YCCĐ Chinh phục', icon: '📚', description: 'Mastery ≥ 0.85 toàn bộ 1 ĐVKT', earned_at: null },
  { id: 'perfect_bloom', name: '🎯 Perfect Bloom', icon: '🎯', description: 'Tất cả 6 cấp Bloom ≥ 0.5', earned_at: null },
  { id: 'resilient', name: '🌱 Kiên trì', icon: '🌱', description: 'Hoàn thành sau ≥ 3 lần thử', earned_at: null },
  { id: 'self_learner', name: '💡 Tự học xuất sắc', icon: '💡', description: 'Journal >200 từ × 5 lần', earned_at: null },
]

export default function AchievementsPage() {
  const [profile, setProfile] = useState<GamificationProfile | null>(null)
  const [xpHistory, setXpHistory] = useState<XPTransaction[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      apiFetch<{ data: GamificationProfile }>('/gamification/profile').then(r => setProfile(r.data)),
      apiFetch<{ data: XPTransaction[] }>('/gamification/xp-history?limit=20').then(r => setXpHistory(r.data)),
    ]).catch(() => {}).finally(() => setLoading(false))
  }, [])

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center bg-[#F5F5F2]">
      <div className="animate-pulse text-gray-500">Đang tải thành tích...</div>
    </div>
  }

  const currentLevel = LEVEL_NAMES.find(l => l.level === (profile?.level || 1)) || LEVEL_NAMES[0]
  const nextLevel = LEVEL_NAMES.find(l => l.level === (profile?.level || 1) + 1)
  const xpProgress = nextLevel
    ? ((profile?.total_xp || 0) - currentLevel.xp) / (nextLevel.xp - currentLevel.xp) * 100
    : 100

  return (
    <div className="min-h-screen bg-[#F5F5F2]">
      <div className="bg-white border-b px-6 py-4">
        <h1 className="text-2xl font-bold text-gray-800">Thành tích của em</h1>
        <p className="text-sm text-gray-500">XP · Huy hiệu · Streak — Phần thưởng cho hành vi học tập đúng</p>
      </div>

      <div className="max-w-4xl mx-auto p-6 space-y-6">
        {/* XP + Level Card */}
        <div className="bg-white rounded-xl shadow-sm p-6">
          <div className="flex items-center gap-6">
            <div className="w-20 h-20 rounded-full bg-gradient-to-br from-[#185EA5] to-[#378ADD] flex items-center justify-center">
              <span className="text-3xl font-bold text-white">{profile?.level || 1}</span>
            </div>
            <div className="flex-1">
              <h2 className="text-xl font-bold text-gray-800">{currentLevel.name}</h2>
              <p className="text-sm text-gray-500">{profile?.total_xp || 0} XP tổng cộng</p>
              {nextLevel && (
                <div className="mt-2">
                  <div className="h-3 bg-gray-200 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-[#185EA5] to-[#1D9E75] rounded-full transition-all duration-500"
                      style={{ width: `${Math.min(xpProgress, 100)}%` }}
                    />
                  </div>
                  <p className="text-xs text-gray-400 mt-1">
                    Còn {nextLevel.xp - (profile?.total_xp || 0)} XP → {nextLevel.name}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Streak */}
        <div className="bg-white rounded-xl shadow-sm p-6">
          <h3 className="font-semibold text-gray-800 mb-3">🔥 Streak</h3>
          <div className="flex items-center gap-8">
            <div className="text-center">
              <p className="text-4xl font-bold text-orange-500">{profile?.streak_days || 0}</p>
              <p className="text-sm text-gray-500">ngày liên tiếp</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-semibold text-gray-600">{profile?.streak_max || 0}</p>
              <p className="text-sm text-gray-500">kỷ lục</p>
            </div>
            {/* 7-day calendar mini */}
            <div className="flex gap-1">
              {Array.from({ length: 7 }).map((_, i) => (
                <div
                  key={i}
                  className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-medium
                    ${i < (profile?.streak_days || 0) % 7
                      ? 'bg-orange-100 text-orange-600'
                      : 'bg-gray-100 text-gray-400'}`}
                >
                  {['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'][i]}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Badges */}
        <div className="bg-white rounded-xl shadow-sm p-6">
          <h3 className="font-semibold text-gray-800 mb-4">Huy hiệu</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {BADGE_DEFS.map((badge) => {
              const earned = (profile?.badges || []).find((b: any) => b.id === badge.id || b === badge.id)
              return (
                <div
                  key={badge.id}
                  className={`rounded-xl p-4 text-center border-2 transition-all
                    ${earned
                      ? 'border-[#1D9E75] bg-green-50'
                      : 'border-gray-200 bg-gray-50 opacity-50'}`}
                >
                  <span className="text-3xl">{badge.icon}</span>
                  <p className="text-sm font-medium mt-2">{badge.name.replace(badge.icon + ' ', '')}</p>
                  <p className="text-xs text-gray-500 mt-1">{badge.description}</p>
                  {earned && <p className="text-xs text-green-600 mt-1">✓ Đạt được</p>}
                </div>
              )
            })}
          </div>
        </div>

        {/* XP History */}
        <div className="bg-white rounded-xl shadow-sm p-6">
          <h3 className="font-semibold text-gray-800 mb-4">Lịch sử XP gần đây</h3>
          {xpHistory.length === 0 ? (
            <p className="text-gray-400 text-sm">Chưa có XP nào. Học bài đầu tiên để nhận XP!</p>
          ) : (
            <div className="space-y-2">
              {xpHistory.map((tx) => (
                <div key={tx.id} className="flex items-center justify-between py-2 border-b border-gray-100">
                  <div>
                    <p className="text-sm text-gray-700">{tx.reason}</p>
                    <p className="text-xs text-gray-400">{new Date(tx.created_at).toLocaleDateString('vi-VN')}</p>
                  </div>
                  <span className="text-sm font-bold text-[#1D9E75]">+{tx.amount} XP</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

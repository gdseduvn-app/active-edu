'use client'
import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api'

/**
 * SRL Dashboard — Self-Regulated Learning
 * Source: SRS-CH08 §8.6.4, UI_Ch8, SCR-8-05
 * 6 widgets: Learning Compass, Study Pattern, Error Portfolio, Goal Tracker, Style Insights, Next Step
 * Focus: PROCESS học tập, KHÔNG focus điểm số
 */

interface SRLData {
  mastery_avg: number
  streak_days: number
  bloom_profile: Record<string, number>
  error_portfolio: { error_type: string; count: number; resolved: boolean }[]
  goals: { id: string; text: string; done: boolean }[]
  study_hours: Record<string, number> // dow_hour → score
  next_lesson: { title: string; lesson_id: string; model: string } | null
  flashcards_due: number
  journal_count: number
}

export default function SRLDashboardPage() {
  const [data, setData] = useState<SRLData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    apiFetch<{ data: SRLData }>('/agent/learner/me/model/summary')
      .then(r => setData(r.data))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center bg-[#F5F5F2]">
      <div className="animate-pulse text-gray-500">Đang tải SRL Dashboard...</div>
    </div>
  }

  const bloomLabels = ['Nhận biết', 'Thông hiểu', 'Vận dụng', 'Phân tích', 'Đánh giá', 'Sáng tạo']

  return (
    <div className="min-h-screen bg-[#F5F5F2]">
      <div className="bg-white border-b px-6 py-4">
        <h1 className="text-2xl font-bold text-gray-800">Hành trình học tập</h1>
        <p className="text-sm text-gray-500">Theo dõi CÁCH em học — không chỉ KẾT QUẢ</p>
      </div>

      <div className="max-w-6xl mx-auto p-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">

        {/* Widget 1: Learning Compass — Radar 6 chiều */}
        <div className="bg-white rounded-xl shadow-sm p-6">
          <h3 className="font-semibold text-gray-800 mb-1">🧭 La bàn học tập</h3>
          <p className="text-xs text-gray-400 mb-4">Năng lực nào em mạnh nhất?</p>
          <div className="space-y-2">
            {bloomLabels.map((label, i) => {
              const score = data?.bloom_profile?.[String(i + 1)] || 0
              return (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-xs w-20 text-gray-600">{label}</span>
                  <div className="flex-1 h-4 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-[#185EA5] rounded-full transition-all"
                      style={{ width: `${Math.min(score * 100, 100)}%` }}
                    />
                  </div>
                  <span className="text-xs text-gray-500 w-10 text-right">
                    {Math.round(score * 100)}%
                  </span>
                </div>
              )
            })}
          </div>
        </div>

        {/* Widget 2: Study Pattern Clock */}
        <div className="bg-white rounded-xl shadow-sm p-6">
          <h3 className="font-semibold text-gray-800 mb-1">🕐 Giờ học hiệu quả</h3>
          <p className="text-xs text-gray-400 mb-4">Em học hiệu quả nhất lúc mấy giờ?</p>
          <div className="grid grid-cols-7 gap-1">
            {['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'].map((day, di) => (
              <div key={day} className="text-center">
                <span className="text-[10px] text-gray-400">{day}</span>
                {[8, 10, 14, 16, 19, 21].map(hour => {
                  const key = `${['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'][di]}_${hour}`
                  const score = data?.study_hours?.[key] || 0
                  const opacity = Math.max(0.1, score)
                  return (
                    <div
                      key={hour}
                      className="w-full h-4 rounded-sm mt-0.5"
                      style={{ backgroundColor: `rgba(24, 94, 165, ${opacity})` }}
                      title={`${day} ${hour}h: ${Math.round(score * 100)}%`}
                    />
                  )
                })}
              </div>
            ))}
          </div>
          <div className="flex justify-between mt-2 text-[10px] text-gray-400">
            <span>8h</span><span>10h</span><span>14h</span><span>16h</span><span>19h</span><span>21h</span>
          </div>
        </div>

        {/* Widget 3: Error Portfolio */}
        <div className="bg-white rounded-xl shadow-sm p-6">
          <h3 className="font-semibold text-gray-800 mb-1">🔧 Bộ sưu tập lỗi</h3>
          <p className="text-xs text-gray-400 mb-4">Em hay sai ở dạng nào?</p>
          {(data?.error_portfolio || []).length === 0 ? (
            <p className="text-sm text-gray-400">Chưa phát hiện mẫu lỗi nào. Tốt lắm!</p>
          ) : (
            <div className="space-y-2">
              {(data?.error_portfolio || []).map((ep, i) => (
                <div key={i} className={`flex items-center justify-between p-2 rounded-lg text-sm
                  ${ep.resolved ? 'bg-green-50' : 'bg-red-50'}`}>
                  <div>
                    <p className={`font-medium ${ep.resolved ? 'text-green-700' : 'text-red-700'}`}>
                      {ep.error_type.replace(/_/g, ' ')}
                    </p>
                    <p className="text-xs text-gray-500">{ep.count} lần gặp</p>
                  </div>
                  {ep.resolved ? (
                    <span className="text-green-600 text-xs font-medium">✓ Đã sửa</span>
                  ) : (
                    <a href="#" className="text-red-600 text-xs underline">Ôn lại →</a>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Widget 4: Goal Tracker */}
        <div className="bg-white rounded-xl shadow-sm p-6">
          <h3 className="font-semibold text-gray-800 mb-1">🎯 Mục tiêu tuần</h3>
          <p className="text-xs text-gray-400 mb-4">Tuần này em muốn đạt gì?</p>
          <div className="space-y-2">
            {(data?.goals || []).map((goal) => (
              <label key={goal.id} className="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-50 cursor-pointer">
                <input type="checkbox" checked={goal.done} readOnly
                  className="w-5 h-5 accent-[#1D9E75] rounded" />
                <span className={`text-sm ${goal.done ? 'line-through text-gray-400' : 'text-gray-700'}`}>
                  {goal.text}
                </span>
              </label>
            ))}
            {(data?.goals || []).length === 0 && (
              <p className="text-sm text-gray-400">Chưa có mục tiêu. Hãy tự đặt 1-3 mục tiêu!</p>
            )}
          </div>
        </div>

        {/* Widget 5: Learning Style Insights */}
        <div className="bg-white rounded-xl shadow-sm p-6">
          <h3 className="font-semibold text-gray-800 mb-1">🎨 Phong cách học</h3>
          <p className="text-xs text-gray-400 mb-4">Cách học nào phù hợp em?</p>
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <span className="text-2xl">📊</span>
              <div>
                <p className="text-sm font-medium">Thành thạo trung bình</p>
                <p className="text-xs text-gray-500">{Math.round((data?.mastery_avg || 0) * 100)}%</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-2xl">🔥</span>
              <div>
                <p className="text-sm font-medium">Streak hiện tại</p>
                <p className="text-xs text-gray-500">{data?.streak_days || 0} ngày</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-2xl">📝</span>
              <div>
                <p className="text-sm font-medium">Nhật ký phản chiếu</p>
                <p className="text-xs text-gray-500">{data?.journal_count || 0} bài viết</p>
              </div>
            </div>
          </div>
        </div>

        {/* Widget 6: Next Step Recommendation */}
        <div className="bg-white rounded-xl shadow-sm p-6">
          <h3 className="font-semibold text-gray-800 mb-1">🚀 Bước tiếp theo</h3>
          <p className="text-xs text-gray-400 mb-4">Em nên học gì tiếp theo?</p>
          <div className="space-y-3">
            {data?.next_lesson && (
              <a href={`/lesson/${data.next_lesson.lesson_id}`}
                className="block p-3 bg-blue-50 rounded-lg hover:bg-blue-100 transition-colors">
                <p className="text-sm font-medium text-[#185EA5]">📖 {data.next_lesson.title}</p>
                <p className="text-xs text-gray-500">Model: {data.next_lesson.model}</p>
              </a>
            )}
            {(data?.flashcards_due || 0) > 0 && (
              <a href="/flashcards"
                className="block p-3 bg-amber-50 rounded-lg hover:bg-amber-100 transition-colors">
                <p className="text-sm font-medium text-amber-700">🗂 {data?.flashcards_due} flashcard cần ôn</p>
                <p className="text-xs text-gray-500">Spaced repetition — ôn đúng lúc</p>
              </a>
            )}
            <a href="/achievements"
              className="block p-3 bg-green-50 rounded-lg hover:bg-green-100 transition-colors">
              <p className="text-sm font-medium text-green-700">🏆 Xem thành tích</p>
              <p className="text-xs text-gray-500">XP, huy hiệu, streak</p>
            </a>
          </div>
        </div>
      </div>
    </div>
  )
}

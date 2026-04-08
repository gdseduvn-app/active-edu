'use client'
import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api'

/**
 * Exam Builder — Tạo và quản lý đề kiểm tra
 * Source: SRS-CH08 §8.3, UI_Ch8 SCR-8-02
 * 8 trạng thái lifecycle: draft→review→approved→published→active→closed→graded→archived
 */

interface Exam {
  id: string
  title: string
  exam_type: string
  status: string
  time_limit_min: number
  total_points: number
  question_ids: string[]
  created_at: string
}

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-700',
  review: 'bg-blue-100 text-blue-700',
  approved: 'bg-green-100 text-green-700',
  published: 'bg-purple-100 text-purple-700',
  active: 'bg-orange-100 text-orange-700',
  closed: 'bg-red-100 text-red-700',
  graded: 'bg-teal-100 text-teal-700',
  archived: 'bg-gray-200 text-gray-500',
}

export default function ExamPage() {
  const [exams, setExams] = useState<Exam[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [examType, setExamType] = useState('practice')
  const [timeLimit, setTimeLimit] = useState(45)

  useEffect(() => {
    apiFetch<{ data: Exam[] }>('/exams?limit=50')
      .then(r => setExams(Array.isArray(r.data) ? r.data : []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const handleCreate = async () => {
    if (!title) return
    setCreating(true)
    try {
      const r = await apiFetch<{ data: Exam }>('/exams', {
        method: 'POST',
        body: JSON.stringify({
          title,
          exam_type: examType,
          time_limit_min: timeLimit,
          question_ids: [],
          total_points: 10,
        }),
      })
      setExams(prev => [r.data, ...prev])
      setTitle('')
    } catch { /* ignore */ }
    setCreating(false)
  }

  return (
    <div className="min-h-screen bg-[#F5F5F2]">
      <div className="bg-white border-b px-6 py-4">
        <h1 className="text-2xl font-bold text-gray-800">Đề kiểm tra</h1>
        <p className="text-sm text-gray-500">Tạo, quản lý và phân phối đề — 8 trạng thái vòng đời</p>
      </div>

      <div className="max-w-5xl mx-auto p-6 space-y-6">
        {/* Create Exam */}
        <div className="bg-white rounded-xl shadow-sm p-6">
          <h2 className="font-semibold mb-4">Tạo đề mới</h2>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <input
              type="text" value={title} onChange={e => setTitle(e.target.value)}
              placeholder="Tên đề kiểm tra" className="px-3 py-2 border rounded-lg text-sm md:col-span-2"
            />
            <select value={examType} onChange={e => setExamType(e.target.value)}
              className="px-3 py-2 border rounded-lg text-sm">
              <option value="practice">Luyện tập</option>
              <option value="quiz_15">KT 15 phút</option>
              <option value="quiz_45">KT 1 tiết</option>
              <option value="midterm">Giữa kỳ</option>
              <option value="final">Cuối kỳ</option>
            </select>
            <button onClick={handleCreate} disabled={creating || !title}
              className="px-4 py-2 bg-[#185EA5] text-white rounded-lg font-medium hover:bg-[#134d8a] disabled:bg-gray-300">
              {creating ? 'Đang tạo...' : 'Tạo đề'}
            </button>
          </div>
        </div>

        {/* Exam List */}
        <div className="bg-white rounded-xl shadow-sm p-6">
          <h2 className="font-semibold mb-4">Danh sách đề ({exams.length})</h2>
          {loading ? (
            <p className="text-gray-400 text-center py-8">Đang tải...</p>
          ) : exams.length === 0 ? (
            <p className="text-gray-400 text-center py-8">Chưa có đề. Tạo đề đầu tiên!</p>
          ) : (
            <div className="space-y-3">
              {exams.map(exam => (
                <div key={exam.id} className="border rounded-lg p-4 hover:bg-gray-50 flex items-center gap-4">
                  <div className="flex-1">
                    <p className="font-medium text-gray-800">{exam.title}</p>
                    <p className="text-xs text-gray-500">
                      {exam.exam_type} · {exam.time_limit_min} phút · {exam.question_ids?.length || 0} câu ·
                      {new Date(exam.created_at).toLocaleDateString('vi-VN')}
                    </p>
                  </div>
                  <span className={`px-3 py-1 rounded-full text-xs font-medium ${STATUS_COLORS[exam.status] || STATUS_COLORS.draft}`}>
                    {exam.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

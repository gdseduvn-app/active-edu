'use client'
import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api'

/**
 * Question Bank Manager — Quản lý ngân hàng câu hỏi
 * Source: SRS-CH08 §8.2, UI_Ch8 SCR-8-01
 * Filter: Bloom, lesson_id, review_status, question_type
 * Review workflow: draft → reviewed → approved → deprecated
 */

interface Question {
  id: string
  stem: string
  question_type: string
  bloom_level: number
  difficulty: string
  status: string
  review_status?: string
  is_ai_generated: boolean
  lesson_id: string
  created_at: string
}

const BLOOM_LABELS = ['', 'Nhận biết', 'Thông hiểu', 'Vận dụng', 'Phân tích', 'Đánh giá', 'Sáng tạo']
const BLOOM_COLORS = ['', 'bg-blue-100', 'bg-cyan-100', 'bg-green-100', 'bg-yellow-100', 'bg-orange-100', 'bg-red-100']
const TYPE_LABELS: Record<string, string> = {
  mcq: 'Trắc nghiệm', true_false: 'Đúng/Sai', fill_blank: 'Điền vào chỗ trống',
  ordering: 'Sắp xếp', matching: 'Ghép đôi', short_answer: 'Tự luận ngắn',
  essay: 'Tự luận dài', code_python: 'Code Python', math_input: 'Tính toán',
}

export default function QBankPage() {
  const [questions, setQuestions] = useState<Question[]>([])
  const [loading, setLoading] = useState(true)
  const [bloomFilter, setBloomFilter] = useState<number | ''>('')
  const [typeFilter, setTypeFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')

  const loadQuestions = async () => {
    setLoading(true)
    let path = '/questions?limit=50'
    if (bloomFilter) path += `&bloom_level=${bloomFilter}`
    if (typeFilter) path += `&question_type=${typeFilter}`
    if (statusFilter) path += `&status=${statusFilter}`
    try {
      const r = await apiFetch<{ data: Question[] }>(path)
      setQuestions(Array.isArray(r.data) ? r.data : [])
    } catch { setQuestions([]) }
    setLoading(false)
  }

  useEffect(() => { loadQuestions() }, [bloomFilter, typeFilter, statusFilter])

  return (
    <div className="min-h-screen bg-[#F5F5F2]">
      <div className="bg-white border-b px-6 py-4">
        <h1 className="text-2xl font-bold text-gray-800">Ngân hàng câu hỏi</h1>
        <p className="text-sm text-gray-500">
          {questions.length} câu hỏi · Filter theo Bloom, loại, trạng thái
        </p>
      </div>

      <div className="max-w-6xl mx-auto p-6 space-y-6">
        {/* Filters */}
        <div className="bg-white rounded-xl shadow-sm p-4 flex flex-wrap gap-4">
          <select value={bloomFilter} onChange={e => setBloomFilter(e.target.value ? Number(e.target.value) : '')}
            className="px-3 py-2 border rounded-lg text-sm">
            <option value="">Tất cả Bloom</option>
            {[1,2,3,4,5,6].map(b => (
              <option key={b} value={b}>Bloom {b}: {BLOOM_LABELS[b]}</option>
            ))}
          </select>
          <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}
            className="px-3 py-2 border rounded-lg text-sm">
            <option value="">Tất cả loại</option>
            {Object.entries(TYPE_LABELS).map(([k,v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
            className="px-3 py-2 border rounded-lg text-sm">
            <option value="">Tất cả trạng thái</option>
            <option value="draft">Draft</option>
            <option value="review">Review</option>
            <option value="published">Published</option>
          </select>
          <button onClick={loadQuestions}
            className="px-4 py-2 bg-[#185EA5] text-white rounded-lg text-sm hover:bg-[#134d8a]">
            Tìm kiếm
          </button>
        </div>

        {/* Questions List */}
        <div className="bg-white rounded-xl shadow-sm">
          {loading ? (
            <p className="text-gray-400 text-center py-12">Đang tải...</p>
          ) : questions.length === 0 ? (
            <p className="text-gray-400 text-center py-12">Không tìm thấy câu hỏi nào</p>
          ) : (
            <div className="divide-y">
              {questions.map(q => (
                <div key={q.id} className="p-4 hover:bg-gray-50 flex items-start gap-4">
                  <div className={`px-2 py-1 rounded text-xs font-bold ${BLOOM_COLORS[q.bloom_level]} text-gray-700`}>
                    B{q.bloom_level}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-800 line-clamp-2">{q.stem}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs text-gray-500">{TYPE_LABELS[q.question_type] || q.question_type}</span>
                      <span className="text-xs text-gray-400">·</span>
                      <span className="text-xs text-gray-500">{q.difficulty}</span>
                      {q.is_ai_generated && (
                        <span className="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">AI</span>
                      )}
                    </div>
                  </div>
                  <span className={`px-2 py-1 rounded-full text-xs font-medium
                    ${q.status === 'published' ? 'bg-green-100 text-green-700' :
                      q.status === 'review' ? 'bg-blue-100 text-blue-700' :
                      'bg-gray-100 text-gray-600'}`}>
                    {q.review_status || q.status}
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

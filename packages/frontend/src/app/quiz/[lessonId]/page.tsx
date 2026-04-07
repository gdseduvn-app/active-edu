'use client'
/**
 * Quiz Attempt Page
 * Source: SRS-CH08 §8.1 Assessment System
 * Route: /quiz/[lessonId]
 *
 * Flow:
 * 1. POST /api/v1/quiz/start → get attempt_id + questions
 * 2. Student answers each question (client-side state)
 * 3. POST /api/v1/quiz/:attemptId/submit → get results
 * 4. Show results + XP earned + next recommendation
 */

import { useEffect, useState, useCallback, useRef } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { apiFetch } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import toast from 'react-hot-toast'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Option {
  id: string
  text: string
  is_correct?: boolean
}

interface Question {
  id: string
  stem: string
  question_type: 'mcq' | 'true_false' | 'fill_blank' | 'ordering' | 'matching' |
                 'short_answer' | 'essay' | 'code_python' | 'math_input'
  bloom_level: number
  difficulty: string
  points: number
  options?: Option[]
  hints?: string[]
  estimated_time_sec?: number
}

interface AttemptResult {
  attempt_id: string
  total_score: number
  max_score: number
  score_percent: number
  passed: boolean | null
  feedback: string
  xp_awarded?: number
  level_up?: boolean
  new_level?: string
}

type AnswerMap = Record<string, string | string[]>  // qid → answer(s)

const BLOOM_LABELS: Record<number, string> = {
  1: 'Nhận biết', 2: 'Thông hiểu', 3: 'Vận dụng',
  4: 'Phân tích', 5: 'Đánh giá', 6: 'Sáng tạo'
}

const BLOOM_COLORS: Record<number, string> = {
  1: 'bg-sky-100 text-sky-700', 2: 'bg-green-100 text-green-700',
  3: 'bg-amber-100 text-amber-700', 4: 'bg-orange-100 text-orange-700',
  5: 'bg-red-100 text-red-700', 6: 'bg-purple-100 text-purple-700',
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function QuizPage() {
  const { lessonId } = useParams<{ lessonId: string }>()
  const router = useRouter()
  const { user } = useAuth()

  // Attempt state
  const [phase, setPhase] = useState<'loading' | 'quiz' | 'submitting' | 'results'>('loading')
  const [attemptId, setAttemptId] = useState<string | null>(null)
  const [questions, setQuestions] = useState<Question[]>([])
  const [timeLimitSec, setTimeLimitSec] = useState<number | null>(null)
  const [answers, setAnswers] = useState<AnswerMap>({})
  const [currentIdx, setCurrentIdx] = useState(0)
  const [result, setResult] = useState<AttemptResult | null>(null)
  const [timeLeft, setTimeLeft] = useState<number | null>(null)
  const [shownHints, setShownHints] = useState<Record<string, number>>({})  // qid → hint count shown
  const [startedAt] = useState(Date.now())

  const timerRef = useRef<NodeJS.Timeout | null>(null)

  // ── Start attempt ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!lessonId) return
    apiFetch<{ data: { attempt_id: string; questions: Question[]; time_limit_sec: number } }>(
      `/quiz/start`,
      { method: 'POST', body: JSON.stringify({ lesson_id: lessonId }) }
    )
      .then(res => {
        setAttemptId(res.data.attempt_id)
        setQuestions(res.data.questions)
        setTimeLimitSec(res.data.time_limit_sec)
        setTimeLeft(res.data.time_limit_sec)
        setPhase('quiz')
      })
      .catch(err => {
        toast.error(err.message || 'Không thể bắt đầu bài kiểm tra')
        router.back()
      })
  }, [lessonId, router])

  // ── Countdown timer ────────────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== 'quiz' || timeLeft === null) return
    if (timeLeft <= 0) {
      handleSubmit()
      return
    }
    timerRef.current = setTimeout(() => setTimeLeft(t => (t ?? 1) - 1), 1000)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [phase, timeLeft])  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Answer handlers ────────────────────────────────────────────────────────
  const setAnswer = useCallback((qid: string, value: string | string[]) => {
    setAnswers(prev => ({ ...prev, [qid]: value }))
  }, [])

  const toggleOrderItem = useCallback((qid: string, itemId: string) => {
    setAnswers(prev => {
      const current = (prev[qid] as string[] | undefined) || []
      const exists = current.indexOf(itemId)
      if (exists >= 0) return { ...prev, [qid]: current.filter(id => id !== itemId) }
      return { ...prev, [qid]: [...current, itemId] }
    })
  }, [])

  const showNextHint = useCallback((qid: string) => {
    setShownHints(prev => ({ ...prev, [qid]: (prev[qid] || 0) + 1 }))
  }, [])

  // ── Submit ─────────────────────────────────────────────────────────────────
  const handleSubmit = useCallback(async () => {
    if (!attemptId || phase === 'submitting') return
    if (timerRef.current) clearTimeout(timerRef.current)
    setPhase('submitting')

    const payload = questions.map(q => ({
      question_id: q.id,
      answer: answers[q.id] ?? null,
      time_ms: Date.now() - startedAt,
    }))

    try {
      const res = await apiFetch<{ data: AttemptResult }>(
        `/quiz/${attemptId}/submit`,
        { method: 'POST', body: JSON.stringify({ answers: payload }) }
      )
      setResult(res.data)
      setPhase('results')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Lỗi khi nộp bài')
      setPhase('quiz')
    }
  }, [attemptId, answers, phase, questions, startedAt])

  // ── Render helpers ─────────────────────────────────────────────────────────
  const q = questions[currentIdx]
  const progress = questions.length > 0 ? ((currentIdx + 1) / questions.length) * 100 : 0
  const answered = Object.keys(answers).length
  const formatTime = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`

  if (phase === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-primary-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-gray-600">Đang chuẩn bị bài kiểm tra…</p>
        </div>
      </div>
    )
  }

  if (phase === 'results' && result) {
    return <ResultsScreen result={result} total={questions.length} onBack={() => router.push(`/lesson/${lessonId}`)} />
  }

  if (!q) return null

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Header bar */}
      <header className="bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between sticky top-0 z-10 shadow-sm">
        <div className="flex items-center gap-3">
          <button onClick={() => router.back()} className="text-gray-500 hover:text-gray-700 p-1 rounded">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7"/></svg>
          </button>
          <span className="font-semibold text-gray-800">Bài kiểm tra</span>
        </div>

        {/* Progress */}
        <div className="flex items-center gap-4 flex-1 mx-6">
          <span className="text-sm text-gray-500 whitespace-nowrap">{currentIdx + 1}/{questions.length}</span>
          <div className="flex-1 bg-gray-200 rounded-full h-2">
            <div className="bg-primary-500 h-2 rounded-full transition-all" style={{ width: `${progress}%` }} />
          </div>
          <span className="text-sm text-gray-500 whitespace-nowrap">{answered} đã trả lời</span>
        </div>

        {/* Timer */}
        {timeLeft !== null && (
          <div className={`font-mono text-lg font-bold px-3 py-1 rounded-lg ${timeLeft < 60 ? 'bg-red-100 text-red-600 animate-pulse' : 'bg-gray-100 text-gray-700'}`}>
            {formatTime(timeLeft)}
          </div>
        )}
      </header>

      {/* Question card */}
      <main className="flex-1 max-w-3xl mx-auto w-full px-4 py-8">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8">
          {/* Metadata badges */}
          <div className="flex items-center gap-2 mb-4">
            <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${BLOOM_COLORS[q.bloom_level] || 'bg-gray-100'}`}>
              Bloom {q.bloom_level}: {BLOOM_LABELS[q.bloom_level]}
            </span>
            <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">{q.difficulty}</span>
            <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full ml-auto">{q.points} điểm</span>
          </div>

          {/* Stem */}
          <div className="text-gray-800 text-lg leading-relaxed mb-6" dangerouslySetInnerHTML={{ __html: q.stem }} />

          {/* Answer input by type */}
          <div className="space-y-3">
            {(q.question_type === 'mcq' || q.question_type === 'true_false') && (
              <MCQInput q={q} answer={answers[q.id] as string} onChange={v => setAnswer(q.id, v)} />
            )}
            {q.question_type === 'fill_blank' && (
              <input
                type="text"
                className="w-full border border-gray-300 rounded-xl px-4 py-3 text-gray-800 focus:outline-none focus:ring-2 focus:ring-primary-400"
                placeholder="Nhập câu trả lời…"
                value={(answers[q.id] as string) || ''}
                onChange={e => setAnswer(q.id, e.target.value)}
              />
            )}
            {(q.question_type === 'short_answer' || q.question_type === 'essay') && (
              <textarea
                rows={q.question_type === 'essay' ? 8 : 4}
                className="w-full border border-gray-300 rounded-xl px-4 py-3 text-gray-800 focus:outline-none focus:ring-2 focus:ring-primary-400 resize-none"
                placeholder="Nhập câu trả lời của bạn…"
                value={(answers[q.id] as string) || ''}
                onChange={e => setAnswer(q.id, e.target.value)}
              />
            )}
            {q.question_type === 'math_input' && (
              <div>
                <input
                  type="text"
                  className="w-full border border-gray-300 rounded-xl px-4 py-3 font-mono text-gray-800 focus:outline-none focus:ring-2 focus:ring-primary-400"
                  placeholder="Ví dụ: x^2 + 2x + 1 = 0"
                  value={(answers[q.id] as string) || ''}
                  onChange={e => setAnswer(q.id, e.target.value)}
                />
                <p className="text-xs text-gray-400 mt-1">Dùng ký hiệu toán học: x^2 = x², sqrt(x) = √x</p>
              </div>
            )}
            {q.question_type === 'ordering' && (
              <OrderingInput q={q} answer={(answers[q.id] as string[]) || []} onToggle={id => toggleOrderItem(q.id, id)} />
            )}
            {q.question_type === 'matching' && (
              <MatchingInput q={q} answer={answers[q.id] as string} onChange={v => setAnswer(q.id, v)} />
            )}
            {q.question_type === 'code_python' && (
              <textarea
                rows={10}
                className="w-full border border-gray-300 rounded-xl px-4 py-3 font-mono text-sm text-gray-800 bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-400 resize-y"
                placeholder="# Viết code Python ở đây…"
                value={(answers[q.id] as string) || ''}
                onChange={e => setAnswer(q.id, e.target.value)}
              />
            )}
          </div>

          {/* Hints */}
          {q.hints && q.hints.length > 0 && (
            <div className="mt-6 border-t border-gray-100 pt-4">
              {(shownHints[q.id] || 0) < q.hints.length ? (
                <button
                  onClick={() => showNextHint(q.id)}
                  className="text-sm text-amber-600 hover:text-amber-700 flex items-center gap-1"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg>
                  Xem gợi ý ({shownHints[q.id] || 0}/{q.hints.length})
                </button>
              ) : null}
              {Array.from({ length: shownHints[q.id] || 0 }).map((_, i) => (
                <div key={i} className="mt-2 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2 text-sm text-amber-800">
                  💡 {q.hints![i]}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Navigation */}
        <div className="flex items-center justify-between mt-6">
          <button
            onClick={() => setCurrentIdx(i => Math.max(0, i - 1))}
            disabled={currentIdx === 0}
            className="px-5 py-2.5 rounded-xl border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition"
          >
            ← Câu trước
          </button>

          {/* Question dots */}
          <div className="flex gap-1 flex-wrap justify-center max-w-xs">
            {questions.map((qq, i) => (
              <button
                key={qq.id}
                onClick={() => setCurrentIdx(i)}
                className={`w-7 h-7 rounded-lg text-xs font-medium transition ${
                  i === currentIdx ? 'bg-primary-500 text-white' :
                  answers[qq.id] !== undefined ? 'bg-green-100 text-green-700' :
                  'bg-gray-100 text-gray-500 hover:bg-gray-200'
                }`}
              >
                {i + 1}
              </button>
            ))}
          </div>

          {currentIdx < questions.length - 1 ? (
            <button
              onClick={() => setCurrentIdx(i => i + 1)}
              className="px-5 py-2.5 rounded-xl bg-primary-500 text-white hover:bg-primary-600 transition"
            >
              Câu sau →
            </button>
          ) : (
            <button
              onClick={handleSubmit}
              disabled={phase === 'submitting'}
              className="px-6 py-2.5 rounded-xl bg-green-600 text-white font-semibold hover:bg-green-700 disabled:opacity-60 transition"
            >
              {phase === 'submitting' ? 'Đang nộp…' : 'Nộp bài ✓'}
            </button>
          )}
        </div>
      </main>
    </div>
  )
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function MCQInput({ q, answer, onChange }: { q: Question; answer: string; onChange: (v: string) => void }) {
  const opts = q.options || (q.question_type === 'true_false'
    ? [{ id: 'true', text: 'Đúng' }, { id: 'false', text: 'Sai' }]
    : [])
  return (
    <div className="space-y-2">
      {opts.map(opt => (
        <button
          key={opt.id}
          onClick={() => onChange(opt.id)}
          className={`w-full text-left px-5 py-3.5 rounded-xl border-2 transition ${
            answer === opt.id
              ? 'border-primary-500 bg-primary-50 text-primary-700 font-medium'
              : 'border-gray-200 text-gray-700 hover:border-gray-300 hover:bg-gray-50'
          }`}
        >
          {opt.text}
        </button>
      ))}
    </div>
  )
}

function OrderingInput({ q, answer, onToggle }: { q: Question; answer: string[]; onToggle: (id: string) => void }) {
  const opts = q.options || []
  return (
    <div className="space-y-2">
      <p className="text-sm text-gray-500">Chọn các mục theo thứ tự đúng:</p>
      {/* Selected sequence */}
      {answer.length > 0 && (
        <div className="flex flex-wrap gap-2 p-3 bg-blue-50 rounded-xl border border-blue-200 min-h-[44px]">
          {answer.map((id, i) => {
            const opt = opts.find(o => o.id === id)
            return opt ? (
              <span key={id} className="flex items-center gap-1 bg-blue-500 text-white px-3 py-1 rounded-lg text-sm">
                <span className="font-bold">{i + 1}.</span> {opt.text}
                <button onClick={() => onToggle(id)} className="ml-1 hover:text-blue-200">×</button>
              </span>
            ) : null
          })}
        </div>
      )}
      {/* Options */}
      <div className="space-y-1">
        {opts.filter(o => !answer.includes(o.id)).map(opt => (
          <button key={opt.id} onClick={() => onToggle(opt.id)}
            className="w-full text-left px-4 py-2.5 rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50 transition text-sm">
            {opt.text}
          </button>
        ))}
      </div>
    </div>
  )
}

function MatchingInput({ q, answer, onChange }: { q: Question; answer: string; onChange: (v: string) => void }) {
  const opts = q.options || []
  const parsed: Record<string, string> = answer ? JSON.parse(answer) : {}

  const update = (leftId: string, rightId: string) => {
    const next = { ...parsed, [leftId]: rightId }
    onChange(JSON.stringify(next))
  }

  const lefts = opts.filter(o => o.id.startsWith('L'))
  const rights = opts.filter(o => o.id.startsWith('R'))

  return (
    <div className="space-y-3">
      {lefts.map(left => (
        <div key={left.id} className="flex items-center gap-3">
          <div className="flex-1 bg-gray-50 border border-gray-200 rounded-lg px-4 py-2.5 text-sm text-gray-700">{left.text}</div>
          <svg className="w-4 h-4 text-gray-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3"/></svg>
          <select
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-primary-400 bg-white"
            value={parsed[left.id] || ''}
            onChange={e => update(left.id, e.target.value)}
          >
            <option value="">-- Chọn --</option>
            {rights.map(r => <option key={r.id} value={r.id}>{r.text}</option>)}
          </select>
        </div>
      ))}
    </div>
  )
}

// ── Results screen ─────────────────────────────────────────────────────────────

function ResultsScreen({ result, total, onBack }: { result: AttemptResult; total: number; onBack: () => void }) {
  const pct = Math.round(result.score_percent)
  const passed = result.passed

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl shadow-lg border border-gray-100 max-w-md w-full p-8 text-center">
        {/* Result icon */}
        <div className={`w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-4 ${
          passed === null ? 'bg-amber-100' : passed ? 'bg-green-100' : 'bg-red-100'
        }`}>
          <span className="text-4xl">
            {passed === null ? '⏳' : passed ? '🎉' : '📖'}
          </span>
        </div>

        <h2 className={`text-2xl font-bold mb-1 ${
          passed === null ? 'text-amber-700' : passed ? 'text-green-700' : 'text-red-700'
        }`}>
          {passed === null ? 'Đang chấm điểm…' : passed ? 'Xuất sắc!' : 'Cần ôn luyện thêm'}
        </h2>
        <p className="text-gray-500 text-sm mb-6">
          {passed === null ? 'Bài luận / tự luận sẽ được chấm bởi giáo viên' : ''}
        </p>

        {/* Score circle */}
        <div className="relative w-32 h-32 mx-auto mb-6">
          <svg className="w-32 h-32 -rotate-90" viewBox="0 0 120 120">
            <circle cx="60" cy="60" r="54" fill="none" stroke="#f3f4f6" strokeWidth="10"/>
            <circle cx="60" cy="60" r="54" fill="none"
              stroke={passed ? '#10B981' : pct >= 50 ? '#F59E0B' : '#EF4444'}
              strokeWidth="10"
              strokeDasharray={`${2 * Math.PI * 54}`}
              strokeDashoffset={`${2 * Math.PI * 54 * (1 - pct / 100)}`}
              strokeLinecap="round"
              className="transition-all duration-1000"
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-3xl font-bold text-gray-800">{pct}%</span>
            <span className="text-xs text-gray-500">{result.total_score}/{result.max_score} điểm</span>
          </div>
        </div>

        {/* XP reward */}
        {result.xp_awarded != null && result.xp_awarded > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-4 flex items-center justify-center gap-2">
            <span className="text-amber-600 font-bold text-lg">+{result.xp_awarded} XP</span>
            {result.level_up && (
              <span className="bg-amber-500 text-white text-xs px-2 py-0.5 rounded-full font-bold">
                LEVEL UP → {result.new_level}
              </span>
            )}
          </div>
        )}

        {/* Feedback */}
        {result.feedback && (
          <div className="bg-blue-50 border border-blue-100 rounded-xl px-4 py-3 text-sm text-blue-700 text-left mb-6">
            {result.feedback}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3">
          <button onClick={onBack} className="flex-1 px-4 py-3 rounded-xl border border-gray-200 text-gray-700 hover:bg-gray-50 transition font-medium">
            ← Quay lại bài học
          </button>
          {!passed && (
            <button onClick={() => window.location.reload()} className="flex-1 px-4 py-3 rounded-xl bg-primary-500 text-white font-medium hover:bg-primary-600 transition">
              Làm lại
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

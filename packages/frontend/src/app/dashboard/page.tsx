'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import toast from 'react-hot-toast'
import {
  LayoutDashboard,
  BookOpen,
  CreditCard,
  Trophy,
  Settings,
  Flame,
  Star,
  ChevronRight,
  LogOut,
  Bell,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
} from 'lucide-react'
import { useAuth } from '@/lib/auth'
import { apiFetch } from '@/lib/api'

interface Recommendation {
  lesson_id: string
  title: string
  subject: string
  difficulty: number
  estimated_minutes: number
  reason: string
}

interface QuizResult {
  id: string
  lesson_title: string
  score: number
  total: number
  completed_at: string
}

interface DashboardData {
  xp: number
  level: number
  xp_to_next_level: number
  streak_days: number
  due_flashcards: number
  recommendations: Recommendation[]
  recent_quiz_results: QuizResult[]
}

const NAV_ITEMS = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/lessons', label: 'Bài học', icon: BookOpen },
  { href: '/flashcards', label: 'Flashcard', icon: CreditCard },
  { href: '/leaderboard', label: 'Bảng thành tích', icon: Trophy },
  { href: '/settings', label: 'Cài đặt', icon: Settings },
]

function DifficultyBadge({ level }: { level: number }) {
  const labels: Record<number, { label: string; cls: string }> = {
    1: { label: 'Dễ', cls: 'bg-green-100 text-green-700' },
    2: { label: 'Trung bình', cls: 'bg-yellow-100 text-yellow-700' },
    3: { label: 'Khó', cls: 'bg-orange-100 text-orange-700' },
    4: { label: 'Rất khó', cls: 'bg-red-100 text-red-700' },
  }
  const d = labels[level] ?? { label: 'N/A', cls: 'bg-gray-100 text-gray-600' }
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${d.cls}`}>
      {d.label}
    </span>
  )
}

export default function DashboardPage() {
  const router = useRouter()
  const { user, logout, isLoading: authLoading } = useAuth()
  const [data, setData] = useState<DashboardData | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    if (!authLoading && !user) {
      router.replace('/login')
      return
    }
    if (user) {
      loadDashboard(user.id)
    }
  }, [user, authLoading, router])

  const loadDashboard = async (userId: string) => {
    setIsLoading(true)
    try {
      const [statsRes, recsRes, quizRes, fcRes] = await Promise.allSettled([
        apiFetch<{ data: { xp: number; level: number; xp_to_next_level: number; streak_days: number } }>(
          `/users/${userId}/stats`
        ),
        apiFetch<{ data: Recommendation[] }>(`/agent/recommendations/${userId}`),
        apiFetch<{ data: QuizResult[] }>(`/users/${userId}/quiz-results?limit=5`),
        apiFetch<{ data: { due_count: number } }>('/agent/flashcards/due-count'),
      ])

      const stats =
        statsRes.status === 'fulfilled' ? statsRes.value.data : { xp: 0, level: 1, xp_to_next_level: 100, streak_days: 0 }
      const recs =
        recsRes.status === 'fulfilled' ? recsRes.value.data.slice(0, 3) : []
      const quizResults =
        quizRes.status === 'fulfilled' ? quizRes.value.data : []
      const dueFlashcards =
        fcRes.status === 'fulfilled' ? fcRes.value.data.due_count : 0

      setData({
        ...stats,
        due_flashcards: dueFlashcards,
        recommendations: recs,
        recent_quiz_results: quizResults,
      })
    } catch {
      toast.error('Không thể tải dữ liệu dashboard')
    } finally {
      setIsLoading(false)
    }
  }

  const handleLogout = () => {
    logout()
    router.push('/login')
  }

  const xpPercent =
    data ? Math.round((data.xp / (data.xp + data.xp_to_next_level)) * 100) : 0

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
      </div>
    )
  }

  return (
    <div className="flex min-h-screen bg-gray-50">
      {/* Sidebar */}
      <aside className="w-64 bg-sidebar text-white flex flex-col fixed inset-y-0 left-0 z-30 shadow-xl">
        {/* Logo */}
        <div className="px-6 py-5 border-b border-white/10">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-primary rounded-xl flex items-center justify-center shadow-md">
              <BookOpen className="w-5 h-5 text-white" />
            </div>
            <div>
              <p className="font-bold text-sm leading-tight">AURA AdaptLearn</p>
              <p className="text-xs text-blue-300">THPT Thủ Thiêm</p>
            </div>
          </div>
        </div>

        {/* User info */}
        {user && (
          <div className="px-6 py-4 border-b border-white/10">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-primary/30 flex items-center justify-center text-sm font-bold">
                {user.full_name.charAt(0).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold truncate">{user.full_name}</p>
                <p className="text-xs text-blue-300 capitalize">{user.role}</p>
              </div>
            </div>
          </div>
        )}

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
            const isActive = href === '/dashboard'
            return (
              <Link
                key={href}
                href={href}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-primary text-white shadow-sm'
                    : 'text-blue-100 hover:bg-white/10 hover:text-white'
                }`}
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                {label}
              </Link>
            )
          })}
        </nav>

        {/* Logout */}
        <div className="px-3 py-4 border-t border-white/10">
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-blue-100 hover:bg-white/10 hover:text-white transition-colors"
          >
            <LogOut className="w-4 h-4" />
            Đăng xuất
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 ml-64 p-8 overflow-y-auto">
        {/* Top bar */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">
              Xin chào, {user?.full_name?.split(' ').pop()} 👋
            </h1>
            <p className="text-sm text-gray-500 mt-0.5">
              Hôm nay bạn muốn học gì?
            </p>
          </div>
          <button className="relative p-2.5 rounded-xl bg-white border border-gray-200 shadow-sm hover:shadow-md transition-shadow">
            <Bell className="w-5 h-5 text-gray-600" />
            <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-primary rounded-full" />
          </button>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="w-8 h-8 text-primary animate-spin" />
          </div>
        ) : data ? (
          <div className="space-y-6">
            {/* Stats row */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* XP & Level */}
              <div className="md:col-span-2 bg-white rounded-2xl p-5 border border-gray-100 shadow-sm">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Star className="w-5 h-5 text-yellow-500" />
                    <span className="font-semibold text-gray-800">Cấp độ {data.level}</span>
                  </div>
                  <span className="text-sm text-gray-500 font-medium">
                    {data.xp.toLocaleString()} / {(data.xp + data.xp_to_next_level).toLocaleString()} XP
                  </span>
                </div>
                <div className="w-full bg-gray-100 rounded-full h-3 overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-primary to-orange-400 rounded-full transition-all duration-700"
                    style={{ width: `${xpPercent}%` }}
                  />
                </div>
                <p className="text-xs text-gray-400 mt-2">
                  Còn {data.xp_to_next_level.toLocaleString()} XP để lên cấp {data.level + 1}
                </p>
              </div>

              {/* Streak */}
              <div className="bg-white rounded-2xl p-5 border border-gray-100 shadow-sm flex items-center gap-4">
                <div className="w-12 h-12 bg-orange-50 rounded-xl flex items-center justify-center">
                  <Flame className="w-6 h-6 text-orange-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-gray-900">{data.streak_days}</p>
                  <p className="text-sm text-gray-500">ngày liên tiếp</p>
                </div>
              </div>
            </div>

            {/* Flashcard reminder */}
            {data.due_flashcards > 0 && (
              <Link
                href="/flashcards"
                className="flex items-center justify-between bg-gradient-to-r from-primary to-orange-500 text-white rounded-2xl px-5 py-4 shadow-md hover:shadow-lg transition-shadow"
              >
                <div className="flex items-center gap-3">
                  <CreditCard className="w-5 h-5" />
                  <div>
                    <p className="font-semibold text-sm">
                      Bạn có {data.due_flashcards} flashcard cần ôn tập hôm nay
                    </p>
                    <p className="text-xs text-orange-100">Nhấn để bắt đầu ôn tập ngay</p>
                  </div>
                </div>
                <ChevronRight className="w-5 h-5" />
              </Link>
            )}

            {/* Recommendations */}
            <div>
              <h2 className="text-lg font-bold text-gray-800 mb-3">Bài học gợi ý cho bạn</h2>
              {data.recommendations.length === 0 ? (
                <p className="text-sm text-gray-500 bg-white rounded-2xl p-5 border border-gray-100">
                  Chưa có bài học gợi ý. Hãy hoàn thành thêm bài học!
                </p>
              ) : (
                <div className="grid gap-3">
                  {data.recommendations.map((rec) => (
                    <Link
                      key={rec.lesson_id}
                      href={`/lesson/${rec.lesson_id}`}
                      className="bg-white rounded-2xl p-5 border border-gray-100 shadow-sm hover:shadow-md hover:border-primary/30 transition-all flex items-center gap-4 group"
                    >
                      <div className="w-10 h-10 bg-primary/10 rounded-xl flex items-center justify-center flex-shrink-0 group-hover:bg-primary/20 transition-colors">
                        <BookOpen className="w-5 h-5 text-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <h3 className="font-semibold text-gray-900 text-sm truncate">{rec.title}</h3>
                          <DifficultyBadge level={rec.difficulty} />
                        </div>
                        <div className="flex items-center gap-3 text-xs text-gray-500">
                          <span>{rec.subject}</span>
                          <span className="flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {rec.estimated_minutes} phút
                          </span>
                        </div>
                        <p className="text-xs text-primary mt-1 truncate">{rec.reason}</p>
                      </div>
                      <ChevronRight className="w-4 h-4 text-gray-400 group-hover:text-primary transition-colors flex-shrink-0" />
                    </Link>
                  ))}
                </div>
              )}
            </div>

            {/* Recent quiz results */}
            {data.recent_quiz_results.length > 0 && (
              <div>
                <h2 className="text-lg font-bold text-gray-800 mb-3">Kết quả kiểm tra gần đây</h2>
                <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
                  {data.recent_quiz_results.map((result, idx) => {
                    const pct = Math.round((result.score / result.total) * 100)
                    const passed = pct >= 50
                    return (
                      <div
                        key={result.id}
                        className={`flex items-center gap-4 px-5 py-4 ${
                          idx < data.recent_quiz_results.length - 1 ? 'border-b border-gray-50' : ''
                        }`}
                      >
                        {passed ? (
                          <CheckCircle2 className="w-5 h-5 text-success flex-shrink-0" />
                        ) : (
                          <XCircle className="w-5 h-5 text-danger flex-shrink-0" />
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-900 truncate">
                            {result.lesson_title}
                          </p>
                          <p className="text-xs text-gray-400">
                            {new Date(result.completed_at).toLocaleDateString('vi-VN')}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className={`font-bold text-sm ${passed ? 'text-success' : 'text-danger'}`}>
                            {result.score}/{result.total}
                          </p>
                          <p className="text-xs text-gray-400">{pct}%</p>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        ) : null}
      </main>
    </div>
  )
}

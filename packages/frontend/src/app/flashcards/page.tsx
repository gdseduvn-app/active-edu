'use client'
import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import toast from 'react-hot-toast'
import {
  ArrowLeft,
  RotateCcw,
  CheckCircle2,
  Star,
  Loader2,
  CreditCard,
  Trophy,
} from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { useAuth } from '@/lib/auth'

interface Flashcard {
  id: string
  front: string
  back: string
  subject: string
  lesson_title: string
}

interface ReviewResult {
  card_id: string
  rating: number
  next_review: string
  xp_earned: number
}

const RATING_BUTTONS: { value: number; label: string; emoji: string; cls: string }[] = [
  { value: 0, label: 'Quên hoàn toàn', emoji: '😵', cls: 'bg-red-500 hover:bg-red-600 text-white' },
  { value: 1, label: 'Sai', emoji: '😞', cls: 'bg-orange-500 hover:bg-orange-600 text-white' },
  { value: 2, label: 'Khó', emoji: '😕', cls: 'bg-yellow-500 hover:bg-yellow-600 text-white' },
  { value: 3, label: 'Đúng', emoji: '🙂', cls: 'bg-blue-500 hover:bg-blue-600 text-white' },
  { value: 4, label: 'Dễ', emoji: '😊', cls: 'bg-green-500 hover:bg-green-600 text-white' },
  { value: 5, label: 'Dễ lắm', emoji: '🤩', cls: 'bg-emerald-600 hover:bg-emerald-700 text-white' },
]

export default function FlashcardsPage() {
  const router = useRouter()
  const { user } = useAuth()

  const [cards, setCards] = useState<Flashcard[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [isFlipped, setIsFlipped] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isRating, setIsRating] = useState(false)
  const [totalXpEarned, setTotalXpEarned] = useState(0)
  const [completedCount, setCompletedCount] = useState(0)
  const [done, setDone] = useState(false)
  const [initialCount, setInitialCount] = useState(0)

  useEffect(() => {
    loadDueCards()
  }, [])

  const loadDueCards = async () => {
    setIsLoading(true)
    try {
      const res = await apiFetch<{ data: Flashcard[] }>('/agent/flashcards/due')
      setCards(res.data)
      setInitialCount(res.data.length)
      if (res.data.length === 0) setDone(true)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Không thể tải flashcard'
      toast.error(msg)
    } finally {
      setIsLoading(false)
    }
  }

  const currentCard = cards[currentIndex]
  const remaining = cards.length - currentIndex

  const handleFlip = () => {
    setIsFlipped((v) => !v)
  }

  const handleRate = useCallback(
    async (rating: number) => {
      if (!currentCard || isRating) return
      setIsRating(true)
      try {
        const res = await apiFetch<{ data: ReviewResult }>('/agent/flashcards/review', {
          method: 'POST',
          body: JSON.stringify({
            card_id: currentCard.id,
            rating,
            user_id: user?.id,
          }),
        })
        setTotalXpEarned((prev) => prev + (res.data.xp_earned ?? 0))
        setCompletedCount((prev) => prev + 1)

        // Advance to next card
        setIsFlipped(false)
        if (currentIndex + 1 >= cards.length) {
          setDone(true)
        } else {
          setCurrentIndex((prev) => prev + 1)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Không thể lưu đánh giá'
        toast.error(msg)
      } finally {
        setIsRating(false)
      }
    },
    [currentCard, currentIndex, cards.length, isRating, user]
  )

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
      </div>
    )
  }

  // Completion screen
  if (done) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-6">
        <div className="bg-white rounded-3xl shadow-xl border border-gray-100 p-10 max-w-md w-full text-center">
          <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-5">
            <Trophy className="w-10 h-10 text-success" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 mb-2">
            {initialCount === 0 ? 'Không có thẻ nào!' : 'Hoàn thành rồi!'}
          </h1>
          {initialCount === 0 ? (
            <p className="text-gray-500 text-sm mb-8">
              Hôm nay bạn không có flashcard nào cần ôn tập. Hãy quay lại sau!
            </p>
          ) : (
            <>
              <p className="text-gray-500 text-sm mb-1">
                Bạn đã ôn tập <strong>{completedCount}</strong> thẻ hôm nay.
              </p>
              <div className="flex items-center justify-center gap-2 mt-3 mb-8">
                <Star className="w-5 h-5 text-yellow-500 fill-yellow-400" />
                <span className="text-xl font-bold text-gray-900">+{totalXpEarned} XP</span>
              </div>
            </>
          )}
          <div className="flex flex-col gap-3">
            <Link
              href="/dashboard"
              className="w-full bg-primary text-white py-3 rounded-xl font-semibold text-sm hover:bg-primary-600 transition-colors"
            >
              Về trang chủ
            </Link>
            {initialCount > 0 && (
              <button
                onClick={() => {
                  setDone(false)
                  setCurrentIndex(0)
                  setIsFlipped(false)
                  setTotalXpEarned(0)
                  setCompletedCount(0)
                  loadDueCards()
                }}
                className="w-full border border-gray-200 text-gray-600 py-3 rounded-xl font-semibold text-sm hover:bg-gray-50 transition-colors flex items-center justify-center gap-2"
              >
                <RotateCcw className="w-4 h-4" />
                Ôn tập lại
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Header */}
      <header className="bg-sidebar text-white px-6 py-4 flex items-center gap-4 shadow-md">
        <Link
          href="/dashboard"
          className="p-2 rounded-lg hover:bg-white/10 transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="flex-1">
          <h1 className="font-bold text-base">Ôn tập Flashcard</h1>
          <p className="text-xs text-blue-300">Phương pháp lặp lại ngắt quãng (SRS)</p>
        </div>
        <div className="flex items-center gap-2 bg-white/10 rounded-xl px-3 py-2">
          <CreditCard className="w-4 h-4 text-orange-300" />
          <span className="text-sm font-bold">{remaining}</span>
          <span className="text-xs text-blue-300">thẻ còn lại</span>
        </div>
      </header>

      {/* Progress bar */}
      <div className="w-full bg-gray-200 h-1.5">
        <div
          className="h-full bg-gradient-to-r from-primary to-orange-400 transition-all duration-500"
          style={{ width: `${Math.round((completedCount / initialCount) * 100)}%` }}
        />
      </div>

      {/* Card area */}
      <div className="flex-1 flex flex-col items-center justify-center p-6 gap-6">
        {/* Progress counter */}
        <div className="text-sm text-gray-500 font-medium">
          {currentIndex + 1} / {initialCount}
        </div>

        {/* Subject & lesson */}
        {currentCard && (
          <div className="text-center">
            <span className="inline-block bg-primary/10 text-primary text-xs font-semibold px-3 py-1 rounded-full">
              {currentCard.subject} — {currentCard.lesson_title}
            </span>
          </div>
        )}

        {/* Flashcard */}
        <div
          className="relative w-full max-w-lg cursor-pointer"
          style={{ perspective: '1200px' }}
          onClick={handleFlip}
        >
          <div
            className="relative w-full transition-transform duration-500"
            style={{
              transformStyle: 'preserve-3d',
              transform: isFlipped ? 'rotateY(180deg)' : 'rotateY(0deg)',
              minHeight: '260px',
            }}
          >
            {/* Front */}
            <div
              className="absolute inset-0 bg-white rounded-3xl shadow-lg border border-gray-100 flex flex-col items-center justify-center p-8 text-center"
              style={{ backfaceVisibility: 'hidden' }}
            >
              <p className="text-xs text-gray-400 font-medium uppercase tracking-wide mb-4">
                Câu hỏi
              </p>
              <p className="text-xl font-bold text-gray-900 leading-relaxed">
                {currentCard?.front}
              </p>
              <p className="text-xs text-gray-400 mt-6">Nhấp để xem đáp án</p>
            </div>

            {/* Back */}
            <div
              className="absolute inset-0 bg-gradient-to-br from-primary/5 to-orange-50 rounded-3xl shadow-lg border border-primary/20 flex flex-col items-center justify-center p-8 text-center"
              style={{
                backfaceVisibility: 'hidden',
                transform: 'rotateY(180deg)',
              }}
            >
              <p className="text-xs text-primary font-medium uppercase tracking-wide mb-4">
                Đáp án
              </p>
              <p className="text-xl font-bold text-gray-900 leading-relaxed">
                {currentCard?.back}
              </p>
            </div>
          </div>
        </div>

        {/* Rating buttons — only show when flipped */}
        <div
          className={`w-full max-w-lg transition-all duration-300 ${
            isFlipped ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4 pointer-events-none'
          }`}
        >
          <p className="text-center text-sm text-gray-500 font-medium mb-3">
            Bạn nhớ được bao nhiêu?
          </p>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
            {RATING_BUTTONS.map(({ value, label, emoji, cls }) => (
              <button
                key={value}
                onClick={(e) => {
                  e.stopPropagation()
                  handleRate(value)
                }}
                disabled={isRating}
                className={`flex flex-col items-center gap-1 py-3 px-2 rounded-xl font-medium text-xs transition-all shadow-sm active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed ${cls}`}
              >
                {isRating ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <span className="text-lg">{emoji}</span>
                )}
                <span className="leading-tight text-center">{label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Flip hint when not yet flipped */}
        {!isFlipped && (
          <div className="flex items-center gap-2 text-gray-400 text-sm">
            <RotateCcw className="w-4 h-4" />
            Nhấp vào thẻ để lật
          </div>
        )}

        {/* XP earned so far */}
        {totalXpEarned > 0 && (
          <div className="flex items-center gap-1.5 text-sm font-semibold text-yellow-600 bg-yellow-50 px-4 py-2 rounded-full">
            <Star className="w-4 h-4 text-yellow-500 fill-yellow-400" />
            +{totalXpEarned} XP kiếm được
          </div>
        )}

        {/* XP indicator */}
        <div className="flex items-center gap-1.5 text-xs text-gray-400">
          <CheckCircle2 className="w-3.5 h-3.5 text-success" />
          {completedCount} thẻ đã ôn tập
        </div>
      </div>
    </div>
  )
}

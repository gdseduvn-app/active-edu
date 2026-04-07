'use client'
import { useEffect, useRef, useState, FormEvent } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import toast from 'react-hot-toast'
import {
  ArrowLeft,
  BookOpen,
  FileText,
  MessageCircle,
  X,
  Send,
  PlayCircle,
  CheckCircle,
  Loader2,
  ExternalLink,
  ChevronRight,
} from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { useAuth } from '@/lib/auth'

interface Lesson {
  id: string
  title: string
  subject: string
  material_type: 'html' | 'pdf' | 'video'
  material_url: string
  material_content?: string
  has_quiz: boolean
  questions_count: number
  estimated_minutes: number
  description?: string
}

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

interface ProgressResponse {
  data: { message: string }
}

export default function LessonPage() {
  const params = useParams()
  const router = useRouter()
  const lessonId = params.id as string
  const { user } = useAuth()

  const [lesson, setLesson] = useState<Lesson | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [chatOpen, setChatOpen] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [progressTracked, setProgressTracked] = useState(false)
  const [progressLoading, setProgressLoading] = useState(false)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    if (lessonId) loadLesson()
  }, [lessonId])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const loadLesson = async () => {
    setIsLoading(true)
    try {
      const res = await apiFetch<{ data: Lesson }>(`/lessons/${lessonId}`)
      setLesson(res.data)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Không thể tải bài học'
      toast.error(msg)
      router.push('/dashboard')
    } finally {
      setIsLoading(false)
    }
  }

  const handleTrackProgress = async () => {
    if (progressTracked || !user) return
    setProgressLoading(true)
    try {
      await apiFetch<ProgressResponse>(`/lessons/${lessonId}/progress`, {
        method: 'POST',
        body: JSON.stringify({ user_id: user.id, status: 'completed' }),
      })
      setProgressTracked(true)
      toast.success('Đã ghi nhận hoàn thành bài học! +XP')
    } catch {
      toast.error('Không thể lưu tiến độ')
    } finally {
      setProgressLoading(false)
    }
  }

  const handleSocraticChat = async (e: FormEvent) => {
    e.preventDefault()
    const question = chatInput.trim()
    if (!question || chatLoading) return

    const userMsg: ChatMessage = { role: 'user', content: question }
    setMessages((prev) => [...prev, userMsg])
    setChatInput('')
    setChatLoading(true)

    try {
      const res = await apiFetch<{ data: { answer: string } }>('/agent/socratic', {
        method: 'POST',
        body: JSON.stringify({
          lesson_id: lessonId,
          question,
          user_id: user?.id,
          conversation_history: messages.slice(-6),
        }),
      })
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: res.data.answer,
      }
      setMessages((prev) => [...prev, assistantMsg])
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Không thể kết nối trợ lý'
      toast.error(msg)
    } finally {
      setChatLoading(false)
    }
  }

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
      </div>
    )
  }

  if (!lesson) return null

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Header */}
      <header className="bg-sidebar text-white px-6 py-4 flex items-center gap-4 shadow-md sticky top-0 z-20">
        <Link
          href="/dashboard"
          className="p-2 rounded-lg hover:bg-white/10 transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="flex-1 min-w-0">
          <p className="text-xs text-blue-300 font-medium">{lesson.subject}</p>
          <h1 className="font-bold text-base truncate">{lesson.title}</h1>
        </div>
        <div className="flex items-center gap-2">
          {/* Socratic tutor toggle */}
          <button
            onClick={() => setChatOpen((v) => !v)}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
              chatOpen ? 'bg-primary text-white' : 'bg-white/10 text-white hover:bg-white/20'
            }`}
          >
            <MessageCircle className="w-4 h-4" />
            <span className="hidden sm:inline">Trợ lý AI</span>
          </button>
          {/* Mark complete */}
          <button
            onClick={handleTrackProgress}
            disabled={progressTracked || progressLoading}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
              progressTracked
                ? 'bg-success text-white cursor-default'
                : 'bg-white/10 text-white hover:bg-white/20'
            }`}
          >
            {progressLoading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : progressTracked ? (
              <CheckCircle className="w-4 h-4" />
            ) : (
              <CheckCircle className="w-4 h-4" />
            )}
            <span className="hidden sm:inline">
              {progressTracked ? 'Đã hoàn thành' : 'Đánh dấu xong'}
            </span>
          </button>
        </div>
      </header>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Content area */}
        <div className={`flex-1 flex flex-col overflow-hidden transition-all duration-300 ${chatOpen ? 'mr-96' : ''}`}>
          {/* Material viewer */}
          <div className="flex-1 relative">
            {lesson.material_type === 'html' && (
              <iframe
                ref={iframeRef}
                srcDoc={lesson.material_content}
                src={!lesson.material_content ? lesson.material_url : undefined}
                sandbox="allow-scripts allow-same-origin allow-popups"
                className="w-full h-full border-0 bg-white"
                title={lesson.title}
                style={{ minHeight: 'calc(100vh - 140px)' }}
              />
            )}

            {lesson.material_type === 'pdf' && (
              <div className="flex flex-col items-center justify-center h-full p-8 gap-4">
                <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8 max-w-md w-full text-center">
                  <FileText className="w-16 h-16 text-primary mx-auto mb-4" />
                  <h2 className="text-lg font-bold text-gray-900 mb-2">{lesson.title}</h2>
                  {lesson.description && (
                    <p className="text-sm text-gray-500 mb-6">{lesson.description}</p>
                  )}
                  <a
                    href={lesson.material_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 bg-primary text-white px-5 py-3 rounded-xl font-semibold text-sm hover:bg-primary-600 transition-colors shadow-sm"
                  >
                    <ExternalLink className="w-4 h-4" />
                    Mở tài liệu PDF
                  </a>
                </div>
              </div>
            )}

            {lesson.material_type === 'video' && (
              <div className="flex flex-col items-center justify-center h-full p-8">
                <div className="w-full max-w-3xl bg-black rounded-2xl overflow-hidden shadow-lg aspect-video">
                  <video
                    controls
                    className="w-full h-full"
                    src={lesson.material_url}
                    onEnded={handleTrackProgress}
                  >
                    Trình duyệt của bạn không hỗ trợ video.
                  </video>
                </div>
              </div>
            )}
          </div>

          {/* Footer bar */}
          <div className="bg-white border-t border-gray-100 px-6 py-3 flex items-center justify-between shadow-sm">
            <div className="flex items-center gap-4 text-sm text-gray-500">
              <span className="flex items-center gap-1.5">
                <BookOpen className="w-4 h-4" />
                {lesson.subject}
              </span>
              <span>~{lesson.estimated_minutes} phút</span>
            </div>
            {lesson.has_quiz && (
              <Link
                href={`/lesson/${lessonId}/quiz`}
                className="flex items-center gap-2 bg-primary text-white px-5 py-2.5 rounded-xl font-semibold text-sm hover:bg-primary-600 transition-colors shadow-sm"
              >
                <PlayCircle className="w-4 h-4" />
                Bắt đầu kiểm tra ({lesson.questions_count} câu)
                <ChevronRight className="w-4 h-4" />
              </Link>
            )}
          </div>
        </div>

        {/* Socratic chat sidebar */}
        {chatOpen && (
          <div className="fixed right-0 top-[65px] bottom-0 w-96 bg-white border-l border-gray-200 flex flex-col shadow-xl z-10">
            {/* Chat header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-gray-50">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center">
                  <MessageCircle className="w-4 h-4 text-white" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-900">Trợ lý Socrates</p>
                  <p className="text-xs text-gray-400">Hỏi bất cứ điều gì về bài học</p>
                </div>
              </div>
              <button
                onClick={() => setChatOpen(false)}
                className="p-1.5 rounded-lg hover:bg-gray-200 transition-colors"
              >
                <X className="w-4 h-4 text-gray-500" />
              </button>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {messages.length === 0 && (
                <div className="text-center py-8">
                  <MessageCircle className="w-10 h-10 text-gray-200 mx-auto mb-3" />
                  <p className="text-sm text-gray-400 font-medium">Chào bạn!</p>
                  <p className="text-xs text-gray-400 mt-1">
                    Hãy đặt câu hỏi về nội dung bài học. Tôi sẽ dẫn dắt bạn tư duy theo phương pháp Socrates.
                  </p>
                </div>
              )}
              {messages.map((msg, idx) => (
                <div
                  key={idx}
                  className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                      msg.role === 'user'
                        ? 'bg-primary text-white rounded-br-sm'
                        : 'bg-gray-100 text-gray-800 rounded-bl-sm'
                    }`}
                  >
                    {msg.content}
                  </div>
                </div>
              ))}
              {chatLoading && (
                <div className="flex justify-start">
                  <div className="bg-gray-100 rounded-2xl rounded-bl-sm px-4 py-3 flex items-center gap-2">
                    <Loader2 className="w-4 h-4 text-primary animate-spin" />
                    <span className="text-xs text-gray-500">Đang suy nghĩ...</span>
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            {/* Input */}
            <form
              onSubmit={handleSocraticChat}
              className="p-3 border-t border-gray-100 flex items-end gap-2"
            >
              <textarea
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    handleSocraticChat(e as unknown as FormEvent)
                  }
                }}
                placeholder="Đặt câu hỏi về bài học..."
                rows={2}
                className="flex-1 resize-none rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary placeholder-gray-400"
                disabled={chatLoading}
              />
              <button
                type="submit"
                disabled={chatLoading || !chatInput.trim()}
                className="p-2.5 bg-primary text-white rounded-xl hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex-shrink-0"
              >
                <Send className="w-4 h-4" />
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  )
}

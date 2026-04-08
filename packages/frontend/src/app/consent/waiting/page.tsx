'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useConsent } from '@/lib/consent'

/**
 * Consent Waiting Page — Chờ phụ huynh xác nhận
 * NĐ 13/2023 Đ20: HS dưới 18 cần consent kép (student + parent)
 */
export default function ConsentWaitingPage() {
  const router = useRouter()
  const { consent, loading } = useConsent()
  const [resending, setResending] = useState(false)
  const [resent, setResent] = useState(false)

  // Poll consent status every 10s
  useEffect(() => {
    const interval = setInterval(() => {
      if (consent?.fully_consented) {
        router.push('/dashboard')
      }
    }, 10000)
    return () => clearInterval(interval)
  }, [consent, router])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F5F5F2]">
        <div className="animate-pulse text-gray-500">Đang kiểm tra...</div>
      </div>
    )
  }

  if (consent?.fully_consented) {
    router.push('/dashboard')
    return null
  }

  if (!consent?.student_assent) {
    router.push('/consent')
    return null
  }

  const handleResend = async () => {
    setResending(true)
    try {
      // Re-trigger parent consent email
      await fetch('/api/v1/privacy/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ consent_type: 'resend_parent', purpose: [] }),
      })
      setResent(true)
    } catch {
      // Ignore
    } finally {
      setResending(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F5F5F2] p-4">
      <div className="bg-white rounded-2xl shadow-lg max-w-md w-full p-8 text-center">
        {/* Animated waiting icon */}
        <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-blue-100 flex items-center justify-center">
          <svg className="w-10 h-10 text-[#185EA5] animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>

        <h1 className="text-xl font-bold text-gray-800 mb-2">
          Chờ phụ huynh xác nhận
        </h1>
        <p className="text-gray-600 mb-6">
          Đã gửi email xác nhận đến phụ huynh. Khi phụ huynh đồng ý, em sẽ
          tự động được chuyển vào hệ thống.
        </p>

        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6 text-sm text-amber-800">
          <p className="font-semibold mb-1">Tại sao cần phụ huynh đồng ý?</p>
          <p>
            Theo Nghị định 13/2023 Điều 20, học sinh dưới 18 tuổi cần sự đồng ý
            của cha mẹ hoặc người giám hộ để xử lý dữ liệu cá nhân.
          </p>
        </div>

        <div className="space-y-3">
          <button
            onClick={handleResend}
            disabled={resending || resent}
            className="w-full py-2.5 border-2 border-[#185EA5] text-[#185EA5] rounded-lg
                       font-medium hover:bg-blue-50 disabled:opacity-50 transition-colors"
          >
            {resent ? '✓ Đã gửi lại email' : resending ? 'Đang gửi...' : 'Gửi lại email cho phụ huynh'}
          </button>

          <a href="mailto:it@thuthiem.edu.vn"
            className="block w-full py-2.5 text-gray-500 hover:text-gray-700 text-sm">
            Liên hệ Tổ Tin học nếu cần hỗ trợ
          </a>
        </div>

        <p className="text-xs text-gray-400 mt-6">
          Trang tự động kiểm tra mỗi 10 giây
        </p>
      </div>
    </div>
  )
}

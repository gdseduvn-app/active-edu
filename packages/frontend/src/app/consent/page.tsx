'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useConsent } from '@/lib/consent'

/**
 * Consent Page — NĐ 13/2023 Đ11, Đ20
 * HS phải đồng ý trước khi dùng hệ thống.
 * Checkbox KHÔNG pre-checked (Đ11.6: im lặng ≠ đồng ý)
 */
export default function ConsentPage() {
  const router = useRouter()
  const { consent, loading, grantConsent } = useConsent()
  const [agreed, setAgreed] = useState(false)
  const [parentEmail, setParentEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--color-bg,#F5F5F2)]">
        <div className="animate-pulse text-[var(--color-neutral,#5F5E5A)]">Đang tải...</div>
      </div>
    )
  }

  // Already fully consented → redirect to dashboard
  if (consent?.fully_consented) {
    router.push('/dashboard')
    return null
  }

  // Student assent done, waiting for parent → redirect
  if (consent?.student_assent && !consent?.parent_consent) {
    router.push('/consent/waiting')
    return null
  }

  const handleSubmit = async () => {
    if (!agreed) {
      setError('Vui lòng đọc và đánh dấu đồng ý để tiếp tục.')
      return
    }
    if (!parentEmail || !parentEmail.includes('@')) {
      setError('Vui lòng nhập email phụ huynh hợp lệ.')
      return
    }

    setSubmitting(true)
    setError('')
    try {
      await grantConsent('student_assent', parentEmail)
      router.push('/consent/waiting')
    } catch (e: any) {
      setError(e.message || 'Có lỗi xảy ra. Vui lòng thử lại.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F5F5F2] p-4">
      <div className="bg-white rounded-2xl shadow-lg max-w-lg w-full p-8">
        <h1 className="text-2xl font-bold text-[#185EA5] mb-2">
          Đồng ý sử dụng AdaptLearn
        </h1>
        <p className="text-sm text-gray-500 mb-6">
          Theo Nghị định 13/2023/NĐ-CP về Bảo vệ Dữ liệu Cá nhân
        </p>

        {/* Privacy Notice Summary */}
        <div className="bg-blue-50 rounded-lg p-4 mb-6 text-sm space-y-3">
          <h3 className="font-semibold text-[#185EA5]">Chúng tôi thu thập gì?</h3>
          <ul className="list-disc list-inside space-y-1 text-gray-700">
            <li>Thông tin cá nhân: họ tên, email, lớp</li>
            <li>Dữ liệu học tập: điểm quiz, thời gian làm bài</li>
            <li>Hồ sơ học tập: mức độ thành thạo, hồ sơ Bloom</li>
          </ul>

          <h3 className="font-semibold text-[#185EA5] pt-2">Mục đích</h3>
          <p className="text-gray-700">
            AI Agent phân tích dữ liệu để đề xuất bài học phù hợp năng lực của em.
          </p>

          <h3 className="font-semibold text-[#185EA5] pt-2">Quyền của em</h3>
          <ul className="list-disc list-inside space-y-1 text-gray-700">
            <li>Rút lại đồng ý bất kỳ lúc nào</li>
            <li>Yêu cầu xóa dữ liệu trong 72 giờ</li>
            <li>Nhật ký phản chiếu luôn riêng tư</li>
          </ul>

          <a href="/privacy/notice" className="text-[#185EA5] underline text-xs">
            Đọc đầy đủ thông báo xử lý dữ liệu →
          </a>
        </div>

        {/* Checkbox — NOT pre-checked (Đ11.6) */}
        <label className="flex items-start gap-3 mb-4 cursor-pointer">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            className="mt-1 w-5 h-5 accent-[#185EA5] rounded"
          />
          <span className="text-sm text-gray-700">
            Em đã đọc và <strong>đồng ý</strong> cho phép AdaptLearn xử lý dữ liệu cá nhân
            theo mục đích nêu trên.
          </span>
        </label>

        {/* Parent email */}
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Email phụ huynh <span className="text-red-500">*</span>
          </label>
          <input
            type="email"
            value={parentEmail}
            onChange={(e) => setParentEmail(e.target.value)}
            placeholder="phuhuynh@email.com"
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#185EA5] focus:border-transparent text-base"
          />
          <p className="text-xs text-gray-500 mt-1">
            Phụ huynh sẽ nhận email xác nhận đồng ý (Điều 20 NĐ 13/2023)
          </p>
        </div>

        {error && (
          <p className="text-red-500 text-sm mb-4">{error}</p>
        )}

        <button
          onClick={handleSubmit}
          disabled={submitting || !agreed}
          className="w-full py-3 bg-[#185EA5] text-white rounded-lg font-semibold
                     hover:bg-[#134d8a] disabled:bg-gray-300 disabled:cursor-not-allowed
                     transition-colors duration-200"
        >
          {submitting ? 'Đang gửi...' : 'Đồng ý và tiếp tục'}
        </button>

        <p className="text-xs text-gray-400 text-center mt-4">
          Em có thể rút lại đồng ý bất kỳ lúc nào trong Cài đặt → Quyền riêng tư
        </p>
      </div>
    </div>
  )
}

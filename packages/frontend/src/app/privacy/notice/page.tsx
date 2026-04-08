'use client'
import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api'

/**
 * Privacy Notice Page — NĐ 13/2023 Đ13
 * Thông báo xử lý dữ liệu cá nhân, hiển thị trước khi thu thập.
 * Public — không cần đăng nhập.
 */
export default function PrivacyNoticePage() {
  const [html, setHtml] = useState('')
  const [version, setVersion] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    apiFetch<{ data: { content_html: string; version: string } }>('/privacy/notice')
      .then((r) => {
        setHtml(r.data.content_html)
        setVersion(r.data.version)
      })
      .catch(() => setHtml('<p>Không tải được thông báo. Vui lòng liên hệ Tổ Tin học.</p>'))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F5F5F2]">
        <div className="animate-pulse text-gray-500">Đang tải thông báo...</div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#F5F5F2] py-12 px-4">
      <div className="max-w-2xl mx-auto bg-white rounded-2xl shadow-lg p-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-gray-800">
            Thông báo xử lý dữ liệu cá nhân
          </h1>
          <span className="text-xs text-gray-400 bg-gray-100 px-2 py-1 rounded">
            Phiên bản {version}
          </span>
        </div>

        <div className="prose prose-sm max-w-none text-gray-700"
          dangerouslySetInnerHTML={{ __html: html }}
        />

        <hr className="my-8" />

        <div className="text-xs text-gray-400 space-y-1">
          <p>Tài liệu này tuân thủ Nghị định 13/2023/NĐ-CP về Bảo vệ Dữ liệu Cá nhân.</p>
          <p>Liên hệ: Tổ Tin học, THPT Thủ Thiêm — it@thuthiem.edu.vn</p>
        </div>

        <div className="mt-6 flex gap-3">
          <a href="/consent"
            className="px-6 py-2 bg-[#185EA5] text-white rounded-lg font-medium hover:bg-[#134d8a] transition-colors">
            Đồng ý sử dụng
          </a>
          <a href="/login"
            className="px-6 py-2 border border-gray-300 text-gray-600 rounded-lg hover:bg-gray-50 transition-colors">
            Quay lại
          </a>
        </div>
      </div>
    </div>
  )
}

'use client'
import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { apiFetch } from '@/lib/api'
import { useAuth } from '@/lib/auth'

/**
 * AURA Studio — Upload & Manage Learning Materials
 * Source: SRS-CH07, UI_Ch7, SCR-7-01
 * GV upload files → AURA pipeline parse → QA check → activate
 */

interface AuraLesson {
  lesson_id: string
  file_type: string
  qa_status: string
  has_quiz: boolean
  quiz_count: number
  title?: string
  grade?: number
  bloom_level?: number
  created_at: string
}

export default function AuraStudioPage() {
  const { user } = useAuth()
  const router = useRouter()
  const [lessons, setLessons] = useState<AuraLesson[]>([])
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [lessonId, setLessonId] = useState('')
  const [fileType, setFileType] = useState('html')

  const loadLessons = useCallback(async () => {
    setLoading(true)
    try {
      const r = await apiFetch<{ data: AuraLesson[] }>('/aura/lessons')
      setLessons(r.data)
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

  // Load on mount
  useState(() => { loadLessons() })

  const handleUpload = async () => {
    if (!lessonId || !uploadFile) return
    setUploading(true)
    try {
      // Step 1: Get presigned URL
      const presign = await apiFetch<{ data: { upload_url: string; file_key: string } }>('/files/presign', {
        method: 'POST',
        body: JSON.stringify({
          filename: uploadFile.name,
          content_type: uploadFile.type || 'text/html',
          file_size_bytes: uploadFile.size,
        }),
      })

      // Step 2: Upload to MinIO (in production)
      // For now, skip actual upload and use file_key

      // Step 3: Trigger AURA pipeline
      await apiFetch('/aura/upload', {
        method: 'POST',
        body: JSON.stringify({
          lesson_id: lessonId,
          file_type: fileType,
          file_key: presign.data.file_key,
          exploit_mode: 'hybrid',
        }),
      })

      setUploadFile(null)
      setLessonId('')
      await loadLessons()
    } catch (e: any) {
      alert(e.message || 'Upload failed')
    }
    setUploading(false)
  }

  const qaStatusColor = (status: string) => {
    if (status === 'pass') return 'bg-green-100 text-green-800'
    if (status === 'warn') return 'bg-amber-100 text-amber-800'
    if (status === 'fail') return 'bg-red-100 text-red-800'
    return 'bg-gray-100 text-gray-600'
  }

  const fileTypeIcon = (type: string) => {
    const icons: Record<string, string> = {
      html: '📄', pdf: '📕', video: '🎬', quiz_json: '📝', python: '🐍',
    }
    return icons[type] || '📎'
  }

  return (
    <div className="min-h-screen bg-[#F5F5F2]">
      {/* Header */}
      <div className="bg-white border-b px-6 py-4">
        <h1 className="text-2xl font-bold text-gray-800">AURA Studio</h1>
        <p className="text-sm text-gray-500">Quản lý học liệu đa định dạng — HTML · PDF · Video · Quiz · Python</p>
      </div>

      <div className="max-w-6xl mx-auto p-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Upload Panel */}
        <div className="bg-white rounded-xl shadow-sm p-6 lg:col-span-1">
          <h2 className="text-lg font-semibold mb-4">Upload học liệu</h2>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Lesson ID (QĐ 791)</label>
              <input
                type="text"
                value={lessonId}
                onChange={(e) => setLessonId(e.target.value)}
                placeholder="020808.0201b3"
                className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-[#185EA5]"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Loại file</label>
              <select
                value={fileType}
                onChange={(e) => setFileType(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg text-sm"
              >
                <option value="html">HTML Interactive</option>
                <option value="pdf">PDF Tài liệu</option>
                <option value="video">Video HLS</option>
                <option value="quiz_json">Quiz JSON</option>
                <option value="python">Python Script</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Chọn file</label>
              <div className="border-2 border-dashed rounded-lg p-6 text-center hover:bg-gray-50 cursor-pointer">
                <input
                  type="file"
                  onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
                  className="hidden"
                  id="aura-upload"
                  accept=".html,.pdf,.mp4,.json,.py"
                />
                <label htmlFor="aura-upload" className="cursor-pointer">
                  {uploadFile ? (
                    <p className="text-sm text-[#185EA5] font-medium">{uploadFile.name} ({(uploadFile.size / 1024).toFixed(0)} KB)</p>
                  ) : (
                    <p className="text-sm text-gray-400">Kéo thả hoặc click để chọn file</p>
                  )}
                </label>
              </div>
            </div>

            <button
              onClick={handleUpload}
              disabled={uploading || !lessonId || !uploadFile}
              className="w-full py-2.5 bg-[#185EA5] text-white rounded-lg font-medium
                         hover:bg-[#134d8a] disabled:bg-gray-300 transition-colors"
            >
              {uploading ? 'Đang upload...' : 'Upload → AURA Pipeline'}
            </button>
          </div>
        </div>

        {/* Lessons List */}
        <div className="bg-white rounded-xl shadow-sm p-6 lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Học liệu AURA ({lessons.length})</h2>
            <button onClick={loadLessons} className="text-sm text-[#185EA5] hover:underline">
              Làm mới
            </button>
          </div>

          {loading ? (
            <div className="text-center py-8 text-gray-400">Đang tải...</div>
          ) : lessons.length === 0 ? (
            <div className="text-center py-8 text-gray-400">
              Chưa có học liệu. Upload file đầu tiên để bắt đầu.
            </div>
          ) : (
            <div className="space-y-3">
              {lessons.map((l) => (
                <div key={l.lesson_id} className="border rounded-lg p-4 hover:bg-gray-50 flex items-center gap-4">
                  <span className="text-2xl">{fileTypeIcon(l.file_type)}</span>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-gray-800 truncate">
                      {l.title || l.lesson_id}
                    </p>
                    <p className="text-xs text-gray-500">
                      {l.lesson_id} · Lớp {l.grade} · Bloom {l.bloom_level}
                      {l.has_quiz && ` · ${l.quiz_count} câu quiz`}
                    </p>
                  </div>
                  <span className={`px-2 py-1 rounded-full text-xs font-medium ${qaStatusColor(l.qa_status)}`}>
                    {l.qa_status === 'pass' ? '✓ QA Pass' :
                     l.qa_status === 'warn' ? '⚠ Warning' :
                     l.qa_status === 'fail' ? '✗ QA Fail' : '⏳ Pending'}
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

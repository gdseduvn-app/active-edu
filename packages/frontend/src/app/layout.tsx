import type { Metadata } from 'next'
import { Be_Vietnam_Pro } from 'next/font/google'
import { Toaster } from 'react-hot-toast'
import { AuthProvider } from '@/lib/auth'
import './globals.css'

const beVietnamPro = Be_Vietnam_Pro({
  subsets: ['latin', 'vietnamese'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-be-vietnam-pro',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'AURA AdaptLearn — THPT Thủ Thiêm',
  description: 'Hệ thống học tập thích nghi AURA dành cho học sinh THPT Thủ Thiêm',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="vi" className={beVietnamPro.variable}>
      <body className="font-sans bg-gray-50 min-h-screen antialiased">
        <AuthProvider>
          {children}
          <Toaster
            position="top-right"
            toastOptions={{
              duration: 4000,
              style: {
                fontFamily: 'var(--font-be-vietnam-pro)',
                fontSize: '14px',
              },
              success: {
                style: { background: '#10B981', color: '#fff' },
              },
              error: {
                style: { background: '#EF4444', color: '#fff' },
              },
            }}
          />
        </AuthProvider>
      </body>
    </html>
  )
}

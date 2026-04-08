/** @type {import('next').NextConfig} */
const config = {
  output: 'standalone',
  images: {
    domains: ['learn.thuthiem.edu.vn'],
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
        ],
      },
    ]
  },
}

export default config

import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-be-vietnam-pro)', 'Be Vietnam Pro', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      colors: {
        primary: {
          DEFAULT: '#E66000',
          50: '#FFF4ED',
          100: '#FFE6D5',
          200: '#FFCAA8',
          300: '#FFA471',
          400: '#FF7437',
          500: '#E66000',
          600: '#CC4E00',
          700: '#A33D00',
          800: '#7A2E00',
          900: '#521F00',
        },
        sidebar: '#2D3B45',
        success: '#10B981',
        warning: '#F59E0B',
        danger: '#EF4444',
      },
      borderRadius: {
        sm: '6px',
        DEFAULT: '10px',
        md: '10px',
        lg: '16px',
        xl: '20px',
        '2xl': '24px',
        '3xl': '28px',
      },
      boxShadow: {
        card: '0 2px 8px 0 rgba(0,0,0,0.06)',
        'card-md': '0 4px 16px 0 rgba(0,0,0,0.10)',
      },
    },
  },
  plugins: [],
}

export default config

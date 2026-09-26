import { Inter } from 'next/font/google'

// Configure Inter font to match exactly what Next.js optimizes for
export const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  preload: true,
  adjustFontFallback: true,
  variable: '--font-inter',
})

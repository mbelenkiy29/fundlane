import { Inter } from 'next/font/google'
import localFont from 'next/font/local'

// Configure Inter font to match exactly what Next.js optimizes for
export const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  preload: true,
  adjustFontFallback: true,
  variable: '--font-inter',
})

export const marketingHeading = localFont({
  src: '../../public/fonts/marketing/InterDisplay-Medium.woff2',
  weight: '500',
  display: 'swap',
  preload: true,
  adjustFontFallback: 'Arial',
  variable: '--font-marketing-heading',
})

export const marketingMono = localFont({
  src: '../../public/fonts/marketing/GeistMono-Regular.woff2',
  display: 'swap',
  preload: true,
  variable: '--font-marketing-mono',
})

export const marketingMetric = localFont({
  src: '../../public/fonts/marketing/Geist-Regular.woff2',
  display: 'swap',
  preload: true,
  adjustFontFallback: 'Arial',
  variable: '--font-marketing-metric',
})

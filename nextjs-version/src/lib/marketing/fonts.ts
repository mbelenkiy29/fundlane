import localFont from 'next/font/local'

export const marketingHeading = localFont({
  src: '../../../public/fonts/marketing/InterDisplay-Medium.woff2',
  weight: '500',
  display: 'swap',
  preload: false,
  adjustFontFallback: 'Arial',
  variable: '--font-marketing-heading',
})

export const marketingMono = localFont({
  src: '../../../public/fonts/marketing/GeistMono-Regular.woff2',
  display: 'swap',
  preload: false,
  variable: '--font-marketing-mono',
})

export const marketingMetric = localFont({
  src: '../../../public/fonts/marketing/Geist-Regular.woff2',
  display: 'swap',
  preload: false,
  adjustFontFallback: 'Arial',
  variable: '--font-marketing-metric',
})

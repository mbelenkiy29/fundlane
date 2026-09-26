import localFont from 'next/font/local'

export const marketingMono = localFont({
  src: '../../../public/fonts/marketing/GeistMono-Regular.woff2',
  display: 'swap',
  preload: false,
  variable: '--font-marketing-mono',
})

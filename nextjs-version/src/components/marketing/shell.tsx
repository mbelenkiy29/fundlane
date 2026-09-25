import Link from "next/link"
import localFont from "next/font/local"
import { ArrowUpRight } from "lucide-react"
import { getDemoConfiguration } from "@/lib/marketing/config"
import "./marketing.css"

import { MobileNav } from "./mobile-nav"

const heading = localFont({ src: "../../../public/fonts/marketing/InterDisplay-Medium.woff2", weight: "500", display: "swap", variable: "--font-marketing-heading" })
const mono = localFont({ src: "../../../public/fonts/marketing/GeistMono-Regular.woff2", display: "swap", variable: "--font-marketing-mono" })
const geist = localFont({ src: "../../../public/fonts/marketing/Geist-Regular.woff2", display: "swap", variable: "--font-marketing-metric" })

export function Brand() {
  return (
    <Link href="/" className="fl-brand" aria-label="Fundlane home">
      <svg
        width="32"
        height="32"
        viewBox="0 0 32 32"
        fill="none"
        aria-hidden="true"
      >
        <rect width="32" height="32" rx="0" fill="currentColor" />
        <path
          d="M9 9h15l-4 4H9V9Zm0 7h11l-4 4H9v-4Zm0 7h7l-4 4H9v-4Z"
          fill="#000000"
        />
      </svg>
      <span>fundlane</span>
    </Link>
  )
}

export function DemoLink({
  children = "Book a demo",
  secondary = false,
}: {
  children?: React.ReactNode
  secondary?: boolean
}) {
  return (
    <Link
      className={`fl-button${secondary ? " fl-button-secondary" : ""}`}
      href="/demo"
    >
      {children}
      <ArrowUpRight size={16} aria-hidden="true" />
    </Link>
  )
}

export function MarketingShell({ children, immersive = false }: { children: React.ReactNode; immersive?: boolean }) {
  const { privacyUrl } = getDemoConfiguration()
  return (
    <div className={`fundlane ${heading.variable} ${mono.variable} ${geist.variable}${immersive ? " fl-immersive" : ""}`}>
      <a className="fl-skip" href="#main">
        Skip to content
      </a>
      <header className="fl-header">
        <div className="fl-container fl-nav">
          <Brand />
          <nav className="fl-desktop-nav" aria-label="Main navigation">
            <Link href="/features">Features</Link>
            <Link href="/changelog">Changelog</Link>
            <Link href="/#workflow">How it works</Link>
            <Link href="/#faq">FAQ</Link>
          </nav>
          <div className="fl-nav-actions">
            <Link href="/sign-in" className="fl-signin">
              Sign in
            </Link>
            <DemoLink />
          </div>
          <MobileNav />
        </div>
      </header>
      {children}
      <footer className="fl-footer">
        <div className="fl-container">
          <div className="fl-footer-top">
            <div>
              <Brand />
              <p>A clear path for every deal.</p>
            </div>
            <nav aria-label="Footer navigation">
              <Link href="/features">Features</Link>
              <Link href="/changelog">Changelog</Link>
              <Link href="/#workflow">How it works</Link>
              <Link href="/demo">Book a demo</Link>
              <Link href="/sign-in">Sign in</Link>
              {privacyUrl && <a href={privacyUrl}>Privacy</a>}
            </nav>
          </div>
          <div className="fl-footer-bottom">
            <span>© {new Date().getFullYear()} Fundlane</span>
            <span>Built for MCA brokerages.</span>
          </div>
        </div>
      </footer>
    </div>
  )
}

import Link from "next/link"
import { Manrope } from "next/font/google"
import { Menu, ArrowUpRight } from "lucide-react"
import { getDemoConfiguration } from "@/lib/marketing/config"
import "./marketing.css"

const manrope = Manrope({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-marketing-heading",
})

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
        <rect width="32" height="32" rx="9" fill="currentColor" />
        <path
          d="M9 9h15l-4 4H9V9Zm0 7h11l-4 4H9v-4Zm0 7h7l-4 4H9v-4Z"
          fill="white"
        />
      </svg>
      <span>fundlane</span>
    </Link>
  )
}

export function DemoLink({
  children = "Request a demo",
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

export function MarketingShell({ children }: { children: React.ReactNode }) {
  const { privacyUrl } = getDemoConfiguration()
  return (
    <div className={`fundlane ${manrope.variable}`}>
      <a className="fl-skip" href="#main">
        Skip to content
      </a>
      <header className="fl-header">
        <div className="fl-container fl-nav">
          <Brand />
          <nav className="fl-desktop-nav" aria-label="Main navigation">
            <Link href="/#product">Product</Link>
            <Link href="/#workflow">How it works</Link>
            <Link href="/#faq">FAQ</Link>
          </nav>
          <div className="fl-nav-actions">
            <Link href="/sign-in" className="fl-signin">
              Sign in
            </Link>
            <DemoLink />
          </div>
          <details className="fl-mobile-nav">
            <summary aria-label="Open navigation">
              <Menu size={22} />
            </summary>
            <nav aria-label="Mobile navigation">
              <Link href="/#product">Product</Link>
              <Link href="/#workflow">How it works</Link>
              <Link href="/#faq">FAQ</Link>
              <Link href="/sign-in">Sign in</Link>
              <Link href="/demo">Request a demo</Link>
            </nav>
          </details>
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
              <Link href="/#product">Product</Link>
              <Link href="/#workflow">How it works</Link>
              <Link href="/demo">Request a demo</Link>
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

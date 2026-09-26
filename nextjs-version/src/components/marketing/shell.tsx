import Link from "next/link"
import { ArrowUpRight } from "lucide-react"
import { Logo } from "@/components/logo"
import { marketingFontClasses } from "@/lib/marketing/fonts"
import { marketingJsonLd } from "@/lib/marketing/metadata"
import { companyLegalName, marketingPolishEnabled } from "@/lib/marketing/polish"
import { getDemoConfiguration } from "@/lib/marketing/config"
import { getSupportConfig } from "@/lib/marketing/support-config"
import "./marketing.css"

import { MobileNav } from "./mobile-nav"

export function Brand() {
  return (
    <Link href="/" className="fl-brand" aria-label="Fundlane home">
      <Logo size={32} aria-hidden="true" />
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
      {!marketingPolishEnabled() && <ArrowUpRight size={16} aria-hidden="true" />}
    </Link>
  )
}

export function MarketingJsonLd({ title, path, description, faq }: { title: string; path: string; description?: string; faq?: readonly (readonly [string, string])[] }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(marketingJsonLd({ title, path, description, faq: marketingPolishEnabled() ? faq : undefined })).replace(/</g, "\\u003c") }}
    />
  )
}

export async function MarketingShell({
  children,
  immersive = false,
  jsonLd,
}: {
  children: React.ReactNode
  immersive?: boolean
  jsonLd?: { title: string; path: string; description?: string; faq?: readonly (readonly [string, string])[] }
}) {
  const polished = marketingPolishEnabled()
  const fontClasses = await marketingFontClasses(polished)
  const { privacyUrl } = getDemoConfiguration()
  const { statusUrl, roadmapUrl, supportEmail } = getSupportConfig()
  const legalName = polished ? companyLegalName() : null
  return (
    <div className={`fundlane ${fontClasses}${polished ? " fl-polished" : ""}${immersive ? " fl-immersive" : ""}`}>
      {jsonLd && <MarketingJsonLd {...jsonLd} />}
      <a className="fl-skip" href="#main">
        Skip to content
      </a>
      <header className="fl-header">
        <div className="fl-container fl-nav">
          <Brand />
          <nav className="fl-desktop-nav" aria-label="Main navigation">
            <Link href="/features">Features</Link>
            <Link href="/changelog">Changelog</Link>
            <Link href="/help">Help</Link>
            <Link href="/#workflow">How it works</Link>
            <Link href="/#faq">FAQ</Link>
          </nav>
          <div className="fl-nav-actions">
            <Link href="/sign-in" className="fl-signin">
              Sign in
            </Link>
            <DemoLink />
          </div>
          <MobileNav polished={polished} />
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
              <Link href="/help">Help center</Link>
              <Link href="/#workflow">How it works</Link>
              <Link href="/demo">Book a demo</Link>
              <Link href="/sign-in">Sign in</Link>
              {statusUrl && <a href={statusUrl}>System status</a>}
              {roadmapUrl && <a href={roadmapUrl}>Roadmap</a>}
              {supportEmail && <a href={`mailto:${supportEmail}`}>Support email</a>}
              {privacyUrl && <a href={privacyUrl}>Privacy</a>}
            </nav>
          </div>
          {polished && (legalName || supportEmail) && <address className="fl-footer-contact">
            {legalName && <span>{legalName}</span>}
            {supportEmail && <a href={`mailto:${supportEmail}`}>{supportEmail}</a>}
          </address>}
          <div className="fl-footer-bottom">
            <span>© {new Date().getFullYear()} Fundlane</span>
            <span>Built for MCA brokerages.</span>
          </div>
        </div>
      </footer>
    </div>
  )
}

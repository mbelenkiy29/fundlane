import Link from "next/link"
import { MarketingShell } from "@/components/marketing/shell"

export default function NotFound() {
  return (
    <MarketingShell>
      <main id="main">
        <section className="fl-container fl-features-intro">
          <p className="fl-section-label">404</p>
          <h1>Page not found</h1>
          <p>That address is not a Fundlane page.</p>
          <div className="fl-actions">
            <Link href="/" className="fl-button">Back to home</Link>
            <Link href="/sign-in" className="fl-text-link">Sign in</Link>
          </div>
        </section>
      </main>
    </MarketingShell>
  )
}

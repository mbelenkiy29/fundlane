import Link from "next/link"
import { MarketingShell } from "@/components/marketing/shell"
import { helpArticles } from "@/lib/marketing/help"
import { getConfiguredSupportRows, getSupportConfig } from "@/lib/marketing/support-config"
import { marketingMetadata } from "@/lib/marketing/metadata"

export const metadata = marketingMetadata("Help center", "/help", "Guides to setting up Fundlane and working with applications, documents, submissions, and offers.")
export const dynamic = "force-dynamic"

export default function HelpPage() {
  const supportRows = getConfiguredSupportRows(getSupportConfig())
  return <MarketingShell jsonLd={{ title: "Help center", path: "/help" }}>
    <main id="main" className="fl-container fl-help">
      <p className="fl-section-label">Fundlane help</p>
      <h1>Help center</h1>
      <p>Guides for the workflows available in your Fundlane workspace.</p>
      <section aria-labelledby="guides-title">
        <h2 id="guides-title">Guides</h2>
        <div className="fl-help-grid">{helpArticles.map(article => <Link key={article.slug} href={`/help/${article.slug}`} className="fl-help-card"><h3>{article.title}</h3><p>{article.summary}</p><span>Read guide →</span></Link>)}</div>
      </section>
      {supportRows.length > 0 && <section aria-labelledby="support-title" className="fl-help-resources">
        <h2 id="support-title">Support and updates</h2>
        {supportRows.map(row => <p key={row.label}>{row.label}: <a className="fl-inline-link" href={row.href}>{row.linkText}</a></p>)}
      </section>}
    </main>
  </MarketingShell>
}

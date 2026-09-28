import { notFound } from "next/navigation"
import { MarketingShell } from "@/components/marketing/shell"
import { publicStatusPageEnabled } from "@/lib/marketing/launch-switches"
import { marketingMetadata } from "@/lib/marketing/metadata"
import { getPublicStatusCheck } from "@/lib/marketing/public-status"
import { getSupportConfig } from "@/lib/marketing/support-config"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const metadata = marketingMetadata("System status", "/status", "Current checks for the Fundlane website and database connection.")

export default async function StatusPage() {
  if (!publicStatusPageEnabled()) notFound()
  const check = await getPublicStatusCheck()
  const { statusUrl } = getSupportConfig()
  return <MarketingShell>
    <main id="main" className="fl-container fl-help">
      <h1>System status</h1>
      <p>Current checks for this Fundlane page and its database connection. These checks do not provide historical uptime.</p>
      <section aria-label="Current checks" className="fl-help-grid">
        <article className="fl-help-card"><h2>Website</h2><p>Available</p></article>
        <article className="fl-help-card"><h2>Database</h2><p>{check.databaseAvailable ? "Available" : "Unavailable"}</p></article>
      </section>
      <p>Last checked: <time dateTime={check.checkedAt}>{check.checkedAt}</time></p>
      <p>Checks refresh about once a minute.</p>
      {statusUrl && <p><a className="fl-inline-link" href={statusUrl}>View external status page</a></p>}
    </main>
  </MarketingShell>
}

import type { Metadata } from "next"
import { Check } from "lucide-react"
import { MarketingShell } from "@/components/marketing/shell"
import { DemoForm } from "@/components/marketing/demo-form"
import { getDemoConfiguration } from "@/lib/marketing/config"
import { DEMO_DESCRIPTION, marketingMetadata } from "@/lib/marketing/metadata"

export const metadata: Metadata = marketingMetadata("Request a demo", "/demo", DEMO_DESCRIPTION)
export const dynamic = "force-dynamic"

export default function DemoPage() {
  const { enabled, privacyUrl } = getDemoConfiguration()
  return (
    <MarketingShell jsonLd={{ title: "Request a demo", path: "/demo", description: DEMO_DESCRIPTION }}>
      <main id="main" className="fl-container fl-demo-page">
        <div className="fl-demo-intro">
          <p className="fl-section-label">Your brokerage. Your workflow.</p>
          <h1>
            Let’s find a clearer
            <br />
            path for your deals.
          </h1>
          <p>
            Take a walkthrough of Fundlane, shaped around the way your team
            works.
          </p>
          <ul>
            <li>
              <Check />
              Follow a deal from application to renewal.
            </li>
            <li>
              <Check />
              Explore underwriting and submission workflows.
            </li>
            <li>
              <Check />
              Review team access, reporting, and your tools.
            </li>
          </ul>
          <div className="fl-demo-aside">
            <span className="fl-demo-line" />
            <p>
              Built for the people
              <br />
              behind every funded deal.
            </p>
          </div>
        </div>
        <section className="fl-demo-card" aria-labelledby="demo-title">
          <h2 id="demo-title">Request a demo</h2>
          <p>Tell us a little about your brokerage.</p>
          <DemoForm enabled={enabled} privacyUrl={privacyUrl} />
        </section>
      </main>
    </MarketingShell>
  )
}

import { redirect } from "next/navigation"
import Link from "next/link"
import { MarketingShell } from "@/components/marketing/shell"
import { BILLING_CATALOG, TRIAL_DAYS } from "@/lib/mca/billing-catalog"
import { marketingTrialCtaEnabled, publicPricingEnabled } from "@/lib/marketing/launch-switches"
import { getSupportConfig } from "@/lib/marketing/support-config"
import { marketingMetadata } from "@/lib/marketing/metadata"

export const metadata = marketingMetadata("Pricing", "/pricing", "Monthly Fundlane pricing and trial terms.")
export const dynamic = "force-dynamic"

function dollars(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: BILLING_CATALOG.currency, maximumFractionDigits: 0 }).format(cents / 100)
}

export default function PricingPage() {
  if (!publicPricingEnabled()) redirect("/settings/billing")
  const tiers = BILLING_CATALOG.additionalSeats.tiers
  const { supportEmail } = getSupportConfig()
  return <MarketingShell jsonLd={{ title: "Pricing", path: "/pricing", description: "Monthly Fundlane pricing and trial terms." }}>
    <main id="main" className="fl-container fl-help fl-pricing">
      <p className="fl-section-label">Simple monthly pricing</p>
      <h1>Fundlane pricing</h1>
      <p><strong>{dollars(BILLING_CATALOG.base.unitAmountCents)} per month per company</strong>, including the first user.</p>
      <p>Additional users are billed monthly at these rates:</p>
      <ul>
        {tiers.map((tier, index) => {
          const firstUser = index === 0 ? 2 : (tiers[index - 1].upTo ?? 0) + 2
          const lastUser = tier.upTo === null ? null : tier.upTo + 1
          return <li key={firstUser}>Users {firstUser}{lastUser === null ? "+" : `–${lastUser}`}: {dollars(tier.unitAmountCents)} per user per month</li>
        })}
      </ul>
      <p>Prices are in USD, billed monthly. Sales tax is added where applicable.</p>
      <p>Start with a {TRIAL_DAYS}-day free trial. A card is required to start. Cancel anytime.</p>
      {marketingTrialCtaEnabled() && <Link className="fl-button" href="/sign-up">Start free trial</Link>}
      {supportEmail && <p>Questions? Email <a className="fl-inline-link" href={`mailto:${supportEmail}`}>{supportEmail}</a>.</p>}
    </main>
  </MarketingShell>
}

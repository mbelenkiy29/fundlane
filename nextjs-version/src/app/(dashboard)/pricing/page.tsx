import { MarketingShell } from "@/components/marketing/shell"
import { TrialStartButton } from "@/components/marketing/trial-start-button"
import { BILLING_CATALOG, TRIAL_DAYS } from "@/lib/mca/billing-catalog"
import { marketingTrialEnrollmentEnabled } from "@/lib/marketing/trial-availability"
import { getSupportConfig } from "@/lib/marketing/support-config"
import { marketingMetadata } from "@/lib/marketing/metadata"
import { billingTaxCopy } from "@/lib/mca/billing-tax"

export const metadata = marketingMetadata("Pricing", "/pricing", "Monthly Fundlane pricing and trial terms.")
export const dynamic = "force-dynamic"

function dollars(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: BILLING_CATALOG.currency, maximumFractionDigits: 0 }).format(cents / 100)
}

export default function PricingPage() {
  const tiers = BILLING_CATALOG.additionalSeats.tiers
  const { supportEmail } = getSupportConfig()
  const taxCopy = billingTaxCopy()
  return <MarketingShell jsonLd={{ title: "Pricing", path: "/pricing", description: "Monthly Fundlane pricing and trial terms." }}>
    <main id="main" className="fl-container fl-help fl-pricing">
      <p className="fl-section-label">Simple monthly pricing</p>
      <h1>Fundlane pricing</h1>
      <p><strong>{dollars(BILLING_CATALOG.base.unitAmountCents)} per month per company</strong>, including the first user.</p>
      <p>Manage additional users inside the app after starting your trial. They are billed monthly at these rates:</p>
      <ul>
        {tiers.map((tier, index) => {
          const firstUser = index === 0 ? 2 : (tiers[index - 1].upTo ?? 0) + 2
          const lastUser = tier.upTo === null ? null : tier.upTo + 1
          return <li key={firstUser}>Users {firstUser}{lastUser === null ? "+" : `–${lastUser}`}: {dollars(tier.unitAmountCents)} per user per month</li>
        })}
      </ul>
      <p>Prices are in USD, billed monthly.{taxCopy && <> {taxCopy}</>}</p>
      <p>You choose how many seats to buy. Removing a user frees their seat for someone else but doesn&apos;t lower your bill. Adding seats beyond what you&apos;ve bought is prorated and charged right away; the new seat is ready after payment. Reducing your seat count takes effect at your next renewal, with no mid-cycle credit. Seat changes during the free trial are free.</p>
      <p>AI credits: coming soon.</p>
      <p>Onboarding: set up on your own with our guides{supportEmail && <>, or <a className="fl-inline-link" href={`mailto:${supportEmail}`}>email us</a> for help getting your company set up</>}.</p>
      <p>Start with a {TRIAL_DAYS}-day free trial. A card is required to start. Your subscription automatically converts to {dollars(BILLING_CATALOG.base.unitAmountCents)} per month unless you cancel before the trial ends.</p>
      <p>Stripe will show your first scheduled charge date before you start your trial.</p>
      <TrialStartButton available={marketingTrialEnrollmentEnabled()} />
      {supportEmail && <p>Questions? Email <a className="fl-inline-link" href={`mailto:${supportEmail}`}>{supportEmail}</a>.</p>}
    </main>
  </MarketingShell>
}

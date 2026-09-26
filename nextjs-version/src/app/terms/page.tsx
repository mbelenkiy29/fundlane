import { LegalDraft } from "@/components/marketing/legal-draft"
import { MarketingShell } from "@/components/marketing/shell"
import { termsSections } from "@/lib/marketing/legal-drafts"
import { marketingMetadata } from "@/lib/marketing/metadata"

const description = "Draft terms of service for Fundlane. Pending legal review."
export const metadata = marketingMetadata("Terms of Service (Draft)", "/terms", description)

export default function TermsPage() {
  return <MarketingShell jsonLd={{ title: "Terms of Service (Draft)", path: "/terms", description }}>
    <LegalDraft title="Terms of Service" sections={termsSections} />
  </MarketingShell>
}

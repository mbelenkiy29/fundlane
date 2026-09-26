import { LegalDraft } from "@/components/marketing/legal-draft"
import { MarketingShell } from "@/components/marketing/shell"
import { privacySections } from "@/lib/marketing/legal-drafts"
import { marketingMetadata } from "@/lib/marketing/metadata"

const description = "Draft privacy policy for Fundlane's website and workspace. Pending legal review."
export const metadata = marketingMetadata("Privacy Policy (Draft)", "/privacy", description)

export default function PrivacyPage() {
  return <MarketingShell jsonLd={{ title: "Privacy Policy (Draft)", path: "/privacy", description }}>
    <LegalDraft title="Privacy Policy" sections={privacySections} />
  </MarketingShell>
}

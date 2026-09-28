import { redirect } from "next/navigation"
import { LegalDraft } from "@/components/marketing/legal-draft"
import { MarketingShell } from "@/components/marketing/shell"
import { legalDraftPagesEnabled } from "@/lib/marketing/legal-draft-flag"
import { termsSections } from "@/lib/marketing/legal-drafts"
import { marketingMetadata } from "@/lib/marketing/metadata"

const description = "Draft Terms of Service for Fundlane. Draft, not reviewed by an attorney. Not yet in effect."
export const dynamic = "force-dynamic"
export function generateMetadata() {
  return legalDraftPagesEnabled() ? marketingMetadata("Terms of Service (Draft)", "/terms", description) : {}
}

export default function TermsPage() {
  if (!legalDraftPagesEnabled()) redirect("/sign-in?returnTo=%2Fterms")
  return <MarketingShell jsonLd={{ title: "Terms of Service (Draft)", path: "/terms", description }}>
    <LegalDraft title="Terms of Service" sections={termsSections} />
  </MarketingShell>
}

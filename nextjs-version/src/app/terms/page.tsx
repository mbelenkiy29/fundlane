import { redirect } from "next/navigation"
import { LegalDraft } from "@/components/marketing/legal-draft"
import { MarketingShell } from "@/components/marketing/shell"
import { legalDraftPagesEnabled } from "@/lib/marketing/legal-draft-flag"
import { legalLastUpdated, termsSections } from "@/lib/marketing/legal-drafts"
import { marketingMetadata } from "@/lib/marketing/metadata"

const description = "Fundlane Terms of Service from Sentinel Tech Solutions LLC, effective September 28, 2026."
export const dynamic = "force-dynamic"
export function generateMetadata() {
  return legalDraftPagesEnabled() ? marketingMetadata("Terms of Service", "/terms", description) : {}
}

export default function TermsPage() {
  if (!legalDraftPagesEnabled()) redirect("/sign-in?returnTo=%2Fterms")
  return <MarketingShell jsonLd={{ title: "Terms of Service", path: "/terms", description }}>
    <LegalDraft title="Terms of Service" sections={termsSections} lastUpdated={legalLastUpdated.terms} />
  </MarketingShell>
}

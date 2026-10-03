import { notFound } from "next/navigation"
import { LegalDraft } from "@/components/marketing/legal-draft"
import { MarketingShell } from "@/components/marketing/shell"
import { getDemoConfiguration } from "@/lib/marketing/config"
import { legalDraftPagesEnabled } from "@/lib/marketing/legal-draft-flag"
import { legalLastUpdated, privacySections } from "@/lib/marketing/legal-drafts"
import { privacyNotice } from "@/lib/marketing/privacy-notice"
import { marketingMetadata } from "@/lib/marketing/metadata"

const description = "How Sentinel Tech Solutions LLC handles information in Fundlane, effective September 28, 2026."
const approvedDescription = "How Sentinel Tech Solutions LLC handles Fundlane website and demo request information."
export const dynamic = "force-dynamic"

export function generateMetadata() {
  return legalDraftPagesEnabled()
    ? marketingMetadata("Privacy Policy", "/privacy", description)
    : { ...marketingMetadata("Website and demo privacy notice", "/privacy"), description: approvedDescription }
}

export default function PrivacyPage() {
  if (!legalDraftPagesEnabled()) {
    if (getDemoConfiguration().privacyUrl !== "https://fundlane.io/privacy") notFound()
    return <MarketingShell jsonLd={{ title: "Website and demo privacy notice", path: "/privacy", description: approvedDescription }}>
      <main id="main" className="fl-container" style={{ maxWidth: 800, paddingTop: 64, paddingBottom: 80 }}>
        <h1 style={{ fontSize: 36, lineHeight: 1.2, marginBottom: 32 }}>Website and demo privacy notice</h1>
        {privacyNotice.map((block, index) => block.heading
          ? <h2 key={index} style={{ fontSize: 24, marginTop: 32, marginBottom: 12 }}>{block.text}</h2>
          : <p key={index} style={{ lineHeight: 1.8, marginBottom: 16 }}>{block.text}</p>)}
        <p><a href="mailto:ben@sentineltechsolutions.io">Contact us about privacy</a></p>
      </main>
    </MarketingShell>
  }
  return <MarketingShell jsonLd={{ title: "Privacy Policy", path: "/privacy", description }}>
    <LegalDraft title="Privacy Policy" sections={privacySections} lastUpdated={legalLastUpdated.privacy} />
  </MarketingShell>
}

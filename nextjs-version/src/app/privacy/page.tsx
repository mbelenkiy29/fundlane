import { notFound } from "next/navigation"
import { MarketingShell } from "@/components/marketing/shell"
import { getDemoConfiguration } from "@/lib/marketing/config"
import { privacyNotice } from "@/lib/marketing/privacy-notice"
import { marketingMetadata } from "@/lib/marketing/metadata"

export const dynamic = "force-dynamic"
export const metadata = {
  ...marketingMetadata("Website and demo privacy notice", "/privacy"),
  description: "How Sentinel Tech Solutions LLC handles Fundlane website and demo request information.",
}

export default function PrivacyPage() {
  // Setting the approved URL is the publication gate, as well as the demo gate.
  if (getDemoConfiguration().privacyUrl !== "https://fundlane.io/privacy") notFound()
  return <MarketingShell>
    <main id="main" className="fl-container" style={{ maxWidth: 800, paddingTop: 64, paddingBottom: 80 }}>
      <h1 style={{ fontSize: 36, lineHeight: 1.2, marginBottom: 32 }}>Website and demo privacy notice</h1>
      {privacyNotice.map((block, index) => block.heading
        ? <h2 key={index} style={{ fontSize: 24, marginTop: 32, marginBottom: 12 }}>{block.text}</h2>
        : <p key={index} style={{ lineHeight: 1.8, marginBottom: 16 }}>{block.text}</p>)}
      <p><a href="mailto:ben@sentineltechsolutions.io">Contact us about privacy</a></p>
    </main>
  </MarketingShell>
}

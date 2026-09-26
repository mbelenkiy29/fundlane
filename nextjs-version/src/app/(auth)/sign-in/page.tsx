import type { Metadata } from "next"
import { MarketingShell } from "@/components/marketing/shell"
import { marketingMetadata } from "@/lib/marketing/metadata"
import { SignInForm } from "./sign-in-form"

export const metadata: Metadata = marketingMetadata("Sign in", "/sign-in")

export default function SignInPage() {
  return (
    <MarketingShell>
      <main id="main" className="fl-container fl-demo-page fl-sign-in">
        <div className="fl-demo-intro">
          <p className="fl-section-label">Sign in</p>
          <h1>Welcome back.</h1>
          <p>Sign in to continue to your brokerage workspace.</p>
        </div>
        <section className="fl-demo-card" aria-labelledby="sign-in-title">
          <SignInForm magicLinkEnabled={process.env.MCA_MAGIC_LINK_ENABLED === "true"} />
        </section>
      </main>
    </MarketingShell>
  )
}

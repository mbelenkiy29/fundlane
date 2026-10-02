import type { Metadata } from "next"
import { MarketingShell } from "@/components/marketing/shell"
import { marketingMetadata } from "@/lib/marketing/metadata"
import { SignInForm } from "./sign-in-form"
import { migratedAccountNoticeEnabled, signupMode } from "@/lib/mca/signup-mode"

export const metadata: Metadata = marketingMetadata("Login", "/sign-in")

export default function SignInPage() {
  return (
    <MarketingShell>
      <main id="main" className="fl-container fl-demo-page fl-sign-in">
        <div className="fl-demo-intro">
          <p className="fl-section-label">Login</p>
          <h1>Welcome back.</h1>
          <p>Sign in to continue to your brokerage workspace.</p>
        </div>
        <section className="fl-demo-card" aria-labelledby="sign-in-title">
          <SignInForm
            magicLinkEnabled={process.env.MCA_MAGIC_LINK_ENABLED === "true"}
            inviteOnly={signupMode() === "invite_only"}
            showMigratedAccountNotice={migratedAccountNoticeEnabled()}
          />
        </section>
      </main>
    </MarketingShell>
  )
}

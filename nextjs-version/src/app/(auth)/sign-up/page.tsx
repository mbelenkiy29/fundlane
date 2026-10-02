import { SignupForm1 } from "./components/signup-form-1"
import { Logo } from "@/components/logo"
import Link from "next/link"
import { signupMode } from "@/lib/mca/signup-mode"
import { marketingPolishEnabled } from "@/lib/marketing/polish"
import { legalDraftPagesEnabled } from "@/lib/marketing/legal-draft-flag"
import { redirect } from "next/navigation"
import { stripeFirstSignupRequired } from "@/lib/mca/signup-guard"

export default function SignUpPage() {
  if (signupMode() === "open" && stripeFirstSignupRequired()) redirect("/pricing")
  return (
    <div className="bg-muted flex min-h-svh flex-col items-center justify-center gap-6 p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <Link href="/" className="flex items-center gap-2 self-center font-medium">
          <div className="bg-primary text-primary-foreground flex size-9 items-center justify-center rounded-md">
            <Logo size={24} />
          </div>
          Fundlane
        </Link>
        {signupMode() === "invite_only" ? <div className="rounded-lg border bg-card p-6 text-center">
          <h1 className="text-xl font-semibold">Fundlane is invite-only</h1>
          <p className="mt-2 text-muted-foreground">Book a demo to get started, or use your invitation link to join your team.</p>
          <Link href="/demo" className="mt-4 inline-block underline">Book a demo</Link>
        </div> : <SignupForm1 headingAsH1={marketingPolishEnabled()} legalDraftsEnabled={legalDraftPagesEnabled()} />}
      </div>
    </div>
  )
}

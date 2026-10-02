import { SignupForm1 } from "./components/signup-form-1"
import { Logo } from "@/components/logo"
import Link from "next/link"
import { signupMode } from "@/lib/mca/signup-mode"
import { marketingPolishEnabled } from "@/lib/marketing/polish"
import { legalDraftPagesEnabled } from "@/lib/marketing/legal-draft-flag"

export default async function SignUpPage({searchParams}:{searchParams:Promise<{next?:string}>}) {
  let checkoutEmail="",issue=""
  if ((await searchParams).next === "/activate") {
    const {cookies}=await import("next/headers")
    const {redirect}=await import("next/navigation")
    const {SIGNUP_COOKIE,readSignupIntent}=await import("@/lib/mca/stripe-first-signup")
    const {supabaseIdentity}=await import("@/lib/mca/supabase-auth")
    const {AppError}=await import("@/lib/mca/errors")
    if (await supabaseIdentity()) redirect("/activate")
    try {
      const token=(await cookies()).get(SIGNUP_COOKIE)?.value
      if (!token) throw new AppError(410,"signup_intent_missing","Open your signup recovery email or get started again.")
      const intent=await readSignupIntent(token)
      if (intent.state==="pending" || !intent.checkout_email) throw new AppError(409,"signup_card_incomplete","Finish saving your card in Stripe first.")
      checkoutEmail=intent.checkout_email
    } catch(error){if (!(error instanceof AppError))throw error;issue=error.message}
  }
  return (
    <div className="bg-muted flex min-h-svh flex-col items-center justify-center gap-6 p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <Link href="/" className="flex items-center gap-2 self-center font-medium">
          <div className="bg-primary text-primary-foreground flex size-9 items-center justify-center rounded-md">
            <Logo size={24} />
          </div>
          Fundlane
        </Link>
        {issue?<div role="alert">{issue} <Link href="/get-started" className="underline">Get started</Link></div>:signupMode() === "invite_only" ? <div className="rounded-lg border bg-card p-6 text-center">
          <h1 className="text-xl font-semibold">Fundlane is invite-only</h1>
          <p className="mt-2 text-muted-foreground">Use your invitation link to join your team.</p>
          <Link href="/sign-in" className="mt-4 inline-block underline">Log in</Link>
        </div> : <SignupForm1 checkoutEmail={checkoutEmail} headingAsH1={marketingPolishEnabled()} legalDraftsEnabled={legalDraftPagesEnabled()} />}
      </div>
    </div>
  )
}

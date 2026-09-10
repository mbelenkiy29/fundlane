"use client"
import { Suspense, useState } from "react"
import { useSearchParams } from "next/navigation"
import { useSignUp } from "@clerk/nextjs"
import Link from "next/link"
import { AuthShell } from "@/components/mca/auth-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useSignInFlow } from "@/components/mca/auth/use-sign-in-flow"
import { VerificationForm } from "@/components/mca/auth/verification-form"
import { checkClerk } from "@/lib/mca/auth-navigation"
export default function AcceptInvitePage() {
  return (
    <Suspense>
      <AcceptInvite />
    </Suspense>
  )
}
function AcceptInvite() {
  const params = useSearchParams()
  const ticket = params.get("__clerk_ticket")
  const status = params.get("__clerk_status")
  const flow = useSignInFlow()
  const { signUp } = useSignUp()
  const [name, setName] = useState("")
  const [password, setPassword] = useState("")
  const signup = status === "sign_up"
  return (
    <AuthShell
      title="Join your company"
      description="Accept your invitation to join your team's workspace."
    >
      {flow.error && (
        <p role="alert" className="text-destructive">
          {flow.error}
        </p>
      )}
      {status === "complete" ? (
        <Button asChild className="w-full">
          <Link href="/onboarding">Continue to your company</Link>
        </Button>
      ) : !ticket ? (
        <p>
          This invitation is missing or has expired. Ask your administrator to
          resend it.
        </p>
      ) : flow.codeSent || flow.signIn.status === "needs_second_factor" ? (
        <VerificationForm busy={flow.busy} mfa onVerify={flow.verify} />
      ) : (
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault()
            void flow.run(async () => {
              if (signup) {
                checkClerk(
                  await signUp.create({
                    strategy: "ticket",
                    ticket,
                    firstName: name,
                    password,
                  })
                )
                if (signUp.status !== "complete")
                  throw new Error(
                    "Additional account information is required. Please contact your administrator."
                  )
                checkClerk(
                  await signUp.finalize({
                    navigate: ({ decorateUrl }) => {
                      window.location.href = decorateUrl("/onboarding")
                    },
                  })
                )
              } else {
                checkClerk(await flow.signIn.ticket({ ticket }))
                await flow.finish()
              }
            })
          }}
        >
          {signup && (
            <>
              <Label className="grid gap-2">
                Your name
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </Label>
              <Label className="grid gap-2">
                Password (at least 12 characters)
                <Input
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </Label>
            </>
          )}
          <div id="clerk-captcha" />
          <Button className="w-full" disabled={flow.busy}>
            {flow.busy ? "Joining…" : "Accept invitation"}
          </Button>
        </form>
      )}
    </AuthShell>
  )
}

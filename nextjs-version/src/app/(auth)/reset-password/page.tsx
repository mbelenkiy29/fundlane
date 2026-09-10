"use client"
import { useState } from "react"
import Link from "next/link"
import { AuthShell } from "@/components/mca/auth-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useSignInFlow } from "@/components/mca/auth/use-sign-in-flow"
import { VerificationForm } from "@/components/mca/auth/verification-form"
import { checkClerk } from "@/lib/mca/auth-navigation"
export default function ResetPasswordPage() {
  const flow = useSignInFlow()
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const second =
    flow.signIn.status === "needs_second_factor" ||
    flow.signIn.status === "needs_client_trust"
  return (
    <AuthShell
      title="Choose a new password"
      description="Verify your email code, then set your new password."
    >
      {flow.error && (
        <p role="alert" className="text-destructive">
          {flow.error}
        </p>
      )}
      {!flow.signIn.id ? (
        <p>Request a new recovery code to continue.</p>
      ) : second ? (
        <VerificationForm busy={flow.busy} mfa onVerify={flow.verify} />
      ) : flow.signIn.status !== "needs_new_password" ? (
        <VerificationForm
          busy={flow.busy}
          onVerify={(code) =>
            flow.run(async () => {
              checkClerk(
                await flow.signIn.resetPasswordEmailCode.verifyCode({ code })
              )
            })
          }
          onResend={() =>
            flow.run(async () => {
              checkClerk(await flow.signIn.resetPasswordEmailCode.sendCode())
            })
          }
        />
      ) : (
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault()
            void flow.run(async () => {
              if (password !== confirm)
                throw new Error("Passwords do not match.")
              checkClerk(
                await flow.signIn.resetPasswordEmailCode.submitPassword({
                  password,
                  signOutOfOtherSessions: true,
                })
              )
              await flow.finish()
            })
          }}
        >
          <Label className="grid gap-2">
            New password
            <Input
              type="password"
              autoComplete="new-password"
              minLength={12}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </Label>
          <Label className="grid gap-2">
            Confirm password
            <Input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          </Label>
          <Button className="w-full" disabled={flow.busy}>
            Reset password
          </Button>
        </form>
      )}
      <Button asChild variant="ghost" className="mt-4 w-full">
        <Link href="/forgot-password">Request a new code</Link>
      </Button>
    </AuthShell>
  )
}

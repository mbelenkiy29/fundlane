"use client"

import * as React from "react"
import Link from "next/link"
import { useSignInFlow } from "@/components/mca/auth/use-sign-in-flow"
import { VerificationForm } from "@/components/mca/auth/verification-form"
import { AlertCircle, LoaderCircle } from "lucide-react"
import { AuthShell } from "@/components/mca/auth-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export default function SignInPage() {
  const flow = useSignInFlow()
  const [email, setEmail] = React.useState("")
  const [password, setPassword] = React.useState("")
  const loading = flow.busy,
    error = flow.error
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    await flow.password(email, password)
  }
  if (flow.codeSent)
    return (
      <AuthShell
        title="Verify your sign-in"
        description="Complete verification to continue to your workspace."
      >
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        <VerificationForm
          busy={loading}
          onVerify={flow.verify}
        />
      </AuthShell>
    )
  return (
    <AuthShell
      title="Welcome back"
      description="Sign in to continue to your brokerage workspace."
    >
      <form onSubmit={submit} className="space-y-5">
        {error && (
          <div
            role="alert"
            className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            {error}
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor="email">Work email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
        </div>
        <div className="space-y-2">
          <div className="flex justify-between gap-3">
            <Label htmlFor="password">Password</Label>
            <Link
              href="/forgot-password"
              className="text-xs font-medium text-primary hover:underline"
            >
              Forgot password?
            </Link>
          </div>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <Button className="w-full" disabled={loading}>
          {loading && <LoaderCircle className="animate-spin" />}
          {loading ? "Signing in" : "Sign in"}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="w-full"
          disabled={loading || !email}
          onClick={() => flow.sendCode(email)}
        >
          Resend email verification
        </Button>
        <p className="text-center text-xs text-muted-foreground">Existing users: <Link href="/forgot-password" className="underline">set a new password</Link> to activate your migrated account.</p>
        <p className="text-center text-xs text-muted-foreground">
          New team members join through an invitation.{" "}
          <Link href="/sign-up" className="underline">
            Create a company workspace
          </Link>
          .
        </p>
      </form>
    </AuthShell>
  )
}

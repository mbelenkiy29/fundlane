"use client"
import { useState } from "react"
import Link from "next/link"
import { useSignIn } from "@clerk/nextjs"
import { useRouter } from "next/navigation"
import { AuthShell } from "@/components/mca/auth-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { checkClerk, clerkErrorMessage } from "@/lib/mca/auth-navigation"
export default function ForgotPasswordPage() {
  const { signIn } = useSignIn()
  const router = useRouter()
  const [email, setEmail] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  return (
    <AuthShell
      title="Recover your account"
      description="We'll send a time-limited code to your work email."
    >
      <form
        className="space-y-5"
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError("")
          try {
            checkClerk(await signIn.create({ identifier: email }))
            checkClerk(await signIn.resetPasswordEmailCode.sendCode())
            router.push("/reset-password")
          } catch (e) {
            setError(clerkErrorMessage(e))
          } finally {
            setBusy(false)
          }
        }}
      >
        <Label className="grid gap-2">
          Work email
          <Input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </Label>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        <Button className="w-full" disabled={busy}>
          {busy ? "Sending code…" : "Send reset code"}
        </Button>
        <Button asChild variant="ghost" className="w-full">
          <Link href="/sign-in">Back to sign in</Link>
        </Button>
      </form>
    </AuthShell>
  )
}

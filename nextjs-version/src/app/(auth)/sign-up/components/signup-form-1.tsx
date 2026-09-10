"use client"
import { useState } from "react"
import { useSignUp, useUser } from "@clerk/nextjs"
import { checkClerk } from "@/lib/mca/auth-navigation"
import { VerificationForm } from "@/components/mca/auth/verification-form"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card"
export function SignupForm1(props: React.ComponentProps<"div">) {
  const { signUp } = useSignUp()
  const { isSignedIn } = useUser()
  const [verify, setVerify] = useState(false)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("")
  async function finish() {
    checkClerk(
      await signUp.finalize({
        navigate: ({ decorateUrl }) => {
          window.location.href = decorateUrl("/onboarding?setup=1")
        },
      })
    )
  }
  if (isSignedIn)
    return (
      <Card>
        <CardHeader>
          <CardTitle>Continue to your company</CardTitle>
          <CardDescription>
            You are already signed in. Select a company or create a new one.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild className="w-full">
            <a href="/onboarding?switch=1">Continue</a>
          </Button>
        </CardContent>
      </Card>
    )
  if (verify)
    return (
      <div {...props}>
        <Card>
          <CardHeader>
            <CardTitle>Verify your email</CardTitle>
            <CardDescription>
              Enter the code sent to your work email.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {error && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
            <VerificationForm
              busy={busy}
              onVerify={async (code) => {
                setBusy(true)
                setError("")
                try {
                  checkClerk(
                    await signUp.verifications.verifyEmailCode({ code })
                  )
                  if (signUp.status === "complete") await finish()
                  else
                    setError(
                      "Additional account information is required. Please restart sign-up."
                    )
                } catch (e) {
                  setError(
                    e instanceof Error ? e.message : "Verification failed"
                  )
                } finally {
                  setBusy(false)
                }
              }}
              onResend={async () => {
                setBusy(true)
                try {
                  checkClerk(await signUp.verifications.sendEmailCode())
                } catch (e) {
                  setError(
                    e instanceof Error ? e.message : "Could not resend code"
                  )
                } finally {
                  setBusy(false)
                }
              }}
            />
          </CardContent>
        </Card>
      </div>
    )
  return (
    <div {...props}>
      <Card>
        <CardHeader>
          <CardTitle>Create your company workspace</CardTitle>
          <CardDescription>
            Create your account, verify your email, then set up your company and
            invite employees.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div id="clerk-captcha" />
          <form
            className="space-y-4"
            onSubmit={async (e) => {
              e.preventDefault()
              setBusy(true)
              setError("")
              const f = new FormData(e.currentTarget)
              try {
                checkClerk(
                  await signUp.password({
                    emailAddress: String(f.get("email")),
                    password: String(f.get("password")),
                    firstName: String(f.get("name")),
                    unsafeMetadata: {
                      companyName: String(f.get("companyName")),
                      termsAccepted: true,
                    },
                  })
                )
                if (signUp.status === "complete") await finish()
                else {
                  checkClerk(await signUp.verifications.sendEmailCode())
                  setVerify(true)
                }
              } catch (e) {
                setError(e instanceof Error ? e.message : "Signup failed")
              } finally {
                setBusy(false)
              }
            }}
          >
            {[
              ["companyName", "Company name", "text"],
              ["name", "Your name", "text"],
              ["email", "Email", "email"],
              ["password", "Password (at least 12 characters)", "password"],
            ].map(([name, label, type]) => (
              <Label key={name} className="grid gap-2">
                {label}
                <Input
                  name={name}
                  type={type}
                  required
                  minLength={type === "password" ? 12 : 2}
                  autoComplete={
                    type === "password"
                      ? "new-password"
                      : type === "email"
                        ? "email"
                        : "off"
                  }
                />
              </Label>
            ))}
            <Label className="flex gap-2">
              <input type="checkbox" name="terms" required />I agree to the
              terms of service and privacy policy.
            </Label>
            {error && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
            <Button disabled={busy} className="w-full">
              {busy ? "Creating account…" : "Create account"}
            </Button>
            <a className="block text-sm underline" href="/sign-in">
              Already have an account? Sign in first.
            </a>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

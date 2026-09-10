"use client"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { requestJson } from "@/lib/mca/client"
export default function VerifyCompany() {
  const [message, setMessage] = useState(
      "Confirm your company email to continue SMS onboarding."
    ),
    [busy, setBusy] = useState(false),
    [done, setDone] = useState(false)
  return (
    <main className="mx-auto max-w-md space-y-5 p-8">
      <h1 className="text-2xl font-semibold">Verify company email</h1>
      <p role="status">{message}</p>
      <Button
        disabled={busy || done}
        onClick={async () => {
          setBusy(true)
          try {
            await requestJson("/api/auth/company-verification", {
              method: "POST",
              body: JSON.stringify({
                token: new URLSearchParams(window.location.search).get("token"),
              }),
            })
            setDone(true)
            setMessage("Email verified. Continue in your company workspace.")
            window.history.replaceState(null, "", "/verify-company")
          } catch (e) {
            setMessage(e instanceof Error ? e.message : "Verification failed")
          } finally {
            setBusy(false)
          }
        }}
      >
        Verify email
      </Button>
      <a className="block underline" href="/settings/connections">
        Continue to company setup
      </a>
    </main>
  )
}

"use client"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { requestJson } from "@/lib/mca/client"
import { authErrorMessage, currentAuthContinuation } from "@/lib/mca/auth-navigation"

export function GoogleButton({ disabled = false }: { disabled?: boolean }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("")
  async function signIn() {
    setBusy(true); setError("")
    try {
      const result = await requestJson<{ url: string }>("/api/auth/google", { method: "POST", body: JSON.stringify({ next: currentAuthContinuation() }) })
      window.location.assign(result.url)
    } catch (error) { setError(authErrorMessage(error)); setBusy(false) }
  }
  return <div className="space-y-2"><Button type="button" variant="outline" className="w-full" disabled={disabled || busy} onClick={signIn}>{busy ? "Connecting to Google…" : "Continue with Google"}</Button>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}</div>
}

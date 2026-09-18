"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"
import { requestJson } from "@/lib/mca/client"
import type { ApplicationSession } from "@/lib/mca/applications/contracts"
import { FunnelForm } from "./funnel-form"

export function PublicApplication({ token, formId, provider }: { token: string; formId: string; provider?: string }) {
  const [started, setStarted] = React.useState(false)
  const [session, setSession] = React.useState<ApplicationSession | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")
  const native = provider === "fundlane"
  React.useEffect(() => {
    void requestJson("/api/applications/track", { method: "POST", body: JSON.stringify({ token, kind: "opened" }) }).catch(() => undefined)
    if (!native) return
    void requestJson<ApplicationSession>(`/api/applications/session?token=${encodeURIComponent(token)}`).then(async current => {
      if (current.submitted) { setSession(current); setStarted(true); return }
      if (current.step !== "welcome") { setSession(current); setStarted(true) }
      else setSession(current)
    }).catch(() => undefined)
  }, [token, native])
  async function start() {
    setBusy(true); setError("")
    try {
      await requestJson("/api/applications/track", { method: "POST", body: JSON.stringify({ token, kind: "started" }) })
      if (native) {
        const current = session ?? await requestJson<ApplicationSession>(`/api/applications/session?token=${encodeURIComponent(token)}`)
        const next = current.step === "welcome"
          ? await requestJson<ApplicationSession>("/api/applications/session", { method: "PATCH", body: JSON.stringify({ token, step: "legalName", answers: current.answers }) })
          : current
        setSession(next)
      }
      setStarted(true)
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The application could not open. Try again.") }
    finally { setBusy(false) }
  }
  if (native && session?.submitted) return <FunnelForm token={token} initial={session} />
  if (!started) return <div className="p-8 sm:p-12">
    <h2 className="text-xl font-semibold">{session?.branding.welcomeTitle ?? "Ready when you are"}</h2>
    <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted-foreground">{session?.branding.welcomeBody ?? "Have your business details and recent bank statements handy. Your representative will receive your application when you submit it."}</p>
    {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
    <Button className="mt-6" onClick={() => void start()} disabled={busy}>{busy ? "Opening…" : "Start application"}</Button>
  </div>
  if (native && session) return <FunnelForm token={token} initial={session} />
  return <iframe title="Business funding application" referrerPolicy="no-referrer" src={`https://form.jotform.com/${encodeURIComponent(formId)}?mca_invite=${encodeURIComponent(token)}`} className="min-h-[820px] w-full" allow="geolocation 'none'; camera 'none'; microphone 'none'" />
}

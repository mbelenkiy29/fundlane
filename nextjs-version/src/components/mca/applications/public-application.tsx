"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"
import { requestJson } from "@/lib/mca/client"

export function PublicApplication({ token, formId }: { token: string; formId: string }) {
  const [started, setStarted] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")
  React.useEffect(() => {
    void requestJson("/api/applications/track", { method: "POST", body: JSON.stringify({ token, kind: "opened" }) }).catch(() => undefined)
  }, [token])
  async function start() {
    setBusy(true); setError("")
    try {
      await requestJson("/api/applications/track", { method: "POST", body: JSON.stringify({ token, kind: "started" }) })
      setStarted(true)
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The application could not open. Try again.") }
    finally { setBusy(false) }
  }
  return <div>
    {!started ? <div className="p-8 sm:p-12"><h2 className="text-xl font-semibold">Ready when you are</h2><p className="mt-3 max-w-lg text-sm leading-relaxed text-muted-foreground">Have your business details and recent bank statements handy. Your representative will receive your application when you submit it.</p>{error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}<Button className="mt-6" onClick={() => void start()} disabled={busy}>{busy ? "Opening…" : "Start application"}</Button></div>
      : <iframe title="Business funding application" referrerPolicy="no-referrer" src={`https://form.jotform.com/${encodeURIComponent(formId)}?mca_invite=${encodeURIComponent(token)}`} className="min-h-[820px] w-full" allow="geolocation 'none'; camera 'none'; microphone 'none'" />}
  </div>
}

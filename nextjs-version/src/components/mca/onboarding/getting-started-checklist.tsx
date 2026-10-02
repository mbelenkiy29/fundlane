"use client"
import * as React from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { SetupChecklist } from "@/components/mca/setup/setup-checklist"
import type { WorkspaceSetup } from "@/lib/mca/setup/contracts"
import { requestJson } from "@/lib/mca/client"

/** Mount only reads facts. Every send, purchase and synthetic submission stays on its existing explicit-action page. */
export function GettingStartedChecklist({ initialSetup, resumable = true }: { initialSetup?: WorkspaceSetup; resumable?: boolean }) {
  const [setup, setSetup] = React.useState(initialSetup), [busy, setBusy] = React.useState(false), [error, setError] = React.useState("")
  React.useEffect(() => { if (!initialSetup) void requestJson<WorkspaceSetup>("/api/mca/setup?progressive=1").then(setSetup).catch(() => setError("Setup facts could not be loaded.")) }, [initialSetup])
  async function dismiss(dismissed: boolean) {
    setBusy(true); setError("")
    try { setSetup(await requestJson<WorkspaceSetup>("/api/mca/setup", { method: "POST", body: JSON.stringify({ dismissed, progressive: true }) })) } catch { setError("The checklist could not be updated.") } finally { setBusy(false) }
  }
  if (!setup) return <p role="status">{error || "Loading getting started…"}</p>
  if (setup.dismissed && !resumable) return <Link className="text-sm underline" href="/getting-started">Resume getting started</Link>
  return <div className="space-y-4">{error && <p role="alert">{error}</p>}{setup.dismissed ? <div><p>You hid this optional checklist. Your CRM remains available.</p><Button disabled={busy} onClick={() => void dismiss(false)}>Resume checklist</Button></div> : <SetupChecklist setup={setup} dismissing={busy} onDismiss={() => void dismiss(true)} />}<p className="text-sm text-muted-foreground">Business details, teammates, additional seats, and setup tests are optional. Open <Link href="/dashboard" className="underline">your CRM</Link> at any time.</p></div>
}

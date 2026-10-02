"use client"

import * as React from "react"
import Link from "next/link"
import { Check, Circle, ListChecks, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { SETUP_COPY, type WorkspaceSetup } from "@/lib/mca/setup/contracts"

export function SetupChecklist({
  setup,
  dismissing,
  onDismiss,
}: {
  setup: WorkspaceSetup
  dismissing?: boolean
  onDismiss: () => void
}) {
  if (setup.dismissed) return <Link href="/getting-started" className="text-sm underline">Resume getting started</Link>
  if (setup.readiness) return <ReadinessChecklist setup={setup} dismissing={dismissing} onDismiss={onDismiss} />
  const progress = setup.totalCount ? Math.round((setup.completedCount / setup.totalCount) * 100) : 0

  return (
    <Card data-testid="mca-setup-checklist">
      <CardHeader className="border-b">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2">
              <ListChecks className="size-5" />
              {setup.allComplete ? SETUP_COPY.completeTitle : SETUP_COPY.title}
            </CardTitle>
            <CardDescription>
              {setup.allComplete ? SETUP_COPY.completeDescription : SETUP_COPY.description}
            </CardDescription>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={dismissing}
            onClick={onDismiss}
            aria-label={SETUP_COPY.dismissAria}
          >
            <X />
            {SETUP_COPY.dismiss}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">{SETUP_COPY.progress(setup.completedCount, setup.totalCount)}</p>
          <Progress value={progress} aria-label={SETUP_COPY.progress(setup.completedCount, setup.totalCount)} />
        </div>
        <ol className="space-y-2">
          {setup.steps.map((item) => (
            <li key={item.id} className="flex items-start gap-3 rounded-lg border p-3">
              {item.complete ? (
                <Check className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />
              ) : (
                <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              )}
              <div className="min-w-0 flex-1">
                <p className={`text-sm font-medium ${item.complete ? "text-muted-foreground line-through" : ""}`}>
                  {item.title}
                </p>
                <p className="text-xs text-muted-foreground">{item.description}</p>
              </div>
              {!item.complete ? (
                <Button asChild variant="outline" size="sm">
                  <Link href={item.href}>{item.actionLabel}</Link>
                </Button>
              ) : null}
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  )
}

function ReadinessChecklist({ setup, dismissing, onDismiss }: { setup: WorkspaceSetup; dismissing?: boolean; onDismiss: () => void }) {
  const [copyState, setCopyState] = React.useState("")
  const items = setup.readiness ?? []
  const tested = items.filter((item) => item.phase === "tested" || item.phase === "live_ready").length
  const copyDiagnostics = async () => {
    try {
      const response = await fetch("/api/mca/setup/diagnostics", { cache: "no-store" })
      if (!response.ok) throw new Error()
      const bundle = await response.json()
      await navigator.clipboard.writeText(JSON.stringify(bundle, null, 2))
      setCopyState("Diagnostic bundle copied.")
    } catch {
      setCopyState("Could not copy diagnostics. Download the bundle instead.")
    }
  }
  return <Card data-testid="mca-setup-readiness">
    <CardHeader className="border-b">
      <div className="flex items-start justify-between gap-3">
        <div><CardTitle className="flex items-center gap-2"><ListChecks className="size-5" />Workspace setup</CardTitle>
          <CardDescription>Optional setup. Saved details and provider acceptance are configured. Inbox receipt is customer-confirmed; sandbox testing does not prove live lender delivery. {tested} of {items.length} steps tested or live ready.</CardDescription></div>
        <Button type="button" variant="ghost" size="sm" disabled={dismissing} onClick={onDismiss} aria-label={SETUP_COPY.dismissAria}><X />Hide checklist</Button>
      </div>
    </CardHeader>
    <CardContent className="space-y-4">
      <ol className="space-y-3">
        {items.map((item) => <li key={item.id} className="rounded-lg border p-3 space-y-2">
          <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="font-medium text-sm">{item.title}</p>
            <p className="text-xs text-muted-foreground">{item.detail}</p></div>
            <span className="shrink-0 rounded border px-2 py-1 text-xs capitalize">{item.phase.replace("_", " ")}</span></div>
          <div className="flex flex-wrap gap-3 text-sm"><Link className="underline" href={item.href}>{item.action}</Link>
            <Link className="underline" href={item.helpHref}>How to do this</Link></div>
        </li>)}
      </ol>
      {setup.canDownloadDiagnostics ? <div className="flex flex-wrap items-center gap-3 border-t pt-3 text-sm">
        <a className="underline" href="/api/mca/setup/diagnostics" download="workspace-setup-diagnostics.json">Download sanitized diagnostics</a>
        <Button type="button" size="sm" variant="outline" onClick={() => void copyDiagnostics()}>Copy diagnostics</Button>
        <span role="status">{copyState}</span>
      </div> : null}
    </CardContent>
  </Card>
}

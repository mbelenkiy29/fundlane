"use client"

import * as React from "react"
import Link from "next/link"
import { ArrowUpRight, CheckCircle2, Circle, FileInput, Loader2, RefreshCw, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { IntakeListItem } from "@/lib/mca/intake/service"
import type { IntakeProgress, IntakeStageState } from "@/lib/mca/intake/processing-contracts"
import { IntakeConnections } from "./intake-connections"

export async function intakeRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "content-type": "application/json", ...init?.headers }, cache: "no-store" })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error?.message ?? "Could not load applications. Please retry.")
  return body as T
}
export const providerNames: Record<string, string> = { jotform: "Jotform", highlevel: "GoHighLevel", zoho: "Zoho", custom: "Custom form", fillout: "Fillout", docuseal: "DocuSeal", email: "Email" }
const stateNames: Record<IntakeProgress["state"], string> = { queued: "Queued", running: "Processing", needs_attention: "Needs attention", ready_for_review: "Ready for review", no_matches: "No matching funders", failed: "Processing failed", paused: "Paused" }
const steps = [{ key: "deal", label: "Deal created" }, { key: "documents", label: "Documents secured" }, { key: "underwriting", label: "Statements analyzed" }, { key: "matches", label: "Funders matched" }] as const
function StageIcon({ state }: { state: IntakeStageState }) {
  if (state === "complete") return <CheckCircle2 className="size-4 text-primary" />
  if (state === "running") return <Loader2 className="size-4 motion-safe:animate-spin" />
  if (state === "blocked" || state === "failed") return <TriangleAlert className="size-4 text-amber-600 dark:text-amber-400" />
  return <Circle className="size-4 text-muted-foreground/50" />
}
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })

export function IntakeWorkspace({ canManage }: { canManage: boolean }) {
  const [tab, setTab] = React.useState("applications")
  const [items, setItems] = React.useState<IntakeListItem[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState("")
  const [busy, setBusy] = React.useState("")
  const [filter, setFilter] = React.useState("all")
  const load = React.useCallback(async () => {
    try { const result = await intakeRequest<{ intakes: IntakeListItem[] }>("/api/mca/intake"); setItems(result.intakes); setError("") }
    catch (e) { setError(e instanceof Error ? e.message : "Applications could not be loaded.") }
    finally { setLoading(false) }
  }, [])
  React.useEffect(() => {
    void load()
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load() }, 5000)
    return () => clearInterval(timer)
  }, [load])
  async function retry(item: IntakeListItem) {
    setBusy(item.intakeId)
    try { await intakeRequest(`/api/mca/intake/${item.intakeId}/process`, { method: "POST" }); await load() }
    catch (e) { setError(e instanceof Error ? e.message : "Retry failed.") }
    finally { setBusy("") }
  }
  const visible = items.filter(item => filter === "all" || (filter === "ready" ? item.progress?.state === "ready_for_review" : ["needs_attention", "failed", "no_matches"].includes(item.progress?.state ?? "") || item.state === "error"))
  return <div className="mx-auto w-full max-w-6xl space-y-7 p-4 md:p-6">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><h1 className="text-2xl font-semibold tracking-tight">Application Intake</h1><p className="mt-2 max-w-2xl text-sm text-muted-foreground">From a submitted application to a deal your team can review. Follow every document, analysis, and funder match here.</p></div>
      {canManage && <Button onClick={() => setTab("connections")}><FileInput className="size-4" />Manage connections</Button>}
    </header>
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList><TabsTrigger value="applications">Applications</TabsTrigger>{canManage && <TabsTrigger value="connections">Connections</TabsTrigger>}</TabsList>
      <TabsContent value="applications" className="mt-6 space-y-4">
        <div className="flex items-center justify-between gap-3"><label className="flex items-center gap-2 text-sm">Show<select aria-label="Filter applications" value={filter} onChange={e => setFilter(e.target.value)} className="h-9 rounded-md border bg-background px-3"><option value="all">All applications</option><option value="ready">Ready for review</option><option value="attention">Needs attention</option></select></label><Button variant="ghost" size="sm" onClick={() => void load()}><RefreshCw className="size-4" />Refresh</Button></div>
        {error && <p role="alert" className="rounded-md border border-destructive/30 p-3 text-sm text-destructive">{error}</p>}
        {loading ? <div role="status" className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading applications…</div>
          : visible.length === 0 ? <div className="rounded-xl border border-dashed px-6 py-20 text-center"><FileInput className="mx-auto mb-4 size-9 text-primary" /><h2 className="text-lg font-medium">{items.length ? "No applications in this view" : "Your next application starts here"}</h2><p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">{items.length ? "Choose another filter to see your incoming applications." : canManage ? "Connect an application form to create assigned deals and prepare their documents and funder matches." : "Applications assigned to you will appear here when your team’s forms receive a submission."}</p>{canManage && !items.length && <Button className="mt-5" onClick={() => setTab("connections")}>Connect an application form</Button>}</div>
          : <div className="divide-y overflow-hidden rounded-xl border bg-card">{visible.map(item => {
            const progress = item.progress
            return <article key={item.intakeId} className="p-5 md:p-6">
              <div className="flex flex-wrap items-start justify-between gap-4"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h2 className="break-words text-base font-semibold">{item.merchantName}</h2><Badge variant={progress?.state === "ready_for_review" ? "default" : "secondary"}>{progress ? stateNames[progress.state] : item.state === "error" ? "Needs review" : item.automaticProcessing ? "Awaiting processing" : "Manual processing"}</Badge></div><p className="mt-1 text-sm text-muted-foreground">{providerNames[item.provider] ?? item.provider} · <time dateTime={item.receivedAt}>{new Date(item.receivedAt).toLocaleString()}</time></p></div><div className="text-right"><p className="text-xs text-muted-foreground">Requested</p><p className="text-lg font-semibold tabular-nums">{item.requestedAmount == null ? "Not provided" : money.format(item.requestedAmount)}</p></div></div>
              <p className="mt-3 text-sm"><span className="text-muted-foreground">Assigned to </span>{item.assignedReps.length ? item.assignedReps.join(", ") : "Unassigned — administrator review needed"}</p>
              <ol aria-label="Application progress" className="my-5 grid grid-cols-2 gap-3 lg:grid-cols-4">{steps.map(step => {
                const status = progress?.stages[step.key] ?? { state: step.key === "deal" && item.dealId ? "complete" : "waiting" }
                return <li key={step.key} className="flex items-center gap-2 text-xs"><StageIcon state={status.state as IntakeStageState} /><span>{step.label}<span className="sr-only">: {status.state}</span></span></li>
              })}</ol>
              {(progress?.message || item.errorMessage) && <p className="max-w-3xl text-sm text-muted-foreground">{progress?.message ?? item.errorMessage}</p>}
              {!progress && item.warnings.length > 0 && <p className="text-sm text-muted-foreground">{item.warnings.join(" ")}</p>}
              <div className="mt-4 flex flex-wrap items-center gap-3">{item.dealId && <Button variant="outline" size="sm" asChild><Link href={`/deals?deal=${encodeURIComponent(item.dealId)}`}>Open deal<ArrowUpRight className="size-4" /></Link></Button>}{item.canRetry && !["queued", "running"].includes(progress?.state ?? "") && <Button variant="ghost" size="sm" disabled={busy === item.intakeId} onClick={() => void retry(item)}>{busy === item.intakeId ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}Retry processing</Button>}{progress?.matchedCount != null && <span className="text-xs text-muted-foreground">{progress.matchedCount} eligible funder{progress.matchedCount === 1 ? "" : "s"} · Rep approval required to send</span>}</div>
            </article>
          })}</div>}
      </TabsContent>
      {canManage && <TabsContent value="connections" className="mt-6"><IntakeConnections /></TabsContent>}
    </Tabs>
  </div>
}

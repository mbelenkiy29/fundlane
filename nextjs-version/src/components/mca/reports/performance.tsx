"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { requestJson } from "@/lib/mca/client"
import type { MembershipSummary } from "@/lib/mca/types"
import type { PerformanceMoney, PerformanceReport } from "@/lib/mca/reports/performance-contracts"
import { explainedReportValue } from "./report-ui"

const STAGE_LABELS = { created: "Created deals (lead intake)", submitted: "Submitted deals", approved: "Offered/approved evidence", funded: "Funded deals" }
const FINANCE_LABELS = { fundedVolume: "Committed funded volume", reversedFunding: "Reversed funding evidence", estimatedCommission: "Recorded selected-offer estimate", recordedFundingCommission: "Recorded funding commission", collectedCommission: "Collected company commission", paidBrokerCommission: "Paid broker commission" }
const cents = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value / 100)
function moneyLabel(metric: PerformanceMoney): string {
  if (!metric.visible) return "Restricted"
  return `${cents(metric.knownCents)}${metric.unknownCount ? ` known + ${metric.unknownCount} unknown` : ""}`
}

export function PerformanceReportView({ report }: { report: PerformanceReport }) {
  return <div className="space-y-4">
    <p className="text-sm text-muted-foreground">Snapshot {report.generatedAt} · {report.filters.basis} basis · {report.timezone} · {report.filters.from ?? "Start"} through {report.filters.to ?? "Open end"}. {report.period.label} Cohort outcomes and current financial totals can change as records arrive or are corrected.</p>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {Object.entries(report.stages).map(([key, metric]) => <div key={key} className="rounded-lg border p-3"><p className="text-sm text-muted-foreground">{STAGE_LABELS[key as keyof typeof STAGE_LABELS]}</p><p className="text-2xl font-semibold">{metric.dealCount}</p></div>)}
    </div>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {Object.entries(report.finance).map(([key, metric]) => <div key={key} className="rounded-lg border p-3"><p className="text-sm text-muted-foreground">{FINANCE_LABELS[key as keyof typeof FINANCE_LABELS]}</p><p className="text-lg font-semibold">{explainedReportValue(moneyLabel(metric))}</p>{metric.visible && <p className="text-xs text-muted-foreground">{metric.count} records{metric.unknownCount ? " · incomplete" : ""}</p>}</div>)}
    </div>
    <div className="grid gap-4 md:grid-cols-2">
      <div><h3 className="font-medium">{report.filters.basis === "cohort" ? "Cohort conversion" : "Period activity ratios"}</h3><ul className="mt-2 space-y-1 text-sm">{report.conversions.map((row) => <li key={`${row.from}-${row.to}`}>{row.from} → {row.to}: {explainedReportValue(row.rate === null ? "N/A" : `${(row.rate * 100).toFixed(1)}%`)} ({row.numerator}/{row.denominator})</li>)}</ul></div>
      <div><h3 className="font-medium">Recorded renewals</h3><p className="mt-2 text-sm">{report.renewals.eligibleAdvanceCount} source advances with recorded eligibility · {report.renewals.convertedAdvanceCount} converted with a linked deal.</p></div>
    </div>
    <div><h3 className="font-medium">Current pipeline for created-deal cohort</h3>{report.pipeline.deals.length === 0 ? <p className="text-sm text-muted-foreground">No deals created in this window.</p> : <div className="mt-2 flex flex-wrap gap-2">{Object.entries(report.pipeline.counts).map(([status, count]) => <span key={status} className="rounded-md border px-2 py-1 text-sm">{status.replaceAll("_", " ")}: {count}</span>)}</div>}</div>
    <details className="rounded-lg border p-3"><summary className="cursor-pointer font-medium">Definitions and attribution</summary><dl className="mt-3 space-y-3 text-sm">{Object.entries(report.definitions).map(([key, definition]) => <div key={key}><dt className="font-medium">{key}</dt><dd className="text-muted-foreground">{definition}</dd></div>)}</dl></details>
    <details className="rounded-lg border p-3"><summary className="cursor-pointer font-medium">Reconcile unique deals and financial records</summary><div className="mt-3 space-y-4 text-sm">
      {Object.entries(report.stages).map(([key, metric]) => <div key={key}><h4 className="font-medium">{STAGE_LABELS[key as keyof typeof STAGE_LABELS]} ({metric.dealCount})</h4><ul className="mt-1 space-y-1">{metric.deals.map((row) => <li key={row.dealId}><a href={`/deals/${encodeURIComponent(row.dealId)}`} className="underline">{row.displayId} · {row.legalName}</a> · {row.occurredOn ?? "Date unknown"}{row.shared ? " · shared attribution" : ""}</li>)}</ul></div>)}
      {Object.entries(report.finance).filter(([, metric]) => metric.visible).map(([key, metric]) => metric.visible && <div key={key}><h4 className="font-medium">{FINANCE_LABELS[key as keyof typeof FINANCE_LABELS]}</h4><ul className="mt-1 space-y-1">{metric.records.map((row) => <li key={row.recordId} className="break-all">{row.recordId} · {row.dealId} · {row.occurredOn ?? "Date unknown"} · {row.amountCents === null ? "Unknown" : cents(row.amountCents)}</li>)}</ul></div>)}
    </div></details>
  </div>
}

export function PerformanceReportPanel() {
  const [from, setFrom] = React.useState("")
  const [to, setTo] = React.useState("")
  const [basis, setBasis] = React.useState<"event" | "cohort">("cohort")
  const [brokerIds, setBrokerIds] = React.useState<string[]>([])
  const [members, setMembers] = React.useState<MembershipSummary[]>([])
  const [snapshot, setSnapshot] = React.useState<{ report: PerformanceReport; csvSnapshot: string }>()
  const [status, setStatus] = React.useState<"loading" | "ready" | "error">("loading")
  const [message, setMessage] = React.useState("")
  const requestId = React.useRef(0)
  const load = React.useCallback(async (query: URLSearchParams) => {
    const id = ++requestId.current
    setStatus("loading")
    setMessage("")
    try {
      const next = await requestJson<{ report: PerformanceReport; csvSnapshot: string }>(`/api/mca/reports/performance?${query}`)
      if (id !== requestId.current) return
      setSnapshot(next)
      setStatus("ready")
    } catch (error) {
      if (id !== requestId.current) return
      setStatus("error")
      setMessage(error instanceof Error ? error.message : "The report could not be loaded.")
    }
  }, [])
  React.useEffect(() => {
    void load(new URLSearchParams({ basis: "cohort" }))
    void requestJson<{ memberships: MembershipSummary[] }>("/api/memberships").then((result) => setMembers(result.memberships.filter((row) => row.status !== "pending"))).catch(() => {})
    return () => { requestId.current += 1 }
  }, [load])
  function apply(event: React.FormEvent) {
    event.preventDefault()
    const query = new URLSearchParams({ basis })
    if (from) query.set("from", from)
    if (to) query.set("to", to)
    for (const id of brokerIds) query.append("membershipIds", id)
    void load(query)
  }
  function download() {
    if (!snapshot || status !== "ready") return
    const url = URL.createObjectURL(new Blob([snapshot.csvSnapshot], { type: "text/csv;charset=utf-8" }))
    const link = document.createElement("a")
    link.href = url
    link.download = "fundlane-performance.csv"
    link.click()
    URL.revokeObjectURL(url)
  }
  return <Card className="min-w-0 overflow-hidden"><CardHeader><CardTitle>Broker and company performance</CardTitle><CardDescription>Unique deals, committed funding and recorded commissions with explicit date and attribution definitions.</CardDescription></CardHeader><CardContent className="space-y-4">
    <form onSubmit={apply} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div className="space-y-1"><Label htmlFor="performance-from">From (workspace date)</Label><Input id="performance-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></div>
      <div className="space-y-1"><Label htmlFor="performance-to">To (inclusive)</Label><Input id="performance-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} /></div>
      <div className="space-y-1"><Label htmlFor="performance-basis">Date basis</Label><select id="performance-basis" className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={basis} onChange={(event) => setBasis(event.target.value as "event" | "cohort")}><option value="cohort">Created-deal cohort</option><option value="event">Event activity</option></select></div>
      <div className="flex items-end gap-2"><Button type="submit" disabled={status === "loading"}>Apply filters</Button><Button type="button" variant="outline" disabled={status !== "ready"} onClick={download}>Export snapshot CSV</Button></div>
      {members.length > 0 && <fieldset className="space-y-2 sm:col-span-2 lg:col-span-4"><legend className="text-sm font-medium">Brokers (current assigned memberships; no selection means all)</legend><div className="flex flex-wrap gap-3">{members.map((member) => <label key={member.id} className="flex items-center gap-2 text-sm"><Checkbox checked={brokerIds.includes(member.id)} onCheckedChange={(checked) => setBrokerIds((current) => checked === true ? [...new Set([...current, member.id])] : current.filter((id) => id !== member.id))} />{member.name}{member.status !== "active" ? ` (${member.status})` : ""}</label>)}</div></fieldset>}
    </form>
    {status === "loading" && <p role="status" className="text-sm text-muted-foreground">Loading performance snapshot…</p>}
    {status === "error" && <p role="alert" className="text-sm text-destructive">{message} Adjust the filters and apply again.</p>}
    {status === "ready" && snapshot && <PerformanceReportView report={snapshot.report} />}
  </CardContent></Card>
}

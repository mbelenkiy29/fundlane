"use client"

import * as React from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { requestJson } from "@/lib/mca/client"
import { OUTREACH_METRICS, type OutreachMetric, type OutreachReport } from "@/lib/mca/applications/contracts"

const labels: Record<OutreachMetric, string> = { created: "Invitations", emailed: "Emailed", opened: "Opened", started: "Started", received: "Applications received", incomplete: "Opened, not submitted", submitted: "Sent to funders", approved: "Approved", funded: "Funded" }
const money = (cents: number | null) => cents == null ? "Restricted" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100)
const percent = (rate: number | null) => rate == null ? "—" : new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 }).format(rate)
const cell = "px-3 py-3 text-right tabular-nums"
function progress(stages: OutreachMetric[]): string {
  for (const stage of ["funded", "approved", "submitted", "received"] as const) if (stages.includes(stage)) return labels[stage]
  if (stages.includes("started")) return "Started, not submitted"
  if (stages.includes("opened")) return "Opened, not submitted"
  return "Awaiting client"
}

export function ApplicationOutreachReport() {
  const [report, setReport] = React.useState<OutreachReport | null>(null)
  const [error, setError] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [filters, setFilters] = React.useState({ from: "", to: "", membershipId: "" })
  const [selected, setSelected] = React.useState<OutreachMetric>("created")
  const requestId = React.useRef(0)
  const load = React.useCallback(async (query = "") => {
    const version = ++requestId.current
    setBusy(true); setError("")
    try {
      const result = await requestJson<OutreachReport>(`/api/mca/reports/application-outreach${query ? `?${query}` : ""}`)
      if (version !== requestId.current) return
      setReport(result)
      const search = new URLSearchParams(query)
      setFilters({ from: result.period.from, to: result.period.to, membershipId: search.get("membershipId") ?? "" })
    } catch (reason) { if (version === requestId.current) { setReport(null); setError(reason instanceof Error ? reason.message : "Could not load outreach reporting. Try again.") } }
    finally { if (version === requestId.current) setBusy(false) }
  }, [])
  React.useEffect(() => { void load() }, [load])
  return <section id="mca-reports-application-outreach" className="overflow-hidden rounded-xl border bg-card" aria-labelledby="outreach-title">
    <div className="border-b p-5"><h2 id="outreach-title" className="text-lg font-semibold">Application outreach</h2><p className="mt-1 max-w-3xl text-sm text-muted-foreground">From first contact to funding. Credit stays with the original sender, even when the deal changes hands.</p>
      <form className="mt-5 flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); void load(new URLSearchParams(filters).toString()) }}>
        <div className="space-y-2"><Label htmlFor="outreach-from">Invited from</Label><Input id="outreach-from" type="date" value={filters.from} onChange={event => setFilters({ ...filters, from: event.target.value })} /></div>
        <div className="space-y-2"><Label htmlFor="outreach-to">Invited through</Label><Input id="outreach-to" type="date" value={filters.to} onChange={event => setFilters({ ...filters, to: event.target.value })} /></div>
        <div className="min-w-48 space-y-2"><Label htmlFor="outreach-employee">Original sender</Label><select id="outreach-employee" className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={filters.membershipId} onChange={event => setFilters({ ...filters, membershipId: event.target.value })}><option value="">All employees</option>{report?.employees.map(employee => <option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></div>
        <Button disabled={busy} type="submit">{busy ? "Loading…" : "Apply filters"}</Button>
      </form>
      {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
    </div>
    {busy && <p role="status" className="p-5 text-sm text-muted-foreground">Loading outreach report…</p>}
    {!busy && report && <>
      <div className="p-5 pb-2 text-xs text-muted-foreground">Invitations created {report.period.from} through {report.period.to} ({report.period.timezone}). Outcomes through {new Date(report.period.asOf).toLocaleString()}; this cohort can still progress.</div>
      <div className="overflow-x-auto p-2"><table className="w-full whitespace-nowrap text-sm"><caption className="sr-only">Employee outreach, application completion, and funding outcomes</caption><thead><tr className="border-b text-xs text-muted-foreground"><th scope="col" className="px-3 py-3 text-left">Original sender</th>{OUTREACH_METRICS.map(metric => <th scope="col" key={metric} className={cell}>{labels[metric]}</th>)}<th scope="col" className={cell}>Funded amount</th></tr></thead><tbody>{[report.totals, ...report.reps].map(row => <tr key={row.membershipId ?? "total"} className={`border-b last:border-0 ${row.membershipId ? "" : "bg-muted/40 font-semibold"}`}><th scope="row" className="px-3 py-3 text-left font-medium">{row.name}</th>{OUTREACH_METRICS.map(metric => <td key={metric} className={cell}>{row.counts[metric]}</td>)}<td className={cell}>{money(row.fundedAmountCents)}{row.unknownFundedAmountCount > 0 && <span className="ml-1 text-xs font-normal text-muted-foreground">+ {row.unknownFundedAmountCount} unknown</span>}</td></tr>)}</tbody></table></div>
      <div className="grid gap-4 border-y bg-muted/20 p-5 sm:grid-cols-3">{[["Emailed → opened", report.totals.conversions.emailedToOpened], ["Opened → application received", report.totals.conversions.openedToReceived], ["Application received → funded", report.totals.conversions.receivedToFunded]].map(([label, value]) => <div key={String(label)}><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-xl font-semibold tabular-nums">{percent(value as number | null)}</p></div>)}</div>
      <div className="p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h3 className="font-semibold">Client detail</h3><select className="h-9 max-w-full rounded-md border bg-background px-3 text-sm" aria-label="Filter client detail by metric" value={selected} onChange={event => setSelected(event.target.value as OutreachMetric)}>{OUTREACH_METRICS.map(metric => <option value={metric} key={metric}>{labels[metric]} ({report.totals.counts[metric]})</option>)}</select></div>
        {!report.invitations.some(row => row.stages.includes(selected)) ? <p className="py-6 text-sm text-muted-foreground">No clients match this stage and invitation period.</p> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b text-left text-xs text-muted-foreground"><th className="py-2 pr-4">Client</th><th className="py-2 pr-4">Original sender</th><th className="py-2 pr-4">Outreach</th><th className="py-2 pr-4">Progress</th><th className="py-2">Deal</th></tr></thead><tbody>{report.invitations.filter(row => row.stages.includes(selected)).map(row => <tr className="border-b last:border-0" key={row.id}><td className="py-3 pr-4"><p className="font-medium">{row.clientName}</p><p className="text-xs text-muted-foreground">{row.email}</p></td><td className="py-3 pr-4">{row.employeeName}</td><td className="py-3 pr-4">{row.sentAt ? "Email accepted" : row.copiedAt ? "Link copied; no email recorded" : "No email recorded"}</td><td className="py-3 pr-4">{progress(row.stages)}</td><td className="py-3">{row.dealId ? <Link className="text-primary underline underline-offset-4" href={`/deals?deal=${encodeURIComponent(row.dealId)}`}>View deal</Link> : "—"}</td></tr>)}</tbody></table></div>}
        <p className="mt-5 max-w-3xl text-xs leading-relaxed text-muted-foreground">Opens are observed visits and may include automated scanners. Started means “Start application” was clicked. Incomplete means opened without a submission. Resends do not increase invitation counts. Conversion rates use clients present in both stages; no denominator displays as —.</p>
      </div>
    </>}
  </section>
}

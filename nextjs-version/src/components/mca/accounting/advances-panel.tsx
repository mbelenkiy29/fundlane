"use client"

import * as React from "react"
import { AlertCircle, Loader2, RefreshCw } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { requestJson } from "@/lib/mca/client"
import type { AdvancePerformanceStatus, AdvanceSummary } from "@/lib/mca/accounting/contracts"
import { formatCents, formatMcaDate } from "./format"
import type { SessionResponse } from "@/lib/mca/types"

export function AdvancesPanel() {
  const [advances, setAdvances] = React.useState<AdvanceSummary[]>([])
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState<string>()
  const [error, setError] = React.useState("")
  const [notice, setNotice] = React.useState("")
  const [reasons, setReasons] = React.useState<Record<string, string>>({})
  const [canCorrect, setCanCorrect] = React.useState(false)
  const load = React.useCallback(async () => {
    setLoading(true); setError("")
    try { const [data, session] = await Promise.all([requestJson<{ advances: AdvanceSummary[] }>("/api/mca/advances"), requestJson<SessionResponse>("/api/auth/session")]); setAdvances(data.advances); setCanCorrect(session.membership?.role === "admin" || session.membership?.role === "super_admin") }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Advances could not be loaded.") }
    finally { setLoading(false) }
  }, [])
  React.useEffect(() => { void load() }, [load])
  async function changeStatus(advance: AdvanceSummary, status: AdvancePerformanceStatus) {
    const reason = reasons[advance.id]?.trim()
    if (!reason) { setError("Enter a reason before changing advance performance."); return }
    setBusy(advance.id); setError(""); setNotice("")
    try {
      await requestJson(`/api/mca/advances/${advance.id}`, { method: "PATCH", body: JSON.stringify({ status, reason }) })
      setNotice(`Advance ${advance.id.slice(0, 8)} is now ${status.replace(/_/g, " ")}. No collection was created.`)
      await load()
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Status could not be saved.") }
    finally { setBusy(undefined) }
  }
  return <Card>
    <CardHeader className="flex-row items-start justify-between"><div><CardTitle>Advances</CardTitle><CardDescription>Funding history and scheduled estimates. Estimates are not verified collections.</CardDescription></div><Button variant="outline" size="sm" onClick={() => void load()}><RefreshCw className="size-4" />Refresh</Button></CardHeader>
    <CardContent className="space-y-4">
      {error && <p role="alert" className="flex items-center gap-2 text-sm text-destructive"><AlertCircle className="size-4" />{error}</p>}
      {notice && <p role="status" className="text-sm text-emerald-700">{notice}</p>}
      {loading ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading advances…</p>
        : advances.length === 0 ? <p className="text-sm text-muted-foreground">No funded advances are available.</p>
        : <div className="space-y-3">{advances.map((advance) => <div key={advance.id} className="rounded-lg border p-4">
          <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="font-medium">{advance.businessName}</p><p className="text-sm text-muted-foreground">{advance.funderName} · Funded {formatMcaDate(advance.fundedAt)} · Advance {advance.id.slice(0, 8)}</p></div><Badge variant="outline">{advance.performanceStatus.replace(/_/g, " ")}</Badge></div>
          <div className="mt-3 grid gap-2 text-sm sm:grid-cols-3"><p>Principal <strong>{formatCents(advance.principalCents)}</strong></p><p>Payback <strong>{formatCents(advance.paybackCents)}</strong></p><p>Scheduled paid in <strong>{formatCents(advance.scheduledPaidInCents)}</strong>{advance.scheduledPaidInBasisPoints !== null && ` (${(advance.scheduledPaidInBasisPoints / 100).toFixed(2)}%)`}</p><p>Term <strong>{advance.termMonths ? `${advance.termMonths} months` : "Unknown"}</strong></p><p>Payment schedule <strong>{advance.paymentFrequency ? `${advance.paymentFrequency}, ${advance.paymentCount ?? "?"} payments` : "Unknown"}</strong></p><p>Assigned team <strong>{advance.assignedTeam.join(", ") || "Unassigned"}</strong></p></div>
          {canCorrect && <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_16rem]"><Input aria-label={`Correction reason for ${advance.businessName}`} placeholder="Reason for status correction" value={reasons[advance.id] ?? ""} onChange={(event) => setReasons((current) => ({ ...current, [advance.id]: event.target.value }))} /><Select disabled={busy === advance.id} value={advance.performanceStatus} onValueChange={(value) => void changeStatus(advance, value as AdvancePerformanceStatus)}><SelectTrigger aria-label={`Status for advance ${advance.id}`}><SelectValue /></SelectTrigger><SelectContent>{["on_track","missed_payment","default","renewed","closed","in_collections"].map((status) => <SelectItem key={status} value={status}>{status.replace(/_/g, " ")}</SelectItem>)}</SelectContent></Select></div>}
          <div className="mt-3"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Performance history</p>{advance.statusHistory.length === 0 ? <p className="mt-1 text-sm text-muted-foreground">No manual corrections.</p> : <ol className="mt-1 space-y-1 text-sm">{advance.statusHistory.map((entry) => <li key={entry.id}>{new Date(entry.effectiveAt).toLocaleString()}: <strong>{entry.status.replace(/_/g, " ")}</strong> — {entry.reason}</li>)}</ol>}</div>
        </div>)}</div>}
    </CardContent>
  </Card>
}

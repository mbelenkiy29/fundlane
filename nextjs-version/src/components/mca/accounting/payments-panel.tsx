"use client"

import * as React from "react"
import { AlertCircle, Loader2, Plus, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { requestJson } from "@/lib/mca/client"
import type { AccountingPayment, AccountingTotals, AdvanceSummary, PaymentDistribution, SplitTemplateVersion } from "@/lib/mca/accounting/contracts"
import type { MembershipSummary } from "@/lib/mca/types"
import { formatCents, formatMcaDate } from "./format"
import Link from "next/link"

function parseDollars(value: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim())
  if (!match) return null
  const result = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"))
  return Number.isSafeInteger(result) ? result : null
}

export function PaymentsPanel() {
  const [payments, setPayments] = React.useState<AccountingPayment[]>([])
  const [advances, setAdvances] = React.useState<AdvanceSummary[]>([])
  const [members, setMembers] = React.useState<MembershipSummary[]>([])
  const [templates, setTemplates] = React.useState<SplitTemplateVersion[]>([])
  const [distributions, setDistributions] = React.useState<PaymentDistribution[]>([])
  const [totals, setTotals] = React.useState<AccountingTotals | null>(null)
  const [loading, setLoading] = React.useState(true); const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(""); const [notice, setNotice] = React.useState("")
  const [filters, setFilters] = React.useState({ status: "all", originator: "all", from: "", to: "" })
  const [selectedId, setSelectedId] = React.useState("")
  const [form, setForm] = React.useState({ advanceId: "", type: "commission", amount: "", date: "", originator: "" })
  const [retryKey, setRetryKey] = React.useState(() => crypto.randomUUID())
  const [receipt, setReceipt] = React.useState({ amount: "", date: "" })
  const [adjustment, setAdjustment] = React.useState({ amount: "", reason: "" })
  const [adjustmentRetryKey, setAdjustmentRetryKey] = React.useState(() => crypto.randomUUID())
  const [split, setSplit] = React.useState({ templateId: "", name: "", rows: [
    { key: crypto.randomUUID(), recipient: "", percent: "33.33" },
    { key: crypto.randomUUID(), recipient: "", percent: "33.33" },
    { key: crypto.randomUUID(), recipient: "", percent: "33.34" },
  ] })
  const [splitRetryKey, setSplitRetryKey] = React.useState(() => crypto.randomUUID())
  const [distributionDate, setDistributionDate] = React.useState("")
  const selected = payments.find((item) => item.id === selectedId)
  const advanceById = new Map(advances.map((item) => [item.id, item]))
  const memberById = new Map(members.map((item) => [item.id, item]))
  const selectedAdvance = selected ? advanceById.get(selected.advanceId) : undefined

  const load = React.useCallback(async () => {
    setLoading(true); setError("")
    try {
      const query = new URLSearchParams()
      if (filters.status !== "all") query.set("status", filters.status)
      if (filters.originator !== "all") query.set("originatorMembershipId", filters.originator)
      if (filters.from) query.set("from", `${filters.from}T00:00:00.000Z`)
      if (filters.to) query.set("to", `${filters.to}T23:59:59.999Z`)
      const [ledger, a, m, t, d] = await Promise.all([
        requestJson<{ payments: AccountingPayment[]; totals?: AccountingTotals }>(`/api/mca/accounting/payments?${query}`),
        requestJson<{ advances: AdvanceSummary[] }>("/api/mca/advances"), requestJson<{ memberships: MembershipSummary[] }>("/api/memberships"),
        requestJson<{ templates: SplitTemplateVersion[] }>("/api/mca/accounting/splits"), requestJson<{ distributions: PaymentDistribution[] }>("/api/mca/accounting/distributions"),
      ])
      setPayments(ledger.payments); setTotals(ledger.totals ?? null); setAdvances(a.advances)
      setMembers(m.memberships.filter((item) => item.status === "active")); setTemplates(t.templates); setDistributions(d.distributions)
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Payments could not be loaded.") }
    finally { setLoading(false) }
  }, [filters])
  React.useEffect(() => { void load() }, [load])
  const fail = (caught: unknown, fallback: string) => setError(caught instanceof Error ? caught.message : fallback)

  async function add(event: React.FormEvent) {
    event.preventDefault(); const amount = parseDollars(form.amount)
    if (amount === null) { setError("Expected amount must be dollars with at most two decimals."); return }
    setBusy(true); setError(""); setNotice("")
    try {
      await requestJson("/api/mca/accounting/payments", { method: "POST", body: JSON.stringify({ advanceId: form.advanceId, type: form.type,
        expectedAmountCents: amount, expectedAt: form.date ? `${form.date}T12:00:00.000Z` : undefined,
        originatorMembershipId: form.originator || undefined, idempotencyKey: retryKey }) })
      setRetryKey(crypto.randomUUID()); setNotice("Expected payment added. No bank transfer was initiated.")
      setForm({ advanceId: "", type: "commission", amount: "", date: "", originator: "" }); await load()
    } catch (caught) { fail(caught, "Payment could not be added.") } finally { setBusy(false) }
  }
  async function reconcile(event: React.FormEvent) {
    event.preventDefault(); const amount = parseDollars(receipt.amount)
    if (!selected || amount === null || !receipt.date) { setError("Choose a payment, amount, and received date."); return }
    setBusy(true)
    try { await requestJson(`/api/mca/accounting/payments/${selected.id}`, { method: "PATCH", body: JSON.stringify({ receivedAmountCents: amount, receivedAt: `${receipt.date}T12:00:00.000Z` }) }); setNotice("Collection reconciled; this recorded no transfer."); await load() }
    catch (caught) { fail(caught, "Collection could not be reconciled.") } finally { setBusy(false) }
  }
  async function adjust(event: React.FormEvent) {
    event.preventDefault(); if (!selected) return
    const negative = adjustment.amount.trim().startsWith("-"); const amount = parseDollars(adjustment.amount.replace(/^-/, ""))
    if (amount === null || amount === 0 || !adjustment.reason.trim()) { setError("Enter a non-zero dollar adjustment and reason."); return }
    setBusy(true)
    try { await requestJson(`/api/mca/accounting/payments/${selected.id}/adjustments`, { method: "POST", body: JSON.stringify({ amountCents: negative ? -amount : amount, reason: adjustment.reason, idempotencyKey: adjustmentRetryKey }) }); setAdjustmentRetryKey(crypto.randomUUID()); setAdjustment({ amount: "", reason: "" }); setNotice("Immutable adjustment recorded."); await load() }
    catch (caught) { fail(caught, "Adjustment could not be recorded.") } finally { setBusy(false) }
  }
  async function saveSplit(event: React.FormEvent) {
    event.preventDefault()
    const allocations = split.rows.map((row) => ({ recipientMembershipId: row.recipient, percentageBasisPoints: parseDollars(row.percent) }))
    if (allocations.some((row) => !row.recipientMembershipId || row.percentageBasisPoints === null)
      || allocations.reduce((sum, row) => sum + (row.percentageBasisPoints ?? 0), 0) !== 10_000) {
      setError("Choose recipients whose percentages total exactly 100.00%."); return
    }
    setBusy(true)
    try { const saved = await requestJson<SplitTemplateVersion>("/api/mca/accounting/splits", { method: "POST", body: JSON.stringify({ templateId: split.templateId || undefined, name: split.name, allocations }) }); setSplit((current) => ({ ...current, templateId: saved.templateId })); setNotice(`Split template version ${saved.version} saved.`); await load() }
    catch (caught) { fail(caught, "Split template could not be saved.") } finally { setBusy(false) }
  }
  async function applySplit(template: SplitTemplateVersion) {
    if (!selected) { setError("Select a payment before applying a split."); return }
    setBusy(true)
    try { await requestJson("/api/mca/accounting/splits/apply", { method: "POST", body: JSON.stringify({ paymentId: selected.id, templateId: template.templateId, version: template.version, idempotencyKey: splitRetryKey }) }); setSplitRetryKey(crypto.randomUUID()); setNotice("Recipient distributions created. No bank transfer was initiated."); await load() }
    catch (caught) { fail(caught, "Split could not be applied.") } finally { setBusy(false) }
  }
  async function setDistribution(id: string, status: "paid" | "void") {
    if (status === "paid" && !distributionDate) { setError("Choose the actual paid date before marking a distribution paid."); return }
    setBusy(true)
    try { await requestJson(`/api/mca/accounting/distributions/${id}`, { method: "PATCH", body: JSON.stringify({ status, paidAt: status === "paid" ? `${distributionDate}T12:00:00.000Z` : undefined }) }); setNotice(status === "paid" ? "Distribution marked paid; no transfer was initiated." : "Unpaid distribution voided."); await load() }
    catch (caught) { fail(caught, "Distribution could not be updated.") } finally { setBusy(false) }
  }

  return <div className="space-y-4">
    <Card><CardHeader className="flex-row items-start justify-between"><div><CardTitle>Commission and fee ledger</CardTitle><CardDescription>Expected, collected, and outstanding company revenue. Records never initiate a bank transfer.</CardDescription></div><Button variant="outline" size="sm" onClick={() => void load()}><RefreshCw className="size-4" />Refresh</Button></CardHeader><CardContent className="space-y-4">
      {error && <p role="alert" className="flex items-center gap-2 text-sm text-destructive"><AlertCircle className="size-4" />{error}</p>}{notice && <p role="status" className="text-sm text-emerald-700">{notice}</p>}
      {totals && <div className="grid gap-3 sm:grid-cols-3">{(["expectedCents", "collectedCents", "outstandingCents"] as const).map((key) => <div key={key} className="rounded border p-3"><p className="text-xs capitalize text-muted-foreground">{key.replace("Cents", "")}</p><p className="text-lg font-semibold">{formatCents(totals[key])}</p></div>)}</div>}
      <div className="grid gap-2 sm:grid-cols-4"><Select value={filters.status} onValueChange={(status) => setFilters({ ...filters, status })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All statuses</SelectItem>{["expected", "partial", "received", "void"].map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent></Select><Select value={filters.originator} onValueChange={(originator) => setFilters({ ...filters, originator })}><SelectTrigger><SelectValue placeholder="Originator" /></SelectTrigger><SelectContent><SelectItem value="all">All originators</SelectItem>{members.map((member) => <SelectItem value={member.id} key={member.id}>{member.name}</SelectItem>)}</SelectContent></Select><Input aria-label="From date" type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} /><Input aria-label="To date" type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} /></div>
      {loading ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading payments…</p> : payments.length === 0 ? <p className="text-sm text-muted-foreground">No payments match these filters.</p> : <div className="divide-y rounded border">{payments.map((p) => { const advance = advanceById.get(p.advanceId); const originator = p.originatorMembershipId ? memberById.get(p.originatorMembershipId) : undefined; return <button type="button" key={p.id} onClick={() => setSelectedId(p.id)} className={`grid w-full gap-2 p-3 text-left text-sm sm:grid-cols-6 ${selectedId === p.id ? "bg-muted" : ""}`}><span><strong>{advance?.businessName ?? "Unknown merchant"}</strong><br />{advance?.funderName ?? "Unknown funder"}</span><span className="capitalize">{p.type}<br />{p.status}</span><span>{formatCents(p.expectedAmountCents)} expected<br />{p.expectedAt ? formatMcaDate(p.expectedAt) : "No expected date"}</span><span>{formatCents(p.receivedAmountCents)} collected<br />{p.receivedAt ? formatMcaDate(p.receivedAt) : "Not received"}</span><span>{originator?.name ?? "No originator"}</span><span>{advance ? `Funded ${formatMcaDate(advance.fundedAt)}` : ""}</span></button> })}</div>}
    </CardContent></Card>
    <Card><CardHeader><CardTitle>Add expected payment</CardTitle><CardDescription>The retry identity remains stable after a failed request.</CardDescription></CardHeader><CardContent><form className="grid gap-3 sm:grid-cols-5" onSubmit={add}><div><Label>Advance</Label><Select value={form.advanceId} onValueChange={(advanceId) => setForm({ ...form, advanceId })}><SelectTrigger><SelectValue placeholder="Choose advance" /></SelectTrigger><SelectContent>{advances.map((a) => <SelectItem value={a.id} key={a.id}>{a.businessName} · {a.funderName}</SelectItem>)}</SelectContent></Select></div><div><Label>Type</Label><Select value={form.type} onValueChange={(type) => setForm({ ...form, type })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="commission">Commission</SelectItem><SelectItem value="fee">Fee</SelectItem></SelectContent></Select></div><div><Label htmlFor="pay-amount">Expected dollars</Label><Input id="pay-amount" required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></div><div><Label htmlFor="pay-date">Expected date</Label><Input id="pay-date" type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></div><div><Label>Originator</Label><Select value={form.originator} onValueChange={(originator) => setForm({ ...form, originator })}><SelectTrigger><SelectValue placeholder="Optional" /></SelectTrigger><SelectContent>{members.map((m) => <SelectItem value={m.id} key={m.id}>{m.name}</SelectItem>)}</SelectContent></Select></div><Button disabled={busy || !form.advanceId} type="submit" className="sm:col-span-5 sm:w-fit"><Plus className="size-4" />Add expected payment</Button></form></CardContent></Card>
    <Card><CardHeader><CardTitle>Payment drilldown</CardTitle><CardDescription>{selected ? `${selectedAdvance?.businessName ?? "Unknown merchant"} · ${selectedAdvance?.funderName ?? "Unknown funder"} · ${selected.type}` : "Select a payment above."}</CardDescription></CardHeader>{selected && <CardContent className="space-y-4"><div className="grid gap-2 rounded border p-3 text-sm sm:grid-cols-3"><p>Expected <strong>{formatCents(selected.expectedAmountCents)}</strong><br />{selected.expectedAt ? formatMcaDate(selected.expectedAt) : "No date"}</p><p>Collected <strong>{formatCents(selected.receivedAmountCents)}</strong><br />{selected.receivedAt ? formatMcaDate(selected.receivedAt) : "Not received"}</p><p>Originator <strong>{selected.originatorMembershipId ? memberById.get(selected.originatorMembershipId)?.name ?? "Unknown" : "Not assigned"}</strong>{selectedAdvance && <><br /><Link className="underline" href={`/deals?deal=${selectedAdvance.dealId}`}>Open deal</Link> · Funded {formatMcaDate(selectedAdvance.fundedAt)}</>}</p></div><div className="grid gap-4 sm:grid-cols-2"><form onSubmit={reconcile} className="space-y-2"><Label>Collected amount and date</Label><div className="flex gap-2"><Input aria-label="Collected dollars" value={receipt.amount} onChange={(e) => setReceipt({ ...receipt, amount: e.target.value })} /><Input aria-label="Received date" type="date" value={receipt.date} onChange={(e) => setReceipt({ ...receipt, date: e.target.value })} /><Button disabled={busy}>Reconcile</Button></div></form><form onSubmit={adjust} className="space-y-2"><Label>Auditable adjustment</Label><div className="flex gap-2"><Input aria-label="Adjustment dollars" placeholder="-25.00" value={adjustment.amount} onChange={(e) => setAdjustment({ ...adjustment, amount: e.target.value })} /><Input aria-label="Adjustment reason" value={adjustment.reason} onChange={(e) => setAdjustment({ ...adjustment, reason: e.target.value })} /><Button disabled={busy} variant="outline">Record</Button></div></form></div><div><div className="flex items-end gap-2"><div><Label htmlFor="distribution-paid-date">Actual paid date</Label><Input id="distribution-paid-date" type="date" value={distributionDate} onChange={(e) => setDistributionDate(e.target.value)} /></div></div><p className="mt-3 text-sm font-medium">Recipient distributions</p>{distributions.filter((d) => d.paymentId === selected.id).length === 0 ? <p className="text-sm text-muted-foreground">No split applied.</p> : distributions.filter((d) => d.paymentId === selected.id).map((d) => <div key={d.id} className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded border p-2 text-sm"><span>{d.recipientName} · {(d.percentageBasisPoints / 100).toFixed(2)}% · {formatCents(d.amountCents)} · <span className="capitalize">{d.status}</span>{d.paidAt ? ` ${formatMcaDate(d.paidAt)}` : ""}</span>{d.status === "expected" && <span className="flex gap-1"><Button type="button" size="sm" variant="outline" onClick={() => void setDistribution(d.id, "paid")}>Mark paid</Button><Button type="button" size="sm" variant="ghost" onClick={() => void setDistribution(d.id, "void")}>Void</Button></span>}</div>)}</div></CardContent>}</Card>
    <Card><CardHeader><CardTitle>Versioned commission splits</CardTitle><CardDescription>Supports any recipient count, including exact 33.33/33.33/33.34 allocations.</CardDescription></CardHeader><CardContent className="space-y-4"><form onSubmit={saveSplit} className="space-y-2"><Input required aria-label="Split name" placeholder="Sales split" value={split.name} onChange={(e) => setSplit({ ...split, name: e.target.value })} />{split.rows.map((row, index) => <div className="grid gap-2 sm:grid-cols-[1fr_10rem_auto]" key={row.key}><Select value={row.recipient} onValueChange={(recipient) => setSplit({ ...split, rows: split.rows.map((item) => item.key === row.key ? { ...item, recipient } : item) })}><SelectTrigger><SelectValue placeholder={`Recipient ${index + 1}`} /></SelectTrigger><SelectContent>{members.map((m) => <SelectItem value={m.id} key={m.id}>{m.name}</SelectItem>)}</SelectContent></Select><Input aria-label={`Recipient ${index + 1} percent`} value={row.percent} onChange={(e) => setSplit({ ...split, rows: split.rows.map((item) => item.key === row.key ? { ...item, percent: e.target.value } : item) })} /><Button type="button" variant="ghost" disabled={split.rows.length === 1} onClick={() => setSplit({ ...split, rows: split.rows.filter((item) => item.key !== row.key) })}>Remove</Button></div>)}<div className="flex gap-2"><Button type="button" variant="outline" onClick={() => setSplit({ ...split, rows: [...split.rows, { key: crypto.randomUUID(), recipient: "", percent: "" }] })}>Add recipient</Button><Button disabled={busy}>Save {split.templateId ? "new version" : "template"}</Button></div></form><div className="space-y-2">{templates.map((t) => <div key={`${t.templateId}:${t.version}`} className="flex items-center justify-between rounded border p-2 text-sm"><span>{t.name} · v{t.version} · {t.allocations.length} recipients</span><Button type="button" size="sm" variant="outline" disabled={busy || !selected} onClick={() => void applySplit(t)}>Apply to selected</Button></div>)}</div></CardContent></Card>
  </div>
}

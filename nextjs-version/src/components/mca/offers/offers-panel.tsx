"use client"

import { commitHistoricalPreview } from "@/lib/mca/historical/commit-client"

import * as React from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { RequestError, requestJson } from "@/lib/mca/client"
import type { OfferRecord, OfferRevision } from "@/lib/mca/offers/contracts"
import type { ManualSubmission } from "@/lib/mca/offers/manual-submissions"
import { historicalResultMessage, historicalRowMessage, parseHistoricalPreview } from "@/lib/mca/historical/preview-client"
import type { HistoricalImportPreview, HistoricalImportResult } from "@/lib/mca/historical/contracts"
import type { MembershipSummary } from "@/lib/mca/types"
import type { FundingResult } from "@/lib/mca/funding/contracts"

const dollars = (cents?: number) => cents === undefined ? "Incomplete" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100)
const current = (offer: OfferRecord) => offer.revisions.find((revision) => revision.id === offer.currentRevisionId)!
const stableKey = (prefix: string) => `${prefix}:${crypto.randomUUID()}`
const cents = (value: string) => {
  const normalized = value.trim()
  if (!normalized) return undefined
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) throw new Error("Money fields support at most two decimal places.")
  const [whole, fraction = ""] = normalized.split(".")
  const parsed = Number(whole) * 100 + Number(fraction.padEnd(2, "0"))
  if (!Number.isSafeInteger(parsed)) throw new Error("Money value is outside the supported range.")
  return parsed
}
const basisPoints = (value: string) => {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim())) throw new Error("Split percentages support at most two decimal places.")
  const [whole, fraction = ""] = value.trim().split(".")
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"))
}

export function OffersPanel({ dealId, onChanged }: { dealId: string; onChanged?: () => void }) {
  const [offers, setOffers] = React.useState<OfferRecord[]>([])
  const [manual, setManual] = React.useState<ManualSubmission[]>([])
  const [manualAllowed, setManualAllowed] = React.useState(true)
  const [memberships, setMemberships] = React.useState<MembershipSummary[]>([])
  const [fundingRecords, setFundingRecords] = React.useState<FundingResult[]>([])
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const [message, setMessage] = React.useState<string>()
  const [editing, setEditing] = React.useState<{ offerId: string; revision: OfferRevision }>()
  const [funderName, setFunderName] = React.useState("")
  const [product, setProduct] = React.useState("")
  const [amount, setAmount] = React.useState("")
  const [factorRate, setFactorRate] = React.useState("")
  const [buyRate, setBuyRate] = React.useState("")
  const [termMonths, setTermMonths] = React.useState("")
  const [payment, setPayment] = React.useState("")
  const [frequency, setFrequency] = React.useState<"daily" | "weekly" | "biweekly" | "monthly" | "irregular">("daily")
  const [commission, setCommission] = React.useState("")
  const [fee, setFee] = React.useState("")
  const [stipulations, setStipulations] = React.useState("")
  const [offerKey, setOfferKey] = React.useState(() => stableKey("offer"))
  const [manualDate, setManualDate] = React.useState(new Date().toISOString().slice(0, 10))
  const [manualReason, setManualReason] = React.useState("")
  const [manualKey, setManualKey] = React.useState(() => stableKey("manual"))
  const [fundingKey, setFundingKey] = React.useState(() => stableKey("funding"))
  const [fundingTarget, setFundingTarget] = React.useState<{ offer: OfferRecord; revision: OfferRevision }>()
  const [fundedAt, setFundedAt] = React.useState(new Date().toISOString().slice(0, 10))
  const [fundingCommission, setFundingCommission] = React.useState("")
  const [fundingFee, setFundingFee] = React.useState("")
  const [fundingFrequency, setFundingFrequency] = React.useState<"" | "daily" | "weekly" | "biweekly" | "monthly">("")
  const [expectedCommissionAt, setExpectedCommissionAt] = React.useState("")
  const [expectedFeeAt, setExpectedFeeAt] = React.useState("")
  const [paymentCount, setPaymentCount] = React.useState("")
  const [calendarConvention, setCalendarConvention] = React.useState<"calendar_days" | "business_days" | "fixed_count">("business_days")
  const [splitRows, setSplitRows] = React.useState<Array<{ recipientMembershipId: string; percentage: string }>>([])
  const [reversingEventId, setReversingEventId] = React.useState<string>()
  const [reversalReason, setReversalReason] = React.useState("")
  const [correctionOfEventId, setCorrectionOfEventId] = React.useState<string>()
  const [historicalFile, setHistoricalFile] = React.useState<File>()
  const [historicalSource, setHistoricalSource] = React.useState("historical")
  const [historicalBatch, setHistoricalBatch] = React.useState(() => new Date().toISOString().slice(0, 10))
  const [historicalPreview, setHistoricalPreview] = React.useState<HistoricalImportPreview>()
  const historicalRetry = React.useRef<{ file: File; sourceId: string; batchId: string; requestId: string } | null>(null)
  const [historicalResult, setHistoricalResult] = React.useState<HistoricalImportResult>()

  const load = React.useCallback(async () => {
    setLoading(true); setError(undefined)
    try {
      const payload = await requestJson<{ offers: OfferRecord[] }>(`/api/mca/offers/${encodeURIComponent(dealId)}`)
      setOffers(payload.offers)
      setFundingRecords((await requestJson<{ funding: FundingResult[] }>(`/api/mca/offers/${encodeURIComponent(dealId)}/funding`)).funding)
      try { setManual((await requestJson<{ submissions: ManualSubmission[] }>(`/api/mca/offers/${encodeURIComponent(dealId)}/manual`)).submissions); setMemberships((await requestJson<{ memberships: MembershipSummary[] }>("/api/memberships")).memberships.filter((item) => item.status === "active")); setManualAllowed(true) }
      catch (caught) { if (caught instanceof RequestError && caught.status === 403) setManualAllowed(false); else throw caught }
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Offer records could not be loaded.") }
    finally { setLoading(false) }
  }, [dealId])
  React.useEffect(() => { void load() }, [load])

  const terms = () => ({ product: product.trim() || undefined, amountCents: cents(amount), factorRate: factorRate ? Number(factorRate) : undefined, buyRate: buyRate ? Number(buyRate) : undefined, termMonths: termMonths ? Number(termMonths) : undefined, paymentAmountCents: cents(payment), paymentFrequency: frequency, commissionCents: cents(commission), feeCents: cents(fee), stipulations: stipulations.split("\n").map((item) => item.trim()).filter(Boolean) })
  const resetTerms = () => { setEditing(undefined); setFunderName(""); setProduct(""); setAmount(""); setFactorRate(""); setBuyRate(""); setTermMonths(""); setPayment(""); setCommission(""); setFee(""); setStipulations("") }
  const run = async (work: () => Promise<void>, success: string) => { setBusy(true); setError(undefined); setMessage(undefined); try { await work(); setMessage(success); await load(); onChanged?.() } catch (caught) { setError(caught instanceof Error ? caught.message : "The action failed.") } finally { setBusy(false) } }

  function edit(offer: OfferRecord) { const revision = current(offer); setEditing({ offerId: offer.id, revision }); setFunderName(offer.funderName); setProduct(revision.product ?? ""); setAmount(revision.amountCents === undefined ? "" : String(revision.amountCents / 100)); setFactorRate(revision.factorRate === undefined ? "" : String(revision.factorRate)); setBuyRate(revision.buyRate === undefined ? "" : String(revision.buyRate)); setTermMonths(revision.termMonths === undefined ? "" : String(revision.termMonths)); setPayment(revision.paymentAmountCents === undefined ? "" : String(revision.paymentAmountCents / 100)); setFrequency(revision.paymentFrequency ?? "daily"); setCommission(revision.commissionCents === undefined ? "" : String(revision.commissionCents / 100)); setFee(revision.feeCents === undefined ? "" : String(revision.feeCents / 100)); setStipulations((revision.stipulations ?? []).join("\n")) }
  function openFunding(offer: OfferRecord, revision: OfferRevision) {
    setFundingTarget({ offer, revision }); setFundingKey(stableKey("funding"))
    setFundedAt(new Date().toISOString().slice(0, 10))
    setFundingCommission(revision.commissionCents === undefined ? "" : String(revision.commissionCents / 100))
    setFundingFee(revision.feeCents === undefined ? "" : String(revision.feeCents / 100))
    setExpectedCommissionAt(""); setExpectedFeeAt(""); setPaymentCount("")
    setFundingFrequency(revision.paymentFrequency && revision.paymentFrequency !== "irregular" ? revision.paymentFrequency : "")
    setCalendarConvention("business_days"); setSplitRows([])
  }

  async function saveOffer(event: React.FormEvent) { event.preventDefault(); await run(async () => {
    if (editing) await requestJson(`/api/mca/offers/${encodeURIComponent(dealId)}/${encodeURIComponent(editing.offerId)}/revisions`, { method: "POST", body: JSON.stringify({ expectedRevisionNumber: editing.revision.revisionNumber, terms: terms() }) })
    else { await requestJson(`/api/mca/offers/${encodeURIComponent(dealId)}`, { method: "POST", body: JSON.stringify({ funderName, source: "manual", externalId: offerKey, terms: terms() }) }); setOfferKey(stableKey("offer")) }
    resetTerms()
  }, editing ? "Offer revision saved; prior terms remain in history." : "Offer added.") }

  async function toggleSelection(offer: OfferRecord, revision: OfferRevision) { const selected = offer.selectedRevisionIds.includes(revision.id); await run(() => requestJson(`/api/mca/offers/${encodeURIComponent(dealId)}/${encodeURIComponent(offer.id)}/selection`, { method: "POST", body: JSON.stringify({ revisionId: revision.id, selected: !selected }) }).then(() => undefined), selected ? "Offer deselected." : "Offer selected.") }
  async function fund(event: React.FormEvent) { event.preventDefault(); if (!fundingTarget) return; await run(async () => { const splits = splitRows.map((row) => ({ recipientMembershipId: row.recipientMembershipId, percentageBasisPoints: basisPoints(row.percentage) })); await requestJson(`/api/mca/offers/${encodeURIComponent(dealId)}/funding`, { method: "POST", body: JSON.stringify({ offerId: fundingTarget.offer.id, offerRevisionId: fundingTarget.revision.id, idempotencyKey: fundingKey, fundedAt, amountCents: fundingTarget.revision.amountCents, commissionCents: cents(fundingCommission) ?? fundingTarget.revision.commissionCents, feeCents: cents(fundingFee) ?? fundingTarget.revision.feeCents, expectedCommissionAt: expectedCommissionAt || undefined, expectedFeeAt: expectedFeeAt || undefined, paymentCount: paymentCount ? Number(paymentCount) : undefined, paymentFrequency: paymentCount ? fundingFrequency || undefined : undefined, calendarConvention: paymentCount ? calendarConvention : undefined, splits, correctionOfEventId }) }); setFundingKey(stableKey("funding")); setFundingTarget(undefined); setCorrectionOfEventId(undefined) }, "Funding recorded atomically. No money was transferred.") }
  async function reverse(event: React.FormEvent) { event.preventDefault(); if (!reversingEventId) return; const id = reversingEventId; await run(async () => { await requestJson(`/api/mca/offers/${encodeURIComponent(dealId)}/funding/${encodeURIComponent(id)}/reverse`, { method: "POST", body: JSON.stringify({ reason: reversalReason, reversedAt: new Date().toISOString() }) }); setCorrectionOfEventId(id); setReversingEventId(undefined); setReversalReason("") }, "Funding reversed. Revise the offer and confirm it again to create an auditable correction.") }
  async function createManual(event: React.FormEvent) { event.preventDefault(); await run(async () => { await requestJson(`/api/mca/offers/${encodeURIComponent(dealId)}/manual`, { method: "POST", body: JSON.stringify({ funderName, historicalAt: manualDate, reason: manualReason, idempotencyKey: manualKey }) }); setManualKey(stableKey("manual")); setManualReason("") }, "Manual submission recorded locally. No message or provider request was sent.") }
  async function approve(submission: ManualSubmission) { await run(() => requestJson(`/api/mca/offers/${encodeURIComponent(dealId)}/manual/${encodeURIComponent(submission.id)}/approve`, { method: "POST", body: JSON.stringify({ terms: terms() }) }).then(() => undefined), "Manual approval created and selected an offer.") }

  async function previewHistory(event: React.FormEvent) {
    event.preventDefault()
    if (!historicalFile || busy) return
    const previous = historicalRetry.current
    const attempt = previous?.file === historicalFile && previous.sourceId === historicalSource && previous.batchId === historicalBatch
      ? previous : { file: historicalFile, sourceId: historicalSource, batchId: historicalBatch, requestId: crypto.randomUUID() }
    historicalRetry.current = attempt
    setBusy(true); setError(undefined); setMessage(undefined); setHistoricalPreview(undefined); setHistoricalResult(undefined)
    try {
      const form = new FormData()
      form.set("requestId", attempt.requestId); form.set("sourceId", historicalSource); form.set("batchId", historicalBatch); form.set("file", historicalFile)
      const response = await fetch("/api/mca/historical/preview", { method: "POST", body: form })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error?.message ?? "Historical preview failed.")
      setHistoricalPreview(parseHistoricalPreview(body)); historicalRetry.current = null
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Historical preview failed.") }
    finally { setBusy(false) }
  }
  const [historicalCommitting, setHistoricalCommitting] = React.useState(false)
  async function commitHistory() {
    if (!historicalPreview || busy || historicalResult?.state === "committed") return
    setBusy(true); setHistoricalCommitting(true); setError(undefined); setMessage(undefined)
    try {
      const result = await commitHistoricalPreview(historicalPreview)
      setHistoricalResult(result)
      await load(); onChanged?.()
      setMessage(historicalResultMessage(result))
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Historical commit failed.") }
    finally { setBusy(false); setHistoricalCommitting(false) }
  }


  return <div className="space-y-6">
    <Card><CardHeader><CardTitle>Offers</CardTitle><CardDescription>Compare exact revisions, retain previous terms, and select more than one offer.</CardDescription></CardHeader><CardContent className="space-y-4">
      {loading && <p role="status" className="text-sm text-muted-foreground">Loading offers…</p>}{error && <p role="alert" className="text-sm text-destructive">{error}</p>}{message && <p role="status" className="text-sm text-emerald-700">{message}</p>}
      {!loading && !offers.length && <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">No offers yet. Add terms below or record an administrator-only manual approval.</p>}
      {!!offers.length && <Table><TableHeader><TableRow><TableHead>Funder</TableHead><TableHead>Revision history</TableHead><TableHead>Amount</TableHead><TableHead>Factor / buy</TableHead><TableHead>Term</TableHead><TableHead>Payment</TableHead><TableHead>Commission</TableHead><TableHead>Status</TableHead><TableHead>Actions</TableHead></TableRow></TableHeader><TableBody>{offers.map((offer) => { const revision = current(offer), selected = offer.selectedRevisionIds.includes(revision.id); return <TableRow key={offer.id}><TableCell>{offer.funderName}</TableCell><TableCell><div>Current v{revision.revisionNumber}</div>{offer.revisions.map((item) => <div className="text-xs text-muted-foreground" key={item.id}>v{item.revisionNumber} · {item.state} · {offer.selectedRevisionIds.includes(item.id) ? "selected" : "not selected"} · {dollars(item.amountCents)}</div>)}</TableCell><TableCell>{dollars(revision.amountCents)}</TableCell><TableCell>{revision.factorRate ?? "Incomplete"} / {revision.buyRate ?? "—"}</TableCell><TableCell>{revision.termMonths ? `${revision.termMonths} mo` : "Incomplete"}</TableCell><TableCell>{dollars(revision.paymentAmountCents)} {revision.paymentFrequency ?? ""}</TableCell><TableCell>{dollars(revision.commissionCents)}</TableCell><TableCell><Badge variant={selected ? "default" : "secondary"}>{selected ? "Selected" : revision.incompleteFields.length ? "Incomplete" : revision.state}</Badge>{(revision.stipulations?.length ?? 0) > 0 && <div className="mt-1 text-xs">{revision.stipulations!.length} stipulation(s)</div>}</TableCell><TableCell className="space-x-2"><Button size="sm" variant="outline" onClick={() => edit(offer)} disabled={busy}>Revise</Button><Button size="sm" variant="outline" onClick={() => void toggleSelection(offer, revision)} disabled={busy}>{selected ? "Deselect" : "Select"}</Button>{selected && revision.amountCents !== undefined && <Button size="sm" onClick={() => openFunding(offer, revision)} disabled={busy || revision.state === "funded"}>{revision.state === "funded" ? "Funded" : "Confirm funded"}</Button>}</TableCell></TableRow> })}</TableBody></Table>}
      <form onSubmit={saveOffer} className="grid gap-3 rounded-md border p-4 md:grid-cols-4"><div className="md:col-span-4 font-medium">{editing ? `Revise ${funderName} v${editing.revision.revisionNumber}` : "Add manual offer"}</div>{[["Funder",funderName,setFunderName],["Product",product,setProduct],["Amount ($)",amount,setAmount],["Factor rate",factorRate,setFactorRate],["Buy rate",buyRate,setBuyRate],["Term months",termMonths,setTermMonths],["Payment ($)",payment,setPayment],["Commission ($)",commission,setCommission],["Fee ($)",fee,setFee]].map(([label,value,setter]) => <Label key={label as string} className="grid gap-2">{label as string}<Input value={value as string} onChange={(e) => (setter as React.Dispatch<React.SetStateAction<string>>)(e.target.value)} disabled={busy || Boolean(editing && label === "Funder")} /></Label>)}<Label className="grid gap-2">Frequency<select className="h-9 rounded-md border bg-transparent px-3" value={frequency} onChange={(e) => setFrequency(e.target.value as typeof frequency)}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="biweekly">Biweekly</option><option value="monthly">Monthly</option><option value="irregular">Irregular</option></select></Label><Label className="grid gap-2 md:col-span-2">Stipulations, one per line<textarea className="min-h-20 rounded-md border bg-transparent p-3 text-sm" value={stipulations} onChange={(e) => setStipulations(e.target.value)} /></Label><div className="flex items-end gap-2"><Button disabled={busy || (!editing && !funderName.trim())}>{busy ? "Saving…" : editing ? "Save revision" : "Add offer"}</Button>{editing && <Button type="button" variant="ghost" onClick={resetTerms}>Cancel</Button>}</div></form>
      {fundingTarget && <form onSubmit={fund} className="grid gap-3 rounded-md border border-emerald-300 p-4 md:grid-cols-4"><div className="md:col-span-4"><p className="font-medium">Confirm actual funding for {fundingTarget.offer.funderName} v{fundingTarget.revision.revisionNumber}</p><p className="text-xs text-muted-foreground">This creates accounting records; it does not transfer money.</p></div><Label className="grid gap-2">Actual funding date<Input type="date" value={fundedAt} onChange={(e) => setFundedAt(e.target.value)} required /></Label><Label className="grid gap-2">Commission ($)<Input value={fundingCommission} onChange={(e) => setFundingCommission(e.target.value)} /></Label><Label className="grid gap-2">Fee ($)<Input value={fundingFee} onChange={(e) => setFundingFee(e.target.value)} /></Label><Label className="grid gap-2">Expected commission date<Input type="date" value={expectedCommissionAt} onChange={(e) => setExpectedCommissionAt(e.target.value)} /></Label><Label className="grid gap-2">Expected fee date<Input type="date" value={expectedFeeAt} onChange={(e) => setExpectedFeeAt(e.target.value)} /></Label><Label className="grid gap-2">Payment count<Input inputMode="numeric" value={paymentCount} onChange={(e) => setPaymentCount(e.target.value)} /></Label><Label className="grid gap-2">Payment frequency<select className="h-9 rounded-md border bg-transparent px-3" value={fundingFrequency} onChange={(e) => setFundingFrequency(e.target.value as typeof fundingFrequency)} required={Boolean(paymentCount)}><option value="">Choose frequency</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="biweekly">Biweekly</option><option value="monthly">Monthly</option></select></Label><Label className="grid gap-2">Payment calendar<select className="h-9 rounded-md border bg-transparent px-3" value={calendarConvention} onChange={(e) => setCalendarConvention(e.target.value as typeof calendarConvention)}><option value="business_days">Business days</option><option value="calendar_days">Calendar days</option><option value="fixed_count">Fixed count</option></select></Label><div className="space-y-2 md:col-span-4"><div className="flex items-center justify-between"><p className="text-sm font-medium">Commission splits</p><Button type="button" size="sm" variant="outline" onClick={() => setSplitRows((rows) => [...rows, { recipientMembershipId: memberships[0]?.id ?? "", percentage: "" }])} disabled={!memberships.length}>Add recipient</Button></div>{splitRows.map((row, index) => <div className="grid gap-2 md:grid-cols-[1fr_10rem_auto]" key={index}><select aria-label={`Split recipient ${index + 1}`} className="h-9 rounded-md border bg-transparent px-3" value={row.recipientMembershipId} onChange={(e) => setSplitRows((rows) => rows.map((item, at) => at === index ? { ...item, recipientMembershipId: e.target.value } : item))}>{memberships.map((member) => <option key={member.id} value={member.id}>{member.name} ({member.role})</option>)}</select><Input aria-label={`Split percentage ${index + 1}`} placeholder="Percent" value={row.percentage} onChange={(e) => setSplitRows((rows) => rows.map((item, at) => at === index ? { ...item, percentage: e.target.value } : item))} /><Button type="button" variant="ghost" onClick={() => setSplitRows((rows) => rows.filter((_, at) => at !== index))}>Remove</Button></div>)}</div><div className="flex gap-2 md:col-span-4"><Button disabled={busy}>Confirm funded</Button><Button type="button" variant="ghost" onClick={() => setFundingTarget(undefined)}>Cancel</Button></div></form>}
    </CardContent></Card>
    {!!fundingRecords.length && <Card><CardHeader><CardTitle>Funding history</CardTitle><CardDescription>Committed events create records only. Reversals void outstanding expectations without transferring money. Collected or paid history requires an accounting adjustment; the next confirmation can link back as a correction.</CardDescription></CardHeader><CardContent className="space-y-3">{fundingRecords.map((item) => <div key={item.fundingEventId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm"><span>{item.fundedAt} · {item.source} · {item.state} · advance {item.advanceId.slice(0, 8)}</span>{manualAllowed && item.state === "committed" && <Button size="sm" variant="outline" onClick={() => setReversingEventId(item.fundingEventId)}>Reverse / correct</Button>}</div>)}{reversingEventId && <form onSubmit={reverse} className="flex flex-wrap gap-2"><Input className="min-w-72 flex-1" placeholder="Required correction reason" value={reversalReason} onChange={(e) => setReversalReason(e.target.value)} required /><Button variant="destructive" disabled={busy}>Confirm reversal</Button><Button type="button" variant="ghost" onClick={() => setReversingEventId(undefined)}>Cancel</Button></form>}</CardContent></Card>}
    {manualAllowed && <Card><CardHeader><CardTitle>Manual submission history</CardTitle><CardDescription>Administrator session required. This creates local records only and never sends a message or provider request.</CardDescription></CardHeader><CardContent className="space-y-4"><form onSubmit={createManual} className="grid gap-3 md:grid-cols-4"><Label className="grid gap-2">Funder<Input value={funderName} onChange={(e) => setFunderName(e.target.value)} required /></Label><Label className="grid gap-2">Historical date<Input type="date" value={manualDate} onChange={(e) => setManualDate(e.target.value)} required /></Label><Label className="grid gap-2 md:col-span-2">Reason<Input value={manualReason} onChange={(e) => setManualReason(e.target.value)} required /></Label><Button disabled={busy} className="md:col-span-1">Record manual submission</Button></form>{manual.map((item) => <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm"><span>{item.funderName} · {item.historicalAt} · {item.state}</span>{item.state === "submitted" && <Button size="sm" onClick={() => void approve(item)} disabled={busy || !amount}>Approve with terms above</Button>}</div>)}</CardContent></Card>}
    {manualAllowed && <Card><CardHeader><CardTitle>Historical funding import</CardTitle><CardDescription>Upload exact integer-cent fields. Previewing creates no funded deals; you can upload again before committing. Already imported source and external IDs are skipped. Nothing is sent to funders.</CardDescription></CardHeader><CardContent className="space-y-4"><a className="text-sm underline" download="historical-funding-example.csv" href={`data:text/csv;charset=utf-8,${encodeURIComponent("external_id,legal_name,funder_name,funded_at,amount_cents,factor_rate,term_months,payment_amount_cents,payment_count,payment_frequency,calendar_convention,commission_cents,paid_commission_cents,paid_commission_at,fee_cents,expected_commission_at,expected_fee_at\nlegacy-001,Example Merchant,Example Funder,2025-03-14,10000000,1.35,8,56250,180,daily,business_days,1000000,500000,2025-03-21,25000,2025-03-21,2025-03-28")}`}>Download example CSV</a><form onSubmit={previewHistory} className="grid gap-3 md:grid-cols-3"><Label className="grid gap-2">Source ID<Input value={historicalSource} disabled={busy} onChange={(e) => { setHistoricalSource(e.target.value); setHistoricalPreview(undefined); setHistoricalResult(undefined); historicalRetry.current = null }} required /></Label><Label className="grid gap-2">Batch ID<Input value={historicalBatch} disabled={busy} onChange={(e) => { setHistoricalBatch(e.target.value); setHistoricalPreview(undefined); setHistoricalResult(undefined); historicalRetry.current = null }} required /></Label><Label className="grid gap-2">CSV/XLSX file<Input type="file" accept=".csv,.tsv,.xlsx,.xls" disabled={busy} onChange={(e) => { setHistoricalFile(e.target.files?.[0]); setHistoricalPreview(undefined); setHistoricalResult(undefined); historicalRetry.current = null }} required /></Label><Button disabled={busy} className="md:col-span-1">Preview history</Button></form>{historicalPreview && <div className="rounded-md border p-4 text-sm"><p>{historicalPreview.totals.rows} rows · {historicalPreview.totals.valid} valid · {historicalPreview.totals.duplicates} duplicates · {historicalPreview.totals.invalid} invalid</p><p>Principal {dollars(historicalPreview.totals.principalCents)} · expected commission {dollars(historicalPreview.totals.expectedCommissionCents)} · paid {dollars(historicalPreview.totals.paidCommissionCents)}</p>{historicalPreview.rows.filter((row) => row.errors.length || row.duplicate).map((row) => <p key={row.rowNumber} className={row.errors.length ? "text-destructive" : "text-amber-700"}>Row {row.rowNumber}: {historicalRowMessage(row)}</p>)}<Button className="mt-3" onClick={() => void commitHistory()} disabled={busy || historicalPreview.totals.valid === 0 || historicalPreview.state === "committed" || historicalResult?.state === "committed"} aria-busy={historicalCommitting}>{historicalCommitting ? "Importing…" : "Commit historical records"}</Button>{historicalCommitting && <p role="status">Creating funded records and repayment schedules. Please keep this preview open.</p>}</div>}{historicalResult && <p role="status" className="text-sm">{historicalResultMessage(historicalResult)}</p>}</CardContent></Card>}
  </div>
}

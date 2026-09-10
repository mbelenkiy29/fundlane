"use client"

import * as React from "react"
import { AlertCircle, Loader2, Play, Save } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { requestJson } from "@/lib/mca/client"
import type { AdvanceSummary, RenewalAction } from "@/lib/mca/accounting/contracts"
import type { DealListItem, DealListResponse } from "@/lib/mca/deals/schema"

type Policy = { paidInThresholdBasisPoints: number; minimumDaysSinceFunding: number; version: number }
export function RenewalsPanel() {
  const [actions, setActions] = React.useState<RenewalAction[]>([]); const [policy, setPolicy] = React.useState<Policy | null>(null)
  const [advances, setAdvances] = React.useState<AdvanceSummary[]>([]); const [deals, setDeals] = React.useState<DealListItem[]>([])
  const [threshold, setThreshold] = React.useState("50.00"); const [days, setDays] = React.useState("60")
  const [loading, setLoading] = React.useState(true); const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(""); const [notice, setNotice] = React.useState("")
  const [renewedDealIds, setRenewedDealIds] = React.useState<Record<string, string>>({})
  const load = React.useCallback(async () => {
    setLoading(true); setError("")
    try { const [policyData, actionData, advanceData, dealData] = await Promise.all([requestJson<{ policy: Policy | null }>("/api/mca/renewals/policy"), requestJson<{ actions: RenewalAction[] }>("/api/mca/renewals"), requestJson<{ advances: AdvanceSummary[] }>("/api/mca/advances"), requestJson<DealListResponse>("/api/mca/deals")]); setPolicy(policyData.policy); setActions(actionData.actions); setAdvances(advanceData.advances); setDeals(dealData.deals); if (policyData.policy) { setThreshold((policyData.policy.paidInThresholdBasisPoints / 100).toFixed(2)); setDays(String(policyData.policy.minimumDaysSinceFunding)) } }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Renewals could not be loaded.") }
    finally { setLoading(false) }
  }, [])
  React.useEffect(() => { void load() }, [load])
  async function savePolicy(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("")
    const parsed = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(threshold)
    if (!parsed) { setError("Threshold must be a percentage with up to two decimal places."); setBusy(false); return }
    const basisPoints = Number(parsed[1]) * 100 + Number((parsed[2] ?? "").padEnd(2, "0"))
    try { await requestJson("/api/mca/renewals/policy", { method: "PUT", body: JSON.stringify({ paidInThresholdBasisPoints: basisPoints, minimumDaysSinceFunding: Number(days) }) }); setNotice("Renewal policy version saved."); await load() }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Policy could not be saved.") } finally { setBusy(false) }
  }
  async function run() { setBusy(true); setError(""); setNotice(""); try { const result = await requestJson<{ created: number }>("/api/mca/renewals", { method: "POST" }); setNotice(`${result.created} advance-specific renewal action${result.created === 1 ? "" : "s"} created.`); await load() } catch (caught) { setError(caught instanceof Error ? caught.message : "Eligibility could not run.") } finally { setBusy(false) } }
  async function saveAction(item: RenewalAction) { setBusy(true); setError(""); try { await requestJson(`/api/mca/renewals/${item.id}`, { method: "PATCH", body: JSON.stringify({ messageSubject: item.messageSubject, messageBody: item.messageBody }) }); setNotice("Renewal preview saved."); await load() } catch (caught) { setError(caught instanceof Error ? caught.message : "Preview could not be saved.") } finally { setBusy(false) } }
  async function requestDocuments(item: RenewalAction) { setBusy(true); setError(""); try { await requestJson(`/api/mca/renewals/${item.id}`, { method: "PATCH", body: JSON.stringify({ requestDocumentation: true }) }); setNotice("Fresh statement and voided-check tasks created for this advance. No message was sent."); await load() } catch (caught) { setError(caught instanceof Error ? caught.message : "Document tasks could not be created.") } finally { setBusy(false) } }
  async function linkRenewedDeal(item: RenewalAction) { const renewedDealId = renewedDealIds[item.id]?.trim() || item.renewedDealId; if (!renewedDealId) { setError("Choose the new repeat-funding deal."); return } setBusy(true); setError(""); try { await requestJson(`/api/mca/renewals/${item.id}`, { method: "PATCH", body: JSON.stringify({ renewedDealId, state: "converted" }) }); setNotice("Repeat-funding lineage linked without changing the original advance or commissions."); await load() } catch (caught) { setError(caught instanceof Error ? caught.message : "Renewed deal could not be linked.") } finally { setBusy(false) } }
  function edit(id: string, patch: Partial<RenewalAction>) { setActions((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item)) }
  return <div className="space-y-4"><Card><CardHeader><CardTitle>Renewal eligibility</CardTitle><CardDescription>Eligibility is calculated for each advance using scheduled estimates and a versioned policy.</CardDescription></CardHeader><CardContent className="space-y-4">{error && <p role="alert" className="flex items-center gap-2 text-sm text-destructive"><AlertCircle className="size-4" />{error}</p>}{notice && <p role="status" className="text-sm text-emerald-700">{notice}</p>}<form className="grid gap-3 sm:grid-cols-3" onSubmit={savePolicy}><div><Label htmlFor="renewal-threshold">Paid-in threshold %</Label><Input id="renewal-threshold" inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} /></div><div><Label htmlFor="renewal-days">Minimum days funded</Label><Input id="renewal-days" type="number" min="0" step="1" value={days} onChange={(e) => setDays(e.target.value)} /></div><div className="flex items-end gap-2"><Button disabled={busy} type="submit"><Save className="size-4" />Save policy</Button><Button disabled={busy || !policy} type="button" variant="outline" onClick={() => void run()}><Play className="size-4" />Run eligibility</Button></div></form></CardContent></Card>
  <Card><CardHeader><CardTitle>Advance-specific follow-up</CardTitle><CardDescription>Edit previews, create fresh-document tasks, and link repeat-funding lineage.</CardDescription></CardHeader><CardContent>{loading ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading renewal actions…</p> : actions.length === 0 ? <p className="text-sm text-muted-foreground">No advances currently qualify for renewal follow-up.</p> : <div className="space-y-4">{actions.map((item) => { const sourceDealId = advances.find((advance) => advance.id === item.sourceAdvanceId)?.dealId; const availableDeals = deals.filter((deal) => deal.id !== sourceDealId); return <div className="space-y-3 rounded border p-4" key={item.id}><p className="text-sm font-medium">Advance {item.sourceAdvanceId.slice(0, 8)} · {item.state.replace(/_/g, " ")}</p><Input aria-label="Renewal subject" value={item.messageSubject} onChange={(e) => edit(item.id, { messageSubject: e.target.value })} /><Textarea aria-label="Renewal message" value={item.messageBody} onChange={(e) => edit(item.id, { messageBody: e.target.value })} /><div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy} onClick={() => void saveAction(item)}>Save preview</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => void requestDocuments(item)}>Request fresh documents</Button></div><div className="flex gap-2"><Select value={renewedDealIds[item.id] ?? item.renewedDealId ?? undefined} onValueChange={(renewedDealId) => setRenewedDealIds((current) => ({ ...current, [item.id]: renewedDealId }))}><SelectTrigger aria-label="New repeat-funding deal"><SelectValue placeholder="Choose accessible deal" /></SelectTrigger><SelectContent>{availableDeals.map((deal) => <SelectItem key={deal.id} value={deal.id}>{deal.legalName}{deal.dbaName ? ` (${deal.dbaName})` : ""} · {deal.displayId}</SelectItem>)}</SelectContent></Select><Button size="sm" variant="outline" disabled={busy || availableDeals.length === 0} onClick={() => void linkRenewedDeal(item)}>Link renewed deal</Button></div>{availableDeals.length === 0 && <p className="text-xs text-muted-foreground">No other accessible deals are available to link.</p>}</div> })}</div>}</CardContent></Card></div>
}

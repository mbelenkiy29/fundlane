"use client"

import { AssistantButton, useAssistantDeal } from "@/components/mca/assistant/assistant-panel"
import { useCallback, useEffect, useMemo, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import {
  AlertCircle, ArrowRight, Building2, Columns3, FileWarning, History, LayoutList,
  Loader2, Plus, RefreshCw, Search, StickyNote,
} from "lucide-react"
import { toast } from "sonner"
import { CalendarWorkspace } from "@/components/mca/calendar/calendar-workspace"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { allowedTransitions } from "@/lib/mca/deals/pipeline"
import { DealForm, emptyDraft, formPayload, type DraftForm } from "@/components/mca/deals/deal-form"
import { useNewDeal } from "@/components/mca/deals/new-deal-provider"
import { DocumentPanel } from "@/components/mca/documents/document-panel"
import { DataMerchPanel } from "@/components/mca/datamerch/data-merch-panel"
import { AnalysisPanel } from "@/components/mca/underwriting/analysis-panel"
import { CompletenessPanel } from "@/components/mca/underwriting/completeness-panel"
import { CorrectionPanel } from "@/components/mca/underwriting/correction-panel"
import { ReviewPanel } from "@/components/mca/underwriting/review-panel"
import { ScorePanel } from "@/components/mca/underwriting/score-panel"
import { StatementPanel } from "@/components/mca/underwriting/statement-panel"
import { SelectionPanel } from "@/components/mca/submissions/selection-panel"
import { PortalPanel } from "@/components/mca/submissions/portal-panel"
import { EmailPreview } from "@/components/mca/submissions/email-preview"
import { ReplyQueue } from "@/components/mca/submissions/reply-queue"
import { OffersPanel } from "@/components/mca/offers/offers-panel"
import { ClosingPanel } from "@/components/mca/closing/closing-panel"
import { SmsInboxPanel } from "@/components/mca/sms/inbox-panel"
import { SmsComposerPanel } from "@/components/mca/sms/composer-panel"
import { ExportPanel } from "@/components/mca/exports/export-panel"
import { DealAssistant } from "@/components/mca/assistant/deal-assistant"
import { RemindFunder } from "@/components/mca/comms/remind-funder"
import {
  DEAL_STATUSES, DEAL_STATUS_LABELS,
  type DealConflict, type DealDetail, type DealFilters, type DealListResponse, type DealStatus,
} from "@/lib/mca/deals/schema"

type ViewMode = "table" | "kanban"

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })

function statusTone(status: DealStatus): string {
  if (["funded", "renewed"].includes(status)) return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
  if (["closed", "default"].includes(status)) return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300"
  if (["offer", "contract", "repricing"].includes(status)) return "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300"
  return "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300"
}

function statusBadge(status: DealStatus) {
  return <Badge variant="outline" className={statusTone(status)}>{DEAL_STATUS_LABELS[status]}</Badge>
}

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json()
  if (!response.ok) throw Object.assign(new Error(body.error?.message ?? "Request failed."), { status: response.status, body })
  return body as T
}

function dealToDraft(deal: DealDetail): DraftForm {
  return {
    legalName: deal.legalName ?? "", dbaName: deal.dbaName ?? "", ein: deal.ein?.includes("•") ? "" : deal.ein ?? "", entityType: deal.entityType ?? "",
    line1: deal.address?.line1 ?? "", city: deal.address?.city ?? "", state: deal.address?.state ?? "", postalCode: deal.address?.postalCode ?? "",
    contactName: deal.contactName ?? "", contactEmail: deal.contactEmail ?? "", contactPhone: deal.contactPhone ?? "", startDate: deal.startDate ?? "",
    industry: deal.industry ?? "", naicsCode: deal.naicsCode ?? "", monthlyRevenue: deal.monthlyRevenue?.toString() ?? "",
    ficoScore: deal.ficoScore?.toString() ?? "", fundingPurpose: deal.fundingPurpose ?? "", requestedAmount: deal.requestedAmount?.toString() ?? "",
    owners: deal.owners,
    originators: deal.assignments.filter((item) => item.kind === "originator").map((item) => item.membershipId).join(", "),
    closers: deal.assignments.filter((item) => item.kind === "closer").map((item) => item.membershipId).join(", "),
  }
}

export function DealsWorkspace() {
  const newDeal = useNewDeal()
  const [assistantRevision, setAssistantRevision] = useState(0)
  const [detailTabs, setDetailTabs] = useState<Record<string, string>>({})
  const router = useRouter(); const pathname = usePathname(); const searchParams = useSearchParams()
  const [result, setResult] = useState<DealListResponse | null>(null); const [loading, setLoading] = useState(true); const [failure, setFailure] = useState("")
  const [form, setForm] = useState<DraftForm>(emptyDraft); const [saving, setSaving] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({})
  const [selected, setSelected] = useState<DealDetail | null>(null); const [detailOpen, setDetailOpen] = useState(false); const [editMode, setEditMode] = useState(false)
  useAssistantDeal(selected?.id, selected?.displayId)
  const [conflict, setConflict] = useState<DealConflict | null>(null); const [note, setNote] = useState(""); const [transition, setTransition] = useState<DealStatus | "">("")
  const view = (searchParams.get("view") === "kanban" ? "kanban" : "table") as ViewMode

  const load = useCallback(async () => {
    setLoading(true); setFailure("")
    try {
      const params = new URLSearchParams(searchParams)
      params.delete("create")
      setResult(await responseJson<DealListResponse>(await fetch(`/api/mca/deals?${params}`, { cache: "no-store" })))
    }
    catch (error) { setFailure(error instanceof Error ? error.message : "Could not load deals.") }
    finally { setLoading(false) }
  }, [searchParams])
  useEffect(() => { void load() }, [load])

  const setParam = useCallback((key: string, value?: string) => { const params = new URLSearchParams(searchParams); if (value) params.set(key, value); else params.delete(key); router.replace(`${pathname}?${params}`) }, [pathname, router, searchParams])
  useEffect(() => {
    if (searchParams.get("create") !== "1") return
    newDeal.open()
    setParam("create", undefined)
  }, [searchParams, setParam, newDeal])
  const openDeal = useCallback(async (id: string) => {
    setDetailOpen(true); setSelected(null); setEditMode(false)
    try { const deal = await responseJson<DealDetail>(await fetch(`/api/mca/deals/${id}`, { cache: "no-store" })); setSelected(deal); setForm(dealToDraft(deal)) }
    catch (error) { toast.error(error instanceof Error ? error.message : "Could not load deal."); setDetailOpen(false) }
  }, [])
  useEffect(() => newDeal.subscribe((deal) => {
    toast.success(`${deal.displayId} saved as ${deal.draftState === "partial" ? "a partial draft" : "submission ready"}.`)
    void load().then(() => openDeal(deal.id))
  }), [newDeal, load, openDeal])
  const refreshWorkflow = async (id: string) => {
    try {
      const deal = await responseJson<DealDetail>(await fetch(`/api/mca/deals/${id}`, { cache: "no-store" }))
      setSelected((current) => current?.id === id ? deal : current)
      await load()
    } catch (error) { toast.error(error instanceof Error ? error.message : "Could not refresh deal.") }
  }
  useEffect(() => {
    const id = searchParams.get("deal")
    if (id && /^[0-9a-f-]{36}$/i.test(id)) void openDeal(id)
  }, [searchParams, openDeal])

  const saveEdit = async (expectedVersion = selected?.version) => {
    if (!selected || expectedVersion === undefined) return
    setSaving(true); setFieldErrors({})
    try {
      const updated = await responseJson<DealDetail>(await fetch(`/api/mca/deals/${selected.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...formPayload(form), expectedVersion }) }))
      setSelected(updated); setForm(dealToDraft(updated)); setEditMode(false); setConflict(null); toast.success("Deal updated."); await load()
    } catch (error) {
      const typed = error as Error & { status?: number; body?: { error?: DealConflict & { fieldErrors?: Record<string, string[]> } } }
      if (typed.status === 409 && typed.body?.error?.current) setConflict(typed.body.error)
      else { setFieldErrors(typed.body?.error?.fieldErrors ?? {}); toast.error(typed.message) }
    } finally { setSaving(false) }
  }

  const changeStatus = async () => {
    if (!selected || !transition) return
    setSaving(true)
    try { const response = await responseJson<{ deal: DealDetail }>(await fetch(`/api/mca/deals/${selected.id}/transition`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: transition, expectedVersion: selected.version }) })); setSelected(response.deal); setForm(dealToDraft(response.deal)); setTransition(""); toast.success(`Moved to ${DEAL_STATUS_LABELS[response.deal.status]}.`); await load() }
    catch (error) { const typed = error as Error & { status?: number; body?: { error?: DealConflict } }; if (typed.status === 409 && typed.body?.error?.current) { setSelected(typed.body.error.current); setForm(dealToDraft(typed.body.error.current)); toast.error("The deal changed. Current status loaded; choose the transition again.") } else toast.error(typed.message) }
    finally { setSaving(false) }
  }

  const addNote = async () => {
    if (!selected || !note.trim()) return
    setSaving(true)
    try { const updated = await responseJson<DealDetail>(await fetch(`/api/mca/deals/${selected.id}/notes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: note, expectedVersion: selected.version }) })); setSelected(updated); setNote(""); toast.success("Note added.") }
    catch (error) { const typed = error as Error & { status?: number; body?: { error?: DealConflict } }; if (typed.status === 409 && typed.body?.error?.current) { setSelected(typed.body.error.current); setForm(dealToDraft(typed.body.error.current)); toast.error("The deal changed. Your note is intact; review and add it again.") } else toast.error(typed.message) }
    finally { setSaving(false) }
  }

  const assignees = useMemo(() => [...new Set(result?.deals.flatMap((deal) => deal.assignments.map((item) => item.membershipId)) ?? [])], [result])
  const stages = useMemo(() => DEAL_STATUSES.filter((status) => (result?.counts[status] ?? 0) > 0 || ["lead", "new_application", "ready_to_submit", "submitted", "offer", "contract", "funded"].includes(status)), [result])
  const exportFilters = useMemo<DealFilters>(() => {
    const status = searchParams.get("status")
    return {
      search: searchParams.get("q")?.trim() || undefined,
      statuses: status && DEAL_STATUSES.includes(status as DealStatus) ? [status as DealStatus] : undefined,
      assignee: searchParams.get("assignee")?.trim() || undefined,
      createdFrom: searchParams.get("from") || undefined,
      createdTo: searchParams.get("to") || undefined,
      funder: searchParams.get("funder")?.trim() || undefined,
    }
  }, [searchParams])

  return <div className="space-y-5 px-4 lg:px-6">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground"><Building2 className="size-3.5" />Deal workspace</div><h1 className="text-2xl font-bold tracking-tight">Pipeline</h1><p className="text-sm text-muted-foreground">Work merchant applications from first contact through servicing events.</p></div><Button onClick={() => newDeal.open()}><Plus className="mr-2 size-4" />New deal</Button></div>
    <div className="grid gap-3 sm:grid-cols-3"><Card><CardContent className="pt-5"><p className="text-sm text-muted-foreground">Filtered deals</p><p className="mt-1 text-2xl font-semibold">{result?.total ?? "—"}</p></CardContent></Card><Card><CardContent className="pt-5"><p className="text-sm text-muted-foreground">Submission ready</p><p className="mt-1 text-2xl font-semibold">{result?.deals.filter((deal) => deal.draftState === "submission_ready").length ?? "—"}</p></CardContent></Card><Card><CardContent className="pt-5"><p className="text-sm text-muted-foreground">Needs information</p><p className="mt-1 text-2xl font-semibold">{result?.deals.filter((deal) => deal.draftState === "partial").length ?? "—"}</p></CardContent></Card></div>
    <Card><CardContent className="pt-5"><div className="grid gap-3 lg:grid-cols-[minmax(220px,1fr)_180px_180px_150px_150px_auto]">
      <div className="relative"><Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input className="pl-9" placeholder="Search name or deal ID" defaultValue={searchParams.get("q") ?? ""} onKeyDown={(event) => { if (event.key === "Enter") setParam("q", event.currentTarget.value) }} /></div>
      <Select value={searchParams.get("status") ?? "all"} onValueChange={(value) => setParam("status", value === "all" ? undefined : value)}><SelectTrigger><SelectValue placeholder="All statuses" /></SelectTrigger><SelectContent><SelectItem value="all">All statuses</SelectItem>{DEAL_STATUSES.map((status) => <SelectItem value={status} key={status}>{DEAL_STATUS_LABELS[status]}</SelectItem>)}</SelectContent></Select>
      <Select value={searchParams.get("assignee") ?? "all"} onValueChange={(value) => setParam("assignee", value === "all" ? undefined : value)}><SelectTrigger><SelectValue placeholder="All assignees" /></SelectTrigger><SelectContent><SelectItem value="all">All assignees</SelectItem>{assignees.map((id) => <SelectItem value={id} key={id}>{id.slice(0, 10)}…</SelectItem>)}</SelectContent></Select>
      <Input type="date" aria-label="Created from" value={searchParams.get("from") ?? ""} onChange={(event) => setParam("from", event.target.value)} /><Input type="date" aria-label="Created to" value={searchParams.get("to") ?? ""} onChange={(event) => setParam("to", event.target.value)} />
      <div className="flex rounded-md border p-1"><Button size="sm" aria-label="Table view" variant={view === "table" ? "secondary" : "ghost"} onClick={() => setParam("view", "table")}><LayoutList className="size-4" /></Button><Button size="sm" aria-label="Kanban view" variant={view === "kanban" ? "secondary" : "ghost"} onClick={() => setParam("view", "kanban")}><Columns3 className="size-4" /></Button></div>
    </div><div className="mt-3"><Input placeholder="Filter by funder name" value={searchParams.get("funder") ?? ""} onChange={(event) => setParam("funder", event.target.value || undefined)} /></div></CardContent></Card>
    <ExportPanel filters={exportFilters} />
    {loading ? <div className="space-y-3">{[0,1,2].map((item) => <Skeleton key={item} className="h-20 w-full" />)}</div> : failure ? <Card className="border-destructive/40"><CardContent className="flex flex-col items-center gap-3 py-10 text-center"><AlertCircle className="size-8 text-destructive" /><div><p className="font-medium">Deals could not be loaded</p><p className="text-sm text-muted-foreground">{failure}</p></div><Button variant="outline" onClick={() => void load()}><RefreshCw className="mr-2 size-4" />Retry</Button></CardContent></Card> : !result?.deals.length ? <Card><CardContent className="flex flex-col items-center gap-3 py-14 text-center"><div className="rounded-full bg-muted p-4"><Building2 className="size-7" /></div><div><p className="font-medium">No deals match this view</p><p className="text-sm text-muted-foreground">Clear filters or save a partial merchant application.</p></div><Button onClick={() => newDeal.open()}><Plus className="mr-2 size-4" />New deal</Button></CardContent></Card> : view === "table" ? <Card className="overflow-hidden"><Table><TableHeader><TableRow><TableHead>Merchant</TableHead><TableHead>Status</TableHead><TableHead>Requested</TableHead><TableHead>Assignees</TableHead><TableHead>Readiness</TableHead><TableHead>Updated</TableHead></TableRow></TableHeader><TableBody>{result.deals.map((deal) => <TableRow key={deal.id} className="cursor-pointer" onClick={() => void openDeal(deal.id)}><TableCell><p className="font-medium">{deal.legalName}</p><p className="text-xs text-muted-foreground">{deal.displayId}{deal.dbaName ? ` · ${deal.dbaName}` : ""}</p></TableCell><TableCell>{statusBadge(deal.status)}</TableCell><TableCell>{deal.requestedAmount ? money.format(deal.requestedAmount) : "—"}</TableCell><TableCell>{deal.assignments.length || "—"}</TableCell><TableCell>{deal.draftState === "partial" ? <span className="inline-flex items-center gap-1 text-amber-600"><FileWarning className="size-3.5" />{deal.missingRequiredFields.length} missing</span> : <span className="text-emerald-600">Ready</span>}</TableCell><TableCell className="text-muted-foreground">{new Date(deal.updatedAt).toLocaleDateString()}</TableCell></TableRow>)}</TableBody></Table></Card> : <div className="overflow-x-auto pb-3"><div className="flex min-w-max gap-3">{stages.map((status) => <div className="w-72 rounded-xl bg-muted/45 p-3" key={status}><div className="mb-3 flex items-center justify-between"><p className="text-sm font-medium">{DEAL_STATUS_LABELS[status]}</p><Badge variant="secondary">{result.counts[status] ?? 0}</Badge></div><div className="space-y-2">{result.deals.filter((deal) => deal.status === status).map((deal) => <Card className="cursor-pointer transition-shadow hover:shadow-sm" key={deal.id} onClick={() => void openDeal(deal.id)}><CardContent className="p-3"><p className="font-medium">{deal.legalName}</p><p className="text-xs text-muted-foreground">{deal.displayId}</p><div className="mt-3 flex items-center justify-between text-xs"><span>{deal.requestedAmount ? money.format(deal.requestedAmount) : "No request"}</span>{deal.draftState === "partial" && <span className="text-amber-600">{deal.missingRequiredFields.length} missing</span>}</div></CardContent></Card>)}</div></div>)}</div></div>}

    <Dialog open={detailOpen} onOpenChange={setDetailOpen}><DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-4xl">{!selected ? <><DialogHeader className="sr-only"><DialogTitle>Loading deal</DialogTitle><DialogDescription>Loading the selected merchant deal.</DialogDescription></DialogHeader><div className="space-y-3 py-8"><Skeleton className="h-8 w-48" /><Skeleton className="h-64 w-full" /></div></> : <><DialogHeader><div className="flex flex-wrap items-center gap-2"><DialogTitle>{selected.legalName || "Untitled draft"}</DialogTitle>{statusBadge(selected.status)}<Badge variant="secondary">v{selected.version}</Badge><AssistantButton onOpen={() => setDetailOpen(false)} /></div><DialogDescription>{selected.displayId} · Updated {new Date(selected.updatedAt).toLocaleString()}</DialogDescription></DialogHeader>
      {selected.missingRequiredFields.length > 0 && <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3"><div className="flex items-center gap-2 font-medium text-amber-700 dark:text-amber-300"><FileWarning className="size-4" />Partial draft · {selected.missingRequiredFields.length} submission fields missing</div><p className="mt-1 text-xs text-muted-foreground">{selected.missingRequiredFields.join(", ")}</p></div>}
      {detailOpen && <DealAssistant key={selected.id} dealId={selected.id} onChanged={() => { void fetch(`/api/mca/deals/${selected.id}`).then(responseJson<DealDetail>).then(deal => { setSelected(current => current?.id === deal.id ? deal : current); setAssistantRevision(value => value + 1) }).catch(() => {}) }} />}
      {editMode ? <DealForm form={form} setForm={setForm} fieldErrors={fieldErrors} /> : <Tabs key={assistantRevision} onValueChange={tab => setDetailTabs(current => ({ ...current, [selected.id]: tab }))} defaultValue={detailTabs[selected.id] ?? (searchParams.get("addDocument") === "1" ? "documents" : ["schedule", "submissions", "offers", "messages", "underwriting", "documents", "activity"].includes(searchParams.get("tab") ?? "") ? searchParams.get("tab")! : "application")}><TabsList className="h-auto flex-wrap justify-start"><TabsTrigger value="application">Application</TabsTrigger><TabsTrigger value="owners">Owners</TabsTrigger><TabsTrigger value="documents">Documents</TabsTrigger><TabsTrigger value="underwriting">Underwriting</TabsTrigger><TabsTrigger value="submissions">Submissions</TabsTrigger><TabsTrigger value="messages">Messages</TabsTrigger><TabsTrigger value="offers">Offers</TabsTrigger><TabsTrigger value="closing">Closing</TabsTrigger><TabsTrigger value="schedule">Schedule</TabsTrigger><TabsTrigger value="activity">Activity</TabsTrigger></TabsList><TabsContent value="application" className="space-y-4"><div className="grid gap-3 rounded-lg border p-4 sm:grid-cols-3">{[["Legal name",selected.legalName],["DBA",selected.dbaName],["EIN",selected.ein],["Entity",selected.entityType?.replace(/_/g," ")],["Industry",selected.industry],["NAICS",selected.naicsCode],["Revenue",selected.monthlyRevenue ? money.format(selected.monthlyRevenue) : undefined],["Requested",selected.requestedAmount ? money.format(selected.requestedAmount) : undefined],["FICO",selected.ficoScore]].map(([label,value]) => <div key={String(label)}><p className="text-xs text-muted-foreground">{label}</p><p className="text-sm font-medium">{value || "—"}</p></div>)}</div><div className="rounded-lg border p-3"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Field sources</p><div className="mt-2 flex flex-wrap gap-2">{Object.entries(selected.fieldSources).map(([field, source]) => <Badge variant="secondary" key={field}>{field}: {source.source.replace(/_/g, " ")}</Badge>)}</div></div><div className="flex flex-wrap items-end gap-2"><div className="min-w-48 flex-1 space-y-1.5"><Label>Move status</Label><Select value={transition} onValueChange={(value) => setTransition(value as DealStatus)}><SelectTrigger><SelectValue placeholder="Choose next status" /></SelectTrigger><SelectContent>{allowedTransitions(selected.status).map((status) => <SelectItem value={status} key={status}>{DEAL_STATUS_LABELS[status]}</SelectItem>)}</SelectContent></Select></div><Button onClick={() => void changeStatus()} disabled={!transition || saving}>Move<ArrowRight className="ml-2 size-4" /></Button></div></TabsContent><TabsContent value="owners" className="space-y-2">{selected.owners.length ? selected.owners.map((owner) => <div className="rounded-lg border p-3" key={owner.id}><div className="flex items-center justify-between"><p className="font-medium">{owner.firstName} {owner.lastName}</p>{owner.isPrimary && <Badge>Primary</Badge>}</div><div className="mt-2 grid gap-2 text-sm text-muted-foreground sm:grid-cols-3"><span>{owner.ownershipPercent ?? "—"}% ownership</span><span>{owner.email ?? "No email"}</span><span>{owner.identityLast4 ? `ID ${owner.identityLast4}` : "No identity value"}</span></div></div>) : <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No owners recorded.</p>}</TabsContent><TabsContent value="documents"><DocumentPanel dealId={selected.id} onRefresh={() => void openDeal(selected.id)} /></TabsContent><TabsContent value="underwriting" className="space-y-4"><CompletenessPanel dealId={selected.id} /><StatementPanel dealId={selected.id} /><CorrectionPanel dealId={selected.id} /><ScorePanel dealId={selected.id} /><AnalysisPanel dealId={selected.id} /><ReviewPanel dealId={selected.id} /><DataMerchPanel dealId={selected.id} /></TabsContent><TabsContent value="submissions" className="space-y-4"><SelectionPanel dealId={selected.id} /><RemindFunder dealId={selected.id} /><PortalPanel dealId={selected.id} /><EmailPreview dealId={selected.id} /><ReplyQueue dealId={selected.id} /></TabsContent><TabsContent value="messages" className="space-y-4"><SmsComposerPanel dealId={selected.id} /><SmsInboxPanel dealId={selected.id} /></TabsContent><TabsContent value="offers"><OffersPanel dealId={selected.id} onChanged={() => void refreshWorkflow(selected.id)} /></TabsContent><TabsContent value="closing"><ClosingPanel dealId={selected.id} onChanged={() => void refreshWorkflow(selected.id)} /></TabsContent><TabsContent value="schedule"><CalendarWorkspace dealId={selected.id} /></TabsContent><TabsContent value="activity" className="space-y-4"><div className="flex gap-2"><Textarea aria-label="Internal note" placeholder="Add an internal note" value={note} onChange={(event) => setNote(event.target.value)} /><Button aria-label="Add note" onClick={() => void addNote()} disabled={!note.trim() || saving}><StickyNote className="size-4" /></Button></div>{selected.notes.length > 0 && <div className="space-y-2">{[...selected.notes].reverse().map((item) => <div className="rounded-lg border bg-muted/30 p-3" key={item.id}><p className="text-sm">{item.body}</p><p className="mt-1 text-xs text-muted-foreground">{new Date(item.createdAt).toLocaleString()}</p></div>)}</div>}<div className="space-y-3">{[...selected.activity].reverse().map((item) => <div className="flex gap-3" key={item.id}><div className="mt-0.5 rounded-full bg-muted p-1.5"><History className="size-3.5" /></div><div><p className="text-sm">{item.summary}</p><p className="text-xs text-muted-foreground">{new Date(item.createdAt).toLocaleString()} · v{item.version}</p></div></div>)}</div></TabsContent></Tabs>}
      <DialogFooter>{editMode ? <><Button variant="outline" onClick={() => { setForm(dealToDraft(selected)); setEditMode(false) }}>Cancel</Button><Button onClick={() => void saveEdit()} disabled={saving}>{saving && <Loader2 className="mr-2 size-4 animate-spin" />}Save changes</Button></> : <Button onClick={() => setEditMode(true)}>Edit application</Button>}</DialogFooter></>}</DialogContent></Dialog>

    <Dialog open={Boolean(conflict)} onOpenChange={(open) => !open && setConflict(null)}><DialogContent><DialogHeader><DialogTitle>Newer deal version found</DialogTitle><DialogDescription>{conflict?.message}</DialogDescription></DialogHeader><div className="rounded-lg border p-3 text-sm"><p className="font-medium">Your form is still intact.</p><p className="text-muted-foreground">Server version: {conflict?.current.version}. Fields in your attempted save: {conflict?.attemptedFields.join(", ")}.</p></div><DialogFooter className="gap-2"><Button variant="outline" onClick={() => { if (conflict) { setSelected(conflict.current); setForm(dealToDraft(conflict.current)) } setConflict(null) }}>Reload current</Button><Button onClick={() => conflict && void saveEdit(conflict.current.version)} disabled={saving}><RefreshCw className="mr-2 size-4" />Keep mine & retry</Button></DialogFooter></DialogContent></Dialog>
  </div>
}

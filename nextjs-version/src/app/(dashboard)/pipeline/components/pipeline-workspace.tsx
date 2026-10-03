"use client"

import { AssistantButton, useAssistantDeal } from "@/components/mca/assistant/assistant-panel"
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import {
  AlertCircle, ArrowRight, Building2, Columns3, History, LayoutList,
  Loader2, Plus, RefreshCw, Search, StickyNote,
} from "lucide-react"
import { CalendarWorkspace } from "@/components/mca/calendar/calendar-workspace"
import { toast } from "sonner"
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
import { allowedTransitions, pipelineHasFilters } from "@/lib/mca/deals/pipeline"
import { ENTITY_TYPE_LABELS } from "@/lib/mca/applications/form-schema"
import { dealListQueryString, parseDealListFilters } from "@/lib/mca/deals/filters"
import { createDealDetailSession } from "@/components/mca/deals/detail-session"
import { PipelineEmptyState } from "@/components/mca/pipeline/pipeline-empty-state"
import { DealForm, draftMissingRequiredFields, emptyDraft, formPayload, type DraftForm } from "@/components/mca/deals/deal-form"
import { MissingFieldsCount, MissingSubmissionFields } from "@/components/mca/deals/missing-submission-fields"
import { useNewDeal } from "@/components/mca/deals/new-deal-provider"
import { focusMissingRequiredField } from "@/lib/mca/deals/validation"
import { DocumentPanel } from "@/components/mca/documents/document-panel"
import { DataMerchPanel } from "@/components/mca/datamerch/data-merch-panel"
import { AnalysisPanel } from "@/components/mca/underwriting/analysis-panel"
import { AutoSubmitSettingsPanel } from "@/components/mca/underwriting/auto-submit-settings"
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
import { DealMessages } from "@/components/mca/email/deal-messages"
import { ExportPanel } from "@/components/mca/exports/export-panel"
import { BulkUpdatePanel } from "@/components/mca/imports/bulk-update-panel"
import { DealAssistant } from "@/components/mca/assistant/deal-assistant"
import { RemindFunder } from "@/components/mca/comms/remind-funder"
import {
  DEAL_STATUSES, DEAL_STATUS_LABELS,
  type DealConflict, type DealDetail, type DealListResponse, type DealStatus,
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

export function DealsWorkspace({ autoSubmitEnabled }: { autoSubmitEnabled: boolean }) {
  const newDeal = useNewDeal()
  const [assistantRevision, setAssistantRevision] = useState(0)
  const [messageChannels,setMessageChannels] = useState<Record<string,"sms"|"email">>({})
  const [detailTabs, setDetailTabs] = useState<Record<string, string>>({})
  const router = useRouter(); const pathname = usePathname(); const searchParams = useSearchParams()
  const [result, setResult] = useState<DealListResponse | null>(null); const [loading, setLoading] = useState(true); const [failure, setFailure] = useState("")
  const [form, setForm] = useState<DraftForm>(emptyDraft); const [saving, setSaving] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({})
  const [detailSession] = useState(() => createDealDetailSession(async (id) => responseJson<DealDetail>(await fetch(`/api/mca/deals/${id}`, { cache: "no-store" }))))
  const detailState = useSyncExternalStore(detailSession.subscribe, detailSession.getSnapshot, detailSession.getSnapshot)
  const { selected, note, transition } = detailState
  // Child panels retain this render's token while their own async work runs.
  const detailToken = detailSession.capture()
  const [assistantContext, setAssistantContext] = useState<Pick<DealDetail, "id" | "displayId"> | null>(null)
  const setSelected = (deal: DealDetail) => detailSession.update(deal)
  const setNote = detailSession.setNote; const setTransition = detailSession.setTransition
  const [detailOpen, setDetailOpen] = useState(false); const [editMode, setEditMode] = useState(false); const [focusField, setFocusField] = useState<string | null>(null)
  useAssistantDeal(selected?.id ?? assistantContext?.id, selected?.displayId ?? assistantContext?.displayId)
  const [conflict, setConflict] = useState<DealConflict | null>(null)
  const urlFunder = searchParams.get("funder") ?? ""
  const [funderDraft, setFunderDraft] = useState(urlFunder)
  const lastUrlFunder = useRef(urlFunder)
  if (lastUrlFunder.current !== urlFunder) {
    lastUrlFunder.current = urlFunder
    setFunderDraft(urlFunder)
  }
  const view = (searchParams.get("view") === "kanban" ? "kanban" : "table") as ViewMode
  const listQuery = useMemo(() => dealListQueryString(searchParams), [searchParams])
  const listFilters = useMemo(() => {
    const parsed = parseDealListFilters(searchParams, "omit")
    return parsed.ok ? parsed.filters : {}
  }, [searchParams])
  const loadGeneration = useRef(0)
  const filtered = pipelineHasFilters(searchParams)

  const load = useCallback(async (signal?: AbortSignal) => {
    const requestId = ++loadGeneration.current
    setLoading(true); setFailure("")
    try {
      const path = listQuery ? `/api/mca/deals?${listQuery}` : "/api/mca/deals"
      const body = await responseJson<DealListResponse>(await fetch(path, { cache: "no-store", signal }))
      if (requestId !== loadGeneration.current) return
      setResult(body)
    }
    catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) return
      if (requestId !== loadGeneration.current) return
      setFailure(error instanceof Error ? error.message : "Could not load deals.")
    }
    finally { if (requestId === loadGeneration.current) setLoading(false) }
  }, [listQuery])
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  const setParam = useCallback((key: string, value?: string) => { const params = new URLSearchParams(searchParams); if (value) params.set(key, value); else params.delete(key); router.replace(`${pathname}?${params}`) }, [pathname, router, searchParams])
  const searchParamsRef = useRef(searchParams)
  const setParamRef = useRef(setParam)
  searchParamsRef.current = searchParams
  setParamRef.current = setParam
  useEffect(() => {
    const handle = window.setTimeout(() => {
      const next = funderDraft.trim() || undefined
      const current = searchParamsRef.current.get("funder")?.trim() || undefined
      if (next !== current) setParamRef.current("funder", next)
    }, 300)
    return () => window.clearTimeout(handle)
  }, [funderDraft])
  useEffect(() => {
    if (searchParams.get("create") !== "1") return
    newDeal.open()
    setParam("create", undefined)
  }, [searchParams, setParam, newDeal])
  const openDeal = useCallback(async (id: string) => {
    setAssistantContext(null); setDetailOpen(true); setEditMode(false); setFocusField(null); setConflict(null)
    setFieldErrors({}); setSaving(false); setForm(emptyDraft)
    const pending = detailSession.open(id)
    const token = detailSession.capture()
    await pending
    const deal = detailSession.getSnapshot().selected
    if (detailSession.isCurrent(token) && deal) setForm(dealToDraft(deal))
  }, [detailSession])
  const closeDetail = (open: boolean) => {
    setDetailOpen(open)
    if (!open) { detailSession.close(); setConflict(null); setAssistantContext(null) }
  }
  useEffect(() => () => detailSession.close(), [detailSession])
  useEffect(() => newDeal.subscribe((deal) => {
    toast.success(`${deal.displayId} saved as ${deal.draftState === "partial" ? "a partial draft" : "submission ready"}.`)
    void load().then(() => openDeal(deal.id))
  }), [newDeal, load, openDeal])
  const refreshWorkflow = async (id: string, token = detailToken) => {
    if (!detailSession.isCurrent(token)) return
    try {
      const deal = await responseJson<DealDetail>(await fetch(`/api/mca/deals/${id}`, { cache: "no-store" }))
      if (!detailSession.isCurrent(token)) return
      detailSession.update(deal)
      await load()
    } catch (error) { if (detailSession.isCurrent(token)) toast.error(error instanceof Error ? error.message : "Could not refresh deal.") }
  }
  useEffect(() => {
    const id = searchParams.get("deal")
    if (id && /^[0-9a-f-]{36}$/i.test(id)) void openDeal(id)
  }, [searchParams, openDeal])
  useEffect(() => {
    if (!editMode || !focusField) return
    focusMissingRequiredField(focusField, document)
    setFocusField(null)
  }, [editMode, focusField])

  const saveEdit = async (expectedVersion = selected?.version) => {
    if (!selected || expectedVersion === undefined) return
    const token = detailSession.capture()
    setSaving(true); setFieldErrors({})
    try {
      const updated = await responseJson<DealDetail>(await fetch(`/api/mca/deals/${selected.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...formPayload(form), expectedVersion }) }))
      if (!detailSession.isCurrent(token) || !detailSession.update(updated)) return
      setForm(dealToDraft(updated)); setEditMode(false); setConflict(null); toast.success("Deal updated."); await load()
    } catch (error) {
      if (!detailSession.isCurrent(token)) return
      const typed = error as Error & { status?: number; body?: { error?: DealConflict & { fieldErrors?: Record<string, string[]> } } }
      if (typed.status === 409 && typed.body?.error?.current) setConflict(typed.body.error)
      else { setFieldErrors(typed.body?.error?.fieldErrors ?? {}); toast.error(typed.message) }
    } finally { if (detailSession.isCurrent(token)) setSaving(false) }
  }

  const changeStatus = async () => {
    if (!selected || !transition) return
    const token = detailSession.capture()
    setSaving(true)
    try { const response = await responseJson<{ deal: DealDetail }>(await fetch(`/api/mca/deals/${selected.id}/transition`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: transition, expectedVersion: selected.version }) })); if (!detailSession.isCurrent(token) || !detailSession.update(response.deal)) return; setForm(dealToDraft(response.deal)); setTransition(""); toast.success(`Moved to ${DEAL_STATUS_LABELS[response.deal.status]}.`); await load() }
    catch (error) { if (!detailSession.isCurrent(token)) return; const typed = error as Error & { status?: number; body?: { error?: DealConflict } }; if (typed.status === 409 && typed.body?.error?.current) { if (setSelected(typed.body.error.current)) setForm(dealToDraft(typed.body.error.current)); toast.error("The deal changed. Current status loaded; choose the transition again.") } else toast.error(typed.message) }
    finally { if (detailSession.isCurrent(token)) setSaving(false) }
  }

  const addNote = async () => {
    if (!selected || !note.trim()) return
    const token = detailSession.capture()
    setSaving(true)
    try { const updated = await responseJson<DealDetail>(await fetch(`/api/mca/deals/${selected.id}/notes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: note, expectedVersion: selected.version }) })); if (!detailSession.isCurrent(token) || !detailSession.update(updated)) return; setNote(""); toast.success("Note added.") }
    catch (error) { if (!detailSession.isCurrent(token)) return; const typed = error as Error & { status?: number; body?: { error?: DealConflict } }; if (typed.status === 409 && typed.body?.error?.current) { if (setSelected(typed.body.error.current)) setForm(dealToDraft(typed.body.error.current)); toast.error("The deal changed. Your note is intact; review and add it again.") } else toast.error(typed.message) }
    finally { if (detailSession.isCurrent(token)) setSaving(false) }
  }

  const assignees = useMemo(() => [...new Set(result?.deals.flatMap((deal) => deal.assignments.map((item) => item.membershipId)) ?? [])], [result])
  const stages = useMemo(() => DEAL_STATUSES.filter((status) => (result?.counts[status] ?? 0) > 0 || ["lead", "new_application", "ready_to_submit", "submitted", "offer", "contract", "funded"].includes(status)), [result])
  const exportFilters = listFilters

  const dialogMissingFields = selected
    ? (editMode ? draftMissingRequiredFields(form) : selected.missingRequiredFields)
    : []

  return <div className="space-y-5 px-4 lg:px-6">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground"><Building2 className="size-3.5" />Deal workspace</div><h1 className="text-2xl font-bold tracking-tight">Pipeline</h1><p className="text-sm text-muted-foreground">Work merchant applications from first contact through servicing events.</p></div><Button onClick={() => newDeal.open()}><Plus className="mr-2 size-4" />New deal</Button></div>
    <div id="mca-export-panel"><ExportPanel filters={exportFilters} /></div>
    <BulkUpdatePanel />
    <div className="grid gap-3 sm:grid-cols-3"><Card><CardContent className="pt-5"><p className="text-sm text-muted-foreground">Filtered deals</p><p className="mt-1 text-2xl font-semibold">{result?.total ?? "—"}</p></CardContent></Card><Card><CardContent className="pt-5"><p className="text-sm text-muted-foreground">Submission ready</p><p className="mt-1 text-2xl font-semibold">{result?.deals.filter((deal) => deal.draftState === "submission_ready").length ?? "—"}</p></CardContent></Card><Card><CardContent className="pt-5"><p className="text-sm text-muted-foreground">Needs information</p><p className="mt-1 text-2xl font-semibold">{result?.deals.filter((deal) => deal.draftState === "partial").length ?? "—"}</p></CardContent></Card></div>
    <Card><CardContent className="pt-5"><div className="grid gap-3 lg:grid-cols-[minmax(220px,1fr)_180px_180px_150px_150px_auto]">
      <div className="relative"><Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input className="pl-9" placeholder="Search name or deal ID" defaultValue={searchParams.get("q") ?? ""} onKeyDown={(event) => { if (event.key === "Enter") setParam("q", event.currentTarget.value) }} /></div>
      <Select value={searchParams.get("status") && DEAL_STATUSES.includes(searchParams.get("status") as DealStatus) ? searchParams.get("status")! : "all"} onValueChange={(value) => setParam("status", value === "all" ? undefined : value)}><SelectTrigger><SelectValue placeholder="All statuses" /></SelectTrigger><SelectContent><SelectItem value="all">All statuses</SelectItem>{DEAL_STATUSES.map((status) => <SelectItem value={status} key={status}>{DEAL_STATUS_LABELS[status]}</SelectItem>)}</SelectContent></Select>
      <Select value={searchParams.get("assignee") ?? "all"} onValueChange={(value) => setParam("assignee", value === "all" ? undefined : value)}><SelectTrigger><SelectValue placeholder="All assignees" /></SelectTrigger><SelectContent><SelectItem value="all">All assignees</SelectItem>{assignees.map((id) => <SelectItem value={id} key={id}>{id.slice(0, 10)}…</SelectItem>)}</SelectContent></Select>
      <Input type="date" aria-label="Created from" value={listFilters.createdFrom ?? ""} onChange={(event) => setParam("from", event.target.value)} /><Input type="date" aria-label="Created to" value={listFilters.createdTo ?? ""} onChange={(event) => setParam("to", event.target.value)} />
      <div className="flex rounded-md border p-1"><Button size="sm" aria-label="Table view" variant={view === "table" ? "secondary" : "ghost"} onClick={() => setParam("view", "table")}><LayoutList className="size-4" /></Button><Button size="sm" aria-label="Kanban view" variant={view === "kanban" ? "secondary" : "ghost"} onClick={() => setParam("view", "kanban")}><Columns3 className="size-4" /></Button></div>
    </div><div className="mt-3"><Input placeholder="Filter by funder name" value={funderDraft} onChange={(event) => setFunderDraft(event.target.value)} /></div></CardContent></Card>
    {failure ? <Card className="border-destructive/40"><CardContent className="flex flex-col items-center gap-3 py-10 text-center"><AlertCircle className="size-8 text-destructive" /><div><p className="font-medium">Deals could not be loaded</p><p className="text-sm text-muted-foreground">{failure}</p></div><Button variant="outline" onClick={() => void load()}><RefreshCw className="mr-2 size-4" />Retry</Button></CardContent></Card> : null}
    {loading && result ? <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="size-4 animate-spin" />Updating deals…</p> : null}
    {loading && !result && !failure ? <div className="space-y-3" role="status" aria-label="Loading deals">{[0,1,2].map((item) => <Skeleton key={item} className="h-20 w-full" />)}</div> : !result?.deals.length && !failure ? <PipelineEmptyState filtered={filtered} onCreate={() => newDeal.open()} /> : result?.deals.length && !failure ? view === "table" ? <Card className="overflow-hidden"><Table><TableHeader><TableRow><TableHead>Merchant</TableHead><TableHead>Status</TableHead><TableHead>Requested</TableHead><TableHead>Assignees</TableHead><TableHead>Readiness</TableHead><TableHead>Updated</TableHead></TableRow></TableHeader><TableBody>{result.deals.map((deal) => <TableRow key={deal.id} className="cursor-pointer" onClick={() => void openDeal(deal.id)}><TableCell><p className="font-medium">{deal.legalName}</p><p className="text-xs text-muted-foreground">{deal.displayId}{deal.dbaName ? ` · ${deal.dbaName}` : ""}</p></TableCell><TableCell>{statusBadge(deal.status)}</TableCell><TableCell>{deal.requestedAmount ? money.format(deal.requestedAmount) : "—"}</TableCell><TableCell>{deal.assignments.length || "—"}</TableCell><TableCell>{deal.draftState === "partial" ? <MissingFieldsCount fields={deal.missingRequiredFields} /> : <span className="text-emerald-600">Ready</span>}</TableCell><TableCell className="text-muted-foreground">{new Date(deal.updatedAt).toLocaleDateString("en-US")}</TableCell></TableRow>)}</TableBody></Table></Card> : <div className="overflow-x-auto pb-3"><div className="flex min-w-max gap-3">{stages.map((status) => <div className="w-72 rounded-xl bg-muted/45 p-3" key={status}><div className="mb-3 flex items-center justify-between"><p className="text-sm font-medium">{DEAL_STATUS_LABELS[status]}</p><Badge variant="secondary">{result.counts[status] ?? 0}</Badge></div><div className="space-y-2">{result.deals.filter((deal) => deal.status === status).map((deal) => <Card className="cursor-pointer transition-shadow hover:shadow-sm" key={deal.id} onClick={() => void openDeal(deal.id)}><CardContent className="p-3"><p className="font-medium">{deal.legalName}</p><p className="text-xs text-muted-foreground">{deal.displayId}</p><div className="mt-3 flex items-center justify-between text-xs"><span>{deal.requestedAmount ? money.format(deal.requestedAmount) : "No request"}</span>{deal.draftState === "partial" && <MissingFieldsCount fields={deal.missingRequiredFields} />}</div></CardContent></Card>)}</div></div>)}</div></div> : null}

    <Dialog open={detailOpen} onOpenChange={closeDetail}><DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-4xl">{!selected ? <><DialogHeader className="sr-only"><DialogTitle>{detailState.failure ? "Deal could not be loaded" : "Loading deal"}</DialogTitle><DialogDescription>Selected merchant deal details.</DialogDescription></DialogHeader>{detailState.failure ? <div className="space-y-3 py-8 text-center" role="alert"><p>{detailState.failure}</p><Button variant="outline" onClick={() => detailState.id && void openDeal(detailState.id)}><RefreshCw className="mr-2 size-4" />Retry</Button></div> : <div className="space-y-3 py-8" role="status" aria-label="Loading deal"><Skeleton className="h-8 w-48" /><Skeleton className="h-64 w-full" /></div>}</> : <><DialogHeader><div className="flex flex-wrap items-center gap-2"><DialogTitle>{selected.legalName || "Untitled draft"}</DialogTitle>{statusBadge(selected.status)}<Badge variant="secondary">v{selected.version}</Badge><AssistantButton onOpen={() => { const deal = detailSession.handoff(); setAssistantContext(deal ? { id: deal.id, displayId: deal.displayId } : null); setDetailOpen(false); setConflict(null) }} /></div><DialogDescription>{selected.displayId} · Updated {new Date(selected.updatedAt).toLocaleString("en-US")}</DialogDescription></DialogHeader>
      {!editMode && <div className="flex flex-wrap items-center gap-2 rounded-lg border p-3"><div className="mr-auto text-sm"><p className="font-medium">{selected.contactName || "Merchant contact"}</p><p className="text-muted-foreground">{selected.contactEmail || "No email"} · {selected.contactPhone || "No phone"}</p></div>{(["sms","email"] as const).map(channel=><Button key={channel} size="sm" variant="outline" onClick={()=>{setDetailTabs(current=>({...current,[selected.id]:"messages"}));setMessageChannels(current=>({...current,[selected.id]:channel}))}}>{channel==="sms"?"Text":"Email"}</Button>)}</div>}
      {dialogMissingFields.length > 0 && <MissingSubmissionFields fields={dialogMissingFields} onSelect={(field) => { setEditMode(true); setFocusField(field) }} />}
      {detailOpen && <DealAssistant key={selected.id} dealId={selected.id} onChanged={() => { const token = detailToken; if (!detailSession.isCurrent(token)) return; void fetch(`/api/mca/deals/${selected.id}`).then(responseJson<DealDetail>).then(deal => { if (detailSession.isCurrent(token) && detailSession.update(deal)) setAssistantRevision(value => value + 1) }).catch(() => {}) }} />}
      {editMode ? <DealForm form={form} setForm={setForm} fieldErrors={fieldErrors} /> : <Tabs key={assistantRevision} value={detailTabs[selected.id] ?? (searchParams.get("addDocument") === "1" ? "documents" : ["schedule", "submissions", "offers", "messages", "underwriting", "documents", "activity"].includes(searchParams.get("tab") ?? "") ? searchParams.get("tab")! : "application")} onValueChange={tab => setDetailTabs(current => ({ ...current, [selected.id]: tab }))}><TabsList className="h-auto flex-wrap justify-start"><TabsTrigger value="application">Application</TabsTrigger><TabsTrigger value="owners">Owners</TabsTrigger><TabsTrigger value="documents">Documents</TabsTrigger><TabsTrigger value="underwriting">Underwriting</TabsTrigger><TabsTrigger value="submissions">Submissions</TabsTrigger><TabsTrigger value="messages">Messages</TabsTrigger><TabsTrigger value="offers">Offers</TabsTrigger><TabsTrigger value="closing">Closing</TabsTrigger><TabsTrigger value="schedule">Schedule</TabsTrigger><TabsTrigger value="activity">Activity</TabsTrigger></TabsList><TabsContent value="application" className="space-y-4"><div className="grid gap-3 rounded-lg border p-4 sm:grid-cols-3">{[["Legal name",selected.legalName],["DBA",selected.dbaName],["EIN",selected.ein],["Entity",selected.entityType ? ENTITY_TYPE_LABELS[selected.entityType] ?? selected.entityType : undefined],["Industry",selected.industry],["NAICS",selected.naicsCode],["Revenue",selected.monthlyRevenue ? money.format(selected.monthlyRevenue) : undefined],["Requested",selected.requestedAmount ? money.format(selected.requestedAmount) : undefined],["FICO",selected.ficoScore]].map(([label,value]) => <div key={String(label)}><p className="text-xs text-muted-foreground">{label}</p><p className="text-sm font-medium">{value || "—"}</p></div>)}</div><div className="rounded-lg border p-3"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Field sources</p><div className="mt-2 flex flex-wrap gap-2">{Object.entries(selected.fieldSources).map(([field, source]) => <Badge variant="secondary" key={field}>{field}: {source.source.replace(/_/g, " ")}</Badge>)}</div></div><div className="flex flex-wrap items-end gap-2"><div className="min-w-48 flex-1 space-y-1.5"><Label>Move status</Label><Select value={transition || undefined} onValueChange={(value) => setTransition(value as DealStatus)}><SelectTrigger><SelectValue placeholder="Choose next status" /></SelectTrigger><SelectContent>{allowedTransitions(selected.status).map((status) => <SelectItem value={status} key={status}>{DEAL_STATUS_LABELS[status]}</SelectItem>)}</SelectContent></Select></div><Button onClick={() => void changeStatus()} disabled={!transition || saving}>Move<ArrowRight className="ml-2 size-4" /></Button></div></TabsContent><TabsContent value="owners" className="space-y-2">{selected.owners.length ? selected.owners.map((owner) => <div className="rounded-lg border p-3" key={owner.id}><div className="flex items-center justify-between"><p className="font-medium">{owner.firstName} {owner.lastName}</p>{owner.isPrimary && <Badge>Primary</Badge>}</div><div className="mt-2 grid gap-2 text-sm text-muted-foreground sm:grid-cols-3"><span>{owner.ownershipPercent ?? "—"}% ownership</span><span>{owner.email ?? "No email"}</span><span>{owner.identityLast4 ? `ID ${owner.identityLast4}` : "No identity value"}</span></div></div>) : <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No owners recorded.</p>}</TabsContent><TabsContent value="documents"><DocumentPanel dealId={selected.id} onRefresh={() => void refreshWorkflow(selected.id)} /></TabsContent><TabsContent value="underwriting" className="space-y-4"><CompletenessPanel dealId={selected.id} /><StatementPanel dealId={selected.id} /><CorrectionPanel dealId={selected.id} /><ScorePanel dealId={selected.id} /><AnalysisPanel dealId={selected.id} /><AutoSubmitSettingsPanel enabled={autoSubmitEnabled} /><ReviewPanel dealId={selected.id} /><DataMerchPanel dealId={selected.id} /></TabsContent><TabsContent value="submissions" className="space-y-4"><SelectionPanel dealId={selected.id} /><RemindFunder dealId={selected.id} /><PortalPanel dealId={selected.id} /><EmailPreview dealId={selected.id} /><ReplyQueue dealId={selected.id} /></TabsContent><TabsContent value="messages" className="space-y-4"><DealMessages dealId={selected.id} channel={messageChannels[selected.id] ?? "sms"} /></TabsContent><TabsContent value="offers"><OffersPanel dealId={selected.id} onChanged={() => void refreshWorkflow(selected.id)} /></TabsContent><TabsContent value="closing"><ClosingPanel dealId={selected.id} onChanged={() => void refreshWorkflow(selected.id)} /></TabsContent><TabsContent value="schedule"><CalendarWorkspace dealId={selected.id} /></TabsContent><TabsContent value="activity" className="space-y-4"><div className="flex gap-2"><Textarea aria-label="Internal note" placeholder="Add an internal note" value={note} onChange={(event) => setNote(event.target.value)} /><Button aria-label="Add note" onClick={() => void addNote()} disabled={!note.trim() || saving}><StickyNote className="size-4" /></Button></div>{selected.notes.length > 0 && <div className="space-y-2">{[...selected.notes].reverse().map((item) => <div className="rounded-lg border bg-muted/30 p-3" key={item.id}><p className="text-sm">{item.body}</p><p className="mt-1 text-xs text-muted-foreground">{new Date(item.createdAt).toLocaleString()}</p></div>)}</div>}<div className="space-y-3">{[...selected.activity].reverse().map((item) => <div className="flex gap-3" key={item.id}><div className="mt-0.5 rounded-full bg-muted p-1.5"><History className="size-3.5" /></div><div><p className="text-sm">{item.summary}</p><p className="text-xs text-muted-foreground">{new Date(item.createdAt).toLocaleString()} · v{item.version}</p></div></div>)}</div></TabsContent></Tabs>}
      <DialogFooter>{editMode ? <><Button variant="outline" onClick={() => { setForm(dealToDraft(selected)); setEditMode(false); setFocusField(null) }}>Cancel</Button><Button onClick={() => void saveEdit()} disabled={saving}>{saving && <Loader2 className="mr-2 size-4 animate-spin" />}Save changes</Button></> : <Button onClick={() => setEditMode(true)}>Edit application</Button>}</DialogFooter></>}</DialogContent></Dialog>

    <Dialog open={Boolean(conflict)} onOpenChange={(open) => !open && setConflict(null)}><DialogContent><DialogHeader><DialogTitle>Newer deal version found</DialogTitle><DialogDescription>{conflict?.message}</DialogDescription></DialogHeader><div className="rounded-lg border p-3 text-sm"><p className="font-medium">Your form is still intact.</p><p className="text-muted-foreground">Server version: {conflict?.current.version}. Fields in your attempted save: {conflict?.attemptedFields.join(", ")}.</p></div><DialogFooter className="gap-2"><Button variant="outline" onClick={() => { if (conflict) { setSelected(conflict.current); setForm(dealToDraft(conflict.current)) } setConflict(null) }}>Reload current</Button><Button onClick={() => conflict && void saveEdit(conflict.current.version)} disabled={saving}><RefreshCw className="mr-2 size-4" />Keep mine & retry</Button></DialogFooter></DialogContent></Dialog>
  </div>
}

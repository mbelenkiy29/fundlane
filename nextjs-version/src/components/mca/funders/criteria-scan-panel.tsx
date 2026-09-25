"use client"

import * as React from "react"
import { AlertCircle, CheckCircle2, FileSearch, Loader2, Plus, RefreshCw, RotateCcw, ScanText, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { uploadMultipart } from "@/components/mca/documents/upload"
import { RequestError, requestJson } from "@/lib/mca/client"
import { CRITERIA_OPERATORS, CRITERIA_UNITS, type CriteriaOperator, type CriteriaUnit, type EligibilityRule } from "@/lib/mca/funders/contracts"
import type { SessionResponse } from "@/lib/mca/types"

type Evidence = { confidence: number; page?: number; text?: string; unknown?: boolean }
type Proposal = {
  id: string
  funderId: string
  documentId: string
  version: number
  rules: EligibilityRule[]
  warnings: string[]
  evidence: Record<string, Evidence>
  provider: string
  status: "proposed" | "accepted" | "rejected"
  contactsPreserved?: boolean
  ambiguousRanges?: Array<{ field: string; rangeText: string }>
  rolledBackAt?: string
  criteriaVersion?: number
}
type ListPayload = {
  proposals: Proposal[]
  currentRules: EligibilityRule[]
  documents?: Array<{ id: string; displayFilename: string; originalFilename: string; processingState: string; mimeType: string }>
}
type DealOption = { id: string; legalName: string; dbaName?: string; displayId: string }

const FIELDS = [
  "revenue", "fico", "time_in_business", "positions", "requested_amount", "term",
  "average_daily_balance", "deposit_count", "nsf", "negative_days", "default_status",
  "entity", "state", "industry",
] as const

type RuleDraft = {
  key: string
  id?: string
  field: (typeof FIELDS)[number]
  operator: CriteriaOperator
  unit: CriteriaUnit
  value: string
  sourceText: string
  unspecified: boolean
}

function formatValue(value: EligibilityRule["value"]): string {
  if (value == null) return ""
  if (Array.isArray(value)) return value.join(", ")
  if (typeof value === "boolean") return value ? "true" : "false"
  return String(value)
}

function fromRule(rule: EligibilityRule): RuleDraft {
  return {
    key: rule.id,
    id: rule.id,
    field: FIELDS.includes(rule.field as (typeof FIELDS)[number]) ? rule.field as (typeof FIELDS)[number] : "revenue",
    operator: rule.operator,
    unit: rule.unit,
    value: formatValue(rule.value),
    sourceText: rule.sourceText ?? "",
    unspecified: rule.unspecified,
  }
}

function payloadValue(draft: RuleDraft): EligibilityRule["value"] {
  if (draft.unspecified) return null
  if (draft.operator === "in" || draft.operator === "not_in") {
    return draft.value.split(",").map((item) => item.trim()).filter(Boolean)
  }
  if (draft.unit === "boolean" || draft.value === "true" || draft.value === "false") return draft.value === "true"
  const numeric = Number(draft.value)
  return draft.value.trim() !== "" && Number.isFinite(numeric) ? numeric : draft.value
}

function emptyRule(): RuleDraft {
  return { key: crypto.randomUUID(), field: "revenue", operator: "min", unit: "usd_monthly", value: "", sourceText: "", unspecified: false }
}

function importStatus(proposal: Proposal): string {
  if (proposal.rolledBackAt) return "Undone"
  if (proposal.status === "accepted") return "Applied"
  if (proposal.status === "rejected") return "Discarded"
  return "Awaiting review"
}

export function CriteriaScanPanel({ funderId }: { funderId: string }) {
  const [payload, setPayload] = React.useState<ListPayload>()
  const [deals, setDeals] = React.useState<DealOption[]>([])
  const [selected, setSelected] = React.useState<Proposal>()
  const [dealId, setDealId] = React.useState("")
  const [documentId, setDocumentId] = React.useState("")
  const [file, setFile] = React.useState<File>()
  const [ruleDrafts, setRuleDrafts] = React.useState<RuleDraft[]>([])
  const [canManage, setCanManage] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")
  const [notice, setNotice] = React.useState("")
  const [uploadProgress, setUploadProgress] = React.useState<number>()
  const uploadKeys = React.useRef(new Map<string, string>())
  const loadVersion = React.useRef(0)
  const fileInput = React.useRef<HTMLInputElement>(null)

  const load = React.useCallback(async () => {
    const version = ++loadVersion.current
    setLoading(true); setError("")
    try {
      const query = new URLSearchParams({ funderId })
      if (dealId.trim()) query.set("dealId", dealId.trim())
      const [listed, dealList, session] = await Promise.all([
        requestJson<ListPayload>(`/api/mca/funders/scan?${query.toString()}`),
        requestJson<{ deals: DealOption[] }>("/api/mca/deals"),
        requestJson<SessionResponse>("/api/auth/session"),
      ])
      if (version !== loadVersion.current) return
      setPayload(listed)
      setDeals(dealList.deals)
      setCanManage(Boolean(session.permissions?.canManageWorkspace))
      setSelected((current) => listed.proposals.find((item) => item.id === current?.id) ?? listed.proposals.find((item) => item.status === "proposed") ?? listed.proposals[0])
    } catch (caught) {
      if (version === loadVersion.current) setError(caught instanceof Error ? caught.message : "Previous imports could not be loaded.")
    } finally {
      if (version === loadVersion.current) setLoading(false)
    }
  }, [funderId, dealId])

  React.useEffect(() => { void load() }, [load])
  React.useEffect(() => { setRuleDrafts(selected?.rules.map(fromRule) ?? []) }, [selected])

  function fail(caught: unknown, fallback: string) {
    setNotice("")
    setError(caught instanceof RequestError || caught instanceof Error ? caught.message : fallback)
  }

  async function scanExisting() {
    if (!documentId) { setError("Choose a criteria sheet from the selected deal."); return }
    setBusy(true); setError(""); setNotice("")
    try {
      const proposal = await requestJson<Proposal>("/api/mca/funders/scan", { method: "POST", body: JSON.stringify({ funderId, documentId: documentId.trim() }) })
      setSelected(proposal)
      setRuleDrafts(proposal.rules.map(fromRule))
      setNotice("Proposed criteria are ready. Review them before applying.")
      toast.success("Criteria imported for review")
      await load()
    } catch (caught) {
      fail(caught, "The criteria sheet could not be scanned.")
    } finally {
      setBusy(false)
    }
  }

  async function uploadAndScan() {
    if (!file) { setError("Choose a PDF, PNG, or JPEG criteria sheet."); return }
    setBusy(true); setError(""); setNotice("")
    const fingerprint = `${file.name}:${file.size}:${file.lastModified}`
    let key = uploadKeys.current.get(fingerprint)
    if (!key) { key = crypto.randomUUID(); uploadKeys.current.set(fingerprint, key) }
    try {
      const form = new FormData()
      form.set("funderId", funderId)
      if (dealId.trim()) form.set("dealId", dealId.trim())
      form.set("idempotencyKey", key)
      form.set("file", file)
      const proposal = await uploadMultipart<Proposal>("/api/mca/funders/scan", form, setUploadProgress)
      uploadKeys.current.delete(fingerprint)
      setFile(undefined)
      if (fileInput.current) fileInput.current.value = ""
      setSelected(proposal)
      setRuleDrafts(proposal.rules.map(fromRule))
      setNotice("Proposed criteria are ready. Review them before applying.")
      toast.success("Criteria imported for review")
      await load()
    } catch (caught) {
      fail(caught, "The criteria sheet could not be uploaded.")
    } finally {
      setBusy(false)
      setUploadProgress(undefined)
    }
  }

  async function decide(path: "accept" | "reject" | "rollback") {
    if (!selected) return
    setBusy(true); setError(""); setNotice("")
    try {
      const body = path === "accept"
        ? JSON.stringify({
          rules: ruleDrafts.map((rule) => ({
            id: rule.id,
            field: rule.field,
            operator: rule.operator,
            unit: rule.unit,
            value: payloadValue(rule),
            sourceText: rule.sourceText || undefined,
            unspecified: rule.unspecified,
          })),
        })
        : "{}"
      const result = await requestJson<Proposal | { proposal: Proposal }>(`/api/mca/funders/scan/${encodeURIComponent(selected.id)}/${path}`, { method: "POST", body })
      const proposal = "proposal" in result && result.proposal ? result.proposal : result as Proposal
      setSelected(proposal)
      setRuleDrafts(proposal.rules.map(fromRule))
      setNotice(path === "accept" ? "Reviewed criteria applied to this funder." : path === "reject" ? "Proposal discarded. Current rules were left unchanged." : "Previous eligibility rules restored.")
      toast.success(path === "accept" ? "Criteria applied" : path === "reject" ? "Proposal discarded" : "Import undone")
      await load()
    } catch (caught) {
      fail(caught, "The scan decision could not be saved.")
    } finally {
      setBusy(false)
    }
  }

  if (loading && !payload) {
    return <Card><CardContent className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="size-4 animate-spin" />Loading previous imports…</CardContent></Card>
  }

  if (error && !payload) {
    return <Card><CardContent className="flex min-h-40 items-center gap-3 p-6"><AlertCircle className="size-5 text-destructive" /><div className="flex-1"><p className="font-medium">Previous imports unavailable</p><p className="text-sm text-muted-foreground">{error}</p></div><Button variant="outline" onClick={() => void load()}><RefreshCw />Retry</Button></CardContent></Card>
  }

  const proposals = payload?.proposals ?? []
  return <div className="space-y-4">
    {(error || notice) && <div className={`rounded-lg border p-4 text-sm ${error ? "border-destructive/30 bg-destructive/5 text-destructive" : "border-emerald-500/30 bg-emerald-500/5"}`} role={error ? "alert" : "status"}>
      <div className="flex items-start gap-2">{error ? <AlertCircle className="mt-0.5 size-4 shrink-0" /> : <CheckCircle2 className="mt-0.5 size-4 shrink-0" />}<p>{error || notice}</p></div>
    </div>}

    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ScanText className="size-5" />Import lender criteria</CardTitle>
        <CardDescription>Upload a guideline PDF to propose eligibility fields. Edit the proposal, then confirm. Importing never changes live rules or funder contacts on its own. A deal vault is optional and only needed if you want to keep the sheet with a deal.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="scan-deal">Deal vault</Label>
            <Select value={dealId || undefined} disabled={busy || !canManage} onValueChange={(value) => { setDealId(value); setDocumentId(""); setPayload((current) => current ? { ...current, documents: [] } : current) }}>
              <SelectTrigger id="scan-deal"><SelectValue placeholder="Choose a deal" /></SelectTrigger>
              <SelectContent>{deals.map((deal) => <SelectItem key={deal.id} value={deal.id}>{deal.legalName}{deal.dbaName ? ` (${deal.dbaName})` : ""} · {deal.displayId}</SelectItem>)}</SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Optional. Use a deal vault only when you want to keep the sheet with that deal.</p>
            {!loading && !deals.length && <p className="text-xs text-muted-foreground">No deals available for storing a criteria sheet.</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="scan-document">Existing vault file</Label>
            <Select value={documentId || undefined} disabled={!canManage || busy || !dealId || loading || !payload?.documents?.length} onValueChange={setDocumentId}>
              <SelectTrigger id="scan-document"><SelectValue placeholder={dealId ? "Choose a ready PDF or image" : "Choose a deal first"} /></SelectTrigger>
              <SelectContent>{payload?.documents?.map((document) => <SelectItem key={document.id} value={document.id}>{document.displayFilename || document.originalFilename}</SelectItem>)}</SelectContent>
            </Select>
            {dealId && !loading && !payload?.documents?.length && <p className="text-xs text-muted-foreground">No ready PDF, PNG, or JPEG files in this vault. Upload a criteria sheet below.</p>}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
          <Input ref={fileInput} type="file" aria-label="New lender criteria sheet" accept="application/pdf,image/png,image/jpeg" disabled={!canManage || busy} onChange={(event) => setFile(event.target.files?.[0])} />
          {canManage ? <>
            <Button type="button" onClick={() => void uploadAndScan()} disabled={busy || !file}><FileSearch className="size-4" />Import new sheet</Button>
            <Button type="button" variant="outline" onClick={() => void scanExisting()} disabled={busy || !documentId}>Import selected sheet</Button>
          </> : <p className="text-sm text-muted-foreground">Only workspace admins can import or apply lender criteria.</p>}
        </div>
        {uploadProgress !== undefined && <p role="status" className="text-sm text-muted-foreground">Uploading: {uploadProgress}%</p>}
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>Previous imports</CardTitle>
        <CardDescription>Review a proposal before applying it. Discarding leaves live rules alone; undoing an applied import restores the previous rules.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!proposals.length ? <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No lender criteria have been imported yet.</div> : <ul className="space-y-2">
          {proposals.map((item) => <li key={item.id}>
            <button type="button" className={`flex w-full items-center justify-between gap-3 rounded-lg border p-3 text-left text-sm ${selected?.id === item.id ? "border-primary" : ""}`} onClick={() => setSelected(item)}>
              <span>Import {item.version}</span>
              <span className="flex items-center gap-2">
                <Badge variant={item.status === "accepted" && !item.rolledBackAt ? "default" : item.status === "rejected" ? "secondary" : "outline"}>{importStatus(item)}</Badge>
              </span>
            </button>
          </li>)}
        </ul>}

        {selected && <div className="space-y-4 rounded-lg border p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>Import {selected.version}</Badge>
            <Badge variant="outline">{selected.provider}</Badge>
            {selected.contactsPreserved && <Badge variant="secondary">Contacts preserved</Badge>}
            {selected.ambiguousRanges?.length ? <Badge variant="secondary">{selected.ambiguousRanges.length} ambiguous</Badge> : null}
          </div>
          {selected.warnings.length > 0 && <div className="rounded-md bg-amber-50 p-3 text-sm text-amber-950" role="status">{selected.warnings.join(" ")}</div>}
          {!ruleDrafts.length ? <p className="text-sm text-muted-foreground">This scan did not propose eligibility rules.</p> : <div className="space-y-2">
            {ruleDrafts.map((rule, index) => <div key={rule.key} className="space-y-2 rounded-md border p-2">
              <div className="grid gap-2 lg:grid-cols-[1fr_8rem_9rem_1fr_auto]">
                <Select value={rule.field} disabled={!canManage || selected.status !== "proposed" || busy} onValueChange={(field) => setRuleDrafts((current) => current.map((item) => item.key === rule.key ? { ...item, field: field as (typeof FIELDS)[number] } : item))}>
                  <SelectTrigger aria-label={`Proposed rule ${index + 1} field`}><SelectValue /></SelectTrigger>
                  <SelectContent>{FIELDS.map((field) => <SelectItem key={field} value={field}>{field.replace(/_/g, " ")}</SelectItem>)}</SelectContent>
                </Select>
                <Select value={rule.operator} disabled={!canManage || selected.status !== "proposed" || busy} onValueChange={(operator) => setRuleDrafts((current) => current.map((item) => item.key === rule.key ? { ...item, operator: operator as CriteriaOperator } : item))}>
                  <SelectTrigger aria-label={`Proposed rule ${index + 1} operator`}><SelectValue /></SelectTrigger>
                  <SelectContent>{CRITERIA_OPERATORS.map((operator) => <SelectItem key={operator} value={operator}>{operator}</SelectItem>)}</SelectContent>
                </Select>
                <Select value={rule.unit} disabled={!canManage || selected.status !== "proposed" || busy || rule.unspecified} onValueChange={(unit) => setRuleDrafts((current) => current.map((item) => item.key === rule.key ? { ...item, unit: unit as CriteriaUnit } : item))}>
                  <SelectTrigger aria-label={`Proposed rule ${index + 1} unit`}><SelectValue /></SelectTrigger>
                  <SelectContent>{CRITERIA_UNITS.map((unit) => <SelectItem key={unit} value={unit}>{unit.replace(/_/g, " ")}</SelectItem>)}</SelectContent>
                </Select>
                <Input aria-label={`Proposed rule ${index + 1} value`} value={rule.unspecified ? "" : rule.value} disabled={!canManage || selected.status !== "proposed" || busy || rule.unspecified} placeholder={rule.operator === "in" || rule.operator === "not_in" ? "Comma-separated values" : "Value"} onChange={(event) => setRuleDrafts((current) => current.map((item) => item.key === rule.key ? { ...item, value: event.target.value } : item))} />
                {canManage && selected.status === "proposed" && <Button type="button" variant="ghost" size="icon" aria-label={`Remove proposed rule ${index + 1}`} onClick={() => setRuleDrafts((current) => current.filter((item) => item.key !== rule.key))}><Trash2 /></Button>}
              </div>
              <Input aria-label={`Proposed rule ${index + 1} source`} value={rule.sourceText} disabled={!canManage || selected.status !== "proposed" || busy} placeholder="Source wording" onChange={(event) => setRuleDrafts((current) => current.map((item) => item.key === rule.key ? { ...item, sourceText: event.target.value } : item))} />
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={rule.unspecified} disabled={!canManage || selected.status !== "proposed" || busy} onCheckedChange={(unspecified) => setRuleDrafts((current) => current.map((item) => item.key === rule.key ? { ...item, unspecified, value: unspecified ? "" : item.value } : item))} />
                Unspecified
              </label>
            </div>)}
          </div>}
          {canManage && selected.status === "proposed" && <Button type="button" variant="outline" size="sm" onClick={() => setRuleDrafts((current) => [...current, emptyRule()])}><Plus />Add proposed field</Button>}
          {Object.keys(selected.evidence).length > 0 && <div className="space-y-2">
            <h3 className="font-medium">Evidence</h3>
            {Object.entries(selected.evidence).map(([field, evidence]) => <div key={field} className="grid gap-1 rounded-md border p-2 text-sm sm:grid-cols-[180px_100px_1fr]">
              <span className="font-medium">{field}</span>
              <span>{evidence.unknown ? "Unknown" : `${Math.round(evidence.confidence * 100)}%`}{evidence.page ? ` · page ${evidence.page}` : ""}</span>
              <span className="text-muted-foreground">{evidence.text || "No source excerpt returned"}</span>
            </div>)}
          </div>}
          {canManage && selected.status === "proposed" && <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => void decide("accept")} disabled={busy}>Apply reviewed criteria</Button>
            <Button type="button" variant="outline" onClick={() => void decide("reject")} disabled={busy}>Discard proposal</Button>
          </div>}
          {canManage && selected.status === "accepted" && !selected.rolledBackAt && <Button type="button" variant="outline" onClick={() => void decide("rollback")} disabled={busy}><RotateCcw className="size-4" />Undo this import</Button>}
        </div>}
      </CardContent>
    </Card>
  </div>
}

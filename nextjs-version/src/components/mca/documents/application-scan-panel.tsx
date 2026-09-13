"use client"

import { awaitBackgroundResult } from "@/components/mca/jobs"

import * as React from "react"
import { FileSearch, Plus, Save, ScanText, Trash2, Upload } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { DuplicateMerchantDialog } from "@/components/mca/deals/duplicate-merchant-dialog"
import { loadAttachPayload, lookupMerchantMatches, merchantMatchesFromError } from "@/components/mca/deals/merchant-lookup"
import { requestJson as requestJsonBase } from "@/lib/mca/client"
import type { DealOwnerInput, DealWriteInput, EntityType } from "@/lib/mca/deals/schema"
import {
  classifyNewDealFilename,
  classifyNewDealFiles,
  isPdfFile,
  NEW_DEAL_FILE_ACCEPT,
  NEW_DEAL_FILE_CATEGORIES,
  NEW_DEAL_FILE_CATEGORY_LABELS,
  type NewDealFileCategory,
} from "@/lib/mca/documents/new-deal-files"
import type { MerchantMatch } from "@/lib/mca/merchants/contracts"
import { cn } from "@/lib/utils"
import { uploadMultipart } from "./upload"

type Evidence = { confidence: number; page?: number; text?: string; unknown?: boolean }
type Review = { id: string; extractionVersion: number; fields: DealWriteInput; approvedFields: DealWriteInput; evidence: Record<string, Evidence>; warnings: string[]; lowConfidenceFields: string[]; provider: string }
type Draft = { id: string; filename: string; processingState: "pending_scan" | "clean" | "quarantined" | "scan_failed" }
type OwnerForm = { firstName: string; lastName: string; ownershipPercent: string; isPrimary: boolean; dateOfBirth: string; identityLast4: string; email: string; phone: string }
type FormState = { legalName: string; dbaName: string; ein: string; entityType: string; line1: string; line2: string; city: string; state: string; postalCode: string; country: string; contactName: string; contactEmail: string; contactPhone: string; startDate: string; industry: string; naicsCode: string; monthlyRevenue: string; ficoScore: string; fundingPurpose: string; requestedAmount: string; owners: OwnerForm[] }
type PendingFile = { id: string; file: File; category: NewDealFileCategory }
type CreatedDeal = { id: string; displayId: string; draftState?: string }

const blankOwner = (): OwnerForm => ({ firstName: "", lastName: "", ownershipPercent: "", isPrimary: false, dateOfBirth: "", identityLast4: "", email: "", phone: "" })
const blank: FormState = { legalName: "", dbaName: "", ein: "", entityType: "", line1: "", line2: "", city: "", state: "", postalCode: "", country: "", contactName: "", contactEmail: "", contactPhone: "", startDate: "", industry: "", naicsCode: "", monthlyRevenue: "", ficoScore: "", fundingPurpose: "", requestedAmount: "", owners: [] }
const textFields: Array<[keyof Omit<FormState, "owners">, string, string?]> = [
  ["legalName", "Legal name"], ["dbaName", "DBA"], ["ein", "EIN"], ["line1", "Address line 1"], ["line2", "Address line 2"], ["city", "City"], ["state", "State"], ["postalCode", "Postal code"], ["country", "Country"],
  ["contactName", "Contact name"], ["contactEmail", "Contact email", "email"], ["contactPhone", "Contact phone"], ["startDate", "Business start date", "date"], ["industry", "Industry"], ["naicsCode", "NAICS code"], ["monthlyRevenue", "Monthly revenue", "number"], ["ficoScore", "FICO score", "number"], ["fundingPurpose", "Funding purpose"], ["requestedAmount", "Requested amount", "number"],
]

function toForm(fields: DealWriteInput): FormState {
  const value = (key: keyof DealWriteInput) => fields[key] === undefined ? "" : String(fields[key])
  return { ...blank, legalName: value("legalName"), dbaName: value("dbaName"), ein: value("ein"), entityType: value("entityType"), line1: fields.address?.line1 ?? "", line2: fields.address?.line2 ?? "", city: fields.address?.city ?? "", state: fields.address?.state ?? "", postalCode: fields.address?.postalCode ?? "", country: fields.address?.country ?? "", contactName: value("contactName"), contactEmail: value("contactEmail"), contactPhone: value("contactPhone"), startDate: value("startDate"), industry: value("industry"), naicsCode: value("naicsCode"), monthlyRevenue: value("monthlyRevenue"), ficoScore: value("ficoScore"), fundingPurpose: value("fundingPurpose"), requestedAmount: value("requestedAmount"), owners: (fields.owners ?? []).map((owner) => ({ firstName: owner.firstName ?? "", lastName: owner.lastName ?? "", ownershipPercent: owner.ownershipPercent?.toString() ?? "", isPrimary: Boolean(owner.isPrimary), dateOfBirth: owner.dateOfBirth ?? "", identityLast4: owner.identityLast4 ?? "", email: owner.email ?? "", phone: owner.phone ?? "" })) }
}

function mergeAttach(current: FormState, fields: DealWriteInput): FormState {
  const attached = toForm(fields)
  const pick = (key: keyof Omit<FormState, "owners">) => attached[key] || current[key]
  return {
    ...current,
    legalName: pick("legalName"), dbaName: pick("dbaName"), ein: pick("ein"), entityType: pick("entityType"),
    line1: pick("line1"), line2: pick("line2"), city: pick("city"), state: pick("state"), postalCode: pick("postalCode"), country: pick("country"),
    contactName: pick("contactName"), contactEmail: pick("contactEmail"), contactPhone: pick("contactPhone"),
    startDate: pick("startDate"), industry: pick("industry"), naicsCode: pick("naicsCode"),
    monthlyRevenue: pick("monthlyRevenue"), ficoScore: pick("ficoScore"), fundingPurpose: pick("fundingPurpose"), requestedAmount: pick("requestedAmount"),
    owners: attached.owners.length ? attached.owners : current.owners,
  }
}

function toWriteInput(fields: FormState): DealWriteInput {
  const numberValue = (value: string) => value === "" ? undefined : Number(value)
  const address = { line1: fields.line1 || undefined, line2: fields.line2 || undefined, city: fields.city || undefined, state: fields.state || undefined, postalCode: fields.postalCode || undefined, country: fields.country || undefined }
  const owners: DealOwnerInput[] = fields.owners.map((owner) => ({ firstName: owner.firstName || undefined, lastName: owner.lastName || undefined, ownershipPercent: numberValue(owner.ownershipPercent), isPrimary: owner.isPrimary, dateOfBirth: owner.dateOfBirth || undefined, identityLast4: owner.identityLast4 || undefined, email: owner.email || undefined, phone: owner.phone || undefined }))
  return { legalName: fields.legalName || undefined, dbaName: fields.dbaName || undefined, ein: fields.ein || undefined, entityType: (fields.entityType || undefined) as EntityType | undefined, address, contactName: fields.contactName || undefined, contactEmail: fields.contactEmail || undefined, contactPhone: fields.contactPhone || undefined, startDate: fields.startDate || undefined, industry: fields.industry || undefined, naicsCode: fields.naicsCode || undefined, monthlyRevenue: numberValue(fields.monthlyRevenue), ficoScore: numberValue(fields.ficoScore), fundingPurpose: fields.fundingPurpose || undefined, requestedAmount: numberValue(fields.requestedAmount), owners }
}

async function requestJson<T>(...args: Parameters<typeof requestJsonBase>): Promise<T> { return awaitBackgroundResult<T>(await requestJsonBase(...args)) }

export function ApplicationScanPanel({ embedded = false, onCreated }: { embedded?: boolean; onCreated?: (deal: CreatedDeal) => void }) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [files, setFiles] = React.useState<PendingFile[]>([])
  const [dragOver, setDragOver] = React.useState(false)
  const [document, setDocument] = React.useState<Draft>()
  const [review, setReview] = React.useState<Review>()
  const [fields, setFields] = React.useState<FormState>(blank)
  const [mode, setMode] = React.useState<"create" | "merge">("create")
  const [targetDealId, setTargetDealId] = React.useState("")
  const [targetVersion, setTargetVersion] = React.useState<number>()
  const [conflicts, setConflicts] = React.useState<string[]>([])
  const [accepted, setAccepted] = React.useState<string[]>([])
  const [busy, setBusy] = React.useState(false)
  const [uploadProgress, setUploadProgress] = React.useState<number>()
  const [error, setError] = React.useState<string>()
  const [message, setMessage] = React.useState<string>()
  const [attachMerchantId, setAttachMerchantId] = React.useState<string>()
  const [forceDuplicate, setForceDuplicate] = React.useState(false)
  const [match, setMatch] = React.useState<MerchantMatch>()
  const [duplicateOpen, setDuplicateOpen] = React.useState(false)
  const [proceedOnChoice, setProceedOnChoice] = React.useState(false)
  const confirmationId = React.useRef("")
  const uploadKeys = React.useRef(new Map<string, string>())
  const applicationFile = files.find((item) => item.category === "application")
  const applicationLocked = Boolean(document)

  function renew() { confirmationId.current = crypto.randomUUID() }
  function edit(next: FormState) { setFields(next); setTargetVersion(undefined); setConflicts([]); setAccepted([]); renew() }
  function keyFor(file: File, context: string): { fingerprint: string; key: string } {
    const fingerprint = `${context}:${file.name}:${file.size}:${file.lastModified}`
    let key = uploadKeys.current.get(fingerprint)
    if (!key) { key = crypto.randomUUID(); uploadKeys.current.set(fingerprint, key) }
    return { fingerprint, key }
  }

  function addFiles(list: FileList | File[]) {
    const incoming = [...list]
    if (!incoming.length) return
    setFiles((current) => {
      const hasApplication = current.some((item) => item.category === "application")
      const classified = classifyNewDealFiles(incoming)
      const added = incoming.map((file, index) => ({
        id: crypto.randomUUID(),
        file,
        category: (hasApplication && classified[index] === "application"
          ? classifyNewDealFilename(file.name) ?? "statement"
          : classified[index])!,
      }))
      return [...current, ...added]
    })
    setError(undefined)
  }

  function setCategory(id: string, category: NewDealFileCategory) {
    if (applicationLocked && (category === "application" || files.find((item) => item.id === id)?.category === "application")) return
    setFiles((current) => current.map((item) => item.id === id ? { ...item, category } : item.category === "application" && category === "application" ? { ...item, category: "statement" } : item))
  }

  function removeFile(id: string) {
    const removed = files.find((item) => item.id === id)
    setFiles((current) => current.filter((item) => item.id !== id))
    if (removed?.category === "application") {
      setDocument(undefined)
      setReview(undefined)
      setFields(blank)
      setAttachMerchantId(undefined)
      setForceDuplicate(false)
    }
  }

  async function promptDuplicate(next: FormState, proceed: boolean) {
    if (mode !== "create" || attachMerchantId || forceDuplicate) return
    try {
      const matches = await lookupMerchantMatches({ ein: next.ein, owners: next.owners })
      if (!matches[0]) return
      setMatch(matches[0])
      setProceedOnChoice(proceed)
      setDuplicateOpen(true)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Merchant lookup failed.")
    }
  }

  async function uploadApplication() {
    if (!applicationFile) { setError("Mark one PDF as Application."); return }
    if (!isPdfFile(applicationFile.file)) { setError("Application scans must be PDF files."); return }
    setBusy(true); setError(undefined)
    const upload = keyFor(applicationFile.file, "application-draft")
    try {
      const form = new FormData()
      form.set("idempotencyKey", upload.key)
      form.set("file", applicationFile.file)
      const payload = await uploadMultipart<Draft>("/api/mca/documents/application/drafts", form, setUploadProgress)
      uploadKeys.current.delete(upload.fingerprint)
      setDocument(payload)
      setReview(undefined)
      renew()
      setMessage(payload.processingState === "clean" ? "Application uploaded and scanned." : "Application saved but locked until malware scanning succeeds.")
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Upload failed.") }
    finally { setBusy(false); setUploadProgress(undefined) }
  }

  async function extract() {
    if (!document) return
    setBusy(true); setError(undefined)
    try {
      const result = await requestJson<Review>(`/api/mca/documents/application/drafts/${document.id}/extract`, { method: "POST", body: "{}" })
      setReview(result)
      const next = toForm(result.fields)
      setFields(next)
      renew()
      setMessage("Extraction ready. Review every field and its evidence.")
      await promptDuplicate(next, false)
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Extraction failed.") }
    finally { setBusy(false) }
  }

  async function retryDraftScan() {
    if (!document) return
    setBusy(true); setError(undefined)
    try {
      const updated = await requestJson<Draft>(`/api/mca/documents/application/drafts/${document.id}/scan`, { method: "POST", body: "{}" })
      setDocument(updated)
      setMessage(updated.processingState === "clean" ? "Malware scan passed. Extraction is available." : "Scanner is still unavailable or did not clear the file.")
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Scan retry failed.") }
    finally { setBusy(false) }
  }

  async function saveReview() {
    if (!review) return
    setBusy(true); setError(undefined)
    try {
      const next = await requestJson<Review>(`/api/mca/documents/application/drafts/${review.id}/extract`, { method: "POST", body: JSON.stringify({ approvedFields: toWriteInput(fields) }) })
      setReview(next)
      setFields(toForm({ ...next.fields, ...next.approvedFields }))
      renew()
      setMessage("Review saved; another extraction will preserve these edits.")
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Review could not be saved.") }
    finally { setBusy(false) }
  }

  async function previewMerge() {
    if (!review || !targetDealId) return
    setBusy(true); setError(undefined)
    try {
      const result = await requestJson<{ conflicts: string[]; targetVersion: number }>(`/api/mca/documents/application/drafts/${review.id}/merge-preview`, { method: "POST", body: JSON.stringify({ targetDealId, manualFields: toWriteInput(fields) }) })
      setConflicts(result.conflicts)
      setAccepted([])
      setTargetVersion(result.targetVersion)
      setMessage(result.conflicts.length ? "Choose an action for every conflicting field." : "No conflicts found. The merge is ready.")
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Merge preview failed.") }
    finally { setBusy(false) }
  }

  async function uploadSupporting(dealId: string) {
    const extras = files.filter((item) => item.category !== "application")
    for (const item of extras) {
      const upload = keyFor(item.file, `support:${dealId}:${item.category}`)
      const form = new FormData()
      form.set("dealId", dealId)
      form.set("idempotencyKey", upload.key)
      form.set("category", item.category)
      form.set("source", "user_upload")
      form.set("file", item.file)
      await uploadMultipart(`/api/mca/documents`, form, setUploadProgress)
      uploadKeys.current.delete(upload.fingerprint)
    }
  }

  async function confirm(overrides?: { fields?: FormState; attachMerchantId?: string; forceDuplicate?: boolean }) {
    if (!review) return
    const current = overrides?.fields ?? fields
    const attach = overrides && "attachMerchantId" in overrides ? overrides.attachMerchantId : attachMerchantId
    const force = overrides && "forceDuplicate" in overrides ? Boolean(overrides.forceDuplicate) : forceDuplicate
    setBusy(true); setError(undefined)
    try {
    if (mode === "create" && !attach && !force) {
      const matches = await lookupMerchantMatches({ ein: current.ein, owners: current.owners })
      if (matches[0]) {
        setMatch(matches[0])
        setProceedOnChoice(true)
        setDuplicateOpen(true)
        return
      }
    }
      if (!confirmationId.current) renew()
      const result = await requestJson<{ deal: CreatedDeal; replayed: boolean }>(`/api/mca/documents/application/drafts/${review.id}/confirm`, {
        method: "POST",
        body: JSON.stringify({
          confirmationId: confirmationId.current,
          mode,
          targetDealId: mode === "merge" ? targetDealId : undefined,
          expectedVersion: mode === "merge" ? targetVersion : undefined,
          acceptedConflictFields: accepted,
          manualFields: toWriteInput(current),
          attachMerchantId: mode === "create" ? attach : undefined,
          forceDuplicate: mode === "create" ? force : undefined,
        }),
      })
      try { await uploadSupporting(result.deal.id) }
      catch (caught) {
        setError(caught instanceof Error ? `Deal saved, but a supporting file failed: ${caught.message}` : "Deal saved, but a supporting file failed.")
        return
      }
      setMessage(`${result.replayed ? "Recovered" : mode === "create" ? "Created" : "Updated"} ${result.deal.displayId}. The source PDF and extraction version are retained.`)
      onCreated?.(result.deal)
    } catch (caught) {
      const matches = merchantMatchesFromError(caught)
      if (matches[0]) {
        setMatch(matches[0])
        setProceedOnChoice(true)
        setDuplicateOpen(true)
        return
      }
      setError(caught instanceof Error ? caught.message : "Confirmation failed.")
    } finally { setBusy(false) }
  }

  async function attachExisting() {
    if (!match) return
    setBusy(true); setError(undefined)
    try {
      const payload = await loadAttachPayload(match.merchantId)
      const merged = mergeAttach(fields, payload.fields)
      setFields(merged)
      setAttachMerchantId(payload.merchantId)
      setForceDuplicate(false)
      setDuplicateOpen(false)
      if (proceedOnChoice) await confirm({ fields: merged, attachMerchantId: payload.merchantId, forceDuplicate: false })
      else setMessage(`Fields filled from ${payload.fields.legalName ?? match.legalName}. Review and save the draft.`)
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not load the existing merchant.") }
    finally { setBusy(false) }
  }

  function createAnyway() {
    setForceDuplicate(true)
    setAttachMerchantId(undefined)
    setDuplicateOpen(false)
    if (proceedOnChoice) void confirm({ forceDuplicate: true, attachMerchantId: undefined })
  }

  const allConflictsAccepted = conflicts.every((field) => accepted.includes(field))
  const body = (
    <div className="space-y-5">
      <div
        className={cn("rounded-lg border border-dashed p-6 text-center", dragOver && "border-primary bg-muted/40")}
        onDragOver={(event) => { event.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => { event.preventDefault(); setDragOver(false); addFiles(event.dataTransfer.files) }}
      >
        <Upload className="mx-auto mb-2 size-5 text-muted-foreground" />
        <p className="text-sm font-medium">Drop an application PDF plus supporting files</p>
        <p className="mt-1 text-xs text-muted-foreground">Bank statements, voided check, and ID are classified from the filename. You can change the chip before upload.</p>
        <input ref={inputRef} type="file" multiple accept={NEW_DEAL_FILE_ACCEPT} className="sr-only" onChange={(event) => { addFiles(event.target.files ?? []); event.target.value = "" }} />
        <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => inputRef.current?.click()}>Choose files</Button>
      </div>
      {files.length > 0 && <div className="space-y-2">{files.map((item) => <div key={item.id} className="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm">
        <span className="min-w-0 flex-1 truncate font-medium">{item.file.name}</span>
        <div className="flex flex-wrap gap-1">{NEW_DEAL_FILE_CATEGORIES.map((category) => <Button key={category} type="button" size="sm" variant={item.category === category ? "default" : "outline"} className="h-7 px-2 text-xs" disabled={applicationLocked && (item.category === "application" || category === "application")} onClick={() => setCategory(item.id, category)}>{NEW_DEAL_FILE_CATEGORY_LABELS[category]}</Button>)}</div>
        <Button type="button" size="icon" variant="ghost" aria-label={`Remove ${item.file.name}`} onClick={() => removeFile(item.id)}><Trash2 className="size-4" /></Button>
      </div>)}</div>}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void uploadApplication()} disabled={busy || !applicationFile || applicationLocked}><FileSearch className="size-4" />Upload application</Button>
      </div>
      {document && <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm"><span>{document.filename}</span><Badge variant={document.processingState === "clean" ? "default" : "secondary"}>{document.processingState.replace(/_/g, " ")}</Badge>{document.processingState === "clean" ? <Button size="sm" onClick={() => void extract()} disabled={busy}>Extract</Button> : <Button size="sm" variant="outline" onClick={() => void retryDraftScan()} disabled={busy}>Retry scan</Button>}</div>}
      {review && <div className="space-y-5 rounded-lg border p-4"><div className="flex flex-wrap items-center gap-2"><Badge>Extraction v{review.extractionVersion}</Badge><Badge variant="outline">{review.provider}</Badge>{review.lowConfidenceFields.length > 0 && <Badge variant="secondary">{review.lowConfidenceFields.length} need review</Badge>}</div>
        <div className="grid gap-3 sm:grid-cols-2">{textFields.map(([key, label, type]) => <div key={key}><Label>{label}</Label><Input type={type} value={fields[key]} onChange={(event) => edit({ ...fields, [key]: event.target.value })} /></div>)}<div><Label>Entity type</Label><Select value={fields.entityType || "unspecified"} onValueChange={(value) => edit({ ...fields, entityType: value === "unspecified" ? "" : value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="unspecified">Not provided</SelectItem>{["llc","corporation","s_corporation","partnership","sole_proprietor","nonprofit","other"].map((value) => <SelectItem value={value} key={value}>{value.replace(/_/g, " ")}</SelectItem>)}</SelectContent></Select></div></div>
        <div className="space-y-3"><div className="flex items-center justify-between"><h3 className="font-medium">Owners</h3><Button size="sm" variant="outline" onClick={() => edit({ ...fields, owners: [...fields.owners, blankOwner()] })}><Plus className="size-4" />Add owner</Button></div>{fields.owners.length === 0 && <p className="text-sm text-amber-700">No owner was extracted. Add every beneficial owner or explicitly leave the application incomplete.</p>}{fields.owners.map((owner, index) => <div key={index} className="space-y-3 rounded-md bg-muted p-3"><div className="flex justify-between"><strong>Owner {index + 1}</strong><Button size="icon" variant="ghost" aria-label={`Remove owner ${index + 1}`} onClick={() => edit({ ...fields, owners: fields.owners.filter((_, item) => item !== index) })}><Trash2 className="size-4" /></Button></div><div className="grid gap-2 sm:grid-cols-4">{(["firstName","lastName","ownershipPercent","dateOfBirth","identityLast4","email","phone"] as const).map((key) => <div key={key}><Label>{key.replace(/([A-Z])/g, " $1")}</Label><Input type={key === "ownershipPercent" ? "number" : key === "dateOfBirth" ? "date" : key === "email" ? "email" : "text"} maxLength={key === "identityLast4" ? 4 : undefined} value={owner[key]} onChange={(event) => { const owners = [...fields.owners]; owners[index] = { ...owner, [key]: key === "identityLast4" ? event.target.value.replace(/\D/g, "") : event.target.value }; edit({ ...fields, owners }) }} /></div>)}<div className="flex items-center gap-2 pt-6"><Checkbox checked={owner.isPrimary} onCheckedChange={(value) => { const owners = [...fields.owners]; owners[index] = { ...owner, isPrimary: value === true }; edit({ ...fields, owners }) }} /><Label>Primary</Label></div></div></div>)}</div>
        <div className="space-y-2"><h3 className="font-medium">Extraction evidence</h3>{Object.entries(review.evidence).map(([field, evidence]) => <div key={field} className="grid gap-1 rounded-md border p-2 text-sm sm:grid-cols-[180px_100px_1fr]"><span className="font-medium">{field}</span><span>{evidence.unknown ? "Unknown" : `${Math.round(evidence.confidence * 100)}%`}{evidence.page ? ` · page ${evidence.page}` : ""}</span><span className="text-muted-foreground">{evidence.text || "No source excerpt returned"}</span></div>)}</div>
        {review.warnings.length > 0 && <div className="rounded-md bg-amber-50 p-3 text-sm text-amber-950">{review.warnings.join(" ")}</div>}<Button variant="outline" onClick={() => void saveReview()} disabled={busy}><Save className="size-4" />Save review and re-extract</Button>
        <div className="grid gap-3 border-t pt-4 sm:grid-cols-[160px_minmax(0,1fr)_auto]"><Select value={mode} onValueChange={(value) => { setMode(value as typeof mode); setTargetVersion(undefined); setConflicts([]); setAccepted([]); setAttachMerchantId(undefined); setForceDuplicate(false); renew() }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="create">Create new deal</SelectItem><SelectItem value="merge">Merge existing</SelectItem></SelectContent></Select>{mode === "merge" && <Input placeholder="Target deal ID" value={targetDealId} onChange={(event) => { setTargetDealId(event.target.value); setTargetVersion(undefined); setConflicts([]); setAccepted([]); renew() }} />}{mode === "merge" && <Button variant="outline" onClick={() => void previewMerge()}>Review conflicts</Button>}</div>
        {conflicts.length > 0 && <div className="space-y-2 rounded-md bg-amber-50 p-3 text-sm text-amber-950"><strong>Explicit conflict choices</strong>{conflicts.map((field) => <label key={field} className="flex items-center gap-2"><Checkbox checked={accepted.includes(field)} onCheckedChange={(value) => { setAccepted((current) => value === true ? [...current, field] : current.filter((item) => item !== field)); renew() }} />Replace the current {field} with the reviewed application value</label>)}</div>}
        <Button onClick={() => void confirm()} disabled={busy || (mode === "merge" && (targetVersion === undefined || !allConflictsAccepted))}>{mode === "create" ? "Save as Draft" : "Confirm reviewed merge"}</Button>
      </div>}
      {uploadProgress !== undefined && <p role="status" className="text-sm text-muted-foreground">Uploading: {uploadProgress}%</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {message && <p role="status" className="text-sm text-emerald-700">{message}</p>}
      <DuplicateMerchantDialog
        open={duplicateOpen}
        onOpenChange={setDuplicateOpen}
        merchantName={match?.legalName ?? ""}
        busy={busy}
        onAttach={() => void attachExisting()}
        onCreateNew={createAnyway}
      />
    </div>
  )

  if (embedded) return body
  return <Card><CardHeader><CardTitle className="flex items-center gap-2"><ScanText className="size-5" />Application scan</CardTitle><CardDescription>Upload, scan, extract, and review every business and owner field with source evidence before creating or merging a deal.</CardDescription></CardHeader><CardContent>{body}</CardContent></Card>
}

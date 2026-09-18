"use client"

import { isDocumentReady } from "../../../lib/mca/documents/contracts"

import * as React from "react"
import { Download, FileText, RefreshCw, Sparkles, Upload } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { DocumentCategory, DocumentSummary } from "@/lib/mca/documents/contracts"
import { requestJson } from "@/lib/mca/client"
import { uploadMultipart } from "./upload"

type FilenamePreview = { suggestedFilename: string; uncertain: boolean; warnings: string[]; candidates: { bankLabel?: { value: string }; statementMonth?: { value: string }; accountSuffix?: { value: string } } }

const labels: Record<DocumentCategory, string> = {
  statement: "Bank statement", application: "Application", api_application: "Generated application",
  driver_license: "Driver license", voided_check: "Voided check", closing_document: "Closing document", other_stip: "Other stipulation",
}

export function DocumentPanel({ dealId, onRefresh }: { dealId: string; onRefresh?: () => void }) {
  const [documents, setDocuments] = React.useState<DocumentSummary[]>([])
  const [category, setCategory] = React.useState<DocumentCategory>("statement")
  const [file, setFile] = React.useState<File>()
  const [busy, setBusy] = React.useState<string>()
  const [uploadProgress, setUploadProgress] = React.useState<number>()
  const [message, setMessage] = React.useState<string>()
  const [error, setError] = React.useState<string>()
  const [previews, setPreviews] = React.useState<Record<string, FilenamePreview>>({})
  const [corrections, setCorrections] = React.useState<Record<string, { bankLabel: string; statementMonth: string; accountSuffix: string }>>({})
  const [displayNames, setDisplayNames] = React.useState<Record<string, string>>({})
  const uploadKeys = React.useRef(new Map<string, string>())
  const [contactMode, setContactMode] = React.useState<"real" | "omitted" | "redacted">("redacted")
  const [contactPreview, setContactPreview] = React.useState<{ contactName?: string; contactEmail?: string; contactPhone?: string }>()
  const [signed, setSigned] = React.useState(false)
  const [merchantName, setMerchantName] = React.useState("")
  const [authorizationReference, setAuthorizationReference] = React.useState("")

  const load = React.useCallback(async () => {
    setError(undefined)
    try {
      const [vault, deal] = await Promise.all([
        requestJson<{ documents: DocumentSummary[] }>(`/api/mca/documents?dealId=${encodeURIComponent(dealId)}`),
        requestJson<{ contactName?: string; contactEmail?: string; contactPhone?: string }>(`/api/mca/deals/${encodeURIComponent(dealId)}`),
      ])
      setDocuments(vault.documents)
      setContactPreview(deal)
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Documents could not be loaded.") }
  }, [dealId])
  React.useEffect(() => { void load() }, [load])

  function keyFor(file: File, context: string): { fingerprint: string; key: string } {
    const fingerprint = `${context}:${file.name}:${file.size}:${file.lastModified}`
    let key = uploadKeys.current.get(fingerprint)
    if (!key) { key = crypto.randomUUID(); uploadKeys.current.set(fingerprint, key) }
    return { fingerprint, key }
  }

  async function uploadDocument() {
    if (!file) { setError("Choose a PDF, PNG, or JPEG file."); return }
    setBusy("upload"); setError(undefined); setMessage(undefined)
    try {
      const upload = keyFor(file, `new:${dealId}:${category}`)
      const form = new FormData()
      form.set("dealId", dealId); form.set("idempotencyKey", upload.key); form.set("category", category); form.set("source", "user_upload"); form.set("file", file)
      const document = await uploadMultipart<DocumentSummary>("/api/mca/documents", form, setUploadProgress)
      uploadKeys.current.delete(upload.fingerprint)
      setMessage(isDocumentReady(document.processingState) ? "Upload complete." : "Upload saved. Retry upload completion to make this file available.")
      setFile(undefined); await load(); onRefresh?.()
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Upload failed.") } finally { setBusy(undefined); setUploadProgress(undefined) }
  }

  async function retryCompletion(id: string) {
    setBusy(id); setError(undefined)
    try { await requestJson(`/api/mca/documents/${id}/scan`, { method: "POST", body: "{}" }); setMessage("Upload completion retried."); await load() }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Upload completion failed.") } finally { setBusy(undefined) }
  }

  async function uploadNewVersion(document: DocumentSummary, replacement?: File) {
    if (!replacement) return
    setBusy(document.id); setError(undefined)
    try {
      const upload = keyFor(replacement, `version:${dealId}:${document.id}`)
      const form = new FormData(); form.set("dealId", dealId); form.set("idempotencyKey", upload.key); form.set("category", document.category); form.set("source", "user_version_upload"); form.set("sourceReference", `document-version:${document.id}`); form.set("file", replacement)
      const payload = await uploadMultipart<DocumentSummary>("/api/mca/documents", form, setUploadProgress)
      uploadKeys.current.delete(upload.fingerprint)
      setMessage(`Version ${payload.version} uploaded.`); await load(); onRefresh?.()
    } catch (caught) { setError(caught instanceof Error ? caught.message : "New version upload failed.") } finally { setBusy(undefined); setUploadProgress(undefined) }
  }

  async function changeCategory(id: string, nextCategory: DocumentCategory) {
    setBusy(id); setError(undefined)
    try { await requestJson(`/api/mca/documents/${id}/category`, { method: "POST", body: JSON.stringify({ category: nextCategory }) }); setMessage("Document category updated."); await load() }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Category update failed.") } finally { setBusy(undefined) }
  }

  async function applyDisplayName(document: DocumentSummary) {
    const displayFilename = displayNames[document.id] ?? document.displayFilename
    setBusy(document.id); setError(undefined)
    try {
      await requestJson(`/api/mca/documents/${document.id}/filename`, { method: "POST", body: JSON.stringify({ action: "rename", displayFilename }) })
      setMessage("Display filename updated; the immutable original is unchanged."); await load()
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Filename update failed.") } finally { setBusy(undefined) }
  }

  async function download(id: string) {
    setBusy(id); setError(undefined)
    try {
      const result = await requestJson<{ url: string }>(`/api/mca/documents/${id}/download-token`, { method: "POST", body: "{}" })
      window.location.assign(result.url)
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Download link could not be created.") } finally { setBusy(undefined) }
  }

  async function preview(id: string) {
    setBusy(id); setError(undefined)
    try {
      const result = await requestJson<{ url: string }>(`/api/mca/documents/${id}/download-token`, { method: "POST", body: "{}" })
      window.open(`${result.url}?preview=1`, "_blank", "noopener,noreferrer")
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Preview could not be opened.") } finally { setBusy(undefined) }
  }

  async function previewFilename(id: string) {
    setBusy(id); setError(undefined)
    try {
      const preview = await requestJson<FilenamePreview>(`/api/mca/documents/${id}/filename`, { method: "POST", body: JSON.stringify({ action: "preview" }) })
      setPreviews((current) => ({ ...current, [id]: preview }))
      setCorrections((current) => ({ ...current, [id]: { bankLabel: preview.candidates.bankLabel?.value ?? "", statementMonth: preview.candidates.statementMonth?.value ?? "", accountSuffix: preview.candidates.accountSuffix?.value ?? "" } }))
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Filename suggestion failed.") } finally { setBusy(undefined) }
  }

  async function applyFilename(id: string) {
    const preview = previews[id], correction = corrections[id]
    if (!preview || !correction) return
    setBusy(id); setError(undefined)
    try {
      await requestJson(`/api/mca/documents/${id}/filename`, { method: "POST", body: JSON.stringify({ action: "correct", ...correction }) })
      setMessage("Statement filename updated; the immutable original is unchanged."); await load()
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Filename could not be applied.") } finally { setBusy(undefined) }
  }

  async function recordAuthorization() {
    setBusy("authorization"); setError(undefined)
    try {
      await requestJson("/api/mca/documents/pdf/authorization", { method: "POST", body: JSON.stringify({ dealId, merchantName, authorizationReference }) })
      setMessage("Merchant authorization recorded for signed-on-behalf generation.")
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Authorization could not be recorded.") } finally { setBusy(undefined) }
  }

  async function generatePdf() {
    setBusy("pdf"); setError(undefined)
    try {
      await requestJson("/api/mca/documents/pdf/generate", { method: "POST", body: JSON.stringify({ dealId, idempotencyKey: crypto.randomUUID(), contactMode, signedOnBehalf: signed }) })
      setMessage("Application PDF generated and saved to the vault."); await load()
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Application PDF generation failed.") } finally { setBusy(undefined) }
  }

  return <div className="space-y-4">
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><FileText className="size-5" />Document vault</CardTitle><CardDescription>Originals are preserved. Completed uploads are available for download and AI processing.</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-[180px_minmax(0,1fr)_auto]">
          <Select value={category} onValueChange={(value) => setCategory(value as DocumentCategory)}><SelectTrigger aria-label="Document category"><SelectValue /></SelectTrigger><SelectContent>{Object.entries(labels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select>
          <Input type="file" accept="application/pdf,image/png,image/jpeg" onChange={(event) => setFile(event.target.files?.[0])} aria-label="Document file" />
          <Button onClick={uploadDocument} disabled={busy === "upload"}><Upload className="size-4" />{busy === "upload" ? "Uploading…" : "Upload"}</Button>
        </div>
        {uploadProgress !== undefined && <p role="status" className="text-sm text-muted-foreground">Uploading: {uploadProgress}%</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {message && <p role="status" className="text-sm text-emerald-700">{message}</p>}
        {!documents.length && !error ? <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No documents yet. Upload the first application, statement, or stipulation.</div> : <div className="space-y-2">{documents.map((document) => <div key={document.id} className="rounded-lg border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="font-medium">{document.displayFilename}</p><p className="text-xs text-muted-foreground">{labels[document.category]} · v{document.version} · {(document.byteLength / 1024).toFixed(1)} KB</p></div><Badge variant={isDocumentReady(document.processingState) ? "default" : "secondary"}>{isDocumentReady(document.processingState) ? "Ready" : document.processingState === "quarantined" ? "Blocked" : "Upload incomplete"}</Badge></div>
          <div className="mt-3 flex flex-wrap gap-2"><Select value={document.category} onValueChange={(value) => changeCategory(document.id, value as DocumentCategory)}><SelectTrigger className="w-48" aria-label={`Category for ${document.displayFilename}`}><SelectValue /></SelectTrigger><SelectContent>{Object.entries(labels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select><Input className="w-64" aria-label={`Display filename for ${document.displayFilename}`} value={displayNames[document.id] ?? document.displayFilename} onChange={(event) => setDisplayNames((current) => ({ ...current, [document.id]: event.target.value }))} /><Button size="sm" variant="outline" onClick={() => applyDisplayName(document)} disabled={busy === document.id}>Save filename</Button>{isDocumentReady(document.processingState) ? <><Button size="sm" variant="outline" onClick={() => preview(document.id)} disabled={busy === document.id}>Preview</Button><Button size="sm" variant="outline" onClick={() => download(document.id)} disabled={busy === document.id}><Download className="size-4" />Download</Button></> : document.processingState !== "quarantined" ? <Button size="sm" variant="outline" onClick={() => retryCompletion(document.id)} disabled={busy === document.id}><RefreshCw className="size-4" />Retry upload completion</Button> : <span className="text-sm text-destructive">This file is quarantined. Upload a new version.</span>}{document.category === "statement" && <Button size="sm" variant="outline" onClick={() => previewFilename(document.id)} disabled={!isDocumentReady(document.processingState) || busy === document.id}><Sparkles className="size-4" />Suggest filename</Button>}<label className="inline-flex cursor-pointer items-center justify-center rounded-md border px-3 text-sm font-medium hover:bg-muted">Upload new version<input className="sr-only" type="file" accept="application/pdf,image/png,image/jpeg" onChange={(event) => void uploadNewVersion(document, event.target.files?.[0])} /></label></div>
          {previews[document.id] && corrections[document.id] && <div className="mt-3 space-y-2 rounded-md bg-muted p-3 text-sm"><p className="font-medium">Suggested: {previews[document.id].suggestedFilename}</p>{previews[document.id].uncertain && <p className="text-amber-700">Review uncertain bank or statement period values before applying.</p>}<div className="grid gap-2 sm:grid-cols-3"><Input aria-label="Bank label" value={corrections[document.id].bankLabel} onChange={(event) => setCorrections((current) => ({ ...current, [document.id]: { ...current[document.id], bankLabel: event.target.value } }))} /><Input aria-label="Statement month" placeholder="YYYY-MM" value={corrections[document.id].statementMonth} onChange={(event) => setCorrections((current) => ({ ...current, [document.id]: { ...current[document.id], statementMonth: event.target.value } }))} /><Input aria-label="Account last four" maxLength={4} value={corrections[document.id].accountSuffix} onChange={(event) => setCorrections((current) => ({ ...current, [document.id]: { ...current[document.id], accountSuffix: event.target.value.replace(/\D/g, "") } }))} /></div><Button size="sm" onClick={() => applyFilename(document.id)}>Apply corrected name</Button></div>}
        </div>)}</div>}
      </CardContent>
    </Card>
    <Card><CardHeader><CardTitle>Generate application PDF</CardTitle><CardDescription>Choose exactly how merchant contact details appear. Missing and redacted fields are labeled.</CardDescription></CardHeader><CardContent className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3"><div className="space-y-1"><Label>Contact disclosure</Label><Select value={contactMode} onValueChange={(value) => setContactMode(value as typeof contactMode)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="real">Real contact details</SelectItem><SelectItem value="omitted">Omitted</SelectItem><SelectItem value="redacted">Explicitly redacted</SelectItem></SelectContent></Select></div></div>
      <div className="grid gap-2 rounded-lg bg-muted p-3 text-sm sm:grid-cols-3"><div><span className="text-muted-foreground">Name</span><p>{contactMode === "real" ? contactPreview?.contactName || "NOT PROVIDED" : contactMode === "omitted" ? "OMITTED BY REQUEST" : "REDACTED"}</p></div><div><span className="text-muted-foreground">Email</span><p>{contactMode === "real" ? contactPreview?.contactEmail || "NOT PROVIDED" : contactMode === "omitted" ? "OMITTED BY REQUEST" : "REDACTED"}</p></div><div><span className="text-muted-foreground">Phone</span><p>{contactMode === "real" ? contactPreview?.contactPhone || "NOT PROVIDED" : contactMode === "omitted" ? "OMITTED BY REQUEST" : "REDACTED"}</p></div></div>
      <div className="flex items-center gap-2"><Checkbox id={`signed-${dealId}`} checked={signed} onCheckedChange={(value) => setSigned(value === true)} /><Label htmlFor={`signed-${dealId}`}>Generate on behalf of merchant</Label></div>
      {signed && <div className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2"><Input placeholder="Merchant name" value={merchantName} onChange={(event) => setMerchantName(event.target.value)} /><Input placeholder="Authorization reference" value={authorizationReference} onChange={(event) => setAuthorizationReference(event.target.value)} /><Button variant="outline" onClick={recordAuthorization} disabled={busy === "authorization"}>Record authorization</Button></div>}
      <Button onClick={generatePdf} disabled={busy === "pdf"}>{busy === "pdf" ? "Generating…" : "Generate PDF"}</Button>
    </CardContent></Card>
  </div>
}

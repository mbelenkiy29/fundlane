"use client"

import * as React from "react"
import { AlertCircle, CheckCircle2, FileSearch, Loader2, RefreshCw, RotateCcw, ScanText } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { uploadMultipart } from "@/components/mca/documents/upload"
import { RequestError, requestJson } from "@/lib/mca/client"
import type { EligibilityRule } from "@/lib/mca/funders/contracts"
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
  contacts: Array<{ id: string; name?: string; email?: string }>
  criteriaVersion: number
  documents?: Array<{ id: string; originalFilename: string; processingState: string; mimeType: string }>
}

function formatValue(value: EligibilityRule["value"]): string {
  if (value == null) return "Unspecified"
  if (Array.isArray(value)) return value.join(", ")
  if (typeof value === "boolean") return value ? "true" : "false"
  return String(value)
}

export function CriteriaScanPanel({ funderId }: { funderId: string }) {
  const [payload, setPayload] = React.useState<ListPayload>()
  const [selected, setSelected] = React.useState<Proposal>()
  const [dealId, setDealId] = React.useState("")
  const [documentId, setDocumentId] = React.useState("")
  const [file, setFile] = React.useState<File>()
  const [canManage, setCanManage] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")
  const [notice, setNotice] = React.useState("")
  const [uploadProgress, setUploadProgress] = React.useState<number>()
  const uploadKeys = React.useRef(new Map<string, string>())

  const load = React.useCallback(async () => {
    setLoading(true); setError("")
    try {
      const query = new URLSearchParams({ funderId })
      if (dealId.trim()) query.set("dealId", dealId.trim())
      const [listed, session] = await Promise.all([
        requestJson<ListPayload>(`/api/mca/funders/scan?${query.toString()}`),
        requestJson<SessionResponse>("/api/auth/session"),
      ])
      setPayload(listed)
      setCanManage(Boolean(session.permissions?.canManageWorkspace))
      setSelected((current) => listed.proposals.find((item) => item.id === current?.id) ?? listed.proposals.find((item) => item.status === "proposed") ?? listed.proposals[0])
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Criteria scans could not be loaded.")
    } finally {
      setLoading(false)
    }
  }, [funderId, dealId])

  React.useEffect(() => { void load() }, [load])

  function fail(caught: unknown, fallback: string) {
    setNotice("")
    setError(caught instanceof RequestError || caught instanceof Error ? caught.message : fallback)
  }

  async function scanExisting() {
    if (!documentId.trim()) { setError("Enter a clean vault document ID."); return }
    setBusy(true); setError(""); setNotice("")
    try {
      const proposal = await requestJson<Proposal>("/api/mca/funders/scan", { method: "POST", body: JSON.stringify({ funderId, documentId: documentId.trim() }) })
      setSelected(proposal)
      setNotice("Proposed changeset ready. Review warnings before accepting.")
      toast.success("Criteria scan proposed")
      await load()
    } catch (caught) {
      fail(caught, "The criteria sheet could not be scanned.")
    } finally {
      setBusy(false)
    }
  }

  async function uploadAndScan() {
    if (!file) { setError("Choose a PDF, PNG, or JPEG criteria sheet."); return }
    if (!dealId.trim()) { setError("Enter the vault deal ID that should store this sheet."); return }
    setBusy(true); setError(""); setNotice("")
    const fingerprint = `${file.name}:${file.size}:${file.lastModified}`
    let key = uploadKeys.current.get(fingerprint)
    if (!key) { key = crypto.randomUUID(); uploadKeys.current.set(fingerprint, key) }
    try {
      const form = new FormData()
      form.set("funderId", funderId)
      form.set("dealId", dealId.trim())
      form.set("idempotencyKey", key)
      form.set("file", file)
      const proposal = await uploadMultipart<Proposal>("/api/mca/funders/scan", form, setUploadProgress)
      uploadKeys.current.delete(fingerprint)
      setSelected(proposal)
      setNotice("Proposed changeset ready. Review warnings before accepting.")
      toast.success("Criteria scan proposed")
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
      const result = await requestJson<Proposal | { proposal: Proposal }>(`/api/mca/funders/scan/${encodeURIComponent(selected.id)}/${path}`, { method: "POST", body: "{}" })
      const proposal = "proposal" in result && result.proposal ? result.proposal : result as Proposal
      setSelected(proposal)
      setNotice(path === "accept" ? "Scan accepted. Eligibility rules published." : path === "reject" ? "Scan rejected. Current rules were left unchanged." : "Accepted scan rolled back to the previous rules.")
      toast.success(path === "accept" ? "Criteria accepted" : path === "reject" ? "Scan rejected" : "Scan rolled back")
      await load()
    } catch (caught) {
      fail(caught, "The scan decision could not be saved.")
    } finally {
      setBusy(false)
    }
  }

  if (loading && !payload) {
    return <Card><CardContent className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="size-4 animate-spin" />Loading criteria scans…</CardContent></Card>
  }

  if (error && !payload) {
    return <Card><CardContent className="flex min-h-40 items-center gap-3 p-6"><AlertCircle className="size-5 text-destructive" /><div className="flex-1"><p className="font-medium">Criteria scans unavailable</p><p className="text-sm text-muted-foreground">{error}</p></div><Button variant="outline" onClick={() => void load()}><RefreshCw />Retry</Button></CardContent></Card>
  }

  const proposals = payload?.proposals ?? []
  const contacts = payload?.contacts ?? []

  return <div className="space-y-4">
    {(error || notice) && <div className={`rounded-lg border p-4 text-sm ${error ? "border-destructive/30 bg-destructive/5 text-destructive" : "border-emerald-500/30 bg-emerald-500/5"}`} role={error ? "alert" : "status"}>
      <div className="flex items-start gap-2">{error ? <AlertCircle className="mt-0.5 size-4 shrink-0" /> : <CheckCircle2 className="mt-0.5 size-4 shrink-0" />}<p>{error || notice}</p></div>
    </div>}

    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ScanText className="size-5" />AI criteria scan {payload && <Badge variant="outline">criteria v{payload.criteriaVersion}</Badge>}</CardTitle>
        <CardDescription>Scan clean vault PDF, PNG, or JPEG sheets into a proposed changeset. Contacts stay as configured. Unspecified limits stay empty, and broader extracted rules are blocked until you accept a reviewed version.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2"><Label htmlFor="scan-deal">Vault deal ID</Label><Input id="scan-deal" value={dealId} onChange={(event) => setDealId(event.target.value)} placeholder="Deal that stores the sheet" /></div>
          <div className="space-y-2"><Label htmlFor="scan-document">Existing document ID</Label><Input id="scan-document" value={documentId} onChange={(event) => setDocumentId(event.target.value)} placeholder="Clean PDF/PNG/JPEG document" /></div>
        </div>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
          <Input type="file" accept="application/pdf,image/png,image/jpeg" onChange={(event) => setFile(event.target.files?.[0])} />
          {canManage ? <>
            <Button type="button" onClick={() => void uploadAndScan()} disabled={busy}><FileSearch className="size-4" />Upload and scan</Button>
            <Button type="button" variant="outline" onClick={() => void scanExisting()} disabled={busy}>Scan document</Button>
          </> : <p className="text-sm text-muted-foreground">Only workspace admins can scan or accept criteria sheets.</p>}
        </div>
        {uploadProgress !== undefined && <p role="status" className="text-sm text-muted-foreground">Uploading: {uploadProgress}%</p>}
        <div className="rounded-lg border p-3 text-sm">
          <p className="font-medium">Configured contacts</p>
          {contacts.length ? <ul className="mt-2 space-y-1 text-muted-foreground">{contacts.map((contact) => <li key={contact.id}>{contact.name || "Contact"}{contact.email ? ` · ${contact.email}` : ""}</li>)}</ul> : <p className="mt-2 text-muted-foreground">No contacts configured. Scans will not invent contact records.</p>}
        </div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>Scan history</CardTitle>
        <CardDescription>Accept publishes the proposed rules, reject leaves the current book unchanged, and rollback restores the previous accepted version.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!proposals.length ? <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No criteria scans yet. Upload a clean PDF, PNG, or JPEG criteria sheet from the vault.</div> : <ul className="space-y-2">
          {proposals.map((item) => <li key={item.id}>
            <button type="button" className={`flex w-full items-center justify-between gap-3 rounded-lg border p-3 text-left text-sm ${selected?.id === item.id ? "border-primary" : ""}`} onClick={() => setSelected(item)}>
              <span>Scan v{item.version} · {item.provider}</span>
              <span className="flex items-center gap-2">
                <Badge variant={item.status === "accepted" ? "default" : item.status === "rejected" ? "secondary" : "outline"}>{item.status}{item.rolledBackAt ? " · rolled back" : ""}</Badge>
              </span>
            </button>
          </li>)}
        </ul>}

        {selected && <div className="space-y-4 rounded-lg border p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>Proposal v{selected.version}</Badge>
            <Badge variant="outline">{selected.provider}</Badge>
            {selected.contactsPreserved && <Badge variant="secondary">Contacts preserved</Badge>}
            {selected.ambiguousRanges?.length ? <Badge variant="secondary">{selected.ambiguousRanges.length} ambiguous</Badge> : null}
          </div>
          {selected.warnings.length > 0 && <div className="rounded-md bg-amber-50 p-3 text-sm text-amber-950" role="status">{selected.warnings.join(" ")}</div>}
          {!selected.rules.length ? <p className="text-sm text-muted-foreground">This scan did not propose eligibility rules.</p> : <div className="space-y-2">
            {selected.rules.map((rule) => <div key={rule.id} className="grid gap-1 rounded-md border p-2 text-sm sm:grid-cols-[140px_80px_1fr]">
              <span className="font-medium">{rule.field.replace(/_/g, " ")}</span>
              <span>{rule.operator}</span>
              <span>{rule.unspecified ? "Unspecified" : `${formatValue(rule.value)} ${rule.unit.replace(/_/g, " ")}`}{rule.sourceText ? ` · ${rule.sourceText}` : ""}</span>
            </div>)}
          </div>}
          {Object.keys(selected.evidence).length > 0 && <div className="space-y-2">
            <h3 className="font-medium">Evidence</h3>
            {Object.entries(selected.evidence).map(([field, evidence]) => <div key={field} className="grid gap-1 rounded-md border p-2 text-sm sm:grid-cols-[180px_100px_1fr]">
              <span className="font-medium">{field}</span>
              <span>{evidence.unknown ? "Unknown" : `${Math.round(evidence.confidence * 100)}%`}{evidence.page ? ` · page ${evidence.page}` : ""}</span>
              <span className="text-muted-foreground">{evidence.text || "No source excerpt returned"}</span>
            </div>)}
          </div>}
          {canManage && selected.status === "proposed" && <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => void decide("accept")} disabled={busy}>Accept changeset</Button>
            <Button type="button" variant="outline" onClick={() => void decide("reject")} disabled={busy}>Reject</Button>
          </div>}
          {canManage && selected.status === "accepted" && !selected.rolledBackAt && <Button type="button" variant="outline" onClick={() => void decide("rollback")} disabled={busy}><RotateCcw className="size-4" />Rollback</Button>}
        </div>}
      </CardContent>
    </Card>
  </div>
}

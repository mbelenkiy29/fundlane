"use client"

import * as React from "react"
import { AlertCircle, CheckCircle2, Download, FileUp, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { RequestError, requestJson } from "@/lib/mca/client"
import type { FunderImportCommitResult, FunderImportDraft, FunderImportPreview, FunderImportPreviewRow } from "@/lib/mca/funders/contracts"
import type { SessionResponse } from "@/lib/mca/types"

const MAX_IMPORT_BYTES = 1_048_576

const TEMPLATE = `legalName,nickname,website,domains,products,active,contactName,contactEmail,contactRole,criteria
Acme Capital,Acme,https://acme.example,acme.example,MCA,true,Pat Desk,pat@acme.example,ISO,"[{""field"":""fico"",""operator"":""min"",""unit"":""fico"",""value"":600,""unspecified"":false}]"
`

function statusLabel(status: FunderImportPreviewRow["status"]): string {
  if (status === "duplicate") return "Duplicate"
  if (status === "invalid") return "Needs review"
  return "Ready"
}

function joinList(values: string[]): string {
  return values.join(", ")
}

function criteriaJson(draft: FunderImportDraft): string {
  return draft.criteria?.length ? JSON.stringify(draft.criteria) : ""
}

export function FunderImportPanel({ onImported }: { onImported?: () => Promise<void> | void }) {
  const [canManage, setCanManage] = React.useState(false)
  const [preview, setPreview] = React.useState<FunderImportPreview>()
  const [rows, setRows] = React.useState<FunderImportPreviewRow[]>([])
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")
  const [notice, setNotice] = React.useState("")
  const [jsonText, setJsonText] = React.useState("")
  const [criteriaText, setCriteriaText] = React.useState<Record<string, string>>({})
  const [criteriaErrors, setCriteriaErrors] = React.useState<Record<string, string>>({})
  const fileInput = React.useRef<HTMLInputElement>(null)
  const commitKey = React.useRef(crypto.randomUUID())

  React.useEffect(() => {
    void requestJson<SessionResponse>("/api/auth/session")
      .then((session) => setCanManage(Boolean(session.permissions?.canManageWorkspace)))
      .catch(() => setCanManage(false))
  }, [])

  function fail(caught: unknown, fallback: string) {
    setNotice("")
    setError(caught instanceof RequestError || caught instanceof Error ? caught.message : fallback)
  }

  function applyPreview(next: FunderImportPreview) {
    setPreview(next)
    setRows(next.rows)
    setCriteriaText(Object.fromEntries(next.rows.map((row) => [row.key, criteriaJson(row.draft)])))
    setCriteriaErrors({})
    commitKey.current = crypto.randomUUID()
    setNotice(`Review ${next.summary.ready} ready funder${next.summary.ready === 1 ? "" : "s"} before saving. Duplicates stay excluded.`)
  }

  async function previewFile(file?: File) {
    if (!file) { setError("Choose a CSV or JSON file of funders."); return }
    if (file.size > MAX_IMPORT_BYTES) { setError("Funder import files must be 1 MiB or smaller."); return }
    setBusy(true); setError(""); setNotice("")
    try {
      const next = await requestJson<FunderImportPreview>("/api/mca/funders/import/preview", {
        method: "POST",
        body: JSON.stringify({ text: await file.text() }),
      })
      applyPreview(next)
      toast.success("Import ready for review")
    } catch (caught) {
      fail(caught, "The funder file could not be previewed.")
    } finally {
      setBusy(false)
    }
  }

  async function previewJson() {
    if (!jsonText.trim()) { setError("Paste a JSON array of funders or { funders: [] }."); return }
    if (new TextEncoder().encode(jsonText).byteLength > MAX_IMPORT_BYTES) { setError("Funder import files must be 1 MiB or smaller."); return }
    setBusy(true); setError(""); setNotice("")
    try {
      const next = await requestJson<FunderImportPreview>("/api/mca/funders/import/preview", {
        method: "POST",
        body: JSON.stringify({ text: jsonText }),
      })
      applyPreview(next)
      toast.success("Import ready for review")
    } catch (caught) {
      fail(caught, "The funder JSON could not be previewed.")
    } finally {
      setBusy(false)
    }
  }

  function updateDraft(key: string, patch: Partial<FunderImportDraft>) {
    setRows((current) => current.map((row) => row.key === key ? { ...row, draft: { ...row.draft, ...patch } } : row))
  }

  function updateCriteria(key: string, raw: string) {
    setCriteriaText((current) => ({ ...current, [key]: raw }))
    const trimmed = raw.trim()
    if (!trimmed) {
      setCriteriaErrors((current) => {
        const next = { ...current }
        delete next[key]
        return next
      })
      updateDraft(key, { criteria: undefined })
      return
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (!Array.isArray(parsed)) throw new Error("not-array")
      setCriteriaErrors((current) => {
        const next = { ...current }
        delete next[key]
        return next
      })
      updateDraft(key, { criteria: parsed as FunderImportDraft["criteria"] })
    } catch {
      setCriteriaErrors((current) => ({ ...current, [key]: "Criteria must be a JSON array of eligibility rules." }))
    }
  }

  async function commit() {
    const included = rows.filter((row) => row.included)
    if (!included.length) { setError("Select at least one reviewed funder to save."); return }
    const invalidCriteria = included.find((row) => criteriaErrors[row.key])
    if (invalidCriteria) { setError(`Row ${invalidCriteria.rowNumber}: Criteria must be a JSON array of eligibility rules.`); return }
    setBusy(true); setError(""); setNotice("")
    try {
      const result = await requestJson<FunderImportCommitResult>("/api/mca/funders/import/commit", {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey: commitKey.current,
          rows: rows.map((row) => ({ key: row.key, included: row.included, draft: row.draft })),
        }),
      })
      const created = result.created.length + result.replayed.length
      setNotice(`${created} funder${created === 1 ? "" : "s"} saved. ${result.criteriaPublished} criteria set${result.criteriaPublished === 1 ? "" : "s"} published for matching.`)
      toast.success("Funders imported")
      setPreview(undefined)
      setRows([])
      setJsonText("")
      setCriteriaText({})
      setCriteriaErrors({})
      if (fileInput.current) fileInput.current.value = ""
      commitKey.current = crypto.randomUUID()
      await onImported?.()
    } catch (caught) {
      fail(caught, "The reviewed funders could not be saved.")
    } finally {
      setBusy(false)
    }
  }

  function downloadTemplate() {
    const blob = new Blob([TEMPLATE], { type: "text/csv;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = "funder-import-template.csv"
    link.click()
    URL.revokeObjectURL(url)
  }

  if (!canManage) {
    return <Card><CardContent className="p-6 text-sm text-muted-foreground">Only workspace admins can import funders.</CardContent></Card>
  }

  return <div className="space-y-4">
    {(error || notice) && <div className={`rounded-lg border p-4 text-sm ${error ? "border-destructive/30 bg-destructive/5 text-destructive" : "border-emerald-500/30 bg-emerald-500/5"}`} role={error ? "alert" : "status"}>
      <div className="flex items-start gap-2">{error ? <AlertCircle className="mt-0.5 size-4 shrink-0" /> : <CheckCircle2 className="mt-0.5 size-4 shrink-0" />}<p>{error || notice}</p></div>
    </div>}

    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><FileUp className="size-5" />Bulk funder import</CardTitle>
        <CardDescription>Upload several funders at once, review names and criteria, then save. Existing legal names and domains are flagged so the same funder cannot be imported twice.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Input ref={fileInput} type="file" aria-label="Funder import file" accept=".csv,.json,text/csv,application/json" disabled={busy} onChange={(event) => void previewFile(event.target.files?.[0])} />
          <Button type="button" variant="outline" onClick={downloadTemplate}><Download className="size-4" />CSV template</Button>
        </div>
        <div className="space-y-2">
          <Label htmlFor="funder-import-json">Or paste JSON</Label>
          <Textarea id="funder-import-json" value={jsonText} disabled={busy} rows={5} placeholder='[{"legalName":"Acme Capital","domains":["acme.example"],"criteria":[{"field":"fico","operator":"min","unit":"fico","value":600}]}]' onChange={(event) => setJsonText(event.target.value)} />
          <Button type="button" variant="outline" disabled={busy || !jsonText.trim()} onClick={() => void previewJson()}>Review pasted funders</Button>
        </div>
      </CardContent>
    </Card>

    {preview && <Card>
      <CardHeader>
        <CardTitle>Review before saving</CardTitle>
        <CardDescription>
          {preview.summary.ready} ready · {preview.summary.duplicate} duplicate · {preview.summary.invalid} invalid.
          Edit a row, uncheck anything you do not want, then save.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {preview.warnings.map((warning) => <p key={warning} className="text-sm text-muted-foreground">{warning}</p>)}
        {!rows.length ? <p className="text-sm text-muted-foreground">No funders in this file.</p> : <div className="space-y-3">
          {rows.map((row) => <div key={row.key} className="space-y-3 rounded-lg border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={row.included} disabled={busy} onCheckedChange={(checked) => setRows((current) => current.map((item) => item.key === row.key ? { ...item, included: checked === true } : item))} />
                Include row {row.rowNumber}
              </label>
              <Badge variant={row.status === "ready" ? "secondary" : row.status === "duplicate" ? "outline" : "destructive"}>{statusLabel(row.status)}</Badge>
            </div>
            {row.duplicate && <p className="text-sm text-muted-foreground">Matches {row.duplicate.legalName} by {row.duplicate.match.replace("_", " ")}.</p>}
            {Object.values(row.errors).flat().map((message) => <p key={message} className="text-sm text-destructive">{message}</p>)}
            {criteriaErrors[row.key] ? <p className="text-sm text-destructive">{criteriaErrors[row.key]}</p> : null}
            <div className="grid gap-2 sm:grid-cols-2">
              <Input aria-label={`Row ${row.rowNumber} legal name`} value={row.draft.legalName} disabled={busy} onChange={(event) => updateDraft(row.key, { legalName: event.target.value })} placeholder="Legal name" />
              <Input aria-label={`Row ${row.rowNumber} nickname`} value={row.draft.nickname ?? ""} disabled={busy} onChange={(event) => updateDraft(row.key, { nickname: event.target.value })} placeholder="Nickname" />
              <Input aria-label={`Row ${row.rowNumber} website`} value={row.draft.website ?? ""} disabled={busy} onChange={(event) => updateDraft(row.key, { website: event.target.value })} placeholder="Website" />
              <Input aria-label={`Row ${row.rowNumber} domains`} value={joinList(row.draft.domains)} disabled={busy} onChange={(event) => updateDraft(row.key, { domains: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} placeholder="Domains" />
              <Input aria-label={`Row ${row.rowNumber} products`} value={joinList(row.draft.products)} disabled={busy} onChange={(event) => updateDraft(row.key, { products: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} placeholder="Products" />
              <Input aria-label={`Row ${row.rowNumber} criteria JSON`} value={criteriaText[row.key] ?? ""} disabled={busy} onChange={(event) => updateCriteria(row.key, event.target.value)} placeholder='Criteria JSON, e.g. [{"field":"fico","operator":"min","unit":"fico","value":600}]' />
            </div>
          </div>)}
        </div>}
        <Button type="button" disabled={busy || !rows.some((row) => row.included)} onClick={() => void commit()}>
          {busy ? <Loader2 className="animate-spin" /> : null}
          Save reviewed funders
        </Button>
      </CardContent>
    </Card>}
  </div>
}

"use client"

import * as React from "react"
import { AlertCircle, CheckCircle2, Download, FileSpreadsheet, LoaderCircle, RefreshCw, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { RequestError, requestJson } from "@/lib/mca/client"
import {
  BULK_UPDATE_PANEL_COPY,
  UPDATE_CSV_FIELDS,
  type ImportCommitResult,
  type ImportSource,
  type LeadBatch,
  type UpdatePreview,
} from "@/lib/mca/imports/contracts"
import type { SessionResponse } from "@/lib/mca/types"

function errorText(error: unknown): string {
  if (error instanceof RequestError) return error.message
  return error instanceof Error ? error.message : "The bulk update could not be completed."
}

async function multipart<T>(url: string, form: FormData): Promise<T> {
  const response = await fetch(url, { method: "POST", body: form })
  const payload = await response.json() as T & { error?: { message?: string } }
  if (!response.ok) throw new Error(payload.error?.message ?? "The request failed.")
  return payload
}

function isAdmin(session: SessionResponse | undefined): boolean {
  return session?.membership?.role === "admin" || session?.membership?.role === "super_admin"
}

export function BulkUpdatePanel() {
  const [session, setSession] = React.useState<SessionResponse>()
  const [source, setSource] = React.useState<ImportSource>()
  const [batch, setBatch] = React.useState<LeadBatch>()
  const [file, setFile] = React.useState<File | null>(null)
  const [preview, setPreview] = React.useState<UpdatePreview | null>(null)
  const [mapping, setMapping] = React.useState<Record<string, string>>({})
  const [result, setResult] = React.useState<ImportCommitResult | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")
  const [loading, setLoading] = React.useState(true)

  const load = React.useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const nextSession = await requestJson<SessionResponse>("/api/auth/session")
      setSession(nextSession)
      if (!isAdmin(nextSession)) return
      const workspace = await requestJson<{ source: ImportSource; batch: LeadBatch }>("/api/mca/imports/update/workspace", {
        method: "POST",
        body: "{}",
      })
      setSource(workspace.source)
      setBatch(workspace.batch)
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { void load() }, [load])

  async function previewUpdate(override?: Record<string, string>) {
    if (!file || !source || !batch) return
    setBusy(true)
    setError("")
    try {
      const form = new FormData()
      form.set("file", file)
      form.set("sourceId", source.id)
      form.set("batchId", batch.id)
      if (override) form.set("mapping", JSON.stringify(override))
      const next = await multipart<UpdatePreview>("/api/mca/imports/update/preview", form)
      setPreview(next)
      setMapping(next.mapping)
      setResult(null)
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  async function commitUpdate() {
    if (!preview) return
    setBusy(true)
    setError("")
    try {
      setResult(await requestJson<ImportCommitResult>(`/api/mca/imports/update/${preview.runId}/commit`, {
        method: "POST",
        body: JSON.stringify({ expectedPreviewRevision: preview.previewRevision }),
      }))
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  if (!isAdmin(session)) return null
  if (loading) {
    return (
      <Card data-testid="mca-bulk-update-panel">
        <CardContent className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />Loading bulk update…
        </CardContent>
      </Card>
    )
  }

  return (
    <Card data-testid="mca-bulk-update-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><FileSpreadsheet className="size-5" />{BULK_UPDATE_PANEL_COPY.title}</CardTitle>
        <CardDescription>{BULK_UPDATE_PANEL_COPY.description} {BULK_UPDATE_PANEL_COPY.adminOnly}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <div role="alert" className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertCircle className="size-4 shrink-0" />{error}
            <button className="ml-auto" type="button" onClick={() => setError("")}>Dismiss</button>
          </div>
        )}
        <div className="flex flex-wrap items-end gap-3">
          <Button variant="outline" asChild>
            <a href="/api/mca/imports/update/template"><Download className="size-4" />{BULK_UPDATE_PANEL_COPY.template}</a>
          </Button>
          <div className="min-w-56 space-y-1.5">
            <Label htmlFor="bulk-update-file">CSV file</Label>
            <Input id="bulk-update-file" type="file" accept=".csv,text/csv" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
          </div>
          <Button disabled={!file || !source || !batch || busy} onClick={() => void previewUpdate()}>
            {busy ? <LoaderCircle className="size-4 animate-spin" /> : <Upload className="size-4" />}
            {BULK_UPDATE_PANEL_COPY.preview}
          </Button>
        </div>
        {preview && (
          <>
            <div className="rounded-lg border p-3">
              <p className="font-medium">{BULK_UPDATE_PANEL_COPY.mapping}</p>
              <div className="mt-2 grid gap-2 md:grid-cols-2">
                {preview.headers.map((header) => (
                  <div className="grid grid-cols-2 items-center gap-2" key={header}>
                    <span className="truncate text-sm">{header}</span>
                    <Select
                      value={mapping[header] || "unmapped"}
                      onValueChange={(value) => setMapping({ ...mapping, [header]: value === "unmapped" ? "" : value })}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="unmapped">Do not update</SelectItem>
                        {UPDATE_CSV_FIELDS.map((field) => <SelectItem value={field} key={field}>{field}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
              <Button className="mt-3" variant="outline" onClick={() => void previewUpdate(Object.fromEntries(Object.entries(mapping).filter(([, value]) => value)))}>
                <RefreshCw className="size-4" />Apply mapping
              </Button>
            </div>
            <div className="max-h-80 overflow-auto rounded-lg border p-3 text-sm">
              {preview.rows.map((row) => (
                <div key={row.id} className="border-b py-2 last:border-0">
                  <p className="font-medium">Row {row.rowNumber} · {row.dealId || "Missing ID"} · expected v{row.expectedVersion}</p>
                  {row.errors.length ? (
                    <p className="text-destructive">{row.errors.join(" ")}</p>
                  ) : (
                    <div className="mt-1 grid gap-1">
                      {Object.entries(row.changes).map(([field, value]) => (
                        <p key={field}><span className="font-medium">{field}:</span> {String(row.before[field] ?? "blank")} → {value === null ? "clear" : String(value)}</p>
                      ))}
                      {row.status && <p><span className="font-medium">status:</span> {String(row.before.status ?? "unknown")} → {row.status}</p>}
                      {!Object.keys(row.changes).length && !row.status && <p className="text-muted-foreground">No field changes</p>}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <Button disabled={busy || result?.state === "completed"} onClick={() => void commitUpdate()}>
              {result?.state === "failed" ? BULK_UPDATE_PANEL_COPY.retry : BULK_UPDATE_PANEL_COPY.commit}
            </Button>
            {result && <BulkUpdateResult result={result} />}
          </>
        )}
      </CardContent>
    </Card>
  )
}

function BulkUpdateResult({ result }: { result: ImportCommitResult }) {
  const [url, setUrl] = React.useState("")
  React.useEffect(() => {
    const next = URL.createObjectURL(new Blob([result.resultsCsv], { type: "text/csv" }))
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [result.resultsCsv])
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg bg-muted p-3 text-sm">
      <CheckCircle2 className="text-emerald-600" />
      <span>{result.created} updated · {result.skipped} skipped · {result.failed} failed</span>
      <Button size="sm" variant="outline" asChild>
        <a href={url} download={`${result.runId}-results.csv`}>Results CSV</a>
      </Button>
    </div>
  )
}

"use client"

import * as React from "react"
import { Loader2, Upload } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { uploadMultipart } from "@/components/mca/documents/upload"
import { historicalResultMessage, historicalRowMessage, parseHistoricalPreview } from "@/lib/mca/historical/preview-client"
import { commitHistoricalPreview } from "@/lib/mca/historical/commit-client"
import type { HistoricalImportPreview, HistoricalImportResult } from "@/lib/mca/historical/contracts"

const EXAMPLE = "external_id,legal_name,funder_name,funded_at,amount_cents,factor_rate,term_months,payment_amount_cents,payment_count,payment_frequency,calendar_convention,commission_cents,paid_commission_cents,paid_commission_at,fee_cents,expected_commission_at,expected_fee_at\nlegacy-001,Example Merchant,Example Funder,2025-03-14,10000000,1.35,8,56250,180,daily,business_days,1000000,500000,2025-03-21,25000,2025-03-21,2025-03-28"

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

export function HistoricalImportDialog({ open, onOpenChange, onImported }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported: () => void
}) {
  const [file, setFile] = React.useState<File>()
  const [sourceId, setSourceId] = React.useState("historical")
  const [batchId, setBatchId] = React.useState(() => new Date().toISOString().slice(0, 10))
  const [preview, setPreview] = React.useState<HistoricalImportPreview>()
  const [result, setResult] = React.useState<HistoricalImportResult>()
  const [phase, setPhase] = React.useState<"idle" | "uploading" | "preparing">("idle")
  const [progress, setProgress] = React.useState(0)
  const [committing, setCommitting] = React.useState(false)
  const retryRef = React.useRef<{ file: File; sourceId: string; batchId: string; requestId: string } | null>(null)
  const requestRef = React.useRef<AbortController | null>(null)
  const generation = React.useRef(0)
  const busy = phase !== "idle" || committing
  const [error, setError] = React.useState("")

  const invalidatePreview = React.useCallback(() => {
    generation.current += 1
    retryRef.current = null
    requestRef.current?.abort()
    requestRef.current = null
    setPhase("idle")
    setPreview(undefined)
    setResult(undefined)
    setError("")
  }, [])

  React.useEffect(() => {
    if (!open) invalidatePreview()
  }, [open, invalidatePreview])
  React.useEffect(() => () => {
    generation.current += 1
    retryRef.current = null
    requestRef.current?.abort()
  }, [])

  async function previewHistory(event: React.FormEvent) {
    event.preventDefault()
    if (!file || busy) return
    const previous = retryRef.current
    const attempt = previous?.file === file && previous.sourceId === sourceId && previous.batchId === batchId
      ? previous : { file, sourceId, batchId, requestId: crypto.randomUUID() }
    invalidatePreview()
    retryRef.current = attempt
    const controller = new AbortController()
    requestRef.current = controller
    const current = generation.current
    setPhase("uploading"); setProgress(0)
    try {
      const form = new FormData()
      form.set("requestId", attempt.requestId)
      form.set("sourceId", sourceId)
      form.set("batchId", batchId)
      form.set("file", file)
      const payload = await uploadMultipart<unknown>("/api/mca/historical/preview", form, (percent) => {
        if (current !== generation.current) return
        setProgress(percent)
        if (percent >= 100) setPhase("preparing")
      }, { timeoutMs: 60_000, signal: controller.signal })
      if (current === generation.current) { setPreview(parseHistoricalPreview(payload)); retryRef.current = null }
    } catch (caught) {
      if (current === generation.current) setError(caught instanceof Error ? caught.message : "Historical preview failed.")
    } finally {
      if (current === generation.current) { setPhase("idle"); requestRef.current = null }
    }
  }

  async function commit() {
    if (!preview || busy || preview.state === "committed") return
    const current = generation.current
    setCommitting(true); setError("")
    try {
      const next = await commitHistoricalPreview(preview)
      if (current === generation.current) setResult(next)
      if (next.failed || next.invalid) toast.warning(historicalResultMessage(next))
      else if (next.created) toast.success(historicalResultMessage(next))
      else toast.info(historicalResultMessage(next))
      onImported()
    } catch (caught) {
      if (current === generation.current) setError(caught instanceof Error ? caught.message : "Historical commit failed.")
    } finally { setCommitting(false) }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) invalidatePreview(); onOpenChange(next) }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload funded deals CSV</DialogTitle>
          <DialogDescription>Import existing advances with integer-cent fields. Previewing creates no funded deals. You can upload again before committing. Nothing is sent to funders.</DialogDescription>
        </DialogHeader>
        <a className="text-sm underline" download="historical-funding-example.csv" href={`data:text/csv;charset=utf-8,${encodeURIComponent(EXAMPLE)}`}>Download example CSV</a>
        <form onSubmit={previewHistory} className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5"><Label htmlFor="historical-source">Source ID</Label><Input id="historical-source" value={sourceId} disabled={busy} onChange={(event) => { invalidatePreview(); setSourceId(event.target.value) }} required /></div>
          <div className="space-y-1.5"><Label htmlFor="historical-batch">Batch ID</Label><Input id="historical-batch" value={batchId} disabled={busy} onChange={(event) => { invalidatePreview(); setBatchId(event.target.value) }} required /></div>
          <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="historical-file">CSV file</Label><Input id="historical-file" type="file" accept=".csv,text/csv" disabled={busy} onChange={(event) => { invalidatePreview(); setFile(event.target.files?.[0]) }} required /></div>
          <Button disabled={busy || !file} className="sm:col-span-2">{phase !== "idle" ? <Loader2 className="animate-spin" /> : <Upload />}{phase === "uploading" ? "Uploading CSV…" : phase === "preparing" ? "Preparing preview…" : "Preview history"}</Button>
        </form>
        {phase !== "idle" && <div className="flex items-center justify-between gap-3">
          <p role="status" className="text-sm text-muted-foreground">{phase === "uploading" ? `Uploading… ${progress}%` : "Upload complete. Checking rows and duplicates…"}</p>
          <Button type="button" variant="ghost" onClick={invalidatePreview}>Cancel preview</Button>
        </div>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {preview && <div className="space-y-2 rounded-md border p-3 text-sm">
          <p>{preview.totals.rows} rows · {preview.totals.valid} valid · {preview.totals.duplicates} duplicates · {preview.totals.invalid} invalid</p>
          <p>Principal {money.format(preview.totals.principalCents / 100)} · expected commission {money.format(preview.totals.expectedCommissionCents / 100)}</p>
          {preview.rows.filter((row) => row.errors.length || row.duplicate).map((row) => (
            <p key={row.rowNumber} className={row.errors.length ? "text-destructive" : "text-amber-700"}>Row {row.rowNumber}: {historicalRowMessage(row)}</p>
          ))}
          <Button onClick={() => void commit()} disabled={busy || preview.totals.valid === 0 || preview.state === "committed" || result?.state === "committed"} aria-busy={committing}>{committing ? <><Loader2 className="animate-spin" />Importing…</> : "Commit historical records"}</Button>
          {committing && <p role="status" className="text-sm text-muted-foreground">Creating funded records and repayment schedules. Please keep this preview open.</p>}
        </div>}
        {preview?.state === "committed" && <p role="status" className="text-sm">This batch has already been imported.</p>}
        {result && <p role="status" className="text-sm">{historicalResultMessage(result)}</p>}
      </DialogContent>
    </Dialog>
  )
}

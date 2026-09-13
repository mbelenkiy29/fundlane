"use client"

import * as React from "react"
import { Loader2, Upload } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { uploadMultipart } from "@/components/mca/documents/upload"
import { requestJson } from "@/lib/mca/client"
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
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")

  async function previewHistory(event: React.FormEvent) {
    event.preventDefault()
    if (!file) return
    setBusy(true); setError("")
    try {
      const form = new FormData()
      form.set("sourceId", sourceId)
      form.set("batchId", batchId)
      form.set("file", file)
      setPreview(await uploadMultipart<HistoricalImportPreview>("/api/mca/historical/preview", form, () => undefined))
      setResult(undefined)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Historical preview failed.")
    } finally { setBusy(false) }
  }

  async function commit() {
    if (!preview) return
    setBusy(true); setError("")
    try {
      const next = await requestJson<HistoricalImportResult>(`/api/mca/historical/${encodeURIComponent(preview.runId)}/commit`, {
        method: "POST",
        body: JSON.stringify({ expectedPreviewRevision: preview.previewRevision }),
      })
      setResult(next)
      toast.success("Historical funding imported and reconciled by its actual dates.")
      onImported()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Historical commit failed.")
    } finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload funded deals CSV</DialogTitle>
          <DialogDescription>Import existing advances with integer-cent fields. Preview totals and duplicates, then commit. Nothing is sent to funders.</DialogDescription>
        </DialogHeader>
        <a className="text-sm underline" download="historical-funding-example.csv" href={`data:text/csv;charset=utf-8,${encodeURIComponent(EXAMPLE)}`}>Download example CSV</a>
        <form onSubmit={previewHistory} className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5"><Label htmlFor="historical-source">Source ID</Label><Input id="historical-source" value={sourceId} onChange={(event) => setSourceId(event.target.value)} required /></div>
          <div className="space-y-1.5"><Label htmlFor="historical-batch">Batch ID</Label><Input id="historical-batch" value={batchId} onChange={(event) => setBatchId(event.target.value)} required /></div>
          <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="historical-file">CSV, TSV, XLSX, or XLS</Label><Input id="historical-file" type="file" accept=".csv,.tsv,.xlsx,.xls" onChange={(event) => setFile(event.target.files?.[0])} required /></div>
          <Button disabled={busy} className="sm:col-span-2">{busy ? <Loader2 className="animate-spin" /> : <Upload />}Preview history</Button>
        </form>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {preview && <div className="space-y-2 rounded-md border p-3 text-sm">
          <p>{preview.totals.rows} rows · {preview.totals.valid} valid · {preview.totals.duplicates} duplicates · {preview.totals.invalid} invalid</p>
          <p>Principal {money.format(preview.totals.principalCents / 100)} · expected commission {money.format(preview.totals.expectedCommissionCents / 100)}</p>
          {preview.rows.filter((row) => row.errors.length || row.duplicate).map((row) => (
            <p key={row.rowNumber} className={row.errors.length ? "text-destructive" : "text-amber-700"}>Row {row.rowNumber}: {row.duplicate ? "duplicate external ID" : row.errors.join(" ")}</p>
          ))}
          <Button onClick={() => void commit()} disabled={busy || preview.totals.valid === 0}>Commit historical records</Button>
        </div>}
        {result && <p role="status" className="text-sm">Created {result.created}; duplicates {result.duplicates}; failed {result.failed}.</p>}
      </DialogContent>
    </Dialog>
  )
}

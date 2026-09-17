"use client"

import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table"
import * as React from "react"
import { AlertCircle, CheckCircle2, LoaderCircle, Package, Plus, RefreshCw, Upload } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { RequestError, requestJson } from "@/lib/mca/client"
import {
  formatPurchaseCost,
  parsePurchaseCostInput,
  type LeadProvider,
  type LeadWorkspaceSnapshot,
  type PurchaseBatch,
  type PurchasedPackageCommitResult,
} from "@/lib/mca/leads/contracts"
import type { ImportPreview } from "@/lib/mca/imports/contracts"

function errorText(error: unknown): string {
  if (error instanceof RequestError) {
    const fields = Object.values(error.fieldErrors ?? {}).flat().filter(Boolean)
    return fields.length ? `${error.message} ${fields.join(" ")}` : error.message
  }
  return error instanceof Error ? error.message : "Lead providers could not be updated."
}

async function multipart<T>(url: string, form: FormData): Promise<T> {
  const response = await fetch(url, { method: "POST", body: form })
  const payload = await response.json() as T & { error?: { message?: string; fieldErrors?: Record<string, string[]> } }
  if (!response.ok) {
    throw new RequestError(response.status, payload.error?.message ?? "The request could not be completed.", "request_failed", payload.error?.fieldErrors)
  }
  return payload
}

const emptyProvider: { name: string; kind: "spreadsheet" | "drive" } = { name: "", kind: "spreadsheet" }
const emptyBatch = { sourceId: "", name: "", purchasedOn: "", cost: "" }

export function ProvidersPanel() {
  const [snapshot, setSnapshot] = React.useState<LeadWorkspaceSnapshot>()
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState<string>()
  const [error, setError] = React.useState<string>()
  const [notice, setNotice] = React.useState<string>()
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({})
  const [providerForm, setProviderForm] = React.useState(emptyProvider)
  const [batchForm, setBatchForm] = React.useState(emptyBatch)
  const [costEdits, setCostEdits] = React.useState<Record<string, string>>({})
  const [assign, setAssign] = React.useState({ dealId: "", sourceId: "", batchId: "", correlationId: crypto.randomUUID() })
  const [file, setFile] = React.useState<File | null>(null)
  const [preview, setPreview] = React.useState<ImportPreview | null>(null)
  const [importResult, setImportResult] = React.useState<PurchasedPackageCommitResult | null>(null)
  const [packageSourceId, setPackageSourceId] = React.useState("")
  const [packageBatchId, setPackageBatchId] = React.useState("")

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      const next = await requestJson<LeadWorkspaceSnapshot>("/api/mca/leads")
      setSnapshot(next)
      setPackageSourceId((current) => current && next.selectable.providerIds.includes(current) ? current : next.selectable.providerIds[0] ?? "")
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { void load() }, [load])
  React.useEffect(() => {
    const available = snapshot?.batches.filter((batch) => batch.sourceId === packageSourceId && snapshot.selectable.batchIds.includes(batch.id)) ?? []
    if (!available.some((batch) => batch.id === packageBatchId)) setPackageBatchId(available[0]?.id ?? "")
  }, [snapshot, packageSourceId, packageBatchId])

  function fail(caught: unknown) {
    if (caught instanceof RequestError) {
      setFieldErrors(Object.fromEntries(Object.entries(caught.fieldErrors ?? {}).map(([key, value]) => [key, value[0] ?? ""])))
    }
    setError(errorText(caught))
  }

  async function createProvider(event: React.FormEvent) {
    event.preventDefault()
    const name = providerForm.name.trim()
    if (!name) { setFieldErrors({ name: "Enter a source name." }); return }
    setBusy("provider"); setError(undefined); setNotice(undefined); setFieldErrors({})
    try {
      await requestJson("/api/mca/leads/providers", { method: "POST", body: JSON.stringify({ name, kind: providerForm.kind }) })
      setProviderForm(emptyProvider)
      setNotice(`Source “${name}” was saved. Historical deals keep their acquisition records if you later deactivate it.`)
      await load()
    } catch (caught) { fail(caught) }
    finally { setBusy(undefined) }
  }

  async function toggleProvider(provider: LeadProvider, active: boolean) {
    setBusy(provider.id); setError(undefined); setNotice(undefined)
    try {
      await requestJson(`/api/mca/leads/providers/${encodeURIComponent(provider.id)}`, { method: "PATCH", body: JSON.stringify({ active }) })
      setNotice(active ? `${provider.name} can be selected for new deals.` : `${provider.name} is inactive. Historical deals remain attributed.`)
      await load()
    } catch (caught) { fail(caught) }
    finally { setBusy(undefined) }
  }

  async function createBatch(event: React.FormEvent) {
    event.preventDefault()
    const name = batchForm.name.trim()
    const parsed = parsePurchaseCostInput(batchForm.cost)
    const nextErrors: Record<string, string> = {}
    if (!batchForm.sourceId) nextErrors.sourceId = "Choose a source."
    if (!name) nextErrors.name = "Enter a batch name."
    if (!parsed.ok) nextErrors.cost = parsed.message
    if (Object.keys(nextErrors).length) { setFieldErrors(nextErrors); return }
    setBusy("batch"); setError(undefined); setNotice(undefined); setFieldErrors({})
    try {
      await requestJson("/api/mca/leads/batches", { method: "POST", body: JSON.stringify({
        sourceId: batchForm.sourceId, name, purchasedOn: batchForm.purchasedOn || null, costCents: parsed.ok ? parsed.costCents : null,
      }) })
      setBatchForm({ ...emptyBatch, sourceId: batchForm.sourceId })
      setNotice(`Purchase batch “${name}” was saved. Cost ${parsed.ok && parsed.costCents === null ? "is not set" : formatPurchaseCost(parsed.ok ? parsed.costCents : null)}.`)
      await load()
    } catch (caught) { fail(caught) }
    finally { setBusy(undefined) }
  }

  async function saveBatchCost(batch: PurchaseBatch) {
    const raw = costEdits[batch.id] ?? (batch.costCents === null ? "" : (batch.costCents / 100).toFixed(2))
    const parsed = parsePurchaseCostInput(raw)
    if (!parsed.ok) { setFieldErrors({ [`cost-${batch.id}`]: parsed.message }); return }
    setBusy(batch.id); setError(undefined); setNotice(undefined); setFieldErrors({})
    try {
      await requestJson(`/api/mca/leads/batches/${encodeURIComponent(batch.id)}`, { method: "PATCH", body: JSON.stringify({ costCents: parsed.costCents }) })
      setNotice(`Cost for ${batch.name} is now ${formatPurchaseCost(parsed.costCents)}. Existing acquisition snapshots were not rewritten.`)
      await load()
    } catch (caught) { fail(caught) }
    finally { setBusy(undefined) }
  }

  async function toggleBatch(batch: PurchaseBatch, inactive: boolean) {
    setBusy(batch.id); setError(undefined); setNotice(undefined)
    try {
      await requestJson(`/api/mca/leads/batches/${encodeURIComponent(batch.id)}`, { method: "PATCH", body: JSON.stringify({ inactive }) })
      setNotice(inactive ? `${batch.name} cannot be selected for new deals. Historical attributions remain.` : `${batch.name} can be selected for new deals.`)
      await load()
    } catch (caught) { fail(caught) }
    finally { setBusy(undefined) }
  }

  async function assignDeal(event: React.FormEvent) {
    event.preventDefault()
    const nextErrors: Record<string, string> = {}
    if (!assign.dealId) nextErrors.dealId = "Choose an unassigned deal."
    if (!assign.sourceId) nextErrors.assignSourceId = "Choose a source."
    if (!assign.batchId) nextErrors.assignBatchId = "Choose a purchase batch."
    if (Object.keys(nextErrors).length) { setFieldErrors(nextErrors); return }
    setBusy("assign"); setError(undefined); setNotice(undefined); setFieldErrors({})
    try {
      await requestJson("/api/mca/leads/assignments", { method: "POST", body: JSON.stringify(assign) })
      setNotice("Deal acquisition was recorded. Retrying this assignment keeps the same history row.")
      setAssign((current) => ({ ...current, dealId: "", correlationId: crypto.randomUUID() }))
      await load()
    } catch (caught) { fail(caught) }
    finally { setBusy(undefined) }
  }

  async function previewPackage() {
    if (!file || !packageSourceId || !packageBatchId) {
      setFieldErrors({
        ...(!file ? { file: "Choose a spreadsheet." } : {}),
        ...(!packageSourceId ? { packageSourceId: "Choose an active source." } : {}),
        ...(!packageBatchId ? { packageBatchId: "Choose an active purchase batch." } : {}),
      })
      return
    }
    setBusy("preview"); setError(undefined); setNotice(undefined); setFieldErrors({}); setImportResult(null)
    try {
      const form = new FormData()
      form.set("file", file)
      form.set("sourceId", packageSourceId)
      form.set("batchId", packageBatchId)
      const next = await multipart<ImportPreview>("/api/mca/leads/packages/preview", form)
      setPreview(next)
      setNotice(`Preview staged ${next.rows.length} row${next.rows.length === 1 ? "" : "s"} against the selected purchase batch.`)
    } catch (caught) { fail(caught) }
    finally { setBusy(undefined) }
  }

  async function commitPackage() {
    if (!preview) return
    setBusy("commit"); setError(undefined); setNotice(undefined)
    try {
      const result = await requestJson<PurchasedPackageCommitResult>(`/api/mca/leads/packages/${encodeURIComponent(preview.runId)}/commit`, {
        method: "POST", body: JSON.stringify({ expectedPreviewRevision: preview.previewRevision }),
      })
      setImportResult(result)
      setNotice(`Imported ${result.created} deal${result.created === 1 ? "" : "s"} and attached ${result.attachedDealIds.length} to the purchase batch.`)
      await load()
    } catch (caught) { fail(caught) }
    finally { setBusy(undefined) }
  }

  if (loading) {
    return <Card><CardContent className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />Loading lead providers…</CardContent></Card>
  }

  if (error && !snapshot) {
    return <Card><CardContent className="flex items-center gap-3 py-8"><AlertCircle className="text-destructive" /><div className="flex-1"><p className="font-medium">Lead providers unavailable</p><p className="text-sm text-muted-foreground">{error}</p></div><Button variant="outline" onClick={() => void load()}><RefreshCw />Retry</Button></CardContent></Card>
  }

  if (!snapshot) return null

  const selectableProviders = snapshot.providers.filter((item) => snapshot.selectable.providerIds.includes(item.id))
  const selectableBatches = snapshot.batches.filter((item) => snapshot.selectable.batchIds.includes(item.id) && (!assign.sourceId || item.sourceId === assign.sourceId))
  const packageBatches = snapshot.batches.filter((item) => item.sourceId === packageSourceId && snapshot.selectable.batchIds.includes(item.id))

  return <Card>
    <CardHeader>
      <div className="flex items-start gap-3">
        <div className="rounded-md bg-muted p-2"><Package className="size-5" /></div>
        <div>
          <CardTitle>Lead providers and purchase batches</CardTitle>
          <CardDescription>Track purchased lead packages, assign deals, and keep an append-only acquisition history. Zero is a real cost; leave cost blank when it is unknown.</CardDescription>
        </div>
      </div>
    </CardHeader>
    <CardContent className="space-y-5">
      {error && <div role="alert" className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"><AlertCircle className="size-4 shrink-0" />{error}<button className="ml-auto" onClick={() => setError(undefined)}>Dismiss</button></div>}
      {notice && <div role="status" className="flex gap-2 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800"><CheckCircle2 className="size-4 shrink-0" />{notice}</div>}

      <Tabs defaultValue="providers">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="providers">Sources</TabsTrigger>
          <TabsTrigger value="batches">Batches</TabsTrigger>
          <TabsTrigger value="unassigned">Unassigned</TabsTrigger>
          <TabsTrigger value="import">Purchased package</TabsTrigger>
        </TabsList>

        <TabsContent value="providers" className="space-y-4">
          <form className="grid gap-3 rounded-lg border p-3 md:grid-cols-[1fr_160px_auto]" onSubmit={(event) => void createProvider(event)}>
            <div className="space-y-1.5">
              <Label htmlFor="provider-name">New source</Label>
              <Input id="provider-name" aria-invalid={Boolean(fieldErrors.name)} value={providerForm.name} onChange={(event) => setProviderForm((current) => ({ ...current, name: event.target.value }))} placeholder="Broker referrals" />
              {fieldErrors.name && <p className="text-xs text-destructive">{fieldErrors.name}</p>}
            </div>
            <div className="space-y-1.5">
              <Label>Kind</Label>
              <Select value={providerForm.kind} onValueChange={(kind) => setProviderForm((current) => ({ ...current, kind: kind as "spreadsheet" | "drive" }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="spreadsheet">Spreadsheet</SelectItem><SelectItem value="drive">Drive</SelectItem></SelectContent>
              </Select>
            </div>
            <div className="flex items-end"><Button type="submit" disabled={Boolean(busy)}><Plus />Save source</Button></div>
          </form>
          {!snapshot.providers.length ? <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No lead sources yet. Create a provider to track purchased batches.</div> : <div className="space-y-2">
            {snapshot.providers.map((provider) => <div key={provider.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
              <div>
                <div className="flex flex-wrap items-center gap-2"><p className="font-medium">{provider.name}</p><Badge variant={provider.active ? "secondary" : "outline"}>{provider.active ? "Active" : "Inactive"}</Badge></div>
                <p className="text-xs text-muted-foreground">{provider.kind} · {provider.batchCount} batch{provider.batchCount === 1 ? "" : "es"}</p>
              </div>
              <div className="flex items-center gap-2">
                <Switch checked={provider.active} disabled={Boolean(busy)} onCheckedChange={(active) => void toggleProvider(provider, active)} aria-label={`${provider.active ? "Deactivate" : "Activate"} ${provider.name}`} />
                <span className="text-xs text-muted-foreground">{provider.active ? "Selectable" : "Historical only"}</span>
              </div>
            </div>)}
          </div>}
        </TabsContent>

        <TabsContent value="batches" className="space-y-4">
          <form className="grid gap-3 rounded-lg border p-3 md:grid-cols-2" onSubmit={(event) => void createBatch(event)}>
            <div className="space-y-1.5">
              <Label>Source</Label>
              <Select value={batchForm.sourceId} onValueChange={(sourceId) => setBatchForm((current) => ({ ...current, sourceId }))}>
                <SelectTrigger aria-invalid={Boolean(fieldErrors.sourceId)}><SelectValue placeholder="Choose an active source" /></SelectTrigger>
                <SelectContent>{selectableProviders.map((provider) => <SelectItem key={provider.id} value={provider.id}>{provider.name}</SelectItem>)}</SelectContent>
              </Select>
              {fieldErrors.sourceId && <p className="text-xs text-destructive">{fieldErrors.sourceId}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="batch-name">Batch name</Label>
              <Input id="batch-name" value={batchForm.name} onChange={(event) => setBatchForm((current) => ({ ...current, name: event.target.value }))} placeholder="September 2026" />
              {fieldErrors.name && <p className="text-xs text-destructive">{fieldErrors.name}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="batch-date">Purchased on</Label>
              <Input id="batch-date" type="date" value={batchForm.purchasedOn} onChange={(event) => setBatchForm((current) => ({ ...current, purchasedOn: event.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="batch-cost">Cost (USD)</Label>
              <Input id="batch-cost" inputMode="decimal" placeholder="Leave blank if unknown" value={batchForm.cost} onChange={(event) => setBatchForm((current) => ({ ...current, cost: event.target.value }))} />
              {fieldErrors.cost && <p className="text-xs text-destructive">{fieldErrors.cost}</p>}
              <p className="text-xs text-muted-foreground">Blank is missing cost. 0.00 is a real zero.</p>
            </div>
            <div><Button type="submit" disabled={Boolean(busy) || !snapshot.canEditCost}><Plus />Save batch</Button></div>
          </form>
          {!snapshot.batches.length ? <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No purchase batches yet. Add a date and optional cost after choosing a source.</div> : <div className="space-y-2">
            {snapshot.batches.map((batch) => <div key={batch.id} className="space-y-3 rounded-lg border p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2"><p className="font-medium">{batch.name}</p><Badge variant={batch.inactive ? "outline" : "secondary"}>{batch.inactive ? "Inactive" : "Active"}</Badge></div>
                  <p className="text-xs text-muted-foreground">{batch.sourceName} · purchased {batch.purchasedOn ?? "date not set"} · {formatPurchaseCost(batch.costCents)} · {batch.dealCount} deal{batch.dealCount === 1 ? "" : "s"}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Switch checked={!batch.inactive} disabled={Boolean(busy)} onCheckedChange={(active) => void toggleBatch(batch, !active)} aria-label={`${batch.inactive ? "Activate" : "Deactivate"} ${batch.name}`} />
                </div>
              </div>
              {snapshot.canEditCost && <div className="flex flex-wrap items-end gap-2">
                <div className="space-y-1.5">
                  <Label htmlFor={`cost-${batch.id}`}>Correct cost</Label>
                  <Input id={`cost-${batch.id}`} className="w-36" inputMode="decimal" value={costEdits[batch.id] ?? (batch.costCents === null ? "" : (batch.costCents / 100).toFixed(2))} onChange={(event) => setCostEdits((current) => ({ ...current, [batch.id]: event.target.value }))} />
                  {fieldErrors[`cost-${batch.id}`] && <p className="text-xs text-destructive">{fieldErrors[`cost-${batch.id}`]}</p>}
                </div>
                <Button type="button" variant="outline" disabled={Boolean(busy)} onClick={() => void saveBatchCost(batch)}>Save cost</Button>
              </div>}
            </div>)}
          </div>}
        </TabsContent>

        <TabsContent value="unassigned" className="space-y-4">
          {!snapshot.unassignedDeals.length ? <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">All visible deals have a source and purchase batch.</div> : <>
            <div className="rounded-lg border">
              <Table className="w-full text-left text-sm">
                <TableHeader><TableRow><TableHead>Deal</TableHead><TableHead>Business</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
                <TableBody>{snapshot.unassignedDeals.map((deal) => <TableRow key={deal.id}><TableCell className="font-mono text-xs">{deal.displayId}</TableCell><TableCell>{deal.legalName}</TableCell><TableCell>{deal.status}</TableCell></TableRow>)}</TableBody>
              </Table>
            </div>
            <form className="grid gap-3 rounded-lg border p-3 md:grid-cols-2" onSubmit={(event) => void assignDeal(event)}>
              <div className="space-y-1.5">
                <Label>Unassigned deal</Label>
                <Select value={assign.dealId} onValueChange={(dealId) => setAssign((current) => ({ ...current, dealId }))}>
                  <SelectTrigger><SelectValue placeholder="Choose a deal" /></SelectTrigger>
                  <SelectContent>{snapshot.unassignedDeals.map((deal) => <SelectItem key={deal.id} value={deal.id}>{deal.displayId} · {deal.legalName}</SelectItem>)}</SelectContent>
                </Select>
                {fieldErrors.dealId && <p className="text-xs text-destructive">{fieldErrors.dealId}</p>}
              </div>
              <div className="space-y-1.5">
                <Label>Source</Label>
                <Select value={assign.sourceId} onValueChange={(sourceId) => setAssign((current) => ({ ...current, sourceId, batchId: "" }))}>
                  <SelectTrigger><SelectValue placeholder="Active source" /></SelectTrigger>
                  <SelectContent>{selectableProviders.map((provider) => <SelectItem key={provider.id} value={provider.id}>{provider.name}</SelectItem>)}</SelectContent>
                </Select>
                {fieldErrors.assignSourceId && <p className="text-xs text-destructive">{fieldErrors.assignSourceId}</p>}
              </div>
              <div className="space-y-1.5">
                <Label>Purchase batch</Label>
                <Select value={assign.batchId} onValueChange={(batchId) => setAssign((current) => ({ ...current, batchId }))}>
                  <SelectTrigger><SelectValue placeholder="Active batch" /></SelectTrigger>
                  <SelectContent>{selectableBatches.map((batch) => <SelectItem key={batch.id} value={batch.id}>{batch.name}</SelectItem>)}</SelectContent>
                </Select>
                {fieldErrors.assignBatchId && <p className="text-xs text-destructive">{fieldErrors.assignBatchId}</p>}
              </div>
              <div className="flex items-end"><Button type="submit" disabled={Boolean(busy)}>Record acquisition</Button></div>
            </form>
          </>}
        </TabsContent>

        <TabsContent value="import" className="space-y-4">
          <div className="grid gap-3 rounded-lg border p-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Source</Label>
              <Select value={packageSourceId} onValueChange={setPackageSourceId}>
                <SelectTrigger><SelectValue placeholder="Active source" /></SelectTrigger>
                <SelectContent>{selectableProviders.map((provider) => <SelectItem key={provider.id} value={provider.id}>{provider.name}</SelectItem>)}</SelectContent>
              </Select>
              {fieldErrors.packageSourceId && <p className="text-xs text-destructive">{fieldErrors.packageSourceId}</p>}
            </div>
            <div className="space-y-1.5">
              <Label>Purchase batch</Label>
              <Select value={packageBatchId} onValueChange={setPackageBatchId}>
                <SelectTrigger><SelectValue placeholder="Active batch" /></SelectTrigger>
                <SelectContent>{packageBatches.map((batch) => <SelectItem key={batch.id} value={batch.id}>{batch.name} · {formatPurchaseCost(batch.costCents)}</SelectItem>)}</SelectContent>
              </Select>
              {fieldErrors.packageBatchId && <p className="text-xs text-destructive">{fieldErrors.packageBatchId}</p>}
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="package-file">Purchased package spreadsheet</Label>
              <Input id="package-file" type="file" accept=".csv,.tsv,.xlsx,.xls" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
              {fieldErrors.file && <p className="text-xs text-destructive">{fieldErrors.file}</p>}
            </div>
            <div><Button type="button" disabled={Boolean(busy)} onClick={() => void previewPackage()}>{busy === "preview" ? <LoaderCircle className="animate-spin" /> : <Upload />}Preview package</Button></div>
          </div>
          {preview && <div className="space-y-3 rounded-lg border p-3">
            <p className="font-medium">{preview.rows.length} staged row{preview.rows.length === 1 ? "" : "s"} · revision {preview.previewRevision}</p>
            <div className="max-h-48 overflow-auto text-sm">{preview.rows.map((row) => <p key={row.id}>Row {row.rowNumber}: {row.application.legalName ?? row.application.dbaName ?? "Unnamed"} {row.errors.length ? `· ${row.errors.join(" ")}` : ""}</p>)}</div>
            <Button type="button" disabled={Boolean(busy) || importResult?.state === "completed"} onClick={() => void commitPackage()}>{busy === "commit" ? <LoaderCircle className="animate-spin" /> : <CheckCircle2 />}Commit and attach to batch</Button>
            {importResult && <p className="text-sm text-muted-foreground">{importResult.created} created · {importResult.attachedDealIds.length} attached · {importResult.skipped} skipped · {importResult.failed} failed</p>}
          </div>}
        </TabsContent>
      </Tabs>
    </CardContent>
  </Card>
}

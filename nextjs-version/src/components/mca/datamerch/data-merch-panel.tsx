"use client"

import * as React from "react"
import { RefreshCw, ShieldAlert } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { RequestError, requestJson } from "@/lib/mca/client"
import type { DataMerchCheck, DataMerchConfig } from "@/lib/mca/datamerch/contracts"

type RecordView = {
  category?: string
  notes?: string
  funder?: string
  occurredOn?: string
  merchantName?: string
  riskLevel?: string
}

type CheckView = DataMerchCheck & { records?: RecordView[]; queryKind?: "ein" | "legal_name" }

type DealPayload = {
  config: DataMerchConfig
  canRun: boolean
  checks: DataMerchCheck[]
  latest: CheckView | null
}

function statusLabel(status: DataMerchCheck["status"]): string {
  if (status === "records") return "Records found"
  if (status === "no_result") return "No result"
  if (status === "queued") return "Queued"
  return "Failed"
}

function statusVariant(status: DataMerchCheck["status"]): "default" | "secondary" | "destructive" | "outline" {
  if (status === "records") return "default"
  if (status === "no_result") return "secondary"
  if (status === "queued") return "outline"
  return "destructive"
}

export function DataMerchPanel({ dealId }: { dealId: string }) {
  const [payload, setPayload] = React.useState<DealPayload>()
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const [message, setMessage] = React.useState<string>()

  const load = React.useCallback(async () => {
    setError(undefined)
    setLoading(true)
    try {
      setPayload(await requestJson<DealPayload>(`/api/mca/datamerch/${encodeURIComponent(dealId)}`))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Data Merch could not be loaded.")
    } finally {
      setLoading(false)
    }
  }, [dealId])

  React.useEffect(() => { void load() }, [load])

  async function run() {
    setBusy(true)
    setError(undefined)
    setMessage(undefined)
    try {
      const check = await requestJson<CheckView>(`/api/mca/datamerch/${encodeURIComponent(dealId)}`, { method: "POST", body: "{}" })
      setPayload(await requestJson<DealPayload>(`/api/mca/datamerch/${encodeURIComponent(dealId)}`))
      if (check.status === "records") setMessage(check.resultSummary ?? "Data Merch records were found.")
      else if (check.status === "no_result") setMessage("No Data Merch records were found for this merchant.")
      else setError(check.resultSummary ?? "Data Merch check failed.")
    } catch (caught) {
      if (caught instanceof RequestError && caught.code === "datamerch_disabled") {
        setError("Data Merch is disabled for this workspace.")
        setPayload((current) => current ? { ...current, canRun: false, config: { ...current.config, enabled: false } } : current)
      } else {
        setError(caught instanceof Error ? caught.message : "Data Merch check failed.")
      }
    } finally {
      setBusy(false)
    }
  }

  const latest = payload?.latest
  const records = latest?.records ?? []
  const enabled = payload?.config.enabled === true

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>Data Merch</CardTitle>
          <CardDescription>Merchant history lookup using the workspace Data Merch key. Results are stored against the current deal version.</CardDescription>
        </div>
        {enabled && payload?.canRun && (
          <Button onClick={() => void run()} disabled={busy || loading} aria-label="Run Data Merch">
            <RefreshCw className="size-4" />{busy ? "Running…" : latest ? "Rerun Data Merch" : "Run Data Merch"}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && <p role="status" className="text-sm text-muted-foreground">Loading Data Merch…</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {message && <p role="status" className="text-sm text-emerald-700">{message}</p>}
        {!loading && payload && !enabled && (
          <p className="text-sm text-muted-foreground">Data Merch is disabled. An administrator can enable it in workspace connections.</p>
        )}
        {!loading && payload && enabled && !payload.canRun && (
          <p className="text-sm text-muted-foreground">Add an EIN or legal name, and a valid Data Merch key, before running a check.</p>
        )}
        {!loading && !error && payload && !latest && (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            No Data Merch checks yet. {enabled ? "Run a check to look up merchant records." : "Enable Data Merch to run a check."}
          </div>
        )}
        {latest && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={statusVariant(latest.status)}>{statusLabel(latest.status)}</Badge>
              <Badge variant="outline">Deal v{latest.dealVersion}</Badge>
              {latest.queryKind && <Badge variant="outline">{latest.queryKind === "ein" ? "EIN search" : "Legal name search"}</Badge>}
            </div>
            <p className="text-sm">{latest.resultSummary}</p>
            {latest.status === "failed" && (
              <p className="flex items-center gap-2 text-sm text-destructive"><ShieldAlert className="size-4" />Update the workspace credential and retry. The previous key is not shown.</p>
            )}
            {records.length > 0 && (
              <ul className="space-y-2">
                {records.map((record, index) => (
                  <li key={`${record.category ?? "record"}-${index}`} className="rounded-md border p-3 text-sm">
                    <p className="font-medium">{record.category ?? "Record"}{record.merchantName ? ` · ${record.merchantName}` : ""}</p>
                    {record.notes && <p>{record.notes}</p>}
                    <p className="text-xs text-muted-foreground">{[record.funder, record.occurredOn, record.riskLevel].filter(Boolean).join(" · ")}</p>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">{new Date(latest.createdAt).toLocaleString()}</p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export function DataMerchConfigPanel() {
  const [config, setConfig] = React.useState<DataMerchConfig>()
  const [enabled, setEnabled] = React.useState(false)
  const [credential, setCredential] = React.useState("")
  const [expiresAt, setExpiresAt] = React.useState("")
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const [message, setMessage] = React.useState<string>()

  const load = React.useCallback(async () => {
    setError(undefined)
    setLoading(true)
    try {
      const next = await requestJson<DataMerchConfig>("/api/mca/datamerch")
      setConfig(next)
      setEnabled(next.enabled)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Data Merch settings could not be loaded.")
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { void load() }, [load])

  async function save(testConnection = false) {
    setBusy(true)
    setError(undefined)
    setMessage(undefined)
    try {
      const next = await requestJson<DataMerchConfig>("/api/mca/datamerch", {
        method: "POST",
        body: JSON.stringify({
          enabled,
          ...(credential.trim() ? { credential: credential.trim() } : {}),
          credentialExpiresAt: expiresAt.trim() || null,
          testConnection,
        }),
      })
      setConfig(next)
      setCredential("")
      setMessage(testConnection ? `Diagnostic: ${next.lastDiagnostic ?? "saved"}` : "Data Merch settings saved.")
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Data Merch settings could not be saved.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Data Merch connection</CardTitle>
        <CardDescription>Workspace administrators store an encrypted API key and enable Run Data Merch on deals.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && <p role="status" className="text-sm text-muted-foreground">Loading Data Merch settings…</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {message && <p role="status" className="text-sm text-emerald-700">{message}</p>}
        {config && (
          <>
            <div className="flex items-center gap-3">
              <Switch id="datamerch-enabled" checked={enabled} onCheckedChange={setEnabled} disabled={busy} />
              <Label htmlFor="datamerch-enabled">Enable Data Merch</Label>
              <Badge variant={config.hasCredential ? "default" : "secondary"}>{config.hasCredential ? "Key saved" : "No key"}</Badge>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="datamerch-credential">API key</Label>
              <Input
                id="datamerch-credential"
                type="password"
                autoComplete="off"
                placeholder={config.hasCredential ? "Saved key is hidden. Enter a new key to replace it." : "Paste the Data Merch API key"}
                value={credential}
                onChange={(event) => setCredential(event.target.value)}
                disabled={busy}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="datamerch-expiry">Optional key expiry</Label>
              <Input id="datamerch-expiry" type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} disabled={busy} />
            </div>
            {config.lastDiagnostic && <p className="text-xs text-muted-foreground">Last diagnostic: {config.lastDiagnostic}</p>}
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void save(false)} disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
              <Button variant="outline" onClick={() => void save(true)} disabled={busy}>Test connection</Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

"use client"

import * as React from "react"
import { Download, Loader2, RefreshCw, ShieldAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { RequestError, requestJson } from "@/lib/mca/client"
import type { DealFilters } from "@/lib/mca/deals/schema"
import {
  EXPORT_KIND_LABELS,
  EXPORT_PANEL_COPY,
  type ExportCapabilities,
  type ExportDownload,
  type ExportJobView,
  type ExportKind,
} from "@/lib/mca/exports/contracts"
import { FIELD_MANIFESTS } from "@/lib/mca/exports/manifests"
import { exportPanelView } from "@/lib/mca/exports/panel-state"

function errorText(error: unknown): string {
  if (error instanceof RequestError) {
    const fields = Object.values(error.fieldErrors ?? {}).flat().filter(Boolean)
    return fields.length ? fields.join(" ") : error.message
  }
  return error instanceof Error ? error.message : "The export could not be completed."
}

export function ExportPanel({ filters }: { filters?: DealFilters }) {
  const [capabilities, setCapabilities] = React.useState<ExportCapabilities>()
  const [jobs, setJobs] = React.useState<ExportJobView[]>([])
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState<string>()
  const [error, setError] = React.useState<string>()
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string[]>>()
  const [notice, setNotice] = React.useState<string>()
  const [downloads, setDownloads] = React.useState<Record<string, ExportDownload>>({})
  const [keys, setKeys] = React.useState<Record<ExportKind, string>>(() => ({
    deals: crypto.randomUUID(),
    offers: crypto.randomUUID(),
    all_deals_owners: crypto.randomUUID(),
    funded_deals: crypto.randomUUID(),
  }))

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      const payload = await requestJson<{ capabilities: ExportCapabilities; jobs: ExportJobView[] }>("/api/mca/exports")
      setCapabilities(payload.capabilities)
      setJobs(payload.jobs)
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { void load() }, [load])

  const view = exportPanelView({ loading, error, fieldErrors, jobs, capabilities })

  async function run(kind: ExportKind) {
    setBusy(kind)
    setError(undefined)
    setFieldErrors(undefined)
    setNotice(undefined)
    try {
      const payload = await requestJson<{ job: ExportJobView; download: ExportDownload | null }>("/api/mca/exports", {
        method: "POST",
        body: JSON.stringify({
          kind,
          correlationId: keys[kind],
          filters: kind === "deals" || kind === "offers" ? filters : undefined,
        }),
      })
      let job = payload.job
      if (job.state === "queued") {
        job = (await requestJson<{ job: ExportJobView }>(`/api/mca/exports/${encodeURIComponent(job.id)}/process`, { method: "POST", body: "{}" })).job
      }
      let download = payload.download
      if (!download && job.state === "ready") {
        download = (await requestJson<{ download: ExportDownload }>(`/api/mca/exports/${encodeURIComponent(job.id)}/token`, { method: "POST", body: "{}" })).download
      }
      if (download) setDownloads((current) => ({ ...current, [job.id]: download }))
      if (job.state === "ready") {
        setNotice(`${EXPORT_PANEL_COPY.success} ${job.rowCount ?? 0} rows. ${EXPORT_PANEL_COPY.notPayment}`)
        setKeys((current) => ({ ...current, [kind]: crypto.randomUUID() }))
      } else if (job.state === "failed") {
        setError(job.error?.message ?? EXPORT_PANEL_COPY.failed)
      }
      await load()
    } catch (caught) {
      if (caught instanceof RequestError && caught.fieldErrors) setFieldErrors(caught.fieldErrors)
      setError(errorText(caught))
    } finally {
      setBusy(undefined)
    }
  }

  async function retry(job: ExportJobView) {
    setBusy(job.id)
    setError(undefined)
    try {
      const payload = await requestJson<{ job: ExportJobView }>("/api/mca/exports", {
        method: "POST",
        body: JSON.stringify({ kind: job.kind, correlationId: job.correlationId, async: job.state !== "ready" }),
      })
      let next = payload.job
      if (next.state === "queued" || next.state === "failed") {
        next = (await requestJson<{ job: ExportJobView }>(`/api/mca/exports/${encodeURIComponent(next.id)}/process`, { method: "POST", body: "{}" })).job
      }
      if (next.state === "ready") {
        const download = (await requestJson<{ download: ExportDownload }>(`/api/mca/exports/${encodeURIComponent(next.id)}/token`, { method: "POST", body: "{}" })).download
        setDownloads((current) => ({ ...current, [next.id]: download }))
        setNotice(`${EXPORT_PANEL_COPY.ready} Job identity preserved.`)
      }
      await load()
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(undefined)
    }
  }

  const kinds = capabilities?.kinds ?? []

  return (
    <Card data-testid="mca-export-panel">
      <CardHeader>
        <CardTitle>{EXPORT_PANEL_COPY.title}</CardTitle>
        <CardDescription>{EXPORT_PANEL_COPY.description} {EXPORT_PANEL_COPY.notPayment}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {view.status === "loading" ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="size-4 animate-spin" />{view.message}</p>
        ) : view.status === "disabled" ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><ShieldAlert className="size-4" />{view.message}</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {kinds.includes("deals") && <Button type="button" variant="outline" disabled={Boolean(busy)} onClick={() => void run("deals")}>{busy === "deals" ? <Loader2 className="size-4 animate-spin" /> : null}{EXPORT_PANEL_COPY.deals}</Button>}
              {kinds.includes("offers") && <Button type="button" variant="outline" disabled={Boolean(busy)} onClick={() => void run("offers")}>{busy === "offers" ? <Loader2 className="size-4 animate-spin" /> : null}{EXPORT_PANEL_COPY.offers}</Button>}
              {kinds.includes("all_deals_owners") && <Button type="button" disabled={Boolean(busy)} onClick={() => void run("all_deals_owners")}>{busy === "all_deals_owners" ? <Loader2 className="size-4 animate-spin" /> : null}{EXPORT_PANEL_COPY.allDealsOwners}</Button>}
              {kinds.includes("funded_deals") && <Button type="button" disabled={Boolean(busy)} onClick={() => void run("funded_deals")}>{busy === "funded_deals" ? <Loader2 className="size-4 animate-spin" /> : null}{EXPORT_PANEL_COPY.fundedDeals}</Button>}
              {!capabilities?.workspace && capabilities?.roleScoped && <p className="w-full text-xs text-muted-foreground">{EXPORT_PANEL_COPY.workspaceOnly}</p>}
            </div>
            {kinds.map((kind) => (
              <p key={kind} className="text-xs text-muted-foreground">{EXPORT_KIND_LABELS[kind]}: {FIELD_MANIFESTS[kind].fields.map((field) => field.header).join(", ")}</p>
            ))}
            {view.status === "empty" && <p className="text-sm text-muted-foreground" role="status">{view.message}</p>}
            {view.status === "queued" && <p className="flex items-center gap-2 text-sm" role="status"><Loader2 className="size-4 animate-spin" />{view.message}</p>}
            {view.status === "validation" && <p className="text-sm text-destructive" role="alert">{view.message}</p>}
            {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
            {notice && <p className="text-sm text-emerald-700 dark:text-emerald-300" role="status">{notice}</p>}
            {jobs.length > 0 && (
              <ul className="space-y-2">
                {jobs.map((job) => {
                  const download = downloads[job.id]
                  return (
                    <li key={job.id} className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="text-sm font-medium">{job.kindLabel} · {job.state}{job.rowCount === null ? "" : ` · ${job.rowCount} rows`}</p>
                        <p className="text-xs text-muted-foreground">{job.filename} · {EXPORT_PANEL_COPY.notPayment}</p>
                      </div>
                      <div className="flex gap-2">
                        {(job.state === "failed" || job.state === "queued") && (
                          <Button type="button" size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void retry(job)}>
                            <RefreshCw className="size-3.5" />{EXPORT_PANEL_COPY.retry}
                          </Button>
                        )}
                        {job.state === "ready" && download && (
                          <Button type="button" size="sm" asChild>
                            <a href={download.url}><Download className="size-3.5" />{EXPORT_PANEL_COPY.download}</a>
                          </Button>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

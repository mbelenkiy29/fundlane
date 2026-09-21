"use client"

import * as React from "react"
import { AlertCircle, CheckCircle2, Download, ExternalLink, Globe, Loader2, Webhook } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RequestError, requestJson } from "@/lib/mca/client"

type JobState =
  | "preflight_failed"
  | "queued"
  | "sending"
  | "sent"
  | "failed"
  | "skipped"
  | "pending_portal"
  | "blocked_duplicate"

type AttemptLog = {
  attemptKey: string
  transport: string
  state: string
  correlationId: string
  externalRef?: string
  errorCode?: string
  errorMessage?: string
  createdAt: string
}

type PortalTask = {
  jobId: string
  funderId: string
  displayFunderName: string
  state: JobState
  reason?: string
  portalUrl: string
  assignedOperator: { userId: string | null; name: string }
  packageDocuments: Array<{ documentId: string; filename: string; category: string; checksum: string; downloadUrl?: string }>
  attempts: AttemptLog[]
  externalRef?: string
  confirmationKey: string
  dealVersion: number
}

type WebhookJob = {
  jobId: string
  funderId: string
  displayFunderName: string
  state: JobState
  reason?: string
  destinationHost: string
  schemaPreview: {
    method: "POST"
    contentType: string
    responseSync: false
    statusPoll: false
    authenticationHeader: string
    destinationHost: string
    headers: Record<string, string>
    sample: Record<string, unknown>
  }
  attempts: AttemptLog[]
  responseSync: false
  confirmationKey: string
}

type BoardPayload = {
  dealId: string
  dealVersion: number
  portals: PortalTask[]
  webhooks: WebhookJob[]
}

function stateVariant(state: JobState): "default" | "secondary" | "destructive" | "outline" {
  if (state === "sent") return "default"
  if (state === "pending_portal" || state === "queued") return "secondary"
  if (state === "failed" || state === "preflight_failed" || state === "blocked_duplicate") return "destructive"
  return "outline"
}

function stateLabel(state: JobState): string {
  return state.split("_").join(" ")
}

function errorMessage(caught: unknown, fallback: string): string {
  if (caught instanceof RequestError) {
    const fields = caught.fieldErrors ? Object.values(caught.fieldErrors).flat().filter(Boolean) : []
    if (fields.length) return fields.join(" ")
    return caught.message
  }
  return caught instanceof Error ? caught.message : fallback
}

export function PortalPanel({ dealId }: { dealId: string }) {
  const [payload, setPayload] = React.useState<BoardPayload>()
  const [refs, setRefs] = React.useState<Record<string, string>>({})
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState<string>()
  const [error, setError] = React.useState<string>()
  const [message, setMessage] = React.useState<string>()

  const load = React.useCallback(async () => {
    setError(undefined)
    setLoading(true)
    try {
      const next = await requestJson<BoardPayload>(`/api/mca/submissions/portal/${encodeURIComponent(dealId)}`)
      setPayload(next)
    } catch (caught) {
      setError(errorMessage(caught, "Portal and webhook jobs could not be loaded."))
    } finally {
      setLoading(false)
    }
  }, [dealId])

  React.useEffect(() => { void load() }, [load])

  async function openPortal(task: PortalTask) {
    setBusy(`open:${task.jobId}`)
    setError(undefined)
    setMessage(undefined)
    try {
      const next = await requestJson<{ state: JobState; portalUrl: string }>(`/api/mca/submissions/portal/${encodeURIComponent(dealId)}`, {
        method: "POST",
        body: JSON.stringify({ jobId: task.jobId, action: "open" }),
      })
      if (next.state === "sent") {
        setError("Opening the portal URL must not mark the destination submitted.")
      } else {
        setMessage(`Portal opened for ${task.displayFunderName}. Confirm completion after the funder accepts the package.`)
      }
      if (next.portalUrl) window.open(next.portalUrl, "_blank", "noopener,noreferrer")
      await load()
    } catch (caught) {
      setError(errorMessage(caught, "The portal URL could not be opened."))
    } finally {
      setBusy(undefined)
    }
  }

  async function completePortal(task: PortalTask) {
    setBusy(`complete:${task.jobId}`)
    setError(undefined)
    setMessage(undefined)
    try {
      const next = await requestJson<{ state: JobState; externalRef?: string }>(`/api/mca/submissions/portal/${encodeURIComponent(dealId)}`, {
        method: "POST",
        body: JSON.stringify({ jobId: task.jobId, action: "complete", externalRef: refs[task.jobId] || undefined }),
      })
      setMessage(next.externalRef
        ? `Marked ${task.displayFunderName} submitted with reference ${next.externalRef}.`
        : `Marked ${task.displayFunderName} submitted.`)
      await load()
    } catch (caught) {
      setError(errorMessage(caught, "Portal completion could not be confirmed."))
    } finally {
      setBusy(undefined)
    }
  }

  async function downloadDocument(document: PortalTask["packageDocuments"][number]) {
    const { documentId } = document
    if (document.downloadUrl) {
      window.location.assign(document.downloadUrl)
      return
    }
    setBusy(`download:${documentId}`)
    setError(undefined)
    try {
      const result = await requestJson<{ url: string }>(`/api/mca/documents/${encodeURIComponent(documentId)}/download-token`, {
        method: "POST",
        body: "{}",
      })
      window.location.assign(result.url)
    } catch (caught) {
      setError(errorMessage(caught, "The package document could not be downloaded."))
    } finally {
      setBusy(undefined)
    }
  }

  const portals = payload?.portals ?? []
  const webhooks = payload?.webhooks ?? []
  const empty = !loading && !error && portals.length === 0 && webhooks.length === 0

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Globe className="size-5" />Portal tasks and webhooks</CardTitle>
        <CardDescription>
          Opening a funder portal does not mark the deal submitted. Custom webhooks log delivery only and do not sync provider responses.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {loading && <p role="status" className="text-sm text-muted-foreground">Loading portal and webhook jobs…</p>}
        {error && <p role="alert" className="flex items-start gap-2 text-sm text-destructive"><AlertCircle className="mt-0.5 size-4 shrink-0" />{error}</p>}
        {message && <p role="status" className="flex items-start gap-2 text-sm text-emerald-700"><CheckCircle2 className="mt-0.5 size-4 shrink-0" />{message}</p>}
        {empty && (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            No manual portal or custom webhook jobs for this deal yet. Queue a destination from Submit to funders.
          </div>
        )}

        {portals.length > 0 && (
          <section className="space-y-3">
            <h3 className="text-sm font-medium">Manual portal tasks</h3>
            <ul className="space-y-3">
              {portals.map((task) => {
                const pending = task.state === "pending_portal"
                return (
                  <li key={task.jobId} className="space-y-3 rounded-lg border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={stateVariant(task.state)}>{stateLabel(task.state)}</Badge>
                      <span className="font-medium">{task.displayFunderName}</span>
                    </div>
                    <p className="text-sm text-muted-foreground">Assigned operator: {task.assignedOperator.name}</p>
                    {task.reason ? <p className="text-sm text-muted-foreground">{task.reason}</p> : null}
                    {task.portalUrl ? (
                      <p className="truncate text-sm text-muted-foreground">{task.portalUrl}</p>
                    ) : (
                      <p className="text-sm text-destructive">This funder has no portal URL.</p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void openPortal(task)}
                        disabled={Boolean(busy) || !task.portalUrl}
                        aria-label={`Open portal for ${task.displayFunderName}`}
                      >
                        {busy === `open:${task.jobId}` ? <Loader2 className="size-4 animate-spin" /> : <ExternalLink className="size-4" />}
                        Open portal
                      </Button>
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-muted-foreground">Package</p>
                      {task.packageDocuments.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No documents were frozen for this destination.</p>
                      ) : (
                        <ul className="space-y-1">
                          {task.packageDocuments.map((document) => (
                            <li key={document.documentId} className="flex flex-wrap items-center gap-2 text-sm">
                              <span>{document.filename} · {document.category} · {document.checksum.slice(0, 12)}</span>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => void downloadDocument(document)}
                                disabled={Boolean(busy)}
                                aria-label={`Download ${document.filename}`}
                              >
                                {busy === `download:${document.documentId}` ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
                                Download
                              </Button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    {pending ? (
                      <div className="space-y-2">
                        <Label htmlFor={`portal-ref-${task.jobId}`}>External reference (optional)</Label>
                        <Input
                          id={`portal-ref-${task.jobId}`}
                          value={refs[task.jobId] ?? ""}
                          maxLength={200}
                          onChange={(event) => setRefs((current) => ({ ...current, [task.jobId]: event.target.value }))}
                          placeholder="Funder confirmation number"
                        />
                        <Button
                          size="sm"
                          onClick={() => void completePortal(task)}
                          disabled={Boolean(busy)}
                          aria-label={`Confirm portal completion for ${task.displayFunderName}`}
                        >
                          {busy === `complete:${task.jobId}` ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
                          Confirm completion
                        </Button>
                      </div>
                    ) : task.state === "sent" ? (
                      <p className="text-sm">Completed{task.externalRef ? ` · ${task.externalRef}` : ""}.</p>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        {webhooks.length > 0 && (
          <section className="space-y-3">
            <h3 className="flex items-center gap-2 text-sm font-medium"><Webhook className="size-4" />Custom webhooks</h3>
            <ul className="space-y-3">
              {webhooks.map((job) => (
                <li key={job.jobId} className="space-y-3 rounded-lg border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={stateVariant(job.state)}>{stateLabel(job.state)}</Badge>
                    <span className="font-medium">{job.displayFunderName}</span>
                    {job.destinationHost ? <span className="text-sm text-muted-foreground">{job.destinationHost}</span> : null}
                  </div>
                  {job.reason ? <p className="text-sm text-muted-foreground">{job.reason}</p> : null}
                  <p className="text-sm text-muted-foreground">Response-sync is not supported for custom webhooks. Failures stay failed and are not portal completions.</p>
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-muted-foreground">Schema preview</p>
                    <p className="text-xs text-muted-foreground">{job.schemaPreview.authenticationHeader}</p>
                    <pre className="overflow-x-auto rounded-md bg-muted p-2 text-xs">{JSON.stringify(job.schemaPreview.sample, null, 2)}</pre>
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-muted-foreground">Delivery log</p>
                    {job.attempts.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No delivery attempts yet.</p>
                    ) : (
                      <ul className="space-y-1 text-sm">
                        {job.attempts.map((attempt) => (
                          <li key={attempt.attemptKey}>
                            {attempt.state} · {attempt.correlationId.slice(0, 8)}
                            {attempt.errorMessage ? ` · ${attempt.errorMessage}` : ""}
                            {attempt.externalRef ? ` · ${attempt.externalRef}` : ""}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </CardContent>
    </Card>
  )
}

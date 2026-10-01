"use client"

import * as React from "react"
import { AlertCircle, CheckCircle2, Eye, Loader2, Send } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { RequestError, requestJson } from "@/lib/mca/client"
import { submissionConfirmGate } from "@/lib/mca/integrations/connection-status"
import { MissingPrerequisites } from "@/components/mca/integrations/connection-status"
import {
  DUPLICATE_RULE_COPY,
} from "@/lib/mca/submissions/duplicate-rules"

type JobState =
  | "preflight_failed"
  | "queued"
  | "sending"
  | "sent"
  | "failed"
  | "skipped"
  | "pending_portal"
  | "blocked_duplicate"

type RouteKind = "email" | "api" | "manual_portal" | "custom_webhook"

type SelectionFunder = {
  id: string
  legalName: string
  nickname?: string
  active: boolean
  route: { kind: RouteKind; label: string; destination: string; documentExceptions: string[]; active: boolean } | null
  providerReadiness?: string
  preflightErrors: Array<{ field: string; message: string }>
  checklist: Array<{ documentId: string; filename: string; category: string; checksum: string; excluded: boolean }>
}

type JobView = {
  jobId: string
  funderId: string
  displayFunderName: string
  routeKind: RouteKind
  state: JobState
  reason?: string
  confirmationKey: string
  dealVersion: number
  createdAt: string
  updatedAt: string
  autoSubmitted?: boolean
  deliveryUncertain?: boolean
}

type SelectionPayload = {
  dealId: string
  dealVersion: number
  documents: Array<{ id: string; filename: string; category: string; checksum: string; byteLength: number }>
  funders: SelectionFunder[]
  jobs: JobView[]
  canReconcile?: boolean
  replyMailboxReadiness?: { ready: boolean; consumer: { state: string } }
  autoDecisions?: Array<{ funder_id: string; score: number; outcome: string; reason: string; submission_job_id: string | null; created_at: string }>
}

type ConfirmPayload = {
  ok: true
  confirmationKey: string
  jobs: Array<{ jobId: string; funderId: string; state: JobState; reason?: string; eligibleAt?: string }>
}

type BrokerPreview = {
  id: string
  expiresAt: string
  destinations: Array<{ funderId: string; name: string; method: string; destination: string; providerReadiness?: string; errors: string[]; documents: Array<{ id: string; filename: string; checksum: string }>; email?: { from: string; to: string[]; cc: string[]; replyTo: string; subject: string; body: string } }>
}

type ProtectionPreview = {
  skipped: boolean
  reason?: string
  stampText?: string
  funderLegalName?: string
  watermarkApplied: boolean
  downloadPath?: string
}

const routeLabels: Record<RouteKind, string> = {
  email: "Email",
  api: "API",
  manual_portal: "Manual portal",
  custom_webhook: "Custom webhook",
}

function stateVariant(state: JobState): "default" | "secondary" | "destructive" | "outline" {
  if (state === "sent" || state === "queued" || state === "pending_portal") return "default"
  if (state === "preflight_failed" || state === "failed" || state === "blocked_duplicate") return "destructive"
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

function funderTitle(funder: SelectionFunder): string {
  return funder.nickname || funder.legalName
}

function ReconcileDelivery({ jobId, onSaved }: { jobId: string; onSaved: () => Promise<void> }) {
  const [outcome, setOutcome] = React.useState("")
  const [evidence, setEvidence] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string>()
  async function save() {
    setBusy(true); setError(undefined)
    try {
      await requestJson("/api/mca/submissions/reconcile", { method: "POST", body: JSON.stringify({ jobId, outcome, evidence }) })
      await onSaved()
    } catch (caught) { setError(errorMessage(caught, "Delivery could not be reconciled.")) }
    finally { setBusy(false) }
  }
  return <div className="w-full space-y-2 rounded border p-3">
    <p className="text-sm">Confirm the provider receipt before another send.</p>
    <Label htmlFor={`outcome-${jobId}`}>Provider outcome</Label>
    <select id={`outcome-${jobId}`} className="block rounded border p-2 text-sm" value={outcome} onChange={event => setOutcome(event.target.value)} disabled={busy}>
      <option value="">Choose confirmed outcome</option><option value="accepted">Provider accepted the submission</option><option value="not_sent">Provider confirms it was not sent</option>
    </select>
    <Textarea aria-label="Provider receipt or not-sent evidence" maxLength={500} value={evidence} onChange={event => setEvidence(event.target.value)} disabled={busy} placeholder="Record the provider receipt or confirmation" />
    <Button size="sm" disabled={busy || !outcome || !evidence.trim()} onClick={() => void save()}>Record reconciliation</Button>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>
}

export function SelectionPanel({ dealId }: { dealId: string }) {
  const [payload, setPayload] = React.useState<SelectionPayload>()
  const [selected, setSelected] = React.useState<string[]>([])
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const [message, setMessage] = React.useState<string>()
  const [results, setResults] = React.useState<ConfirmPayload["jobs"]>()
  const [override24h, setOverride24h] = React.useState(false)
  const [overrideReason, setOverrideReason] = React.useState("")
  const [previewBusy, setPreviewBusy] = React.useState<string>()
  const [previewNote, setPreviewNote] = React.useState<string>()
  const [brokerPreview, setBrokerPreview] = React.useState<BrokerPreview>()

  const load = React.useCallback(async () => {
    setError(undefined)
    setLoading(true)
    try {
      const next = await requestJson<SelectionPayload>(`/api/mca/submissions/${encodeURIComponent(dealId)}`)
      setPayload(next)
    } catch (caught) {
      setError(errorMessage(caught, "Submission destinations could not be loaded."))
    } finally {
      setLoading(false)
    }
  }, [dealId])

  React.useEffect(() => { void load() }, [load])

  function toggle(id: string, checked: boolean | "indeterminate") {
    setBrokerPreview(undefined)
    setSelected((current) => {
      if (checked === true) return current.includes(id) ? current : [...current, id]
      return current.filter((item) => item !== id)
    })
  }

  async function confirm() {
    setBusy(true)
    setError(undefined)
    setMessage(undefined)
    if (!selected.length) {
      setError("Select at least one funder.")
      setBusy(false)
      return
    }
    if (override24h && !overrideReason.trim()) {
      setError("Enter a reason to override the 24-hour same-funder rule.")
      setBusy(false)
      return
    }
    try {
      if (!brokerPreview) {
        const preview = await requestJson<BrokerPreview>(`/api/mca/submissions/${encodeURIComponent(dealId)}`, { method: "POST", body: JSON.stringify({ action: "preview", funderIds: selected }) })
        setBrokerPreview(preview)
        return
      }
      const next = await requestJson<ConfirmPayload>(`/api/mca/submissions/${encodeURIComponent(dealId)}`, {
        method: "POST",
        body: JSON.stringify({
          funderIds: selected,
          previewId: brokerPreview.id,
          privilegedRetry: override24h,
          privilegedReason: override24h ? overrideReason.trim() : undefined,
        }),
      })
      setBrokerPreview(undefined)
      setResults(next.jobs)
      const failed = next.jobs.filter((job) => job.state === "failed" || job.state === "preflight_failed" || job.state === "blocked_duplicate").length
      const ok = next.jobs.length - failed
      setMessage(failed && ok
        ? `Queued ${next.jobs.length} destinations. ${ok} continued independently; ${failed} were rejected.`
        : failed
          ? `Queued ${next.jobs.length} destinations. All selected destinations were rejected independently.`
          : `Queued ${next.jobs.length} destinations.`)
      await load()
    } catch (caught) {
      setError(errorMessage(caught, "Submissions could not be confirmed."))
      if (caught instanceof RequestError && caught.status === 409) setBrokerPreview(undefined)
    } finally {
      setBusy(false)
    }
  }

  async function previewProtected(documentId: string, funderId: string, filename: string) {
    const key = `${funderId}:${documentId}`
    setPreviewBusy(key)
    setError(undefined)
    setPreviewNote(undefined)
    try {
      const preview = await requestJson<ProtectionPreview>("/api/mca/submissions/document-protection/preview", {
        method: "POST",
        body: JSON.stringify({ documentId, funderId }),
      })
      if (preview.skipped) {
        setPreviewNote(preview.reason === "disabled"
          ? "Document protection is off. The stored original would be sent."
          : preview.reason === "excluded"
            ? "This funder is excluded from document protection."
            : preview.reason === "not_statement"
              ? `${filename} is not a bank statement, so it is not stamped.`
              : `${filename} cannot be stamped for this destination.`)
        return
      }
      const path = preview.downloadPath ?? `/api/mca/submissions/document-protection/preview/file?documentId=${encodeURIComponent(documentId)}&funderId=${encodeURIComponent(funderId)}`
      window.open(path, "_blank", "noopener,noreferrer")
      setPreviewNote(preview.watermarkApplied
        ? `Opened a protected copy of ${filename}${preview.stampText ? ` (${preview.stampText})` : ""} with the shop logo watermark.`
        : `Opened a stamped copy of ${filename}${preview.stampText ? ` (${preview.stampText})` : ""}. Originals stay unmodified.`)
    } catch (caught) {
      setError(errorMessage(caught, "A stamped preview could not be opened."))
    } finally {
      setPreviewBusy(undefined)
    }
  }

  async function reconciled() { setResults(undefined); await load() }

  const funders = payload?.funders ?? []
  const jobs = payload?.jobs ?? []
  const gate = submissionConfirmGate({ loading, selectedIds: selected, funders })

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2"><Send className="size-5" />Submit to funders</CardTitle>
          <CardDescription>
            Review the exact destination, attachments and email before sending deal version {payload?.dealVersion ?? "—"}. Each funder is queued independently. {DUPLICATE_RULE_COPY.summary}
          </CardDescription>
        </div>
        <Button onClick={() => void confirm()} disabled={!gate.enabled || busy} aria-label={brokerPreview ? "Approve and send submissions" : "Prepare submission preview"}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          {busy ? "Preparing…" : brokerPreview ? "Approve and send" : "Prepare preview"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && <p role="status" className="text-sm text-muted-foreground">Loading submission destinations…</p>}
        {!loading && <MissingPrerequisites missing={gate.missing} />}
        {error && <p role="alert" className="flex items-start gap-2 text-sm text-destructive"><AlertCircle className="mt-0.5 size-4 shrink-0" />{error}</p>}
        {message && <p role="status" className="flex items-start gap-2 text-sm text-emerald-700"><CheckCircle2 className="mt-0.5 size-4 shrink-0" />{message}</p>}
        {payload?.replyMailboxReadiness && !payload.replyMailboxReadiness.ready && <p className="text-sm text-muted-foreground">Automatic reply ingestion is unavailable (mailbox consumer: {payload.replyMailboxReadiness.consumer.state}). Review lender replies manually until the company mailbox is ready.</p>}
        {brokerPreview && <section className="space-y-3 rounded-lg border p-4" aria-label="Exact submission preview">
          <p className="font-medium">Review before sending</p>
          {brokerPreview.destinations.map(destination => <article key={destination.funderId} className="space-y-2 border-t pt-3 text-sm">
            <p className="font-medium">{destination.name} · {destination.method}</p><p className="break-words">Destination: {destination.destination}</p>
            {destination.providerReadiness && <p className="text-muted-foreground">{destination.providerReadiness}</p>}
            {destination.errors.length > 0 && <p role="status">This destination will be rejected: {destination.errors.join(" ")}</p>}
            <ul>{destination.documents.map(document => <li key={document.id}>{document.filename} · {document.checksum.slice(0, 12)}</li>)}</ul>
            {destination.email && <div className="space-y-1"><p>From: {destination.email.from}</p><p>To: {destination.email.to.join(", ")}</p><p>Cc: {destination.email.cc.join(", ") || "None"}</p><p>Reply to: {destination.email.replyTo}</p><p>Subject: {destination.email.subject}</p><pre className="whitespace-pre-wrap font-sans">{destination.email.body}</pre></div>}
          </article>)}
          <p className="text-xs text-muted-foreground">Expires {new Date(brokerPreview.expiresAt).toLocaleString()}.</p>
          <Button variant="outline" disabled={busy} onClick={() => setBrokerPreview(undefined)}>Discard preview</Button>
        </section>}
        {previewNote && <p role="status" className="text-sm text-muted-foreground">{previewNote}</p>}
        <div className="space-y-2 rounded-lg border p-3">
          <div className="flex items-start gap-3">
            <Checkbox
              id="submission-override-24h"
              checked={override24h}
              onCheckedChange={(value) => { setOverride24h(value === true); setBrokerPreview(undefined) }}
              aria-label="Override the 24-hour same-funder rule"
            />
            <div className="min-w-0 flex-1 space-y-2">
              <Label htmlFor="submission-override-24h">{DUPLICATE_RULE_COPY.overrideHint}</Label>
              {override24h && (
                <Textarea
                  id="submission-override-reason"
                  value={overrideReason}
                  onChange={(event) => { setOverrideReason(event.target.value); setBrokerPreview(undefined) }}
                  maxLength={500}
                  aria-label="24-hour override reason"
                  placeholder="Why this deal should be sent to the same funder again"
                />
              )}
            </div>
          </div>
        </div>
        {!loading && !error && funders.length === 0 && (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            Not connected. No active funders are available. Add a funder route before submitting.
          </div>
        )}
        {funders.length > 0 && (
          <ul className="space-y-3">
            {funders.map((funder) => {
              const checked = selected.includes(funder.id)
              const checkboxId = `submission-funder-${funder.id}`
              return (
                <li key={funder.id} className="rounded-lg border p-3">
                  <div className="flex items-start gap-3">
                    <Checkbox
                      id={checkboxId}
                      checked={checked}
                      onCheckedChange={(value) => toggle(funder.id, value)}
                      aria-label={`Select ${funderTitle(funder)}`}
                    />
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <label htmlFor={checkboxId} className="font-medium">{funderTitle(funder)}</label>
                        {funder.route ? (
                          <Badge variant="outline">{routeLabels[funder.route.kind]}</Badge>
                        ) : (
                          <Badge variant="destructive">No active route</Badge>
                        )}
                      </div>
                      {funder.providerReadiness && <p className="text-sm text-muted-foreground">{funder.providerReadiness}</p>}
                      {funder.route && (
                        <p className="text-sm text-muted-foreground">{funder.route.label}: {funder.route.destination}</p>
                      )}
                      {funder.preflightErrors.length > 0 && (
                        <ul className="space-y-1 text-sm text-destructive">
                          {funder.preflightErrors.map((item) => (
                            <li key={`${item.field}:${item.message}`}>{item.message}</li>
                          ))}
                        </ul>
                      )}
                      <ul className="space-y-1 text-xs text-muted-foreground">
                        {funder.checklist.length === 0 ? (
                          <li>No documents on this deal yet.</li>
                        ) : funder.checklist.map((document) => {
                          const previewKey = `${funder.id}:${document.documentId}`
                          const canPreview = document.category === "statement" && !document.excluded
                          return (
                            <li key={document.documentId} className="flex flex-wrap items-center gap-2">
                              <span>
                                {document.filename} · {document.category} · {document.checksum.slice(0, 12)}
                                {document.excluded ? " · excluded" : ""}
                              </span>
                              {canPreview && (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  className="h-7 px-2 text-xs"
                                  disabled={loading || busy || previewBusy === previewKey}
                                  aria-label={`Preview stamped copy of ${document.filename} for ${funderTitle(funder)}`}
                                  onClick={() => void previewProtected(document.documentId, funder.id, document.filename)}
                                >
                                  {previewBusy === previewKey ? <Loader2 className="size-3 animate-spin" /> : <Eye className="size-3" />}
                                  Preview stamped copy
                                </Button>
                              )}
                            </li>
                          )
                        })}
                      </ul>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
        {results && results.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">Latest confirmation</p>
            <ul className="space-y-2 text-sm">
              {results.map((job) => (
                <li key={job.jobId} className="flex flex-wrap items-center gap-2">
                  <Badge variant={stateVariant(job.state)}>{stateLabel(job.state)}</Badge>
                  <span>{funders.find((item) => item.id === job.funderId)?.legalName ?? job.funderId}</span>
                  {job.reason ? <span className="text-muted-foreground">{job.reason}</span> : null}
                  {payload?.canReconcile && jobs.find(existing => existing.jobId === job.jobId)?.deliveryUncertain && <ReconcileDelivery jobId={job.jobId} onSaved={reconciled} />}
                </li>
              ))}
            </ul>
          </div>
        )}
        {payload?.autoDecisions && payload.autoDecisions.length > 0 && <div className="space-y-1 text-sm"><p className="font-medium">Automatic decisions</p>{payload.autoDecisions.map((decision, index) => <p key={`${decision.funder_id}:${index}`} className="text-muted-foreground">{funders.find(item => item.id === decision.funder_id)?.legalName ?? decision.funder_id}: {decision.outcome} (score {decision.score}) — {decision.reason}</p>)}</div>}
        {!results && jobs.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">Existing jobs</p>
            <ul className="space-y-2 text-sm">
              {jobs.map((job) => (
                <li key={job.jobId} className="flex flex-wrap items-center gap-2">
                  <Badge variant={stateVariant(job.state)}>{stateLabel(job.state)}</Badge>
                  <span>{job.displayFunderName}</span>
                  {job.autoSubmitted && <Badge variant="secondary">Auto-submitted</Badge>}
                  {job.reason ? <span className="text-muted-foreground">{job.reason}</span> : null}
                  {payload?.canReconcile && job.deliveryUncertain && <ReconcileDelivery jobId={job.jobId} onSaved={reconciled} />}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

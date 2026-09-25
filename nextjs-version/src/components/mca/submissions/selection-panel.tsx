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
  confirmationAttemptFingerprint,
  confirmationKeyForAttempt,
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
}

type SelectionPayload = {
  dealId: string
  dealVersion: number
  documents: Array<{ id: string; filename: string; category: string; checksum: string; byteLength: number }>
  funders: SelectionFunder[]
  jobs: JobView[]
}

type ConfirmPayload = {
  ok: true
  confirmationKey: string
  jobs: Array<{ jobId: string; funderId: string; state: JobState; reason?: string; eligibleAt?: string }>
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
  const pendingConfirmation = React.useRef<{ fingerprint: string; key: string } | null>(null)

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
    const pending = confirmationKeyForAttempt(
      pendingConfirmation.current,
      confirmationAttemptFingerprint({
        funderIds: selected,
        override24h,
        overrideReason,
      }),
      () => crypto.randomUUID(),
    )
    pendingConfirmation.current = pending
    try {
      const next = await requestJson<ConfirmPayload>(`/api/mca/submissions/${encodeURIComponent(dealId)}`, {
        method: "POST",
        body: JSON.stringify({
          funderIds: selected,
          confirmationKey: pending.key,
          privilegedRetry: override24h,
          privilegedReason: override24h ? overrideReason.trim() : undefined,
        }),
      })
      pendingConfirmation.current = null
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

  const funders = payload?.funders ?? []
  const jobs = payload?.jobs ?? []
  const gate = submissionConfirmGate({ loading, selectedIds: selected, funders })

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2"><Send className="size-5" />Submit to funders</CardTitle>
          <CardDescription>
            Confirming freezes deal version {payload?.dealVersion ?? "—"} and document checksums. Each funder is queued independently. {DUPLICATE_RULE_COPY.summary}
          </CardDescription>
        </div>
        <Button onClick={() => void confirm()} disabled={!gate.enabled || busy} aria-label="Confirm submissions">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          {busy ? "Confirming…" : "Confirm submissions"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && <p role="status" className="text-sm text-muted-foreground">Loading submission destinations…</p>}
        {!loading && <MissingPrerequisites missing={gate.missing} />}
        {error && <p role="alert" className="flex items-start gap-2 text-sm text-destructive"><AlertCircle className="mt-0.5 size-4 shrink-0" />{error}</p>}
        {message && <p role="status" className="flex items-start gap-2 text-sm text-emerald-700"><CheckCircle2 className="mt-0.5 size-4 shrink-0" />{message}</p>}
        {previewNote && <p role="status" className="text-sm text-muted-foreground">{previewNote}</p>}
        <div className="space-y-2 rounded-lg border p-3">
          <div className="flex items-start gap-3">
            <Checkbox
              id="submission-override-24h"
              checked={override24h}
              onCheckedChange={(value) => setOverride24h(value === true)}
              aria-label="Override the 24-hour same-funder rule"
            />
            <div className="min-w-0 flex-1 space-y-2">
              <Label htmlFor="submission-override-24h">{DUPLICATE_RULE_COPY.overrideHint}</Label>
              {override24h && (
                <Textarea
                  id="submission-override-reason"
                  value={overrideReason}
                  onChange={(event) => setOverrideReason(event.target.value)}
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
                </li>
              ))}
            </ul>
          </div>
        )}
        {!results && jobs.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">Existing jobs</p>
            <ul className="space-y-2 text-sm">
              {jobs.map((job) => (
                <li key={job.jobId} className="flex flex-wrap items-center gap-2">
                  <Badge variant={stateVariant(job.state)}>{stateLabel(job.state)}</Badge>
                  <span>{job.displayFunderName}</span>
                  {job.reason ? <span className="text-muted-foreground">{job.reason}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

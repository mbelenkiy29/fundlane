"use client"

import * as React from "react"
import { AlertCircle, CheckCircle2, Loader2, Send } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
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
  jobs: Array<{ jobId: string; funderId: string; state: JobState; reason?: string }>
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
  const [confirmationKey] = React.useState(() => crypto.randomUUID())
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const [message, setMessage] = React.useState<string>()
  const [results, setResults] = React.useState<ConfirmPayload["jobs"]>()

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
    try {
      const next = await requestJson<ConfirmPayload>(`/api/mca/submissions/${encodeURIComponent(dealId)}`, {
        method: "POST",
        body: JSON.stringify({ funderIds: selected, confirmationKey }),
      })
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

  const funders = payload?.funders ?? []
  const jobs = payload?.jobs ?? []

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2"><Send className="size-5" />Submit to funders</CardTitle>
          <CardDescription>
            Confirming freezes deal version {payload?.dealVersion ?? "—"} and document checksums. Each funder is queued independently.
          </CardDescription>
        </div>
        <Button onClick={() => void confirm()} disabled={loading || busy} aria-label="Confirm submissions">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          {busy ? "Confirming…" : "Confirm submissions"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && <p role="status" className="text-sm text-muted-foreground">Loading submission destinations…</p>}
        {error && <p role="alert" className="flex items-start gap-2 text-sm text-destructive"><AlertCircle className="mt-0.5 size-4 shrink-0" />{error}</p>}
        {message && <p role="status" className="flex items-start gap-2 text-sm text-emerald-700"><CheckCircle2 className="mt-0.5 size-4 shrink-0" />{message}</p>}
        {!loading && !error && funders.length === 0 && (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            No active funders are available. Add a funder route before submitting.
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
                        ) : funder.checklist.map((document) => (
                          <li key={document.documentId}>
                            {document.filename} · {document.category} · {document.checksum.slice(0, 12)}
                            {document.excluded ? " · excluded" : ""}
                          </li>
                        ))}
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

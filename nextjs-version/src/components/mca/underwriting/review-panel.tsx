"use client"

import * as React from "react"
import { Check, Mail, RefreshCw, ShieldCheck } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { RequestError, requestJson } from "@/lib/mca/client"
import type { AnalysisSnapshot, FunderScore } from "@/lib/mca/underwriting/contracts"

type Outcome = "selected" | "excluded" | "blocked"

type Candidate = {
  funderId: string
  name: string
  score: number
  grade: FunderScore["grade"]
  eligible: boolean
  selected: boolean
  blocked: boolean
  reasons: FunderScore["reasons"]
  outcome?: Outcome
  reason?: string
}

type Run = {
  id: string
  snapshotId: string
  mode: string
  state: "scored" | "review_pending" | "approved" | "blocked" | "queued" | "submission_unavailable"
  selectedFunderIds: string[]
  reason: string
}

type Payload = {
  dealId: string
  dealName: string
  run: Run | null
  snapshot: AnalysisSnapshot | null
  candidates: Candidate[]
  completenessReady: boolean
  stale: boolean
  staleReasons?: string[]
  disclaimer: string
  approval: { id: string; selectedFunderIds: string[]; createdAt: string } | null
  tokenValid: boolean
  expiresAt?: string
}

function gradeVariant(grade: FunderScore["grade"]): "default" | "secondary" | "destructive" | "outline" {
  if (grade === "DQ" || grade === "F") return "destructive"
  if (grade === "A") return "default"
  return "secondary"
}

function reasonTone(result: FunderScore["reasons"][number]["result"]): string {
  if (result === "fail") return "text-destructive"
  if (result === "unknown") return "text-amber-700"
  return "text-muted-foreground"
}

export function ReviewPanel({ dealId, token }: { dealId?: string; token?: string }) {
  const [payload, setPayload] = React.useState<Payload>()
  const [selected, setSelected] = React.useState<string[]>([])
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const [message, setMessage] = React.useState<string>()

  const endpoint = token
    ? `/api/mca/underwriting/review/${encodeURIComponent(token)}`
    : dealId
      ? `/api/mca/underwriting/review/deal/${encodeURIComponent(dealId)}`
      : ""

  const load = React.useCallback(async () => {
    if (!endpoint) {
      setError("A review link or deal is required.")
      setLoading(false)
      return
    }
    setError(undefined)
    setLoading(true)
    try {
      const next = await requestJson<Payload>(endpoint)
      setPayload(next)
      setSelected(next.candidates.filter((row) => row.selected && row.eligible).map((row) => row.funderId))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "This review could not be loaded.")
    } finally {
      setLoading(false)
    }
  }, [endpoint])

  React.useEffect(() => { void load() }, [load])

  function toggle(funderId: string, enabled: boolean) {
    setSelected((current) => {
      if (enabled) return current.includes(funderId) ? current : [...current, funderId]
      return current.filter((id) => id !== funderId)
    })
  }

  async function send() {
    if (!dealId) return
    setBusy(true)
    setError(undefined)
    setMessage(undefined)
    try {
      const sent = await requestJson<{ expiresAt: string; recipients: Array<{ email: string }> }>("/api/mca/underwriting/review", {
        method: "POST",
        body: JSON.stringify({ dealId }),
      })
      setMessage(`Review email sent to ${sent.recipients.length} recipient${sent.recipients.length === 1 ? "" : "s"}. The link expires at ${new Date(sent.expiresAt).toLocaleString()}.`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The review email could not be sent.")
    } finally {
      setBusy(false)
    }
  }

  async function confirm() {
    if (!endpoint) return
    if (!selected.length) {
      setError("Select at least one eligible funder.")
      return
    }
    setBusy(true)
    setError(undefined)
    setMessage(undefined)
    try {
      const next = await requestJson<Payload>(endpoint, {
        method: "POST",
        body: JSON.stringify({ selectedFunderIds: selected }),
      })
      setPayload(next)
      setSelected(next.approval?.selectedFunderIds ?? selected)
      setMessage("Selection approved for this analysis snapshot.")
    } catch (caught) {
      if (caught instanceof RequestError && caught.fieldErrors?.selectedFunderIds?.[0]) setError(caught.fieldErrors.selectedFunderIds[0])
      else setError(caught instanceof Error ? caught.message : "The review could not be confirmed.")
    } finally {
      setBusy(false)
    }
  }

  const canConfirm = Boolean(payload?.run) && payload?.completenessReady && !payload.stale && (payload.run?.state === "review_pending" || payload.run?.state === "approved")
  const candidates = payload?.candidates ?? []

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2"><ShieldCheck className="size-5" />Review funder selection</CardTitle>
          <CardDescription>
            {payload?.dealName ? `${payload.dealName}. ` : ""}
            {payload?.disclaimer || "Scores describe funder fit, not approval odds."}
          </CardDescription>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void load()} disabled={loading || busy} aria-label="Reload review">
            <RefreshCw className="size-4" />Reload
          </Button>
          {dealId && (
            <Button variant="outline" onClick={() => void send()} disabled={loading || busy || !payload?.run} aria-label="Send review email">
              {busy ? <RefreshCw className="size-4 animate-spin" /> : <Mail className="size-4" />}
              Send review email
            </Button>
          )}
          <Button onClick={() => void confirm()} disabled={loading || busy || !canConfirm} aria-label="Confirm funder selection">
            {busy ? <RefreshCw className="size-4 animate-spin" /> : <Check className="size-4" />}
            {payload?.run?.state === "approved" ? "Save selection" : "Confirm selection"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && <p role="status" className="text-sm text-muted-foreground">Loading review…</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {message && <p role="status" className="text-sm text-emerald-700">{message}</p>}
        {!loading && !error && !payload?.run && (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            No analysis review is waiting. Run review-first analysis before sending a link or confirming a selection.
          </div>
        )}
        {payload?.run && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={payload.run.state === "approved" ? "default" : payload.run.state === "review_pending" ? "secondary" : "outline"}>
                {payload.run.state.replace(/_/g, " ")}
              </Badge>
              {payload.completenessReady ? <Badge variant="outline">Completeness ready</Badge> : <Badge variant="destructive">Completeness not ready</Badge>}
              {payload.stale ? <Badge variant="destructive">Scores stale</Badge> : <Badge variant="outline">Scores current</Badge>}
            </div>
            {!payload.completenessReady && (
              <p role="status" className="rounded-md border px-3 py-2 text-sm">Document completeness must be ready before this snapshot can be approved.</p>
            )}
            {payload.stale && (
              <p role="status" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                Funder scores changed. Re-run analysis. This approval still binds only to snapshot {payload.run.snapshotId}.
              </p>
            )}
            {payload.expiresAt && (
              <p className="text-xs text-muted-foreground">Link expires {new Date(payload.expiresAt).toLocaleString()}.</p>
            )}
            {candidates.length === 0 && (
              <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No funder candidates on this snapshot.</div>
            )}
            <ul className="space-y-3">
              {candidates.map((candidate) => (
                <li key={candidate.funderId} className="rounded-lg border p-3">
                  <label className="flex items-start gap-3">
                    <Checkbox
                      checked={selected.includes(candidate.funderId)}
                      disabled={candidate.blocked || busy}
                      onCheckedChange={(value) => toggle(candidate.funderId, value === true)}
                      aria-label={`Select ${candidate.name}`}
                    />
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{candidate.name}</span>
                        <Badge variant={gradeVariant(candidate.grade)}>{candidate.grade} {candidate.score}</Badge>
                        {candidate.blocked && <Badge variant="destructive">Not selectable</Badge>}
                        {candidate.outcome && <Badge variant="outline">{candidate.outcome}</Badge>}
                      </div>
                      {candidate.reason && <p className="text-sm text-muted-foreground">{candidate.reason}</p>}
                      <ul className="space-y-0.5 text-xs">
                        {candidate.reasons.map((reason) => (
                          <li key={`${candidate.funderId}:${reason.ruleId}`} className={reasonTone(reason.result)}>{reason.detail}</li>
                        ))}
                      </ul>
                    </div>
                  </label>
                </li>
              ))}
            </ul>
            {payload.approval && (
              <p className="text-xs text-muted-foreground">
                Approval {payload.approval.id} is bound to this snapshot only.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

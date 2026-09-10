"use client"

import * as React from "react"
import { Play, RefreshCw, Sparkles } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { RequestError, requestJson } from "@/lib/mca/client"
import type { AnalysisMode, AnalysisSnapshot } from "@/lib/mca/underwriting/contracts"

type Channel = "select_only" | "email_only" | "both"
type Outcome = "selected" | "excluded" | "blocked"

type Settings = {
  mode: AnalysisMode
  topN: number
  reviewNotificationChannel: Channel
  automaticSendEnabled: boolean
}

type Destination = { funderId: string; outcome: Outcome; reason: string }

type Run = {
  id: string
  snapshotId: string
  mode: AnalysisMode
  state: "scored" | "review_pending" | "approved" | "blocked" | "queued" | "submission_unavailable"
  selectedFunderIds: string[]
  reason: string
  topN: number
  reviewNotificationChannel: Channel
  settingsSnapshot: Settings
  trigger: "manual" | "readiness"
  createdAt: string
}

type Payload = {
  settings: Settings
  run: Run | null
  destinations: Destination[]
  snapshot: AnalysisSnapshot | null
  funders?: Array<{ id: string; legalName: string; nickname?: string; active: boolean }>
}

function funderName(payload: Payload, funderId: string): string {
  const match = payload.funders?.find((funder) => funder.id === funderId)
  return match?.nickname || match?.legalName || funderId
}

function modeLabel(mode: AnalysisMode): string {
  if (mode === "analyze_only") return "Analyze only"
  if (mode === "automatic_send") return "Automatic send"
  return "Review first"
}

function channelLabel(channel: Channel): string {
  if (channel === "select_only") return "Select only"
  if (channel === "email_only") return "Email only"
  return "Select and email"
}

function stateVariant(state: Run["state"]): "default" | "secondary" | "destructive" | "outline" {
  if (state === "blocked") return "destructive"
  if (state === "submission_unavailable" || state === "queued") return "outline"
  if (state === "review_pending") return "secondary"
  return "default"
}

function outcomeVariant(outcome: Outcome): "default" | "secondary" | "destructive" | "outline" {
  if (outcome === "blocked") return "destructive"
  if (outcome === "excluded") return "outline"
  return "default"
}

export function AnalysisPanel({ dealId }: { dealId: string }) {
  const [payload, setPayload] = React.useState<Payload>()
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const [message, setMessage] = React.useState<string>()
  const [mode, setMode] = React.useState<AnalysisMode>("review_first")
  const [topN, setTopN] = React.useState("5")
  const [channel, setChannel] = React.useState<Channel>("both")

  const load = React.useCallback(async () => {
    setError(undefined)
    setLoading(true)
    try {
      const next = await requestJson<Payload>(`/api/mca/underwriting/analysis/${encodeURIComponent(dealId)}`)
      setPayload(next)
      setMode(next.settings.mode)
      setTopN(String(next.settings.topN))
      setChannel(next.settings.reviewNotificationChannel)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Analysis could not be loaded.")
    } finally {
      setLoading(false)
    }
  }, [dealId])

  React.useEffect(() => { void load() }, [load])

  async function run() {
    setBusy(true)
    setError(undefined)
    setMessage(undefined)
    const parsedTopN = Number(topN)
    if (!Number.isInteger(parsedTopN) || parsedTopN < 1 || parsedTopN > 25) {
      setError("Top N must be a whole number from 1 to 25.")
      setBusy(false)
      return
    }
    if (mode === "automatic_send" && payload && !payload.settings.automaticSendEnabled) {
      setError("Automatic send is disabled until an administrator enables it.")
      setBusy(false)
      return
    }
    try {
      const next = await requestJson<Payload>(`/api/mca/underwriting/analysis/${encodeURIComponent(dealId)}`, {
        method: "POST",
        body: JSON.stringify({ mode, topN: parsedTopN, reviewNotificationChannel: channel }),
      })
      setPayload(next)
      if (next.run?.state === "blocked" && next.run.reason === "no_qualified_funder") {
        setMessage("No qualified funders. Disqualified funders were not selected.")
      } else if (next.run?.state === "blocked" && next.run.reason === "automatic_send_disabled") {
        setError("Automatic send is disabled until an administrator enables it.")
      } else if (next.run?.state === "queued") {
        setMessage("Analysis queued independent submission jobs. Open the Submissions tab to review destinations.")
      } else if (next.run?.state === "submission_unavailable") {
        setMessage("Analysis queued submissions, but sending is unavailable until the submission job exists.")
      } else if (next.run?.mode === "analyze_only") {
        setMessage("Analysis scored funders without changing selection or sending.")
      } else {
        setMessage("Analysis run saved. Review the selected funders before submitting.")
      }
    } catch (caught) {
      if (caught instanceof RequestError && caught.fieldErrors?.topN?.[0]) setError(caught.fieldErrors.topN[0])
      else setError(caught instanceof Error ? caught.message : "Analysis run failed.")
    } finally {
      setBusy(false)
    }
  }

  const runRecord = payload?.run
  const destinations = payload?.destinations ?? []

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2"><Sparkles className="size-5" />Funder analysis</CardTitle>
          <CardDescription>
            Workspace default is {payload ? modeLabel(payload.settings.mode) : "review first"} with top {payload?.settings.topN ?? 5}.
            Run-level overrides do not change those defaults.
          </CardDescription>
        </div>
        <Button onClick={() => void run()} disabled={loading || busy} aria-label="Run funder analysis">
          {busy ? <RefreshCw className="size-4 animate-spin" /> : <Play className="size-4" />}
          {busy ? "Analyzing…" : payload?.run ? "Run again" : "Run analysis"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="analysis-mode">Mode</Label>
            <Select value={mode} onValueChange={(value) => setMode(value as AnalysisMode)}>
              <SelectTrigger id="analysis-mode" aria-label="Analysis mode"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="analyze_only">Analyze only</SelectItem>
                <SelectItem value="review_first">Review first</SelectItem>
                <SelectItem value="automatic_send">Automatic send</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="analysis-topn">Top N funders</Label>
            <Input id="analysis-topn" inputMode="numeric" value={topN} onChange={(event) => setTopN(event.target.value)} aria-label="Top N funders" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="analysis-channel">Review notification</Label>
            <Select value={channel} onValueChange={(value) => setChannel(value as Channel)}>
              <SelectTrigger id="analysis-channel" aria-label="Review notification channel"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="select_only">Select only</SelectItem>
                <SelectItem value="email_only">Email only</SelectItem>
                <SelectItem value="both">Select and email</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        {payload && !payload.settings.automaticSendEnabled && (
          <p className="text-xs text-muted-foreground">Automatic send stays blocked until an administrator enables it. Analyze-only never changes selection or sends.</p>
        )}
        {loading && <p role="status" className="text-sm text-muted-foreground">Loading analysis…</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {message && <p role="status" className="text-sm text-emerald-700">{message}</p>}
        {!loading && !error && !runRecord && (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            No analysis run yet. Run after completeness is ready, or start a manual analysis with an optional override.
          </div>
        )}
        {runRecord && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={stateVariant(runRecord.state)}>{runRecord.state.split("_").join(" ")}</Badge>
              <Badge variant="outline">{modeLabel(runRecord.mode)}</Badge>
              <Badge variant="secondary">{channelLabel(runRecord.reviewNotificationChannel)}</Badge>
            </div>
            {runRecord.state === "queued" && (
              <p role="status" className="rounded-md border px-3 py-2 text-sm">
                Independent submission jobs were queued. Failed destinations do not stop the others.
              </p>
            )}
            {runRecord.state === "submission_unavailable" && (
              <p role="status" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                Submissions were queued through the shared port and are unavailable until sending exists.
              </p>
            )}
            {runRecord.reason === "no_qualified_funder" && (
              <p role="status" className="rounded-md border px-3 py-2 text-sm">No qualified funders. DQ funders cannot be selected.</p>
            )}
            <p className="text-sm text-muted-foreground">
              {runRecord.selectedFunderIds.length
                ? `Selected ${runRecord.selectedFunderIds.map((id) => funderName(payload!, id)).join(", ")}.`
                : "No in-app selection for this run."}
            </p>
            {destinations.length > 0 && (
              <ul className="space-y-2 text-sm">
                {destinations.map((destination) => (
                  <li key={`${destination.funderId}:${destination.outcome}`} className="flex flex-wrap items-start gap-2">
                    <Badge variant={outcomeVariant(destination.outcome)}>{destination.outcome}</Badge>
                    <span className="font-medium">{funderName(payload!, destination.funderId)}</span>
                    <span className="text-muted-foreground">{destination.reason}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">
              Snapshot {runRecord.settingsSnapshot.mode} · top {runRecord.settingsSnapshot.topN} · {new Date(runRecord.createdAt).toLocaleString()}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

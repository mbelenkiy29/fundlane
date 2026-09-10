"use client"

import * as React from "react"
import { Gauge, RefreshCw } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { requestJson } from "@/lib/mca/client"
import type { AnalysisSnapshot, FunderScore } from "@/lib/mca/underwriting/contracts"

type Payload = {
  snapshot: AnalysisSnapshot | null
  stale: boolean
  staleReasons?: string[]
  disclaimer: string
  autoSelectableFunderIds: string[]
  funders?: Array<{ id: string; legalName: string; nickname?: string; active: boolean }>
}

function funderName(payload: Payload, funderId: string): string {
  const match = payload.funders?.find((funder) => funder.id === funderId)
  return match?.nickname || match?.legalName || funderId
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

export function ScorePanel({ dealId }: { dealId: string }) {
  const [payload, setPayload] = React.useState<Payload>()
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const [message, setMessage] = React.useState<string>()

  const load = React.useCallback(async () => {
    setError(undefined)
    setLoading(true)
    try {
      setPayload(await requestJson<Payload>(`/api/mca/underwriting/scores/${encodeURIComponent(dealId)}`))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Funder scores could not be loaded.")
    } finally {
      setLoading(false)
    }
  }, [dealId])

  React.useEffect(() => { void load() }, [load])

  async function reanalyze() {
    setBusy(true)
    setError(undefined)
    setMessage(undefined)
    try {
      const next = await requestJson<Payload>(`/api/mca/underwriting/scores/${encodeURIComponent(dealId)}`, { method: "POST", body: "{}" })
      setPayload(next)
      setMessage(next.snapshot?.scores.length ? "Funder fit scores updated." : "No active funders were available to score.")
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Funder scoring failed.")
    } finally {
      setBusy(false)
    }
  }

  const scores = payload?.snapshot?.scores ?? []
  const selectable = new Set(payload?.autoSelectableFunderIds ?? [])

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2"><Gauge className="size-5" />Funder fit scores</CardTitle>
          <CardDescription>{payload?.disclaimer ?? "Scores describe funder fit, not approval odds."}</CardDescription>
        </div>
        <Button onClick={() => void reanalyze()} disabled={loading || busy} aria-label="Reanalyze funder scores">
          <RefreshCw className="size-4" />{busy ? "Scoring…" : payload?.snapshot ? "Reanalyze" : "Score funders"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && <p role="status" className="text-sm text-muted-foreground">Loading funder scores…</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {message && <p role="status" className="text-sm text-emerald-700">{message}</p>}
        {payload?.stale && (
          <p role="status" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Scores are stale{payload.staleReasons?.length ? `: ${payload.staleReasons.join("; ")}` : ""}. Reanalyze after the criteria or underwriting change.
          </p>
        )}
        {!loading && !error && !payload?.snapshot && (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            No score snapshot yet. Run scoring after statements and funder criteria are in place.
          </div>
        )}
        {payload?.snapshot && scores.length === 0 && (
          <p className="text-sm text-muted-foreground">No active funders were scored for this deal.</p>
        )}
        {scores.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Rank</TableHead>
                <TableHead>Funder</TableHead>
                <TableHead>Grade</TableHead>
                <TableHead>Score</TableHead>
                <TableHead>Reasons</TableHead>
                <TableHead>Data age</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {scores.map((score) => (
                <TableRow key={score.funderId}>
                  <TableCell>{score.rank}</TableCell>
                  <TableCell>
                    <div className="font-medium">{funderName(payload!, score.funderId)}</div>
                    {!selectable.has(score.funderId) && <p className="text-xs text-muted-foreground">Not eligible for automatic selection</p>}
                  </TableCell>
                  <TableCell><Badge variant={gradeVariant(score.grade)}>{score.grade}</Badge></TableCell>
                  <TableCell>{score.eligible ? score.score : "—"}</TableCell>
                  <TableCell>
                    <ul className="space-y-1 text-xs">
                      {score.reasons.map((reason) => (
                        <li key={`${score.funderId}:${reason.ruleId}:${reason.result}`} className={reasonTone(reason.result)}>
                          {reason.result}: {reason.detail}
                        </li>
                      ))}
                    </ul>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{score.dataAge ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {payload?.snapshot && (
          <p className="text-xs text-muted-foreground">
            Policy v{payload.snapshot.policyVersion} · Underwriting v{payload.snapshot.underwritingVersion} · {new Date(payload.snapshot.createdAt).toLocaleString()}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

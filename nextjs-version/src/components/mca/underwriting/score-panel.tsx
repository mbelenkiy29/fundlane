"use client"

import * as React from "react"
import Link from "next/link"
import { Gauge, RefreshCw } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { requestJson } from "@/lib/mca/client"
import { dealSubmissionHref } from "@/lib/mca/submissions/dashboard-view"
import type { LenderFitResponse, LenderFitStatus } from "@/lib/mca/underwriting/lender-fit-contracts"

const labels: Record<LenderFitStatus, string> = {
  matched: "Configured criteria matched", excluded: "Configured rule excludes", needs_review: "Needs broker review",
  inactive: "Inactive", stale_criteria: "Criteria expired", unscored: "Not scored",
}

export function ScorePanel({ dealId }: { dealId: string }) {
  const [payload, setPayload] = React.useState<LenderFitResponse>()
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const load = React.useCallback(async () => {
    setLoading(true); setError(undefined)
    try { setPayload(await requestJson<LenderFitResponse>(`/api/mca/underwriting/lender-fit/${encodeURIComponent(dealId)}`)) }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Lender fit could not be loaded.") }
    finally { setLoading(false) }
  }, [dealId])
  React.useEffect(() => { void load() }, [load])
  async function reanalyze() {
    setBusy(true); setError(undefined)
    try {
      await requestJson(`/api/mca/underwriting/scores/${encodeURIComponent(dealId)}`, { method: "POST", body: "{}" })
      await load()
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Lender scoring failed.") }
    finally { setBusy(false) }
  }
  return <Card>
    <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
      <div><CardTitle className="flex items-center gap-2"><Gauge className="size-5" />Lender fit</CardTitle>
        <CardDescription>{payload?.disclaimer ?? "Scores describe lender fit, not approval odds."} Broker review and final selection are required. Criteria do not supply offer terms.</CardDescription></div>
      <Button onClick={() => void reanalyze()} disabled={loading || busy}><RefreshCw className="size-4" />{busy ? "Scoring…" : payload?.snapshotId ? "Reanalyze" : "Score lenders"}</Button>
    </CardHeader>
    <CardContent className="space-y-4">
      {loading && <p role="status" className="text-sm text-muted-foreground">Loading lender fit…</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {payload?.stale && <p role="status" className="rounded-md border p-3 text-sm">Snapshot needs recomputation: {payload.staleReasons.join("; ")}. Reanalyze before using ranked fits.</p>}
      {!loading && payload && !payload.lenders.length && <p className="text-sm text-muted-foreground">No lenders configured. Add lender profiles and verified criteria to compare fit.</p>}
      {payload && payload.lenders.length > 0 && <Table>
        <TableHeader><TableRow><TableHead>Rank / fit</TableHead><TableHead>Lender</TableHead><TableHead>Status</TableHead><TableHead>Reasons and sources</TableHead></TableRow></TableHeader>
        <TableBody>{payload.lenders.map((lender) => <TableRow key={lender.funderId}>
          <TableCell>{lender.rank == null ? "—" : `#${lender.rank} · ${lender.score}/100`}</TableCell>
          <TableCell><p className="font-medium">{lender.name}</p><p className="text-xs text-muted-foreground">Criteria v{lender.criteriaVersion}</p></TableCell>
          <TableCell><Badge variant={lender.status === "matched" ? "default" : "outline"}>{labels[lender.status]}</Badge></TableCell>
          <TableCell className="space-y-2 text-xs">
            <ul className="space-y-1">{lender.reasons.map((reason, index) => <li key={`${reason.ruleId}:${index}`} className={reason.result === "fail" ? "text-destructive" : "text-muted-foreground"}>{reason.result}: {reason.detail}</li>)}</ul>
            {lender.criteria.rules.map((rule) => <p key={rule.id}>{rule.field}: {rule.unspecified ? "unspecified" : `${Array.isArray(rule.value) ? rule.value.join(", ") : String(rule.value)} ${rule.unit}`} · Source: {rule.sourceText || "missing"} · As of: {rule.sourceAsOf || "unknown"} · Valid until: {rule.validUntil || "not supplied"}</p>)}
            {lender.missingData.length > 0 && <p>Missing evidence: {lender.missingData.join(", ")}</p>}
          </TableCell>
        </TableRow>)}</TableBody>
      </Table>}
      {payload?.snapshotId && <p className="text-xs text-muted-foreground">Policy v{payload.policyVersion} · Underwriting v{payload.underwritingVersion} · Scored {payload.scoredAt} · Evaluated as of {payload.asOf}</p>}
      <Button asChild variant="outline"><Link href={dealSubmissionHref(dealId)}>Review and select lenders</Link></Button>
    </CardContent>
  </Card>
}

"use client"

import * as React from "react"
import { RefreshCw } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { requestJson } from "@/lib/mca/client"
import type { ExistingPositionCandidate, MetricEvidence, StatementMonthRecord, UnderwritingAggregate } from "@/lib/mca/underwriting/contracts"

type Payload = { months: StatementMonthRecord[]; positions: ExistingPositionCandidate[]; aggregate: UnderwritingAggregate | null }

function formatMetric(metric?: MetricEvidence | null): string {
  if (!metric || metric.unknown || metric.value == null || !Number.isFinite(metric.value)) return "Unknown"
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(metric.value)
}

function kindLabel(kind: StatementMonthRecord["accountKind"]): string {
  if (kind === "checking") return "Checking"
  if (kind === "savings") return "Savings"
  if (kind === "credit_card") return "Credit card"
  if (kind === "loan") return "Loan"
  return "Unsupported"
}

function warningLabel(warning: string): string {
  if (warning.startsWith("transfer:")) return `Transfer: ${warning.slice("transfer:".length).trim() || warning}`
  if (warning.startsWith("mca_credit:")) return `MCA credit: ${warning.slice("mca_credit:".length).trim() || warning}`
  return warning
}

export function StatementPanel({ dealId }: { dealId: string }) {
  const [payload, setPayload] = React.useState<Payload>()
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const [message, setMessage] = React.useState<string>()

  const load = React.useCallback(async () => {
    setError(undefined)
    setLoading(true)
    try {
      setPayload(await requestJson<Payload>(`/api/mca/underwriting/statements/${encodeURIComponent(dealId)}`))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Statement underwriting could not be loaded.")
    } finally { setLoading(false) }
  }, [dealId])

  React.useEffect(() => { void load() }, [load])

  async function analyze() {
    setBusy(true); setError(undefined); setMessage(undefined)
    try {
      const result = await requestJson<Payload>(`/api/mca/underwriting/statements/${encodeURIComponent(dealId)}/analyze`, { method: "POST", body: "{}" })
      setPayload(result)
      setMessage(result.months.length ? "Statement analysis updated." : "No clean checking statements were available to analyze.")
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Statement analysis failed.")
    } finally { setBusy(false) }
  }

  const months = payload?.months ?? []
  const positions = payload?.positions ?? []
  const aggregate = payload?.aggregate

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>Bank statement underwriting</CardTitle>
          <CardDescription>
            Checking-account deposits, unique-day NSF, deposit counts, and confirmed positions. Savings, credit card, and loan statements keep their real account kinds and stay out of checking aggregates. Unknown values stay Unknown and are never shown as 0.
          </CardDescription>
        </div>
        <Button onClick={analyze} disabled={busy || loading}><RefreshCw className="size-4" />{aggregate ? "Rerun analysis" : "Analyze statements"}</Button>
      </CardHeader>
      <CardContent className="space-y-6">
        {loading && <p role="status" className="text-sm text-muted-foreground">Loading statement underwriting…</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {message && <p role="status" className="text-sm text-emerald-700">{message}</p>}
        {!loading && !error && months.length === 0 && (
          <p className="text-sm text-muted-foreground">No analyzed bank statements yet. Run analysis on clean checking statements in the vault.</p>
        )}
        {aggregate && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-medium">Aggregates</h3>
              <Badge variant="outline">v{aggregate.version}</Badge>
              {aggregate.stale ? <Badge variant="secondary">Stale</Badge> : <Badge>Current</Badge>}
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Monthly revenue</TableHead>
                  <TableHead>Average daily balance</TableHead>
                  <TableHead>Unique-day NSF</TableHead>
                  <TableHead>Worst-month NSF</TableHead>
                  <TableHead>Deposit count</TableHead>
                  <TableHead>Negative days</TableHead>
                  <TableHead>Confirmed positions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell>{formatMetric(aggregate.monthlyRevenue)}</TableCell>
                  <TableCell>{formatMetric(aggregate.averageDailyBalance)}</TableCell>
                  <TableCell>{formatMetric(aggregate.nsfCount)}</TableCell>
                  <TableCell>{formatMetric(aggregate.worstMonthNsf)}</TableCell>
                  <TableCell>{formatMetric(aggregate.depositCount)}</TableCell>
                  <TableCell>{formatMetric(aggregate.negativeDays)}</TableCell>
                  <TableCell>{aggregate.positionCount}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
            <p className="text-xs text-muted-foreground">{aggregate.nsfCount.text ?? aggregate.monthlyRevenue.text}</p>
            {aggregate.warnings.length > 0 && (
              <div className="space-y-1">
                <h4 className="text-sm font-medium">Deposit warnings</h4>
                <ul className="list-disc space-y-1 pl-5 text-sm text-amber-900">
                  {aggregate.warnings.map((warning) => (
                    <li key={warning}>{warningLabel(warning)}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        {months.length > 0 && (
          <div className="space-y-2">
            <h3 className="font-medium">Statement months</h3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Period</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Deposits</TableHead>
                  <TableHead>Deposit count</TableHead>
                  <TableHead>ADB</TableHead>
                  <TableHead>NSF</TableHead>
                  <TableHead>Negative days</TableHead>
                  <TableHead>Ending balance</TableHead>
                  <TableHead>Flags</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {months.map((month) => (
                  <TableRow key={month.id}>
                    <TableCell>{month.period}</TableCell>
                    <TableCell>{month.accountSuffix ? `••••${month.accountSuffix}` : "Unknown"}</TableCell>
                    <TableCell>{kindLabel(month.accountKind)}</TableCell>
                    <TableCell>{formatMetric(month.deposits)}</TableCell>
                    <TableCell>{formatMetric(month.depositCount)}</TableCell>
                    <TableCell>{formatMetric(month.averageDailyBalance)}</TableCell>
                    <TableCell>{formatMetric(month.nsfCount)}</TableCell>
                    <TableCell>{formatMetric(month.negativeDays)}</TableCell>
                    <TableCell>{formatMetric(month.endingBalance)}</TableCell>
                    <TableCell className="space-x-1">
                      {month.accountKind === "unsupported" && <Badge variant="secondary">Unsupported</Badge>}
                      {month.accountKind !== "checking" && month.accountKind !== "unsupported" && (
                        <Badge variant="outline">Excluded from checking aggregates</Badge>
                      )}
                      {month.duplicateOfId && <Badge variant="outline">Duplicate</Badge>}
                      {month.deposits.unknown && <Badge variant="outline">Unknown deposits</Badge>}
                      {month.warnings.map((warning) => (
                        <Badge key={`${month.id}:${warning}`} variant="outline">{warningLabel(warning)}</Badge>
                      ))}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {positions.length > 0 && (
          <div className="space-y-2">
            <h3 className="font-medium">Existing position candidates</h3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Label</TableHead>
                  <TableHead>Estimated payment</TableHead>
                  <TableHead>Evidence</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {positions.map((position) => (
                  <TableRow key={position.id}>
                    <TableCell>{position.label}</TableCell>
                    <TableCell>{position.estimatedPayment == null ? "Unknown" : formatMetric({ value: position.estimatedPayment, unknown: false, confidence: 1 })}</TableCell>
                    <TableCell className="max-w-xs truncate text-muted-foreground">{position.evidence}</TableCell>
                    <TableCell><Badge variant="outline">{position.status}</Badge></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

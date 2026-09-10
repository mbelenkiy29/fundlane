"use client"

import * as React from "react"
import { AlertCircle, Loader2, RefreshCw } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatCents } from "@/components/mca/accounting/format"
import { RequestError, requestJson } from "@/lib/mca/client"

const DRILLDOWN_KINDS = ["submissions", "approvals", "advances", "payments"] as const
type DrilldownKind = (typeof DRILLDOWN_KINDS)[number]

interface CountMetric {
  count: number
  knownAmountCents: number
  unknownAmountCount: number
  complete: boolean
  restricted: boolean
}

interface RateMetric {
  from: string
  to: string
  numerator: number
  denominator: number
  rate: number | null
}

interface CommissionMetric {
  visible: boolean
  expectedCents?: number
  collectedCents?: number
  outstandingCents?: number
  count?: number
  reason?: string
}

interface ChannelSplit {
  api: number
  email: number
  other: number
}

interface FunderRow {
  funderId: string | null
  name: string
  channels: ChannelSplit
  submissions: CountMetric
  uniqueMerchants: CountMetric
  approvals: CountMetric
  fundings: CountMetric
  commissions: CommissionMetric
  conversions: RateMetric[]
}

interface SubmissionRow {
  id: string
  funderId: string | null
  dealId: string
  displayId: string
  legalName: string
  channel: string
  sourceKind: string
  sourceId: string
  occurredOn: string | null
  status: string
}

interface ApprovalRow {
  id: string
  funderId: string | null
  dealId: string
  displayId: string
  legalName: string
  offerId: string | null
  revisionCount: number
  occurredOn: string | null
  amountCents: number | null
  source: string
}

interface AdvanceRow {
  id: string
  funderId: string | null
  dealId: string
  displayId: string
  legalName: string
  fundingEventId: string
  source: string
  fundedOn: string | null
  amountCents: number | null
}

interface PaymentRow {
  id: string
  funderId: string | null
  dealId: string
  displayId: string
  legalName: string
  advanceId: string
  type: "commission" | "fee"
  origin: string
  status: string
  receivedOn: string | null
  expectedCents: number
  collectedCents: number
}

interface FunderAnalyticsReport {
  filters: { basis: "event" | "cohort"; from?: string; to?: string; funderIds?: string[] }
  period: { complete: boolean; lifetime: boolean; label: string; timezone: string }
  permission: { allowed: boolean; paymentsVisible: boolean; companyTotalsVisible: boolean; reason?: string }
  totals: FunderRow
  funders: FunderRow[]
  unattributed: FunderRow | null
  drilldown: {
    submissions: SubmissionRow[]
    approvals: ApprovalRow[]
    advances: AdvanceRow[]
    payments: PaymentRow[]
  }
}

export type FunderAnalyticsViewStatus = "loading" | "empty" | "validation" | "error" | "success"

export const FUNDER_ANALYTICS_COPY = {
  loading: "Loading funder analytics…",
  empty: "No funder activity matches these filters.",
  paymentsRestricted: "Collected commissions are restricted. Missing payment permission is not shown as $0.",
  companyTotalsRestricted: "Company-wide earned totals are restricted for this workspace.",
  missingTerms: "Missing term data is labeled unknown, not $0.",
  retry: "Retry",
} as const

function todayIsoDate(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
}

function shiftIsoDate(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map(Number)
  const date = new Date(Date.UTC(year, month - 1, day + days))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`
}

export function validateFunderAnalyticsForm(input: { from: string; to: string; basis: string; lifetime: boolean }): string | null {
  if (input.basis !== "event" && input.basis !== "cohort") return "Choose an event or cohort basis."
  if (input.lifetime) return null
  if (input.from && !/^\d{4}-\d{2}-\d{2}$/.test(input.from)) return "From date must use YYYY-MM-DD."
  if (input.to && !/^\d{4}-\d{2}-\d{2}$/.test(input.to)) return "To date must use YYYY-MM-DD."
  if (input.from && input.to && input.from > input.to) return "From date must be on or before the to date."
  return null
}

export function formatFunderRate(rate: number | null): string {
  if (rate == null) return "N/A"
  const percent = rate * 100
  return Number.isInteger(percent) ? `${percent}%` : `${percent.toFixed(1)}%`
}

export function formatFunderAmount(metric: CountMetric): string {
  if (metric.restricted) return "Restricted"
  if (metric.count === 0) return "—"
  if (metric.unknownAmountCount > 0 && metric.knownAmountCents === 0) return `${metric.unknownAmountCount} unknown`
  if (metric.unknownAmountCount > 0) return `${formatCents(metric.knownAmountCents)} · ${metric.unknownAmountCount} unknown`
  if (metric.knownAmountCents === 0 && metric.complete) return "—"
  return formatCents(metric.knownAmountCents)
}

function formatCommissions(metric: CommissionMetric): string {
  if (!metric.visible) return "Restricted"
  const collected = metric.collectedCents ?? 0
  const expected = metric.expectedCents ?? 0
  if (collected === 0 && expected === 0) return "—"
  return `${formatCents(collected)} collected · ${formatCents(expected)} expected`
}

function errorText(error: unknown): string {
  if (error instanceof RequestError) {
    const fields = Object.values(error.fieldErrors ?? {}).flat().filter(Boolean)
    return fields.length ? fields.join(" ") : error.message
  }
  return error instanceof Error ? error.message : "The report could not be loaded."
}

function channelLabel(channel: string): string {
  if (channel === "api") return "API"
  if (channel === "email") return "Email"
  return channel
}

export function FunderAnalyticsView(props: {
  status: FunderAnalyticsViewStatus
  message?: string
  report?: FunderAnalyticsReport
  drilldownKind: DrilldownKind
  selectedFunderId: string | "all"
  onDrilldown: (kind: DrilldownKind) => void
  onSelectFunder: (id: string | "all") => void
}) {
  const { status, message, report, drilldownKind, selectedFunderId, onDrilldown, onSelectFunder } = props
  const rows = report ? [...report.funders, ...(report.unattributed ? [report.unattributed] : [])] : []
  const matchesFunder = (funderId: string | null) => selectedFunderId === "all" || funderId === selectedFunderId
  const submissions = (report?.drilldown.submissions ?? []).filter((row) => matchesFunder(row.funderId))
  const approvals = (report?.drilldown.approvals ?? []).filter((row) => matchesFunder(row.funderId))
  const advances = (report?.drilldown.advances ?? []).filter((row) => matchesFunder(row.funderId))
  const payments = (report?.drilldown.payments ?? []).filter((row) => matchesFunder(row.funderId))

  return (
    <div className="space-y-4">
      {status === "loading" && (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />{FUNDER_ANALYTICS_COPY.loading}
        </p>
      )}
      {status === "validation" && message && (
        <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
          <AlertCircle className="size-4" />{message}
        </p>
      )}
      {status === "error" && message && (
        <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
          <AlertCircle className="size-4" />{message}
        </p>
      )}
      {status === "empty" && (
        <p className="text-sm text-muted-foreground">{FUNDER_ANALYTICS_COPY.empty}</p>
      )}
      {report && !report.permission.paymentsVisible && (
        <p role="status" className="rounded-md border border-dashed p-3 text-sm">
          {FUNDER_ANALYTICS_COPY.paymentsRestricted}
        </p>
      )}
      {report && !report.permission.companyTotalsVisible && (
        <p role="status" className="rounded-md border border-dashed p-3 text-sm">
          {FUNDER_ANALYTICS_COPY.companyTotalsRestricted}
        </p>
      )}
      {report && !report.period.complete && (
        <p className="text-sm text-muted-foreground">{report.period.label}</p>
      )}
      {report && (status === "success" || status === "empty") && (
        <>
          <p className="text-xs text-muted-foreground">{FUNDER_ANALYTICS_COPY.missingTerms}</p>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Funder</TableHead>
                  <TableHead>Submissions</TableHead>
                  <TableHead>Unique merchants</TableHead>
                  <TableHead>
                    <button type="button" className="underline-offset-2 hover:underline" onClick={() => onDrilldown("approvals")}>Approvals</button>
                  </TableHead>
                  <TableHead>
                    <button type="button" className="underline-offset-2 hover:underline" onClick={() => onDrilldown("advances")}>Fundings</button>
                  </TableHead>
                  <TableHead>Channels</TableHead>
                  <TableHead>Conversions</TableHead>
                  <TableHead>Collected commissions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.permission.companyTotalsVisible && (
                  <TableRow>
                    <TableCell className="font-medium">
                      <button type="button" className="underline-offset-2 hover:underline" onClick={() => onSelectFunder("all")}>{report.totals.name}</button>
                    </TableCell>
                    <TableCell>
                      <button type="button" onClick={() => { onSelectFunder("all"); onDrilldown("submissions") }}>{report.totals.submissions.count}</button>
                    </TableCell>
                    <TableCell>{report.totals.uniqueMerchants.count}</TableCell>
                    <TableCell>
                      <div>{report.totals.approvals.count}</div>
                      <div className="text-xs text-muted-foreground">{formatFunderAmount(report.totals.approvals)}</div>
                    </TableCell>
                    <TableCell>
                      <div>{report.totals.fundings.count}</div>
                      <div className="text-xs text-muted-foreground">{formatFunderAmount(report.totals.fundings)}</div>
                    </TableCell>
                    <TableCell className="text-xs">API {report.totals.channels.api} · Email {report.totals.channels.email}</TableCell>
                    <TableCell className="text-xs">
                      {report.totals.conversions.map((item) => (
                        <div key={`${item.from}-${item.to}`}>{item.from}→{item.to} {formatFunderRate(item.rate)}</div>
                      ))}
                    </TableCell>
                    <TableCell>{formatCommissions(report.totals.commissions)}</TableCell>
                  </TableRow>
                )}
                {rows.map((row) => (
                  <TableRow key={row.funderId ?? "unattributed"}>
                    <TableCell>
                      <button type="button" className="underline-offset-2 hover:underline" onClick={() => onSelectFunder(row.funderId ?? "all")}>
                        {row.name}
                      </button>
                    </TableCell>
                    <TableCell>
                      <button type="button" onClick={() => { onSelectFunder(row.funderId ?? "all"); onDrilldown("submissions") }}>{row.submissions.count}</button>
                    </TableCell>
                    <TableCell>{row.uniqueMerchants.count}</TableCell>
                    <TableCell>
                      <div>{row.approvals.count}</div>
                      <div className="text-xs text-muted-foreground">{formatFunderAmount(row.approvals)}</div>
                    </TableCell>
                    <TableCell>
                      <div>{row.fundings.count}</div>
                      <div className="text-xs text-muted-foreground">{formatFunderAmount(row.fundings)}</div>
                    </TableCell>
                    <TableCell className="text-xs">API {row.channels.api} · Email {row.channels.email}</TableCell>
                    <TableCell className="text-xs">
                      {row.conversions.map((item) => (
                        <div key={`${item.from}-${item.to}`}>{item.from}→{item.to} {formatFunderRate(item.rate)}</div>
                      ))}
                    </TableCell>
                    <TableCell>{formatCommissions(row.commissions)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="flex flex-wrap gap-2">
            {DRILLDOWN_KINDS.map((kind) => (
              <Button key={kind} type="button" size="sm" variant={drilldownKind === kind ? "default" : "outline"} onClick={() => onDrilldown(kind)}>
                {kind}
              </Button>
            ))}
          </div>
          <div>
            <h3 className="mb-2 text-sm font-medium capitalize">
              {drilldownKind} drilldown{selectedFunderId !== "all" ? " (selected funder)" : ""}
            </h3>
            {drilldownKind === "submissions" && (
              submissions.length === 0 ? (
                <p className="text-sm text-muted-foreground">No submission sources for these filters.</p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Deal</TableHead>
                        <TableHead>Date</TableHead>
                        <TableHead>Channel</TableHead>
                        <TableHead>Source</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {submissions.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell>
                            <a className="underline" href={`/deals?deal=${row.dealId}`}>{row.displayId}</a>
                            <div className="text-xs text-muted-foreground">{row.legalName}</div>
                          </TableCell>
                          <TableCell>{row.occurredOn ?? "Unknown"}</TableCell>
                          <TableCell><Badge variant="outline">{channelLabel(row.channel)}</Badge></TableCell>
                          <TableCell className="text-xs">{row.sourceKind} · {row.sourceId}</TableCell>
                          <TableCell>{row.status}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Drilldown {submissions.length} submissions equals the selected submission count. API and email stay distinct.
                  </p>
                </div>
              )
            )}
            {drilldownKind === "approvals" && (
              approvals.length === 0 ? (
                <p className="text-sm text-muted-foreground">No approvals for these filters.</p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Deal</TableHead>
                        <TableHead>Date</TableHead>
                        <TableHead>Amount</TableHead>
                        <TableHead>Revisions</TableHead>
                        <TableHead>Source</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {approvals.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell>
                            <a className="underline" href={`/deals?deal=${row.dealId}`}>{row.displayId}</a>
                            <div className="text-xs text-muted-foreground">{row.legalName}</div>
                          </TableCell>
                          <TableCell>{row.occurredOn ?? "Unknown"}</TableCell>
                          <TableCell>{row.amountCents == null ? "Unknown" : formatCents(row.amountCents)}</TableCell>
                          <TableCell>{row.revisionCount}</TableCell>
                          <TableCell className="text-xs">{row.source}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Revised offers do not create multiple approval counts for one submission.
                  </p>
                </div>
              )
            )}
            {drilldownKind === "advances" && (
              advances.length === 0 ? (
                <p className="text-sm text-muted-foreground">No advance sources for these filters.</p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Deal</TableHead>
                        <TableHead>Funded</TableHead>
                        <TableHead>Amount</TableHead>
                        <TableHead>Advance</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {advances.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell>
                            <a className="underline" href={`/deals?deal=${row.dealId}`}>{row.displayId}</a>
                            <div className="text-xs text-muted-foreground">{row.legalName}</div>
                          </TableCell>
                          <TableCell>{row.fundedOn ?? "Unknown"}</TableCell>
                          <TableCell>{row.amountCents == null ? "Unknown" : formatCents(row.amountCents)}</TableCell>
                          <TableCell className="text-xs">{row.id} · {row.source}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )
            )}
            {drilldownKind === "payments" && (
              !report.permission.paymentsVisible ? (
                <p className="text-sm text-muted-foreground">{FUNDER_ANALYTICS_COPY.paymentsRestricted}</p>
              ) : payments.length === 0 ? (
                <p className="text-sm text-muted-foreground">No payment ledger rows for these filters.</p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Deal</TableHead>
                        <TableHead>Received</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Collected</TableHead>
                        <TableHead>Expected</TableHead>
                        <TableHead>Advance</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {payments.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell>
                            <a className="underline" href={`/deals?deal=${row.dealId}`}>{row.displayId}</a>
                            <div className="text-xs text-muted-foreground">{row.legalName}</div>
                          </TableCell>
                          <TableCell>{row.receivedOn ?? "Unknown"}</TableCell>
                          <TableCell>{row.type}</TableCell>
                          <TableCell>{formatCents(row.collectedCents)}</TableCell>
                          <TableCell>{formatCents(row.expectedCents)}</TableCell>
                          <TableCell className="text-xs">{row.advanceId} · {row.origin} · {row.status}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Funder earned commission totals reconcile to the payment ledger. Fees stay in the drilldown and do not inflate earned commissions.
                  </p>
                </div>
              )
            )}
          </div>
        </>
      )}
    </div>
  )
}

export function FunderAnalytics() {
  const [lifetime, setLifetime] = React.useState(false)
  const [from, setFrom] = React.useState(() => shiftIsoDate(todayIsoDate(), -29))
  const [to, setTo] = React.useState(() => todayIsoDate())
  const [basis, setBasis] = React.useState<"event" | "cohort">("event")
  const [selectedFunders, setSelectedFunders] = React.useState<string[]>([])
  const [listedFunders, setListedFunders] = React.useState<Array<{ id: string; legalName: string }>>([])
  const [report, setReport] = React.useState<FunderAnalyticsReport>()
  const [status, setStatus] = React.useState<FunderAnalyticsViewStatus>("loading")
  const [message, setMessage] = React.useState("")
  const [drilldownKind, setDrilldownKind] = React.useState<DrilldownKind>("submissions")
  const [selectedFunderId, setSelectedFunderId] = React.useState<string | "all">("all")
  const [requestKey, setRequestKey] = React.useState("funder-analytics-load")

  const load = React.useCallback(async () => {
    const validation = validateFunderAnalyticsForm({ from, to, basis, lifetime })
    if (validation) {
      setStatus("validation")
      setMessage(validation)
      return
    }
    setStatus("loading")
    setMessage("")
    try {
      const query = new URLSearchParams({ basis })
      if (!lifetime) {
        if (from) query.set("from", from)
        if (to) query.set("to", to)
      }
      for (const id of selectedFunders) query.append("funderIds", id)
      const [next, listed] = await Promise.all([
        requestJson<FunderAnalyticsReport>(`/api/mca/reports/funders?${query}`),
        requestJson<{ funders: Array<{ id: string; legalName: string }> }>("/api/mca/funders?includeInactive=true").catch(() => ({ funders: [] as Array<{ id: string; legalName: string }> })),
      ])
      setListedFunders(listed.funders)
      setReport(next)
      const empty = next.totals.submissions.count === 0 && next.totals.approvals.count === 0 && next.totals.fundings.count === 0
      setStatus(empty ? "empty" : "success")
    } catch (caught) {
      setStatus("error")
      setMessage(errorText(caught))
    }
  }, [basis, from, lifetime, selectedFunders, to])

  React.useEffect(() => {
    void requestKey
    void load()
  }, [load, requestKey])

  function toggleFunder(id: string, checked: boolean) {
    setSelectedFunders((current) => checked ? [...current, id] : current.filter((item) => item !== id))
  }

  return (
    <Card id="mca-reports-funders">
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>Funder analytics</CardTitle>
          <CardDescription>
            Submissions, unique merchants, approvals, fundings and collected commissions by funder. Revised offers count once. Earned totals follow the payment ledger.
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => setRequestKey((key) => `${key}-retry`)}>
          <RefreshCw className="size-4" />{FUNDER_ANALYTICS_COPY.retry}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
          onSubmit={(event) => { event.preventDefault(); setRequestKey((key) => `${key}-apply`); void load() }}
        >
          <div className="space-y-1">
            <Label htmlFor="funder-analytics-from">From</Label>
            <Input id="funder-analytics-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} disabled={lifetime} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="funder-analytics-to">To</Label>
            <Input id="funder-analytics-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} disabled={lifetime} />
          </div>
          <div className="space-y-1">
            <Label>Date basis</Label>
            <RadioGroup value={basis} onValueChange={(value) => setBasis(value as "event" | "cohort")} className="flex gap-4 pt-2">
              <div className="flex items-center gap-2">
                <RadioGroupItem id="funder-basis-event" value="event" />
                <Label htmlFor="funder-basis-event">Event</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem id="funder-basis-cohort" value="cohort" />
                <Label htmlFor="funder-basis-cohort">Cohort</Label>
              </div>
            </RadioGroup>
          </div>
          <label className="flex items-center gap-2 pt-6 text-sm">
            <Checkbox checked={lifetime} onCheckedChange={(checked) => setLifetime(checked === true)} />
            Lifetime
          </label>
          <div className="pt-6">
            <Button type="submit">Apply filters</Button>
          </div>
        </form>
        {listedFunders.length > 0 && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Funders</legend>
            <div className="flex flex-wrap gap-3">
              {listedFunders.map((funder) => (
                <label key={funder.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={selectedFunders.includes(funder.id)}
                    onCheckedChange={(checked) => toggleFunder(funder.id, checked === true)}
                  />
                  {funder.legalName}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <FunderAnalyticsView
          status={status}
          message={message}
          report={report}
          drilldownKind={drilldownKind}
          selectedFunderId={selectedFunderId}
          onDrilldown={setDrilldownKind}
          onSelectFunder={setSelectedFunderId}
        />
      </CardContent>
    </Card>
  )
}

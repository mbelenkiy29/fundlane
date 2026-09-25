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
import { Table, TableFooter, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatCents } from "@/components/mca/accounting/format"
import { RequestError, requestJson } from "@/lib/mca/client"
import { explainedReportValue, ReportEmptyState } from "@/components/mca/reports/report-ui"
import { isTeamProfitReportEmpty } from "@/lib/mca/reports/team-profit-empty"
import type { MembershipSummary } from "@/lib/mca/types"

const STAGES = ["created", "submitted", "approved", "funded"] as const
type FunnelStage = (typeof STAGES)[number]
type RevenueRecognition = "collected" | "expected"
type GroupBy = "users" | "managers"

interface StageMetric {
  dealCount: number
  knownAmountCents: number
  unknownAmountCount: number
  complete: boolean
  restricted: boolean
}

interface DistributionMetric {
  visible: boolean
  expectedCents?: number
  paidCents?: number
  count?: number
  reason?: string
}

interface MoneyMetric {
  visible: boolean
  collectedCents?: number
  expectedCents?: number
  reason?: string
}

interface GrossContributionMetric {
  visible: boolean
  collectedCents?: number
  expectedCents?: number
  formula: string
  excludesOperatingCosts: true
  reason?: string
}

interface OperatingCostMetric {
  visible: boolean
  knownCents?: number
  unknownCount?: number
  complete?: boolean
  excludedFromGrossContribution: true
  reason?: string
}

interface TeamProfitRow {
  membershipId: string | null
  name: string
  kind: "company" | "user" | "manager" | "unassigned"
  memberIds: string[]
  stages: Record<FunnelStage, StageMetric>
  revenue: MoneyMetric
  distributions: DistributionMetric
  grossContribution: GrossContributionMetric
}

interface LedgerEvidenceRow {
  kind: "payment_void" | "funding_reversal" | "adjustment"
  recordId: string
  paymentId?: string
  fundingEventId?: string
  dealId?: string | null
  amountCents: number
  occurredAt: string
  occurredOn: string | null
  reason?: string
  correlationId?: string
  status: string
}

interface TeamProfitReport {
  filters: { basis: "event" | "cohort"; from?: string; to?: string; membershipIds?: string[] }
  recognition: RevenueRecognition
  period: { complete: boolean; label: string; timezone: string }
  permission: { allowed: boolean; paymentsVisible: boolean; companyTotalsVisible: boolean; reason?: string }
  attribution: { dealCredit: string; companyTotals: string; distributions: string }
  definitions: Record<string, string>
  company: TeamProfitRow
  users: TeamProfitRow[]
  managers: TeamProfitRow[]
  unassigned: TeamProfitRow | null
  evidence: LedgerEvidenceRow[]
  otherOperatingCosts: OperatingCostMetric
}

export type TeamProfitViewStatus = "loading" | "empty" | "validation" | "error" | "success"

export const TEAM_PROFIT_COPY = {
  loading: "Loading team profit…",
  empty: "No deals or ledger activity match these filters.",
  paymentsRestricted: "Payment ledger data is restricted. Missing payment permission is not shown as $0.",
  companyTotalsRestricted: "Unique company profit totals are restricted for this workspace.",
  retry: "Retry",
  collected: "Collected commission and fees minus paid distributions. Other operating costs are shown separately and are not subtracted.",
  expected: "Expected commission and fees minus expected and paid distributions. Other operating costs are shown separately and are not subtracted.",
} as const

export const TEAM_PROFIT_DEFINITIONS = {
  uniqueDeals: "Company and manager totals count each deal once. Shared originator/closer assignments still give each user full row credit.",
  grossContribution: "Collected commission and fees minus paid distributions. Other operating costs are not subtracted.",
  reversalEvidence: "Voided payments, reversed funding events, and accounting adjustments stay listed with record ids, timestamps, amounts, and correlation ids.",
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

export function validateTeamProfitForm(input: { from: string; to: string; basis: string; recognition: string }): string | null {
  if (input.basis !== "event" && input.basis !== "cohort") return "Choose an event or cohort basis."
  if (input.recognition !== "collected" && input.recognition !== "expected") return "Choose collected or expected recognition."
  if (input.from && !/^\d{4}-\d{2}-\d{2}$/.test(input.from)) return "From date must use YYYY-MM-DD."
  if (input.to && !/^\d{4}-\d{2}-\d{2}$/.test(input.to)) return "To date must use YYYY-MM-DD."
  if (input.from && input.to && input.from > input.to) return "From date must be on or before the to date."
  return null
}

export function pickRecognizedCents(metric: MoneyMetric | GrossContributionMetric, recognition: RevenueRecognition): number | null {
  if (!metric.visible) return null
  return recognition === "expected" ? (metric.expectedCents ?? 0) : (metric.collectedCents ?? 0)
}

function formatMoney(metric: MoneyMetric | GrossContributionMetric, recognition: RevenueRecognition): string {
  if (!metric.visible) return "Restricted"
  return formatCents(pickRecognizedCents(metric, recognition) ?? 0)
}

function formatDistributions(metric: DistributionMetric, recognition: RevenueRecognition): string {
  if (!metric.visible) return "Restricted"
  const paid = metric.paidCents ?? 0
  const expected = metric.expectedCents ?? 0
  if (paid === 0 && expected === 0) return "—"
  return recognition === "expected"
    ? `${formatCents(expected)} expected · ${formatCents(paid)} paid`
    : formatCents(paid)
}

function formatOperatingCosts(metric: OperatingCostMetric): string {
  if (!metric.visible) return "Restricted"
  if ((metric.unknownCount ?? 0) > 0 && (metric.knownCents ?? 0) === 0) return `${metric.unknownCount} unknown`
  if ((metric.unknownCount ?? 0) > 0) return `${formatCents(metric.knownCents ?? 0)} · ${metric.unknownCount} unknown`
  return formatCents(metric.knownCents ?? 0)
}

function errorText(error: unknown): string {
  if (error instanceof RequestError) {
    const fields = Object.values(error.fieldErrors ?? {}).flat().filter(Boolean)
    return fields.length ? fields.join(" ") : error.message
  }
  return error instanceof Error ? error.message : "The report could not be loaded."
}

function evidenceLabel(kind: LedgerEvidenceRow["kind"]): string {
  if (kind === "payment_void") return "Payment voided"
  if (kind === "funding_reversal") return "Funding reversed"
  return "Adjustment"
}

export function TeamProfitView(props: {
  status: TeamProfitViewStatus
  message?: string
  report?: TeamProfitReport
  recognition: RevenueRecognition
  groupBy: GroupBy
}) {
  const { status, message, report, recognition, groupBy } = props
  const rows = report
    ? groupBy === "managers"
      ? report.managers
      : [...report.users, ...(report.unassigned ? [report.unassigned] : [])]
    : []

  return (
    <div className="space-y-4">
      {status === "loading" && (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />{TEAM_PROFIT_COPY.loading}
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
        <ReportEmptyState title={TEAM_PROFIT_COPY.empty} detail="Try another date range, recognition mode, or rep filter." />
      )}
      {report && !report.permission.paymentsVisible && (
        <p role="status" className="rounded-md border border-dashed p-3 text-sm">
          {TEAM_PROFIT_COPY.paymentsRestricted}
        </p>
      )}
      {report && !report.permission.companyTotalsVisible && (
        <p role="status" className="rounded-md border border-dashed p-3 text-sm">
          {TEAM_PROFIT_COPY.companyTotalsRestricted}
        </p>
      )}
      {report && !report.period.complete && (
        <p className="text-sm text-muted-foreground">{report.period.label}</p>
      )}
      {report && status === "success" && (
        <>
          <dl className="grid gap-3 rounded-md border p-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="font-medium">Gross contribution</dt>
              <dd>{recognition === "expected" ? TEAM_PROFIT_COPY.expected : TEAM_PROFIT_COPY.collected}</dd>
            </div>
            <div>
              <dt className="font-medium">Unique deals</dt>
              <dd>{TEAM_PROFIT_DEFINITIONS.uniqueDeals}</dd>
            </div>
            <div>
              <dt className="font-medium">Reversal evidence</dt>
              <dd>{TEAM_PROFIT_DEFINITIONS.reversalEvidence}</dd>
            </div>
            <div>
              <dt className="font-medium">Attribution</dt>
              <dd>Company totals are unique deals, never the sum of user rows. Shared deals credit each assigned rep in full.</dd>
            </div>
          </dl>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-md border p-3">
              <p className="text-xs text-muted-foreground">Commission and fees</p>
              <p className="text-lg font-medium">{explainedReportValue(formatMoney(report.company.revenue, recognition))}</p>
            </div>
            <div className="rounded-md border p-3">
              <p className="text-xs text-muted-foreground">Distributions</p>
              <p className="text-lg font-medium">{explainedReportValue(formatDistributions(report.company.distributions, recognition))}</p>
            </div>
            <div className="rounded-md border p-3">
              <p className="text-xs text-muted-foreground">Gross contribution</p>
              <p className="text-lg font-medium">{explainedReportValue(formatMoney(report.company.grossContribution, recognition))}</p>
            </div>
            <div className="rounded-md border p-3">
              <p className="text-xs text-muted-foreground">Other operating costs</p>
              <p className="text-lg font-medium">{explainedReportValue(formatOperatingCosts(report.otherOperatingCosts))}</p>
              <p className="text-xs text-muted-foreground">Excluded from gross contribution</p>
            </div>
          </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{groupBy === "managers" ? "Manager team" : "User"}</TableHead>
                  {STAGES.map((stage) => (
                    <TableHead key={stage} className="capitalize">{stage}</TableHead>
                  ))}
                  <TableHead>Revenue</TableHead>
                  <TableHead>Distributions</TableHead>
                  <TableHead>Gross contribution</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={`${row.kind}-${row.membershipId ?? "unassigned"}`}>
                    <TableCell>
                      {row.name}
                      {row.kind === "manager" && <Badge variant="outline" className="ml-2">Team unique</Badge>}
                    </TableCell>
                    {STAGES.map((stage) => (
                      <TableCell key={stage}>{row.stages[stage].dealCount}</TableCell>
                    ))}
                    <TableCell>{explainedReportValue(formatMoney(row.revenue, recognition))}</TableCell>
                    <TableCell>{explainedReportValue(formatDistributions(row.distributions, recognition))}</TableCell>
                    <TableCell>{explainedReportValue(formatMoney(row.grossContribution, recognition))}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
              {report.permission.companyTotalsVisible && (<TableFooter>
                  <TableRow>
                    <TableCell className="font-medium">
                      {report.company.name}
                      <Badge variant="outline" className="ml-2">Unique</Badge>
                    </TableCell>
                    {STAGES.map((stage) => (
                      <TableCell key={stage}>{report.company.stages[stage].dealCount}</TableCell>
                    ))}
                    <TableCell>{explainedReportValue(formatMoney(report.company.revenue, recognition))}</TableCell>
                    <TableCell>{explainedReportValue(formatDistributions(report.company.distributions, recognition))}</TableCell>
                    <TableCell>{explainedReportValue(formatMoney(report.company.grossContribution, recognition))}</TableCell>
                  </TableRow>
                </TableFooter>)}
            </Table>
          <div>
            <h3 className="mb-2 text-sm font-medium">Ledger evidence</h3>
            {report.evidence.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {report.permission.paymentsVisible ? "No voided payments, reversals, or adjustments in this period." : explainedReportValue("Restricted")}
              </p>
            ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Event</TableHead>
                      <TableHead>Record</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Correlation</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.evidence.map((item) => (
                      <TableRow key={`${item.kind}-${item.recordId}`}>
                        <TableCell>{evidenceLabel(item.kind)}</TableCell>
                        <TableCell className="font-mono text-xs">{item.recordId}</TableCell>
                        <TableCell>{item.occurredOn ?? "Unknown"}</TableCell>
                        <TableCell>{formatCents(item.amountCents)}</TableCell>
                        <TableCell className="font-mono text-xs">{item.correlationId ?? "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
            )}
          </div>
        </>
      )}
    </div>
  )
}

export function TeamProfit() {
  const [from, setFrom] = React.useState(() => shiftIsoDate(todayIsoDate(), -29))
  const [to, setTo] = React.useState(() => todayIsoDate())
  const [basis, setBasis] = React.useState<"event" | "cohort">("event")
  const [recognition, setRecognition] = React.useState<RevenueRecognition>("collected")
  const [groupBy, setGroupBy] = React.useState<GroupBy>("users")
  const [selectedReps, setSelectedReps] = React.useState<string[]>([])
  const [members, setMembers] = React.useState<MembershipSummary[]>([])
  const [report, setReport] = React.useState<TeamProfitReport>()
  const [status, setStatus] = React.useState<TeamProfitViewStatus>("loading")
  const [message, setMessage] = React.useState("")
  const [requestKey, setRequestKey] = React.useState("team-profit-load")

  const load = React.useCallback(async () => {
    const validation = validateTeamProfitForm({ from, to, basis, recognition })
    if (validation) {
      setStatus("validation")
      setMessage(validation)
      return
    }
    setStatus("loading")
    setMessage("")
    try {
      const query = new URLSearchParams({ basis, recognition })
      if (from) query.set("from", from)
      if (to) query.set("to", to)
      for (const id of selectedReps) query.append("membershipIds", id)
      const [next, listed] = await Promise.all([
        requestJson<TeamProfitReport>(`/api/mca/reports/team-profit?${query}`),
        requestJson<{ memberships: MembershipSummary[] }>("/api/memberships").catch(() => ({ memberships: [] as MembershipSummary[] })),
      ])
      setMembers(listed.memberships.filter((item) => item.status === "active"))
      setReport(next)
      setStatus(isTeamProfitReportEmpty(next) ? "empty" : "success")
    } catch (caught) {
      setStatus("error")
      setMessage(errorText(caught))
    }
  }, [basis, from, recognition, selectedReps, to])

  React.useEffect(() => {
    void requestKey
    void load()
  }, [load, requestKey])

  function toggleRep(id: string, checked: boolean) {
    setSelectedReps((current) => checked ? [...current, id] : current.filter((item) => item !== id))
  }

  return (
    <Card id="mca-reports-team-profit" className="min-w-0 overflow-hidden">
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>Team performance and company profit</CardTitle>
          <CardDescription>
            Gross contribution is collected commission and fees minus paid distributions. Shared deals do not inflate unique company totals.
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => setRequestKey((key) => `${key}-retry`)}>
          <RefreshCw className="size-4" />{TEAM_PROFIT_COPY.retry}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
          onSubmit={(event) => { event.preventDefault(); setRequestKey((key) => `${key}-apply`); void load() }}
        >
          <div className="space-y-1">
            <Label htmlFor="team-profit-from">From</Label>
            <Input id="team-profit-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="team-profit-to">To</Label>
            <Input id="team-profit-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Date basis</Label>
            <RadioGroup value={basis} onValueChange={(value) => setBasis(value as "event" | "cohort")} className="flex gap-4 pt-2">
              <div className="flex items-center gap-2">
                <RadioGroupItem id="team-profit-basis-event" value="event" />
                <Label htmlFor="team-profit-basis-event">Event</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem id="team-profit-basis-cohort" value="cohort" />
                <Label htmlFor="team-profit-basis-cohort">Cohort</Label>
              </div>
            </RadioGroup>
          </div>
          <div className="space-y-1">
            <Label>Recognition</Label>
            <RadioGroup value={recognition} onValueChange={(value) => setRecognition(value as RevenueRecognition)} className="flex gap-4 pt-2">
              <div className="flex items-center gap-2">
                <RadioGroupItem id="team-profit-collected" value="collected" />
                <Label htmlFor="team-profit-collected">Collected</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem id="team-profit-expected" value="expected" />
                <Label htmlFor="team-profit-expected">Expected</Label>
              </div>
            </RadioGroup>
          </div>
          <div className="space-y-1">
            <Label>Grouping</Label>
            <RadioGroup value={groupBy} onValueChange={(value) => setGroupBy(value as GroupBy)} className="flex gap-4 pt-2">
              <div className="flex items-center gap-2">
                <RadioGroupItem id="team-profit-group-users" value="users" />
                <Label htmlFor="team-profit-group-users">Users</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem id="team-profit-group-managers" value="managers" />
                <Label htmlFor="team-profit-group-managers">Managers</Label>
              </div>
            </RadioGroup>
          </div>
          <div className="flex items-end">
            <Button type="submit">Apply filters</Button>
          </div>
        </form>
        {members.length > 0 && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Reps</legend>
            <div className="flex flex-wrap gap-3">
              {members.map((member) => (
                <label key={member.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={selectedReps.includes(member.id)}
                    onCheckedChange={(checked) => toggleRep(member.id, checked === true)}
                  />
                  {member.name}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <TeamProfitView
          status={status}
          message={message}
          report={report}
          recognition={recognition}
          groupBy={groupBy}
        />
      </CardContent>
    </Card>
  )
}

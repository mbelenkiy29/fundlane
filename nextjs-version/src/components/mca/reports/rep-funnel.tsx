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
import type { MembershipSummary } from "@/lib/mca/types"

const STAGES = ["created", "submitted", "approved", "funded"] as const
type FunnelStage = (typeof STAGES)[number]

interface StageMetric {
  dealCount: number
  knownAmountCents: number
  unknownAmountCount: number
  complete: boolean
  restricted: boolean
}

interface ConversionMetric {
  from: FunnelStage
  to: FunnelStage
  numerator: number
  denominator: number
  rate: number | null
}

interface DistributionMetric {
  visible: boolean
  expectedCents?: number
  paidCents?: number
  count?: number
  reason?: string
}

interface RepFunnelRow {
  membershipId: string | null
  name: string
  stages: Record<FunnelStage, StageMetric>
  conversions: ConversionMetric[]
  distributions: DistributionMetric
}

interface FunnelDealRow {
  dealId: string
  displayId: string
  legalName: string
  stage: FunnelStage
  occurredOn: string | null
  amountCents: number | null
  attributedMembershipIds: string[]
  shared: boolean
}

interface RepFunnelReport {
  filters: { basis: "event" | "cohort"; from?: string; to?: string; membershipIds?: string[] }
  period: { complete: boolean; label: string; timezone: string }
  permission: { allowed: boolean; paymentsVisible: boolean; companyTotalsVisible: boolean; reason?: string }
  totals: RepFunnelRow
  reps: RepFunnelRow[]
  unassigned: RepFunnelRow | null
  drilldown: Record<FunnelStage, FunnelDealRow[]>
}

export type RepFunnelViewStatus = "loading" | "empty" | "validation" | "error" | "success"

export const REP_FUNNEL_COPY = {
  loading: "Loading rep funnel…",
  empty: "No deals match these filters.",
  paymentsRestricted: "Payment distributions are restricted. Missing payment permission is not shown as $0.",
  companyTotalsRestricted: "Unique company totals are restricted for this workspace.",
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

export function validateRepFunnelForm(input: { from: string; to: string; basis: string }): string | null {
  if (input.basis !== "event" && input.basis !== "cohort") return "Choose an event or cohort basis."
  if (input.from && !/^\d{4}-\d{2}-\d{2}$/.test(input.from)) return "From date must use YYYY-MM-DD."
  if (input.to && !/^\d{4}-\d{2}-\d{2}$/.test(input.to)) return "To date must use YYYY-MM-DD."
  if (input.from && input.to && input.from > input.to) return "From date must be on or before the to date."
  return null
}

export function formatConversionRate(rate: number | null): string {
  if (rate == null) return "N/A"
  const percent = rate * 100
  return Number.isInteger(percent) ? `${percent}%` : `${percent.toFixed(1)}%`
}

export function formatFunnelAmount(metric: StageMetric, dealCount = metric.dealCount): string {
  if (metric.restricted) return "Restricted"
  if (dealCount === 0) return "—"
  if (metric.unknownAmountCount > 0 && metric.knownAmountCents === 0) return `${metric.unknownAmountCount} unknown`
  if (metric.unknownAmountCount > 0) return `${formatCents(metric.knownAmountCents)} · ${metric.unknownAmountCount} unknown`
  return formatCents(metric.knownAmountCents)
}

function formatDistributions(metric: DistributionMetric): string {
  if (!metric.visible) return "Restricted"
  const paid = metric.paidCents ?? 0
  const expected = metric.expectedCents ?? 0
  if (paid === 0 && expected === 0) return "—"
  return `${formatCents(paid)} paid · ${formatCents(expected)} expected`
}

function errorText(error: unknown): string {
  if (error instanceof RequestError) {
    const fields = Object.values(error.fieldErrors ?? {}).flat().filter(Boolean)
    return fields.length ? fields.join(" ") : error.message
  }
  return error instanceof Error ? error.message : "The report could not be loaded."
}

export function RepFunnelView(props: {
  status: RepFunnelViewStatus
  message?: string
  report?: RepFunnelReport
  drilldownStage: FunnelStage
  onDrilldown: (stage: FunnelStage) => void
}) {
  const { status, message, report, drilldownStage, onDrilldown } = props
  const rows = report ? [...report.reps, ...(report.unassigned ? [report.unassigned] : [])] : []
  const drilldown = report?.drilldown[drilldownStage] ?? []
  const drillMetric = report?.totals.stages[drilldownStage]

  return (
    <div className="space-y-4">
      {status === "loading" && (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />{REP_FUNNEL_COPY.loading}
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
        <p className="text-sm text-muted-foreground">{REP_FUNNEL_COPY.empty}</p>
      )}
      {report && !report.permission.paymentsVisible && (
        <p role="status" className="rounded-md border border-dashed p-3 text-sm">
          {REP_FUNNEL_COPY.paymentsRestricted}
        </p>
      )}
      {report && !report.permission.companyTotalsVisible && (
        <p role="status" className="rounded-md border border-dashed p-3 text-sm">
          {REP_FUNNEL_COPY.companyTotalsRestricted}
        </p>
      )}
      {report && !report.period.complete && (
        <p className="text-sm text-muted-foreground">{report.period.label}</p>
      )}
      {report && (status === "success" || status === "empty") && (
        <>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Rep</TableHead>
                  {STAGES.map((stage) => (
                    <TableHead key={stage}>
                      <button type="button" className="capitalize underline-offset-2 hover:underline" onClick={() => onDrilldown(stage)}>
                        {stage}
                      </button>
                    </TableHead>
                  ))}
                  <TableHead>Conversions</TableHead>
                  <TableHead>Distributions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.permission.companyTotalsVisible && (
                  <TableRow>
                    <TableCell className="font-medium">{report.totals.name}</TableCell>
                    {STAGES.map((stage) => (
                      <TableCell key={stage}>
                        <div>{report.totals.stages[stage].dealCount}</div>
                        <div className="text-xs text-muted-foreground">{formatFunnelAmount(report.totals.stages[stage])}</div>
                      </TableCell>
                    ))}
                    <TableCell className="text-xs">
                      {report.totals.conversions.map((item) => (
                        <div key={`${item.from}-${item.to}`}>{item.from}→{item.to} {formatConversionRate(item.rate)}</div>
                      ))}
                    </TableCell>
                    <TableCell>{formatDistributions(report.totals.distributions)}</TableCell>
                  </TableRow>
                )}
                {rows.map((row) => (
                  <TableRow key={row.membershipId ?? "unassigned"}>
                    <TableCell>{row.name}</TableCell>
                    {STAGES.map((stage) => (
                      <TableCell key={stage}>
                        <div>{row.stages[stage].dealCount}</div>
                        <div className="text-xs text-muted-foreground">{formatFunnelAmount(row.stages[stage])}</div>
                      </TableCell>
                    ))}
                    <TableCell className="text-xs">
                      {row.conversions.map((item) => (
                        <div key={`${item.from}-${item.to}`}>{item.from}→{item.to} {formatConversionRate(item.rate)}</div>
                      ))}
                    </TableCell>
                    <TableCell>{formatDistributions(row.distributions)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div>
            <h3 className="mb-2 text-sm font-medium capitalize">{drilldownStage} drilldown</h3>
            {drilldown.length === 0 ? (
              <p className="text-sm text-muted-foreground">No {drilldownStage} deals for these filters.</p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Deal</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Reps</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {drilldown.map((deal) => (
                      <TableRow key={deal.dealId}>
                        <TableCell>
                          <a className="underline" href={`/deals?deal=${deal.dealId}`}>{deal.displayId}</a>
                          <div className="text-xs text-muted-foreground">{deal.legalName}</div>
                        </TableCell>
                        <TableCell>{deal.occurredOn ?? "Unknown"}</TableCell>
                        <TableCell>
                          {drillMetric?.restricted ? "Restricted" : deal.amountCents == null ? "Unknown" : formatCents(deal.amountCents)}
                          {deal.shared && <Badge variant="outline" className="ml-2">Shared</Badge>}
                        </TableCell>
                        <TableCell className="text-xs">{deal.attributedMembershipIds.length || "Unassigned"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {drillMetric && (
                  <p className="mt-2 text-sm text-muted-foreground">
                    Drilldown {drilldown.length} deals · {formatFunnelAmount(drillMetric)} equals the report {drilldownStage} total.
                  </p>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

export function RepFunnel() {
  const [from, setFrom] = React.useState(() => shiftIsoDate(todayIsoDate(), -29))
  const [to, setTo] = React.useState(() => todayIsoDate())
  const [basis, setBasis] = React.useState<"event" | "cohort">("event")
  const [selectedReps, setSelectedReps] = React.useState<string[]>([])
  const [members, setMembers] = React.useState<MembershipSummary[]>([])
  const [report, setReport] = React.useState<RepFunnelReport>()
  const [status, setStatus] = React.useState<RepFunnelViewStatus>("loading")
  const [message, setMessage] = React.useState("")
  const [drilldownStage, setDrilldownStage] = React.useState<FunnelStage>("submitted")
  const [requestKey, setRequestKey] = React.useState("rep-funnel-load")

  const load = React.useCallback(async () => {
    const validation = validateRepFunnelForm({ from, to, basis })
    if (validation) {
      setStatus("validation")
      setMessage(validation)
      return
    }
    setStatus("loading")
    setMessage("")
    try {
      const query = new URLSearchParams({ basis })
      if (from) query.set("from", from)
      if (to) query.set("to", to)
      for (const id of selectedReps) query.append("membershipIds", id)
      const [next, listed] = await Promise.all([
        requestJson<RepFunnelReport>(`/api/mca/reports/rep-funnel?${query}`),
        requestJson<{ memberships: MembershipSummary[] }>("/api/memberships").catch(() => ({ memberships: [] as MembershipSummary[] })),
      ])
      setMembers(listed.memberships.filter((item) => item.status === "active"))
      setReport(next)
      const empty = STAGES.every((stage) => next.totals.stages[stage].dealCount === 0)
      setStatus(empty ? "empty" : "success")
    } catch (caught) {
      setStatus("error")
      setMessage(errorText(caught))
    }
  }, [basis, from, selectedReps, to])

  React.useEffect(() => {
    void requestKey
    void load()
  }, [load, requestKey])

  function toggleRep(id: string, checked: boolean) {
    setSelectedReps((current) => checked ? [...current, id] : current.filter((item) => item !== id))
  }

  return (
    <Card id="mca-reports-rep-funnel">
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>Rep performance funnel</CardTitle>
          <CardDescription>
            Unique deals only: a merchant submitted to five funders counts once. Shared deals credit each assigned rep in full; company totals stay unique.
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => setRequestKey((key) => `${key}-retry`)}>
          <RefreshCw className="size-4" />{REP_FUNNEL_COPY.retry}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
          onSubmit={(event) => { event.preventDefault(); setRequestKey((key) => `${key}-apply`); void load() }}
        >
          <div className="space-y-1">
            <Label htmlFor="rep-funnel-from">From</Label>
            <Input id="rep-funnel-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="rep-funnel-to">To</Label>
            <Input id="rep-funnel-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Date basis</Label>
            <RadioGroup value={basis} onValueChange={(value) => setBasis(value as "event" | "cohort")} className="flex gap-4 pt-2">
              <div className="flex items-center gap-2">
                <RadioGroupItem id="basis-event" value="event" />
                <Label htmlFor="basis-event">Event</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem id="basis-cohort" value="cohort" />
                <Label htmlFor="basis-cohort">Cohort</Label>
              </div>
            </RadioGroup>
          </div>
          <div>
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
        <RepFunnelView
          status={status}
          message={message}
          report={report}
          drilldownStage={drilldownStage}
          onDrilldown={setDrilldownStage}
        />
      </CardContent>
    </Card>
  )
}

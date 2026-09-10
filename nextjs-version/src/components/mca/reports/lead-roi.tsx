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

const DRILLDOWN_KEYS = ["acquired", "submitted", "approved", "funded", "followOn", "unassigned"] as const
type DrilldownKey = (typeof DRILLDOWN_KEYS)[number]

interface LeadConversionMetric {
  from: string
  to: string
  numerator: number
  denominator: number
  rate: number | null
}

interface LeadRoiEconomics {
  paymentsVisible: boolean
  reason?: string
  purchaseCostCents: number | null
  costComplete: boolean
  zeroCost: boolean
  costPerFundedMerchantCents: number | null
  costPerFundedDealCents: number | null
  collectedCommissionCents?: number
  expectedCommissionCents?: number
  followOnCollectedCents?: number
  followOnExpectedCents?: number
  collectedRoi: number | null
  expectedRoi: number | null
  followOnCollectedRoi: number | null
  collectedRoiDisplay: "ratio" | "n_a" | "undefined"
  expectedRoiDisplay: "ratio" | "n_a" | "undefined"
  followOnRoiDisplay: "ratio" | "n_a" | "undefined"
  expectedRoiLabel: "expected_value"
  followOnRoiLabel: "including_follow_on"
}

interface LeadRoiRow {
  key: string
  kind: string
  sourceId: string | null
  batchId: string | null
  name: string
  acquiredCount: number
  submittedCount: number
  approvedCount: number
  fundedDealCount: number
  fundedMerchantCount: number
  conversions: LeadConversionMetric[]
  economics: LeadRoiEconomics
  missingCost: boolean
  zeroCost: boolean
}

interface LeadRoiDealRow {
  dealId: string
  displayId: string
  legalName: string
  sourceName: string | null
  batchName: string | null
  merchantKey: string
  kind: "acquired" | "renewal" | "unassigned"
  funded: boolean
  committedFundingCount: number
  acquiredOn: string | null
  submittedOn: string | null
  approvedOn: string | null
  fundedOn: string | null
  collectedCommissionCents: number | null
  expectedCommissionCents: number | null
}

interface LeadRoiReport {
  filters: { basis: "event" | "cohort"; from?: string; to?: string }
  period: { complete: boolean; label: string; timezone: string }
  permission: { allowed: boolean; paymentsVisible: boolean; companyTotalsVisible: boolean; reason?: string }
  totals: LeadRoiRow
  sources: LeadRoiRow[]
  batches: LeadRoiRow[]
  unassigned: LeadRoiRow | null
  warnings: Array<{ code: string; message: string }>
  options: {
    sources: Array<{ id: string; name: string }>
    batches: Array<{ id: string; sourceId: string; name: string }>
  }
  drilldown: Record<DrilldownKey, LeadRoiDealRow[]>
}

export type LeadRoiViewStatus = "loading" | "empty" | "validation" | "error" | "success"

export const LEAD_ROI_COPY = {
  loading: "Loading lead source CAC and ROI…",
  empty: "No lead sources or batches match these filters.",
  paymentsRestricted: "Collected commission and ROI are restricted. Missing payment permission is not shown as $0.",
  companyTotalsRestricted: "Workspace totals for commission and ROI are restricted.",
  retry: "Retry",
  zeroCostRoi: "Undefined",
  missingCost: "Blank purchase cost is missing. CAC and ROI are omitted for those batches — missing cost is not treated as $0.",
  attribution: "Acquisition counts use the latest source/batch on each deal. Renewal deals and repeat fundings do not increment funded-deal or funded-merchant counts. Follow-on commission is labeled separately from collected ROI.",
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

export function validateLeadRoiForm(input: { from: string; to: string; basis: string }): string | null {
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

export function formatRoiDisplay(value: number | null, display: "ratio" | "n_a" | "undefined", paymentsVisible: boolean): string {
  if (!paymentsVisible) return "Restricted"
  if (display === "undefined") return LEAD_ROI_COPY.zeroCostRoi
  if (display === "n_a" || value == null) return "N/A"
  const percent = value * 100
  const digits = Number.isInteger(percent) ? 0 : 1
  const sign = percent > 0 ? "+" : ""
  return `${sign}${percent.toFixed(digits)}%`
}

export function formatCostPer(value: number | null): string {
  if (value == null) return "N/A"
  return formatCents(Math.round(value))
}

function formatMoney(value: number | null | undefined, visible: boolean): string {
  if (!visible) return "Restricted"
  if (value == null) return "N/A"
  return formatCents(value)
}

function errorText(error: unknown): string {
  if (error instanceof RequestError) {
    const fields = Object.values(error.fieldErrors ?? {}).flat().filter(Boolean)
    return fields.length ? fields.join(" ") : error.message
  }
  return error instanceof Error ? error.message : "The report could not be loaded."
}

function reportIsEmpty(report: LeadRoiReport): boolean {
  return report.totals.acquiredCount === 0
    && report.totals.submittedCount === 0
    && report.totals.approvedCount === 0
    && report.totals.fundedDealCount === 0
    && report.drilldown.followOn.length === 0
    && report.drilldown.unassigned.length === 0
    && report.batches.every((row) => row.acquiredCount === 0)
}

function MetricRow(props: { row: LeadRoiRow; paymentsVisible: boolean }) {
  const { row, paymentsVisible } = props
  const economics = row.economics
  return (
    <TableRow>
      <TableCell className="font-medium">
        {row.name}
        {row.missingCost && <Badge variant="outline" className="ml-2">Missing cost</Badge>}
        {row.zeroCost && <Badge variant="outline" className="ml-2">Zero cost</Badge>}
      </TableCell>
      <TableCell>{row.acquiredCount}</TableCell>
      <TableCell>{row.submittedCount}</TableCell>
      <TableCell>{row.approvedCount}</TableCell>
      <TableCell>{row.fundedDealCount}</TableCell>
      <TableCell>{row.fundedMerchantCount}</TableCell>
      <TableCell>{formatMoney(economics.purchaseCostCents, true)}</TableCell>
      <TableCell>{formatCostPer(economics.costPerFundedMerchantCents)}</TableCell>
      <TableCell>{formatCostPer(economics.costPerFundedDealCents)}</TableCell>
      <TableCell>{formatMoney(economics.collectedCommissionCents, paymentsVisible && economics.paymentsVisible)}</TableCell>
      <TableCell>
        <div>{formatRoiDisplay(economics.collectedRoi, economics.collectedRoiDisplay, paymentsVisible && economics.paymentsVisible)}</div>
        <div className="text-xs text-muted-foreground">
          Expected-value {formatRoiDisplay(economics.expectedRoi, economics.expectedRoiDisplay, paymentsVisible && economics.paymentsVisible)}
        </div>
        <div className="text-xs text-muted-foreground">
          Including follow-on {formatRoiDisplay(economics.followOnCollectedRoi, economics.followOnRoiDisplay, paymentsVisible && economics.paymentsVisible)}
        </div>
      </TableCell>
      <TableCell className="text-xs">
        {row.conversions.map((item) => (
          <div key={`${item.from}-${item.to}`}>{item.from}→{item.to} {formatConversionRate(item.rate)}</div>
        ))}
      </TableCell>
    </TableRow>
  )
}

export function LeadRoiView(props: {
  status: LeadRoiViewStatus
  message?: string
  report?: LeadRoiReport
  drilldownKey: DrilldownKey
  onDrilldown: (key: DrilldownKey) => void
}) {
  const { status, message, report, drilldownKey, onDrilldown } = props
  const drilldown = report?.drilldown[drilldownKey] ?? []
  const paymentsVisible = Boolean(report?.permission.paymentsVisible)

  return (
    <div className="space-y-4">
      {status === "loading" && (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />{LEAD_ROI_COPY.loading}
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
        <p className="text-sm text-muted-foreground">{LEAD_ROI_COPY.empty}</p>
      )}
      {report && !report.permission.paymentsVisible && (
        <p role="status" className="rounded-md border border-dashed p-3 text-sm">
          {LEAD_ROI_COPY.paymentsRestricted}
        </p>
      )}
      {report && !report.permission.companyTotalsVisible && (
        <p role="status" className="rounded-md border border-dashed p-3 text-sm">
          {LEAD_ROI_COPY.companyTotalsRestricted}
        </p>
      )}
      {report?.warnings.map((warning) => (
        <p key={warning.code} role="status" className="rounded-md border border-dashed p-3 text-sm">
          {warning.message}
        </p>
      ))}
      {report && !report.period.complete && (
        <p className="text-sm text-muted-foreground">{report.period.label}</p>
      )}
      {report && (status === "success" || status === "empty") && (
        <>
          <p className="text-sm text-muted-foreground">{LEAD_ROI_COPY.attribution}</p>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Source / batch</TableHead>
                  {(["acquired", "submitted", "approved"] as const).map((key) => (
                    <TableHead key={key}>
                      <button type="button" className="capitalize underline-offset-2 hover:underline" onClick={() => onDrilldown(key)}>
                        {key}
                      </button>
                    </TableHead>
                  ))}
                  <TableHead>
                    <button type="button" className="underline-offset-2 hover:underline" onClick={() => onDrilldown("funded")}>
                      Funded deals
                    </button>
                  </TableHead>
                  <TableHead>Funded merchants</TableHead>
                  <TableHead>Purchase cost</TableHead>
                  <TableHead>Cost / funded merchant</TableHead>
                  <TableHead>Cost / funded deal</TableHead>
                  <TableHead>Collected commission</TableHead>
                  <TableHead>ROI</TableHead>
                  <TableHead>Conversions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.permission.companyTotalsVisible && <MetricRow row={report.totals} paymentsVisible={paymentsVisible} />}
                {report.sources.map((row) => <MetricRow key={row.key} row={row} paymentsVisible={paymentsVisible} />)}
                {report.batches.map((row) => <MetricRow key={row.key} row={row} paymentsVisible={paymentsVisible} />)}
                {report.unassigned && <MetricRow row={report.unassigned} paymentsVisible={paymentsVisible} />}
              </TableBody>
            </Table>
          </div>
          <div className="flex flex-wrap gap-2">
            {DRILLDOWN_KEYS.map((key) => (
              <Button key={key} type="button" size="sm" variant={drilldownKey === key ? "default" : "outline"} onClick={() => onDrilldown(key)}>
                {key === "followOn" ? "Follow-on / renewals" : key}
              </Button>
            ))}
          </div>
          <div>
            <h3 className="mb-2 text-sm font-medium">{drilldownKey === "followOn" ? "Follow-on / renewal drilldown" : `${drilldownKey} drilldown`}</h3>
            {drilldown.length === 0 ? (
              <p className="text-sm text-muted-foreground">No {drilldownKey} deals for these filters.</p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Deal</TableHead>
                      <TableHead>Source / batch</TableHead>
                      <TableHead>Kind</TableHead>
                      <TableHead>Funded</TableHead>
                      <TableHead>Commission</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {drilldown.map((deal) => (
                      <TableRow key={deal.dealId}>
                        <TableCell>
                          <a className="underline" href={`/deals?deal=${deal.dealId}`}>{deal.displayId}</a>
                          <div className="text-xs text-muted-foreground">{deal.legalName}</div>
                        </TableCell>
                        <TableCell className="text-xs">{deal.sourceName ?? "Unassigned"} · {deal.batchName ?? "—"}</TableCell>
                        <TableCell>
                          <Badge variant="outline">{deal.kind}</Badge>
                          {deal.committedFundingCount > 1 && <Badge variant="outline" className="ml-2">Repeat funding</Badge>}
                        </TableCell>
                        <TableCell>{deal.fundedOn ?? (deal.funded ? "Yes" : "—")}</TableCell>
                        <TableCell>
                          {formatMoney(deal.collectedCommissionCents, paymentsVisible)}
                          {deal.expectedCommissionCents != null && paymentsVisible && (
                            <div className="text-xs text-muted-foreground">Expected {formatCents(deal.expectedCommissionCents)}</div>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

export function LeadRoi() {
  const [from, setFrom] = React.useState(() => shiftIsoDate(todayIsoDate(), -29))
  const [to, setTo] = React.useState(() => todayIsoDate())
  const [basis, setBasis] = React.useState<"event" | "cohort">("cohort")
  const [selectedSources, setSelectedSources] = React.useState<string[]>([])
  const [selectedBatches, setSelectedBatches] = React.useState<string[]>([])
  const [report, setReport] = React.useState<LeadRoiReport>()
  const [status, setStatus] = React.useState<LeadRoiViewStatus>("loading")
  const [message, setMessage] = React.useState("")
  const [drilldownKey, setDrilldownKey] = React.useState<DrilldownKey>("funded")
  const [requestKey, setRequestKey] = React.useState("lead-roi-load")

  const load = React.useCallback(async () => {
    const validation = validateLeadRoiForm({ from, to, basis })
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
      for (const id of selectedSources) query.append("sourceIds", id)
      for (const id of selectedBatches) query.append("batchIds", id)
      const next = await requestJson<LeadRoiReport>(`/api/mca/reports/lead-roi?${query}`)
      setReport(next)
      setStatus(reportIsEmpty(next) ? "empty" : "success")
    } catch (caught) {
      setStatus("error")
      setMessage(errorText(caught))
    }
  }, [basis, from, selectedBatches, selectedSources, to])

  React.useEffect(() => {
    void requestKey
    void load()
  }, [load, requestKey])

  function toggle(list: string[], id: string, checked: boolean, setter: (value: string[]) => void) {
    setter(checked ? [...list, id] : list.filter((item) => item !== id))
  }

  return (
    <Card id="mca-reports-lead-roi">
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>Lead source CAC and ROI</CardTitle>
          <CardDescription>
            Cost per funded merchant and cost per funded deal are separate. Zero denominators are N/A. A $0 batch cost makes ROI undefined, not infinity.
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => setRequestKey((key) => `${key}-retry`)}>
          <RefreshCw className="size-4" />{LEAD_ROI_COPY.retry}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
          onSubmit={(event) => { event.preventDefault(); setRequestKey((key) => `${key}-apply`); void load() }}
        >
          <div className="space-y-1">
            <Label htmlFor="lead-roi-from">From</Label>
            <Input id="lead-roi-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="lead-roi-to">To</Label>
            <Input id="lead-roi-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Date basis</Label>
            <RadioGroup value={basis} onValueChange={(value) => setBasis(value as "event" | "cohort")} className="flex gap-4 pt-2">
              <div className="flex items-center gap-2">
                <RadioGroupItem id="lead-roi-basis-event" value="event" />
                <Label htmlFor="lead-roi-basis-event">Event</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem id="lead-roi-basis-cohort" value="cohort" />
                <Label htmlFor="lead-roi-basis-cohort">Cohort</Label>
              </div>
            </RadioGroup>
          </div>
          <div>
            <Button type="submit">Apply filters</Button>
          </div>
        </form>
        {report && report.options.sources.length > 0 && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Sources</legend>
            <div className="flex flex-wrap gap-3">
              {report.options.sources.map((source) => (
                <label key={source.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={selectedSources.includes(source.id)}
                    onCheckedChange={(checked) => toggle(selectedSources, source.id, checked === true, setSelectedSources)}
                  />
                  {source.name}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {report && report.options.batches.length > 0 && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Batches</legend>
            <div className="flex flex-wrap gap-3">
              {report.options.batches.map((batch) => (
                <label key={batch.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={selectedBatches.includes(batch.id)}
                    onCheckedChange={(checked) => toggle(selectedBatches, batch.id, checked === true, setSelectedBatches)}
                  />
                  {batch.name}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <LeadRoiView
          status={status}
          message={message}
          report={report}
          drilldownKey={drilldownKey}
          onDrilldown={setDrilldownKey}
        />
      </CardContent>
    </Card>
  )
}

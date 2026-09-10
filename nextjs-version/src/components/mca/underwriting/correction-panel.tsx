"use client"

import * as React from "react"
import { PencilLine, RefreshCw } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { RequestError, requestJson } from "@/lib/mca/client"
import type { MetricEvidence } from "@/lib/mca/underwriting/contracts"

type MonthView = {
  id: string
  period: string
  accountKind: string
  accountSuffix?: string
  deposits: MetricEvidence
  averageDailyBalance: MetricEvidence
  nsfCount: MetricEvidence
  negativeDays: MetricEvidence
  corrected: boolean
  correctionReason?: string
  original: { deposits: MetricEvidence; averageDailyBalance: MetricEvidence; nsfCount: MetricEvidence; negativeDays: MetricEvidence }
}

type PositionView = {
  id: string
  label: string
  estimatedPayment?: number
  evidence: string
  status: "proposed" | "confirmed" | "dismissed"
  corrected: boolean
}

type Payload = {
  months: MonthView[]
  positions: PositionView[]
  aggregate: { monthlyRevenue: MetricEvidence; stale: boolean; version: number } | null
}

function formatMetric(metric?: MetricEvidence | null): string {
  if (!metric || metric.unknown || metric.value == null || !Number.isFinite(metric.value)) return "Unknown"
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(metric.value)
}

export function CorrectionPanel({ dealId }: { dealId: string }) {
  const [payload, setPayload] = React.useState<Payload>()
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string[]>>()
  const [message, setMessage] = React.useState<string>()
  const [selectedMonthId, setSelectedMonthId] = React.useState<string>()
  const [deposits, setDeposits] = React.useState("")
  const [reason, setReason] = React.useState("")
  const [replaceReviewed, setReplaceReviewed] = React.useState(false)

  const load = React.useCallback(async () => {
    setError(undefined)
    setLoading(true)
    try {
      const next = await requestJson<Payload>(`/api/mca/underwriting/corrections/${encodeURIComponent(dealId)}`)
      setPayload(next)
      setSelectedMonthId((current) => current && next.months.some((month) => month.id === current) ? current : next.months[0]?.id)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Underwriting corrections could not be loaded.")
    } finally { setLoading(false) }
  }, [dealId])

  React.useEffect(() => { void load() }, [load])

  const selected = payload?.months.find((month) => month.id === selectedMonthId)

  async function saveMonth(event: React.FormEvent) {
    event.preventDefault()
    if (!selected) return
    setBusy(true); setError(undefined); setFieldErrors(undefined); setMessage(undefined)
    try {
      const body: Record<string, unknown> = { monthId: selected.id, reason }
      if (deposits.trim() !== "") body.deposits = Number(deposits)
      const result = await requestJson<{ aggregate: Payload["aggregate"] }>(`/api/mca/underwriting/corrections/${encodeURIComponent(dealId)}`, {
        method: "POST", body: JSON.stringify(body),
      })
      setMessage(result.aggregate?.stale ? "Correction saved. Aggregates were recalculated and scores are stale." : "Correction saved.")
      setDeposits("")
      setReason("")
      await load()
    } catch (caught) {
      if (caught instanceof RequestError) setFieldErrors(caught.fieldErrors)
      setError(caught instanceof Error ? caught.message : "The correction could not be saved.")
    } finally { setBusy(false) }
  }

  async function savePosition(positionId: string, status: PositionView["status"]) {
    setBusy(true); setError(undefined); setFieldErrors(undefined); setMessage(undefined)
    try {
      await requestJson(`/api/mca/underwriting/corrections/${encodeURIComponent(dealId)}`, {
        method: "POST",
        body: JSON.stringify({ positionId, status, reason: reason.trim() || `Marked ${status} during underwriting review.` }),
      })
      setMessage(`Position marked ${status}. Aggregates are stale until scores are rerun.`)
      await load()
    } catch (caught) {
      if (caught instanceof RequestError) setFieldErrors(caught.fieldErrors)
      setError(caught instanceof Error ? caught.message : "The position could not be updated.")
    } finally { setBusy(false) }
  }

  async function analyze() {
    setBusy(true); setError(undefined); setFieldErrors(undefined); setMessage(undefined)
    try {
      const result = await requestJson<Payload>(`/api/mca/underwriting/corrections/${encodeURIComponent(dealId)}/analyze`, {
        method: "POST", body: JSON.stringify({ replaceReviewed }),
      })
      setPayload(result)
      setMessage(replaceReviewed ? "Analysis replaced reviewed corrections." : "Analysis completed without overwriting reviewed corrections.")
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Statement analysis failed.")
    } finally { setBusy(false) }
  }

  const months = payload?.months ?? []
  const positions = payload?.positions ?? []
  const aggregate = payload?.aggregate
  const reviewedCount = months.filter((month) => month.corrected).length

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2"><PencilLine className="size-5" />Manual underwriting corrections</CardTitle>
          <CardDescription>Original extraction stays immutable. Manual values are labeled and recalculate aggregates.</CardDescription>
        </div>
        <Button onClick={() => void analyze()} disabled={busy || loading} aria-label="Rerun analysis">
          <RefreshCw className="size-4" />{busy ? "Working…" : "Rerun analysis"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-6">
        {loading && <p role="status" className="text-sm text-muted-foreground">Loading corrections…</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {message && <p role="status" className="text-sm text-emerald-700">{message}</p>}
        {fieldErrors?.reason && <p role="alert" className="text-sm text-destructive">{fieldErrors.reason.join(" ")}</p>}
        {!loading && !error && months.length === 0 && (
          <p className="text-sm text-muted-foreground">No analyzed statement months yet. Run bank-statement analysis before correcting values.</p>
        )}
        {aggregate && (
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">v{aggregate.version}</Badge>
            {aggregate.stale ? <Badge variant="secondary">Stale</Badge> : <Badge>Current</Badge>}
            <span className="text-sm">Monthly revenue {formatMetric(aggregate.monthlyRevenue)}</span>
          </div>
        )}
        {reviewedCount > 0 && (
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={replaceReviewed} onCheckedChange={(value) => setReplaceReviewed(value === true)} aria-label="Replace reviewed corrections" />
            <span>Replace {reviewedCount} reviewed correction{reviewedCount === 1 ? "" : "s"} with a new AI run. This cannot silently overwrite unless checked.</span>
          </label>
        )}
        {months.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Period</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Deposits</TableHead>
                <TableHead>Original</TableHead>
                <TableHead>ADB</TableHead>
                <TableHead>Source</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {months.map((month) => (
                <TableRow key={month.id} data-selected={month.id === selectedMonthId || undefined} className="cursor-pointer" onClick={() => setSelectedMonthId(month.id)}>
                  <TableCell>{month.period}</TableCell>
                  <TableCell>{month.accountSuffix ? `••••${month.accountSuffix}` : "Unknown"}</TableCell>
                  <TableCell>{formatMetric(month.deposits)}</TableCell>
                  <TableCell className="text-muted-foreground">{formatMetric(month.original.deposits)}</TableCell>
                  <TableCell>{formatMetric(month.averageDailyBalance)}</TableCell>
                  <TableCell>{month.corrected ? <Badge>Manual</Badge> : <Badge variant="outline">Extraction</Badge>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {selected && (
          <form onSubmit={(event) => void saveMonth(event)} className="space-y-3 rounded-lg border p-4">
            <h3 className="font-medium">Correct {selected.period} deposits</h3>
            <p className="text-sm text-muted-foreground">Extracted {formatMetric(selected.original.deposits)} · Current {formatMetric(selected.deposits)}</p>
            <div className="space-y-2">
              <Label htmlFor="correction-deposits">Monthly deposits</Label>
              <Input id="correction-deposits" inputMode="decimal" value={deposits} onChange={(event) => setDeposits(event.target.value)} placeholder={formatMetric(selected.deposits)} aria-invalid={Boolean(fieldErrors?.deposits)} />
              {fieldErrors?.deposits && <p className="text-sm text-destructive">{fieldErrors.deposits.join(" ")}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="correction-reason">Reason</Label>
              <Textarea id="correction-reason" value={reason} onChange={(event) => setReason(event.target.value)} required placeholder="Why this value is being changed" aria-invalid={Boolean(fieldErrors?.reason)} />
            </div>
            <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save correction"}</Button>
          </form>
        )}
        {positions.length > 0 && (
          <div className="space-y-2">
            <h3 className="font-medium">Existing positions</h3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Label</TableHead>
                  <TableHead>Payment</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {positions.map((position) => (
                  <TableRow key={position.id}>
                    <TableCell>{position.label}</TableCell>
                    <TableCell>{position.estimatedPayment == null ? "Unknown" : formatMetric({ value: position.estimatedPayment, unknown: false, confidence: 1 })}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{position.status}</Badge>
                      {position.corrected && <Badge className="ml-1">Manual</Badge>}
                    </TableCell>
                    <TableCell className="space-x-2">
                      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void savePosition(position.id, "confirmed")}>Confirm</Button>
                      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void savePosition(position.id, "dismissed")}>Dismiss</Button>
                    </TableCell>
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

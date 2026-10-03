"use client"

import * as React from "react"
import { Calculator, RefreshCw } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { requestJson } from "@/lib/mca/client"
import type { DealEstimatesResponse, LenderEstimate } from "@/lib/mca/underwriting/estimates"

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
const exact = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

function notEstimated(lender: LenderEstimate): string {
  return lender.status === "insufficient_data" ? `Not enough data: ${lender.reason}` : lender.reason ?? "No estimate"
}

export function EstimatesPanel({ dealId }: { dealId: string }) {
  const [loaded, setLoaded] = React.useState<{ dealId: string; data: DealEstimatesResponse }>()
  const payload = loaded?.dealId === dealId ? loaded.data : undefined
  const requestId = React.useRef(0)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string>()
  const load = React.useCallback(async () => {
    const currentRequest = ++requestId.current
    setLoaded(undefined); setLoading(true); setError(undefined)
    try {
      const data = await requestJson<DealEstimatesResponse>(`/api/mca/underwriting/estimates/${encodeURIComponent(dealId)}`)
      if (currentRequest === requestId.current) setLoaded({ dealId, data })
    } catch (caught) {
      if (currentRequest === requestId.current) setError(caught instanceof Error ? caught.message : "Estimates could not be loaded.")
    } finally { if (currentRequest === requestId.current) setLoading(false) }
  }, [dealId])
  React.useEffect(() => { void load() }, [load])
  const inputs = payload?.lenders[0]?.inputs
  return <Card>
    <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
      <div><CardTitle className="flex items-center gap-2"><Calculator className="size-5" />Estimates <Badge variant="outline">{payload?.label ?? "Estimate — not an offer"}</Badge></CardTitle>
        <CardDescription>Rough advance ranges for matched lenders from analyzed statements. Not an offer; lenders set real terms.</CardDescription></div>
      <Button variant="outline" onClick={() => void load()} disabled={loading}><RefreshCw className="size-4" />Refresh</Button>
    </CardHeader>
    <CardContent className="space-y-4">
      {loading && <p role="status" className="text-sm text-muted-foreground">Loading estimates…</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {!loading && payload && !payload.lenders.length && <p className="text-sm text-muted-foreground">No matched lenders to estimate.</p>}
      {payload && payload.lenders.length > 0 && <Table>
        <TableHeader><TableRow><TableHead>Lender</TableHead><TableHead>Advance</TableHead><TableHead>Factor / term</TableHead><TableHead>Payment</TableHead><TableHead>Warnings</TableHead></TableRow></TableHeader>
        <TableBody>{payload.lenders.map((lender) => <TableRow key={lender.funderId}>
          <TableCell className="font-medium">{lender.funderName}</TableCell>
          {lender.status === "estimate" ? <>
            <TableCell>{money.format(lender.advanceLow!)}–{money.format(lender.advanceHigh!)}</TableCell>
            <TableCell>{lender.factor} · {lender.termMonths} mo</TableCell>
            <TableCell>{exact.format(lender.paymentLow!)}–{exact.format(lender.paymentHigh!)}/{lender.frequency === "daily" ? "day" : "week"} · {lender.payments} payments</TableCell>
          </> : <TableCell colSpan={3} className="text-muted-foreground">{notEstimated(lender)}</TableCell>}
          <TableCell className="text-xs text-muted-foreground"><ul className="space-y-1">{lender.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></TableCell>
        </TableRow>)}</TableBody>
      </Table>}
      {payload && inputs && <p className="text-xs text-muted-foreground">Months used: {inputs.monthsUsed} · Average monthly deposits: {inputs.avgMonthlyDeposits == null ? "unknown" : money.format(inputs.avgMonthlyDeposits)} · Formula v{payload.formulaVersion} · As of {payload.asOf}</p>}
    </CardContent>
  </Card>
}

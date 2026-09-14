"use client"

import { useId, useState } from "react"
import { Area, AreaChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import type { HomeKpis } from "@/lib/mca/home/kpi-contracts"

const dollars = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100)
const compact = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(cents / 100)
const month = (value: string) => new Date(`${value}-01T12:00:00Z`).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" })
const config = {
  fundedCents: { label: "Funded", color: "var(--primary)" },
  commissionCents: { label: "Commission received", color: "var(--primary)" },
  expectedCents: { label: "Expected", color: "var(--muted-foreground)" },
  receivedCents: { label: "Received", color: "var(--primary)" },
  new: { label: "New merchants", color: "var(--primary)" },
  returning: { label: "Returning merchants", color: "var(--chart-2)" },
}

function Restricted() {
  return <div className="flex h-64 items-center justify-center rounded-lg border border-dashed px-6 text-center text-sm text-muted-foreground">Financial trends are restricted for your role.</div>
}

export function HomeActivityCharts({ kpis }: { kpis: HomeKpis }) {
  const [metric, setMetric] = useState<"fundedCents" | "commissionCents">("fundedCents")
  const gradient = useId().replace(/:/g, "")
  const hidden = metric === "fundedCents" ? kpis.funded.dollarsHidden : kpis.commission.dollarsHidden
  const total = kpis.series.fundedByMonth.reduce((sum, item) => sum + item[metric], 0)
  return <section aria-label="Business trends" className="grid gap-4 lg:grid-cols-2">
    <Card className="gap-4">
      <CardHeader className="flex flex-wrap items-start justify-between gap-3 sm:flex-row">
        <div className="space-y-1"><CardDescription>Funding performance · Last 12 months</CardDescription><CardTitle className="text-3xl tabular-nums">{hidden ? "Restricted" : dollars(total)}</CardTitle><p className="text-xs text-muted-foreground">{metric === "fundedCents" ? "Total committed funding" : "Total commission received"}</p></div>
        <div className="flex rounded-lg border p-1" aria-label="Trend metric"><Button size="sm" variant={metric === "fundedCents" ? "secondary" : "ghost"} aria-pressed={metric === "fundedCents"} onClick={() => setMetric("fundedCents")}>Funding</Button><Button size="sm" variant={metric === "commissionCents" ? "secondary" : "ghost"} aria-pressed={metric === "commissionCents"} onClick={() => setMetric("commissionCents")}>Commission</Button></div>
      </CardHeader>
      <CardContent>{hidden ? <Restricted /> : <>
        <ChartContainer config={config} className="h-64 w-full aspect-auto" aria-label="Monthly funding performance">
          <AreaChart accessibilityLayer data={kpis.series.fundedByMonth} margin={{ left: 0, right: 8, top: 12 }}>
            <defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--primary)" stopOpacity={0.2} /><stop offset="100%" stopColor="var(--primary)" stopOpacity={0.01} /></linearGradient></defs>
            <CartesianGrid vertical={false} strokeDasharray="3 4" /><XAxis dataKey="month" tickFormatter={month} tickLine={false} axisLine={false} minTickGap={28} /><YAxis tickFormatter={compact} tickLine={false} axisLine={false} width={60} />
            <ChartTooltip content={<ChartTooltipContent labelFormatter={value => String(value)} formatter={value => dollars(Number(value))} />} />
            <Area type="linear" dataKey={metric} stroke="var(--primary)" fill={`url(#${gradient})`} strokeWidth={2.5} isAnimationActive={false} />
          </AreaChart>
        </ChartContainer>
        {total === 0 && <p className="text-xs text-muted-foreground">No {metric === "fundedCents" ? "funding" : "commission"} recorded in this period.</p>}
      </>}</CardContent>
    </Card>
    <Card className="gap-4">
      <CardHeader><CardDescription>Collections · Last 14 days</CardDescription><CardTitle className="text-xl">Expected and received</CardTitle><div className="flex flex-wrap gap-x-6 gap-y-1 text-sm"><span className="text-muted-foreground">Today expected <strong className="font-medium text-foreground">{kpis.collectionsToday.dollarsHidden ? "Restricted" : dollars(kpis.collectionsToday.expectedCents ?? 0)}</strong></span><span className="text-muted-foreground">Received <strong className="font-medium text-foreground">{kpis.collectionsToday.dollarsHidden ? "Restricted" : dollars(kpis.collectionsToday.receivedCents ?? 0)}</strong></span></div></CardHeader>
      <CardContent>{kpis.collectionsToday.dollarsHidden ? <Restricted /> : <><ChartContainer config={config} className="h-64 w-full aspect-auto" aria-label="Daily expected and received collections"><LineChart accessibilityLayer data={kpis.series.collectionsByDay} margin={{ right: 8, top: 12 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 4" /><XAxis dataKey="day" tickFormatter={value => String(value).slice(5)} tickLine={false} axisLine={false} minTickGap={35} /><YAxis tickFormatter={compact} width={60} tickLine={false} axisLine={false} />
        <ChartTooltip content={<ChartTooltipContent formatter={(value, name) => <span>{name === "expectedCents" ? "Expected" : "Received"}: {dollars(Number(value))}</span>} />} />
        <Line type="linear" dataKey="expectedCents" stroke="var(--color-expectedCents)" strokeDasharray="4 4" dot={false} strokeWidth={2} isAnimationActive={false} /><Line type="linear" dataKey="receivedCents" stroke="var(--primary)" dot={false} strokeWidth={2.5} isAnimationActive={false} />
      </LineChart></ChartContainer><p className="text-xs text-muted-foreground">Dashed: expected · Solid: received. Includes commission and fees.</p></>}</CardContent>
    </Card>
    <Card className="gap-4"><CardHeader><CardDescription>Merchant activity · Last 12 months</CardDescription><CardTitle>New and returning business</CardTitle></CardHeader><CardContent><ChartContainer config={config} className="h-56 w-full aspect-auto" aria-label="Monthly new and returning merchant activity"><LineChart accessibilityLayer data={kpis.series.merchantGrowth} margin={{ right: 8, top: 12 }}><CartesianGrid vertical={false} strokeDasharray="3 4" /><XAxis dataKey="month" tickFormatter={month} minTickGap={28} axisLine={false} tickLine={false} /><YAxis allowDecimals={false} width={40} axisLine={false} tickLine={false} /><ChartTooltip content={<ChartTooltipContent />} /><Line type="linear" dataKey="new" stroke="var(--color-new)" dot={false} strokeWidth={2.5} isAnimationActive={false} /><Line type="linear" dataKey="returning" stroke="var(--color-returning)" strokeDasharray="4 4" dot={false} strokeWidth={2} isAnimationActive={false} /></LineChart></ChartContainer><p className="text-xs text-muted-foreground">Solid: new merchants · Dashed: returning merchants</p></CardContent></Card>
    <Card className="gap-4"><CardHeader><CardDescription>Latest movements</CardDescription><CardTitle>Recent financial activity</CardTitle></CardHeader><CardContent><ul className="divide-y">{kpis.series.recentActivity.slice(0, 5).map(item => <li key={`${item.kind}-${item.id}`} className="flex items-center justify-between gap-4 py-3 first:pt-0"><div className="min-w-0"><p className="truncate text-sm font-medium">{item.title}</p><p className="truncate text-xs text-muted-foreground">{item.subtitle} · {item.status.replaceAll("_", " ")}</p></div><div className="shrink-0 text-right"><p className="text-sm font-medium tabular-nums">{item.amountCents === null ? "Restricted" : dollars(item.amountCents)}</p><p className="text-xs text-muted-foreground">{new Date(item.at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: kpis.timezone })}</p></div></li>)}</ul>{!kpis.series.recentActivity.length && <p className="py-12 text-center text-sm text-muted-foreground">Funding, commissions, and fees will appear here as they are recorded.</p>}</CardContent></Card>
  </section>
}

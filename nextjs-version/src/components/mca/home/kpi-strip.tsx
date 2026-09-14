"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { KpiSparkline } from "@/components/mca/home/kpi-sparkline"
import type { HomeKpis, KpiPeriod } from "@/lib/mca/home/kpi-contracts"
import { HOME_KPI_COPY, mapHomeKpiStrip } from "@/lib/mca/home/kpi-strip"

export function KpiStrip({
  kpis,
  period,
  onPeriodChange,
  loading = false,
}: {
  kpis: HomeKpis | null
  period: KpiPeriod
  onPeriodChange: (period: KpiPeriod) => void
  loading?: boolean
}) {
  const cards = mapHomeKpiStrip(kpis, period)

  return (
    <section className="space-y-3" data-testid="mca-home-kpis">
      <div className="flex justify-end">
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          value={period}
          onValueChange={(value) => { if (value === "mtd" || value === "ytd") onPeriodChange(value) }}
          aria-label="Funded and commission period"
        >
          <ToggleGroupItem value="mtd">{HOME_KPI_COPY.mtd}</ToggleGroupItem>
          <ToggleGroupItem value="ytd">{HOME_KPI_COPY.ytd}</ToggleGroupItem>
        </ToggleGroup>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        {loading && !kpis ? Array.from({ length: 6 }, (_, index) => (
          <Card key={index} className="gap-3 py-4">
            <CardHeader className="px-4">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-7 w-20" />
            </CardHeader>
            <CardContent className="px-4 space-y-3">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-16 w-full" />
            </CardContent>
          </Card>
        )) : cards.map((card) => (
          <Card key={card.key} className="gap-3 py-4" data-testid={`mca-home-kpi-${card.key}`}>
            <CardHeader className="px-4">
              <CardDescription>{card.title}</CardDescription>
              <CardTitle className="text-xl font-semibold tabular-nums">{card.value}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 px-4 text-sm text-muted-foreground">
              <p>{card.detail}</p>
              <KpiSparkline points={card.sparkline} hidden={card.sparklineHidden} label={card.key} />
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  )
}

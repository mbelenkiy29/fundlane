"use client"

import * as React from "react"
import { NewDealModal } from "@/components/mca/deals/new-deal-modal"
import { RequestError, requestJson } from "@/lib/mca/client"
import type { HomeKpis } from "@/lib/mca/home/kpi-contracts"
import { mapDashboard2, periodForDateRange, type Dashboard2DateRange } from "@/lib/mca/dashboard2/map-kpis"
import { CustomerInsights } from "./components/customer-insights"
import { DashboardHeader } from "./components/dashboard-header"
import { MetricsOverview } from "./components/metrics-overview"
import { QuickActions } from "./components/quick-actions"
import { RecentTransactions } from "./components/recent-transactions"
import { RevenueBreakdown } from "./components/revenue-breakdown"
import { SalesChart } from "./components/sales-chart"
import { TopProducts } from "./components/top-products"

export function Dashboard2Shell({ initialKpis }: { initialKpis: HomeKpis | null }) {
  const [dateRange, setDateRange] = React.useState<Dashboard2DateRange>("30d")
  const [kpis, setKpis] = React.useState<HomeKpis | null>(initialKpis)
  const [refreshing, setRefreshing] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const [dealOpen, setDealOpen] = React.useState(false)
  const period = periodForDateRange(dateRange)
  const view = mapDashboard2(kpis, { dateRange })
  const lastUpdated = kpis?.asOf ? new Date(kpis.asOf).toLocaleString() : "—"

  const refresh = React.useCallback(async () => {
    setRefreshing(true)
    setError(undefined)
    try {
      setKpis(await requestJson<HomeKpis>(`/api/mca/home/kpis?period=${period}`))
    } catch (caught) {
      setError(caught instanceof RequestError ? caught.message : "Could not load dashboard metrics.")
    } finally {
      setRefreshing(false)
    }
  }, [period])

  React.useEffect(() => {
    if (kpis?.period === period) return
    void refresh()
  }, [kpis?.period, period, refresh])

  return (
    <div className="flex-1 space-y-6 px-6 pt-0">
        <div className="flex md:flex-row flex-col md:items-center justify-between gap-4 md:gap-6">
          <div className="flex flex-col gap-2">
            <h1 className="text-2xl font-bold tracking-tight">Business Dashboard</h1>
            <p className="text-muted-foreground">
              Monitor your business performance and key metrics in real-time
            </p>
          </div>
          <QuickActions onNewDeal={() => setDealOpen(true)} />
        </div>

        <DashboardHeader
          dateRange={dateRange}
          onDateRangeChange={setDateRange}
          onRefresh={() => void refresh()}
          refreshing={refreshing}
          lastUpdated={lastUpdated}
        />
        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        <div className="@container/main space-y-6">
          <MetricsOverview metrics={view.metrics} />

          <div className="grid gap-6 grid-cols-1 @5xl:grid-cols-2">
            <SalesChart kpis={kpis} />
            <RevenueBreakdown revenue={view.revenue} />
          </div>

          <div className="grid gap-6 grid-cols-1 @5xl:grid-cols-2">
            <RecentTransactions activity={view.activity} />
            <TopProducts funders={view.funders} />
          </div>

          <CustomerInsights
            growth={view.growth}
            growthMetrics={view.growthMetrics}
            industries={view.industries}
            states={view.states}
          />
        </div>
        <NewDealModal open={dealOpen} onOpenChange={setDealOpen} onCreated={() => void refresh()} />
      </div>
  )
}

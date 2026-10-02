"use client"

import * as React from "react"
import Link from "next/link"
import { useNewDeal } from "@/components/mca/deals/new-deal-provider"
import { RequestError, requestJson } from "@/lib/mca/client"
import type { HomeKpis } from "@/lib/mca/home/kpi-contracts"
import { formatDashboardTimestamp, mapDashboard2, periodForDateRange, type Dashboard2DateRange } from "@/lib/mca/dashboard2/map-kpis"
import { HomeEmptyState } from "@/components/mca/home/home-empty-state"
import { NeedsAction } from "@/components/mca/home/needs-action"
import { SetupChecklist } from "@/components/mca/setup/setup-checklist"
import { Button } from "@/components/ui/button"
import type { WorkspaceSetup } from "@/lib/mca/setup/contracts"
import { CustomerInsights } from "./components/customer-insights"
import { DashboardHeader } from "./components/dashboard-header"
import { MetricsOverview } from "./components/metrics-overview"
import { QuickActions } from "./components/quick-actions"
import { RecentTransactions } from "./components/recent-transactions"
import { RevenueBreakdown } from "./components/revenue-breakdown"
import { SalesChart } from "./components/sales-chart"
import { TopProducts } from "./components/top-products"

export function Dashboard2Shell({
  initialKpis,
  initialSetup = null,
  firstName,
  canCreateDeal = true,
  readinessEnabled = false,
  progressiveSetup = false,
  trialEndsAt = null,
}: {
  initialKpis: HomeKpis | null
  initialSetup?: WorkspaceSetup | null
  firstName?: string
  canCreateDeal?: boolean
  readinessEnabled?: boolean
  progressiveSetup?: boolean
  trialEndsAt?: string | null
}) {
  const newDeal = useNewDeal()
  const [dateRange, setDateRange] = React.useState<Dashboard2DateRange>("30d")
  const [kpis, setKpis] = React.useState<HomeKpis | null>(initialKpis)
  const [setup, setSetup] = React.useState<WorkspaceSetup | null>(initialSetup)
  const [dismissing, setDismissing] = React.useState(false)
  const [refreshing, setRefreshing] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const [setupLoading, setSetupLoading] = React.useState(readinessEnabled && !initialSetup)
  const [setupError, setSetupError] = React.useState(false)
  const period = periodForDateRange(dateRange)
  const view = mapDashboard2(kpis, { dateRange })
  const lastUpdated = kpis?.asOf ? formatDashboardTimestamp(kpis.asOf, kpis.timezone) : "—"
  const setupPath = progressiveSetup ? "/api/mca/setup?progressive=1" : "/api/mca/setup"
  const trialEnd = trialEndsAt && Number.isFinite(Date.parse(trialEndsAt)) ? trialEndsAt : null

  const loadSetup = React.useCallback(async () => {
    setSetupLoading(true)
    setSetupError(false)
    try {
      setSetup(await requestJson<WorkspaceSetup>(setupPath))
    } catch {
      setSetupError(true)
    } finally {
      setSetupLoading(false)
    }
  }, [setupPath])

  const refresh = React.useCallback(async () => {
    setRefreshing(true)
    setError(undefined)
    try {
      const [nextKpis, nextSetup] = await Promise.all([
        requestJson<HomeKpis>(`/api/mca/home/kpis?period=${period}`),
        requestJson<WorkspaceSetup>(setupPath).catch(() => {
          if (readinessEnabled) setSetupError(true)
          return null
        }),
      ])
      setKpis(nextKpis)
      if (nextSetup) { setSetup(nextSetup); setSetupError(false) }
    } catch (caught) {
      setError(caught instanceof RequestError ? caught.message : "Could not load dashboard metrics.")
    } finally {
      setRefreshing(false)
    }
  }, [period, readinessEnabled, setupPath])

  React.useEffect(() => { if (readinessEnabled && !initialSetup) void loadSetup() }, [readinessEnabled, initialSetup, loadSetup])

  React.useEffect(() => {
    if (kpis?.period === period) return
    void refresh()
  }, [kpis?.period, period, refresh])

  React.useEffect(() => newDeal.subscribe(() => { void refresh() }), [newDeal, refresh])

  return (
    <div className="min-w-0 flex-1 space-y-6 px-4 pt-0 lg:px-6">
        <div className="flex md:flex-row flex-col md:items-center justify-between gap-4 md:gap-6">
          <div className="flex flex-col gap-2">
            <h1 className="text-2xl font-bold tracking-tight">{firstName ? `Good afternoon, ${firstName}` : "Home"}</h1>
            <p className="text-muted-foreground">
              Pipeline performance and the work that needs attention.
            </p>
          </div>
          {canCreateDeal ? <QuickActions onNewDeal={() => newDeal.open()} /> : null}
        </div>

        <DashboardHeader
          dateRange={dateRange}
          onDateRangeChange={setDateRange}
          onRefresh={() => void refresh()}
          refreshing={refreshing}
          lastUpdated={lastUpdated}
        />
        {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
        {trialEnd && <p className="text-sm">Your trial ends <time dateTime={trialEnd}>{new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(trialEnd))} UTC</time>. <Link className="underline" href="/settings/billing">Manage or cancel billing</Link>.</p>}
        {progressiveSetup && <p className="text-sm text-muted-foreground">Getting started is optional. <Link className="underline" href="/settings/business">Business details</Link> and teammate invitations can wait while you use your CRM.</p>}

        <div className="@container/main space-y-6">
          <MetricsOverview metrics={view.metrics} />

          {setup ? (
            <SetupChecklist
              setup={setup}
              dismissing={dismissing}
              onDismiss={() => {
                setDismissing(true)
                void requestJson<WorkspaceSetup>("/api/mca/setup", {
                  method: "POST",
                  body: JSON.stringify({ dismissed: true, ...(progressiveSetup ? { progressive: true } : {}) }),
                }).then((next) => setSetup(next)).catch((caught) => {
                  setError(caught instanceof RequestError ? caught.message : "Could not hide the setup checklist.")
                }).finally(() => setDismissing(false))
              }}
            />
          ) : null}
          {readinessEnabled && !setup && setupLoading ? <p className="text-sm text-muted-foreground" role="status">Loading workspace setup…</p> : null}
          {readinessEnabled && setupError ? <div className="flex flex-wrap items-center gap-3 text-sm" role="alert">
            <span>Could not load workspace setup.</span>
            <Button type="button" variant="outline" size="sm" disabled={setupLoading} onClick={() => void loadSetup()}>Retry</Button>
          </div> : null}

          {kpis?.empty ? (
            <HomeEmptyState
              canCreateDeal={canCreateDeal}
              onCreate={() => newDeal.open()}
              nextStep={setup?.dismissed || setup?.readiness ? null : setup?.nextStep}
            />
          ) : (
            <NeedsAction />
          )}

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
      </div>
  )
}

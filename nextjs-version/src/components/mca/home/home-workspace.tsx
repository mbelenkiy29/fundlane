"use client"

import * as React from "react"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useNewDeal } from "@/components/mca/deals/new-deal-provider"
import { HomeEmptyState } from "@/components/mca/home/home-empty-state"
import { KpiStrip } from "@/components/mca/home/kpi-strip"
import { NeedsAction } from "@/components/mca/home/needs-action"
import { RequestError, requestJson } from "@/lib/mca/client"
import type { HomeKpis, KpiPeriod } from "@/lib/mca/home/kpi-contracts"

export function HomeWorkspace({
  firstName,
  canCreateDeal,
  initialKpis,
}: {
  firstName: string
  canCreateDeal: boolean
  initialKpis: HomeKpis | null
}) {
  const newDeal = useNewDeal()
  const [period, setPeriod] = React.useState<KpiPeriod>(initialKpis?.period ?? "mtd")
  const [kpis, setKpis] = React.useState<HomeKpis | null>(initialKpis)
  const [loading, setLoading] = React.useState(!initialKpis)
  const [error, setError] = React.useState<string>()

  const refresh = React.useCallback(async (nextPeriod = period) => {
    setLoading(true)
    setError(undefined)
    try {
      setKpis(await requestJson<HomeKpis>(`/api/mca/home/kpis?period=${nextPeriod}`))
    } catch (caught) {
      setError(caught instanceof RequestError ? caught.message : "Could not load home metrics.")
    } finally {
      setLoading(false)
    }
  }, [period])

  React.useEffect(() => {
    if (kpis?.period === period) return
    void refresh(period)
  }, [kpis?.period, period, refresh])

  React.useEffect(() => newDeal.subscribe(() => { void refresh() }), [newDeal, refresh])

  function changePeriod(next: KpiPeriod) {
    setPeriod(next)
  }

  return (
    <div className="space-y-6 px-4 lg:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Good afternoon, {firstName}</h1>
          <p className="mt-1 text-sm text-muted-foreground">Here’s where your brokerage needs attention.</p>
        </div>
        {canCreateDeal ? (
          <Button type="button" onClick={() => newDeal.open()}>
            <Plus /> New deal
          </Button>
        ) : null}
      </div>
      {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
      <KpiStrip kpis={kpis} period={period} onPeriodChange={changePeriod} loading={loading} />
      {kpis?.empty ? (
        <HomeEmptyState canCreateDeal={canCreateDeal} onCreate={() => newDeal.open()} />
      ) : loading && !kpis ? null : (
        <NeedsAction />
      )}
    </div>
  )
}

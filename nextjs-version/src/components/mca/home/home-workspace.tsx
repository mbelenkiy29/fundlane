"use client"

import { Dashboard2Shell } from "@/app/(dashboard)/dashboard-2/dashboard-2-shell"
import type { HomeKpis } from "@/lib/mca/home/kpi-contracts"

export function HomeWorkspace({
  firstName,
  canCreateDeal,
  initialKpis,
}: {
  firstName: string
  canCreateDeal: boolean
  initialKpis: HomeKpis | null
}) {
  return <Dashboard2Shell firstName={firstName} canCreateDeal={canCreateDeal} initialKpis={initialKpis} />
}

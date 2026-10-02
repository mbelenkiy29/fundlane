"use client"

import { Dashboard2Shell } from "@/app/(dashboard)/dashboard-2/dashboard-2-shell"
import type { HomeKpis } from "@/lib/mca/home/kpi-contracts"
import type { WorkspaceSetup } from "@/lib/mca/setup/contracts"

export function HomeWorkspace({
  firstName,
  canCreateDeal,
  initialKpis,
  initialSetup = null,
  readinessEnabled = false,
  progressiveSetup = false,
  trialEndsAt = null,
}: {
  firstName: string
  canCreateDeal: boolean
  initialKpis: HomeKpis | null
  initialSetup?: WorkspaceSetup | null
  readinessEnabled?: boolean
  progressiveSetup?: boolean
  trialEndsAt?: string | null
}) {
  return (
    <Dashboard2Shell
      firstName={firstName}
      canCreateDeal={canCreateDeal}
      initialKpis={initialKpis}
      initialSetup={initialSetup}
      readinessEnabled={readinessEnabled}
      progressiveSetup={progressiveSetup}
      trialEndsAt={trialEndsAt}
    />
  )
}

import { actorForDeals } from "@/lib/mca/deals/service"
import { nowIso } from "@/lib/mca/db"
import type { HomeKpis } from "@/lib/mca/home/kpi-contracts"
import { getHomeKpis } from "@/lib/mca/home/kpis"
import { authenticateSupabaseSession } from "@/lib/mca/supabase-auth"
import { getSessionResponse } from "@/lib/mca/sessions"
import { HomeWorkspace } from "@/components/mca/home/home-workspace"

export default async function DashboardPage() {
  const context = await authenticateSupabaseSession()
  const session = context ? await getSessionResponse(context) : null
  const firstName = session?.user?.name.split(" ")[0] ?? "there"
  let initialKpis: HomeKpis | null = null
  if (context) {
    try {
      initialKpis = await getHomeKpis(await actorForDeals(context), { period: "mtd", nowIso: nowIso() })
    } catch {
      initialKpis = null
    }
  }
  return (
    <HomeWorkspace
      firstName={firstName}
      canCreateDeal={Boolean(session?.permissions?.actions.createDeal)}
      initialKpis={initialKpis}
    />
  )
}

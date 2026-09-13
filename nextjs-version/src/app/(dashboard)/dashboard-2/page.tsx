import { actorForDeals } from "@/lib/mca/deals/service"
import { nowIso } from "@/lib/mca/db"
import type { HomeKpis } from "@/lib/mca/home/kpi-contracts"
import { getHomeKpis } from "@/lib/mca/home/kpis"
import { authenticateSupabaseSession } from "@/lib/mca/supabase-auth"
import { Dashboard2Shell } from "./dashboard-2-shell"

async function loadInitialKpis(): Promise<HomeKpis | null> {
  try {
    const context = await authenticateSupabaseSession()
    if (!context) return null
    return await getHomeKpis(await actorForDeals(context), { period: "mtd", nowIso: nowIso() })
  } catch {
    return null
  }
}

export default async function Dashboard2() {
  return <Dashboard2Shell initialKpis={await loadInitialKpis()} />
}

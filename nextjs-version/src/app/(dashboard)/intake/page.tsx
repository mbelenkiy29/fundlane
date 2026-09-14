import { authenticateSupabaseSession } from "@/lib/mca/supabase-auth"
import { IntakeWorkspace } from "@/components/mca/intake/intake-workspace"
export default async function IntakePage() {
  const session = await authenticateSupabaseSession()
  return <IntakeWorkspace canManage={Boolean(session && ["admin", "super_admin"].includes(session.role))} />
}

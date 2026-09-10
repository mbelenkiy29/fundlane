/** Development-only reconciliation. Run with --conditions=react-server --env-file=.env.local --import tsx; dry-run unless --apply. */
import { billingEnabled, billingRole, syncWorkspaceBilling } from "../../src/lib/mca/billing"
import { getDatabase, closeDatabaseForTests } from "../../src/lib/mca/db"
import { syncClerkMember } from "../../src/lib/mca/clerk-team"
async function main() {
  if (!billingEnabled() || !process.env.CLERK_SECRET_KEY?.startsWith("sk_test_")) throw new Error("Requires enabled billing and a development Clerk key.")
  const apply = process.argv.includes("--apply")
  const db = getDatabase()
  const workspaces = await db.prepare<{ id: string }>("SELECT id FROM workspaces WHERE clerk_organization_id IS NOT NULL ORDER BY id").all()
  let failures = 0
  for (const workspace of workspaces) {
    const members = await db.prepare<{ id: string; role: string; status: string }>("SELECT id, role, status FROM memberships WHERE workspace_id=? AND status IN ('active','deactivated') ORDER BY id").all(workspace.id)
    console.log(JSON.stringify({ workspaceId: workspace.id, mode: apply ? "apply" : "dry-run", members: members.map(m => ({ id: m.id, providerRole: m.status === "active" ? billingRole(m.role) : "remove" })) }))
    if (!apply) continue
    try {
      for (const member of members) await syncClerkMember(workspace.id, member.id)
      await syncWorkspaceBilling(workspace.id)
    } catch {
      failures++
      console.error(`Workspace ${workspace.id}: reconciliation failed; rerun to retry. No credentials were logged.`)
    }
  }
  if (failures) process.exitCode = 1
}
main().catch(() => { console.error("Billing reconciliation could not start. Check development configuration and database availability."); process.exitCode = 1 }).finally(closeDatabaseForTests)

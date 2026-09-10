/** Run with node --conditions=react-server --env-file=.env.local --import tsx scripts/clerk/migrate.ts [--apply]. */
import { getClerkClient } from "../../src/lib/mca/clerk-client"
import { billingEnabled, billingRole } from "../../src/lib/mca/billing"
import {
  getDatabase,
  nowIso,
  withImmediateTransaction,
} from "../../src/lib/mca/db"

async function main() {
  const apply = process.argv.includes("--apply")
  if (
    apply &&
    process.env.CLERK_SECRET_KEY?.startsWith("sk_live_") &&
    !process.argv.includes("--allow-production")
  )
    throw new Error(
      "Production import requires --allow-production and a reviewed dry-run."
    )
  const db = getDatabase()
  const users = await db
    .prepare<{
      id: string
      email: string
      name: string
      clerk_user_id: string | null
    }>(
      `SELECT u.id, u.email, u.name, u.clerk_user_id FROM users u
    WHERE EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id AND m.status = 'active') ORDER BY u.id`
    )
    .all()
  const workspaces = await db
    .prepare<{
      id: string
      name: string
      clerk_organization_id: string | null
    }>("SELECT id, name, clerk_organization_id FROM workspaces ORDER BY id")
    .all()
  const memberships = await db
    .prepare<{
      id: string
      user_id: string
      workspace_id: string
      role: string
    }>(
      "SELECT id, user_id, workspace_id, role FROM memberships WHERE status = 'active' ORDER BY id"
    )
    .all()
  console.log(
    JSON.stringify({
      mode: apply ? "apply" : "dry-run",
      activeUsers: users.length,
      workspaces: workspaces.length,
      activeMemberships: memberships.length,
      unmappedUsers: users.filter((u) => !u.clerk_user_id).length,
      unmappedWorkspaces: workspaces.filter((w) => !w.clerk_organization_id)
        .length,
    })
  )
  if (!apply) return
  const client = getClerkClient()
  for (const user of users)
    await withImmediateTransaction(async (tx) => {
      await tx
        .prepare("SELECT id FROM users WHERE id = ? FOR UPDATE")
        .get(user.id)
      const matches = await client.users.getUserList({
        externalId: [user.id],
        limit: 2,
      })
      if (matches.data.length > 1)
        throw new Error(`Duplicate external identity for MCA user ${user.id}`)
      const remote = user.clerk_user_id
        ? await client.users.getUser(user.clerk_user_id)
        : (matches.data[0] ??
          (await client.users.createUser({
            externalId: user.id,
            emailAddress: [user.email],
            firstName: user.name,
            skipPasswordRequirement: true,
            skipLegalChecks: true,
            privateMetadata: { mcaMigration: true },
          })))
      if (remote.externalId !== user.id)
        throw new Error(`Conflicting identity mapping for MCA user ${user.id}`)
      await tx
        .prepare(
          "UPDATE users SET clerk_user_id = ?, updated_at = ? WHERE id = ?"
        )
        .run(remote.id, nowIso(), user.id)
      user.clerk_user_id = remote.id
    })
  const organizations: Awaited<
    ReturnType<typeof client.organizations.getOrganizationList>
  >["data"] = []
  for (let offset = 0; ; offset += 100) {
    const page = await client.organizations.getOrganizationList({
      limit: 100,
      offset,
    })
    organizations.push(...page.data)
    if (offset + page.data.length >= page.totalCount || !page.data.length) break
  }
  for (const workspace of workspaces)
    await withImmediateTransaction(async (tx) => {
      await tx
        .prepare("SELECT id FROM workspaces WHERE id = ? FOR UPDATE")
        .get(workspace.id)
      const matches = organizations.filter(
        (o) => o.privateMetadata.mcaWorkspaceId === workspace.id
      )
      if (matches.length > 1)
        throw new Error(`Duplicate organization mapping for ${workspace.id}`)
      // No createdBy: the migration must not accidentally grant an owner membership to a deactivated user.
      const remote = workspace.clerk_organization_id
        ? await client.organizations.getOrganization({
            organizationId: workspace.clerk_organization_id,
          })
        : (matches[0] ??
          (await client.organizations.createOrganization({
            name: workspace.name,
            // Preserve imported active teams even when the new Free default is one seat.
            maxAllowedMemberships: Math.max(1, memberships.filter(m => m.workspace_id === workspace.id).length),
            privateMetadata: { mcaWorkspaceId: workspace.id },
          })))
      if (remote.privateMetadata.mcaWorkspaceId !== workspace.id)
        throw new Error(`Conflicting organization mapping for ${workspace.id}`)
      await tx
        .prepare(
          "UPDATE workspaces SET clerk_organization_id = ?, updated_at = ? WHERE id = ?"
        )
        .run(remote.id, nowIso(), workspace.id)
      workspace.clerk_organization_id = remote.id
    })
  for (const member of memberships)
    await withImmediateTransaction(async (tx) => {
      const current = await tx
        .prepare<{ status: string }>(
          "SELECT status FROM memberships WHERE id = ? FOR UPDATE"
        )
        .get(member.id)
      if (current?.status !== "active") return
      const organizationId = workspaces.find(
        (w) => w.id === member.workspace_id
      )?.clerk_organization_id
      const userId = users.find((u) => u.id === member.user_id)?.clerk_user_id
      if (!organizationId || !userId)
        throw new Error(`Missing parent mapping for ${member.id}`)
      const existing = await client.organizations.getOrganizationMembershipList(
        { organizationId, userId: [userId], limit: 1 }
      )
      const remote =
        existing.data[0] ??
        (await client.organizations.createOrganizationMembership({
          organizationId,
          userId,
          role: billingEnabled() ? billingRole(member.role) : "org:member",
        }))
      if (billingEnabled() && remote.role !== billingRole(member.role))
        await client.organizations.updateOrganizationMembership({ organizationId, userId, role: billingRole(member.role) })
      await client.organizations.updateOrganizationMembershipMetadata({
        organizationId,
        userId,
        publicMetadata: { mcaRole: member.role },
      })
      await tx
        .prepare(
          "UPDATE memberships SET clerk_membership_id = ?, updated_at = ? WHERE id = ?"
        )
        .run(remote.id, nowIso(), member.id)
    })
  console.log(
    "Import complete. No passwords, legacy sessions, pending invitations, or deactivated memberships were imported. Existing users must verify email and set a password."
  )
}
main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    const provider = error as { status?: number; errors?: Array<{ code?: string }> };
    console.error(JSON.stringify({ status: provider?.status, codes: provider?.errors?.map(item => item.code) }));
    console.error(
      "Migration stopped. No secrets were logged. Review identity conflicts and provider configuration, then rerun the resumable import."
    )
    process.exit(1)
  })

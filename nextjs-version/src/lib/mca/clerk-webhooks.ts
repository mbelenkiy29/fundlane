import "server-only"
import { getClerkClient } from "./clerk-client"
import type { WebhookEvent } from "@clerk/nextjs/server"
import { nowIso, withImmediateTransaction } from "./db"
import { billingEnabled, syncWorkspaceBilling } from "./billing"

function notFound(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "status" in error &&
    error.status === 404
  )
}

/** Events are invalidation hints. Re-read the provider while holding the local event lock. */
export async function processClerkWebhook(
  id: string,
  event: WebhookEvent,
  client = getClerkClient()
) {
  await withImmediateTransaction(async (db) => {
    await db
      .prepare("SELECT pg_advisory_xact_lock(hashtext(?))")
      .get(`clerk-event:${id}`)
    if (
      await db
        .prepare("SELECT id FROM clerk_webhook_events WHERE id = ?")
        .get(id)
    )
      return
    if (event.type.startsWith("user.")) {
      const userId = event.data.id
      if (userId) {
        let user
        try {
          user = await client.users.getUser(userId)
        } catch (error) {
          if (!notFound(error)) throw error
        }
        if (!user || user.banned) {
          await db
            .prepare(
              `UPDATE memberships SET status = 'deactivated', updated_at = ? WHERE user_id IN (SELECT id FROM users WHERE clerk_user_id = ?)`
            )
            .run(nowIso(), userId)
        } else {
          const email = user.emailAddresses.find(
            (e) =>
              e.id === user.primaryEmailAddressId &&
              e.verification?.status === "verified"
          )
          // Only already-linked users are updated. Never associate identities using webhook email alone.
          if (email)
            await db
              .prepare(
                `UPDATE users SET name = ?, email = ?, updated_at = ? WHERE clerk_user_id = ?`
              )
              .run(
                [user.firstName, user.lastName].filter(Boolean).join(" ") ||
                  email.emailAddress,
                email.emailAddress.toLowerCase(),
                nowIso(),
                userId
              )
        }
      }
    }
    if (
      event.type === "organizationMembership.deleted" ||
      event.type === "organizationMembership.updated" ||
      event.type === "organizationMembership.created"
    ) {
      const organizationId = event.data.organization.id,
        userId = event.data.public_user_data.user_id
      let exists = false
      try {
        exists =
          (
            await client.organizations.getOrganizationMembershipList({
              organizationId,
              userId: [userId],
              limit: 1,
            })
          ).data.length > 0
      } catch (error) {
        if (!notFound(error)) throw error
      }
      if (!exists)
        await db
          .prepare(
            `UPDATE memberships SET status = 'deactivated', updated_at = ? WHERE workspace_id IN
        (SELECT id FROM workspaces WHERE clerk_organization_id = ?) AND user_id IN (SELECT id FROM users WHERE clerk_user_id = ?)`
          )
          .run(nowIso(), organizationId, userId)
      // Creation never restores deactivated memberships. Accepted invitations reconcile on the next authenticated request.
    }
    if (billingEnabled() && /^(subscription\.|subscriptionItem\.|paymentAttempt\.)/.test(event.type)) {
      const payer = (event.data as { payer?: { organization_id?: string } }).payer
      if (payer?.organization_id) {
        const workspace = await db.prepare<{ id: string }>("SELECT id FROM workspaces WHERE clerk_organization_id = ?").get(payer.organization_id)
        if (workspace) await syncWorkspaceBilling(workspace.id, client)
      }
    }
    if (event.type === "organization.deleted" && event.data.id) {
      let exists = true
      try {
        await client.organizations.getOrganization({
          organizationId: event.data.id,
        })
      } catch (error) {
        if (!notFound(error)) throw error
        exists = false
      }
      if (!exists)
        await db
          .prepare(
            `UPDATE memberships SET status = 'deactivated', updated_at = ? WHERE workspace_id IN (SELECT id FROM workspaces WHERE clerk_organization_id = ?)`
          )
          .run(nowIso(), event.data.id)
    }
    await db
      .prepare(
        "INSERT INTO clerk_webhook_events (id, event_type, processed_at) VALUES (?, ?, ?)"
      )
      .run(id, event.type, nowIso())
  })
}

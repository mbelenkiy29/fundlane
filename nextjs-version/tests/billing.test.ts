import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { getDatabase, closeDatabaseForTests, withImmediateTransaction } from "../src/lib/mca/db"
import { createWorkspaceWithAdmin, updateWorkspaceSettings } from "../src/lib/mca/workspaces"
import { subscriptionEntitlement, syncWorkspaceBilling, assertBillingCapacity, getWorkspaceBilling, billingRole } from "../src/lib/mca/billing"
import { processClerkWebhook } from "../src/lib/mca/clerk-webhooks"
import type { BillingSubscription } from "@clerk/backend"
import type { WebhookEvent } from "@clerk/nextjs/server"
let database: Awaited<ReturnType<typeof createPostgresTestDatabase>>
before(async () => { database = await createPostgresTestDatabase("billing"); process.env.DATABASE_URL = database.databaseUrl; process.env.MCA_CLERK_BILLING_ENABLED = "true" })
after(async () => { delete process.env.MCA_CLERK_BILLING_ENABLED; await closeDatabaseForTests(); await database.close() })
function subscription(slug = "mca_starter_test", status = "active", id: string = randomUUID()) {
  return { id, status: status === "past_due" ? "past_due" : "active", subscriptionItems: [{ id: `item_${id}`, status, planId: `plan_${slug}`, plan: { id: `plan_${slug}`, slug, name: slug }, periodStart: Date.now() - 1000, periodEnd: Date.now() + 86400000 }] } as unknown as BillingSubscription
}
async function fixture() {
  const suffix = randomUUID()
  const local = await createWorkspaceWithAdmin({ workspaceName: "Billing test", adminName: "Owner", adminEmail: `${suffix}@example.test`, password: "Unused fixture password 99!", role: "admin" })
  const orgId = `org_${suffix}`
  await getDatabase().prepare("UPDATE workspaces SET clerk_organization_id=? WHERE id=?").run(orgId, local.workspaceId)
  const state = { subscription: subscription(), fail: false }
  const client = { billing: { getOrganizationBillingSubscription: async () => { if (state.fail) throw new Error("provider outage"); return state.subscription } } } as unknown as Parameters<typeof syncWorkspaceBilling>[1]
  return { ...local, orgId, state, client }
}
test("plans require successful checkout and preserve cancellation until the period ends", () => {
  assert.equal(subscriptionEntitlement(subscription()).seatLimit, 5)
  assert.equal(subscriptionEntitlement(subscription("mca_team_test")).seatLimit, 20)
  assert.equal(subscriptionEntitlement(subscription("mca_team_test", "canceled")).seatLimit, 20)
  assert.throws(() => subscriptionEntitlement(subscription("mca_team_test", "canceled"), Date.now()+172800000))
  assert.throws(() => subscriptionEntitlement(subscription("mca_team_test", "incomplete")))
  assert.throws(() => subscriptionEntitlement(subscription("unexpected")))
  assert.equal(subscriptionEntitlement(subscription("mca_team_test", "past_due")).paymentPastDue, true)
  assert.equal(billingRole("admin"), "org:mca_billing_admin")
  for (const role of ["rep", "manager"]) assert.equal(billingRole(role), "org:mca_employee")
})
test("sync retains local IDs and permits over-cap historical memberships without deleting them", async () => {
  const f = await fixture()
  await syncWorkspaceBilling(f.workspaceId, f.client)
  assert.equal((await getWorkspaceBilling(f.workspaceId)).billing?.seatLimit, 5)
  f.state.subscription = subscription("free_org", "active", f.state.subscription.id)
  await syncWorkspaceBilling(f.workspaceId, f.client)
  assert.equal((await getWorkspaceBilling(f.workspaceId)).billing?.seatLimit, 1)
  await assert.rejects(assertBillingCapacity(f.workspaceId, 1, f.client), /seats/)
  assert.equal((await getDatabase().prepare<{ status: string }>("SELECT status FROM memberships WHERE id=?").get(f.membershipId))?.status, "active")
})
test("past-due and provider outages block new invitations but retain billing and company records", async () => {
  const f = await fixture()
  await syncWorkspaceBilling(f.workspaceId, f.client)
  f.state.fail = true
  await assert.rejects(assertBillingCapacity(f.workspaceId, 1, f.client), /temporarily unavailable/)
  assert.equal((await getWorkspaceBilling(f.workspaceId)).billing?.seatLimit, 5)
  f.state.fail = false; f.state.subscription = subscription("mca_starter_test", "past_due", f.state.subscription.id)
  await assert.rejects(assertBillingCapacity(f.workspaceId, 1, f.client), /payment method/)
})
test("billing events replay safely and stale events reconcile current provider state", async () => {
  const f = await fixture()
  const event = { type: "subscriptionItem.ended", data: { payer: { organization_id: f.orgId } } } as WebhookEvent
  await processClerkWebhook(`evt_${f.orgId}`, event, f.client)
  await processClerkWebhook(`evt_${f.orgId}`, event, f.client)
  assert.equal((await getWorkspaceBilling(f.workspaceId)).billing?.seatLimit, 5)
  f.state.subscription = subscription("mca_team_test", "active", f.state.subscription.id)
  await processClerkWebhook(`evt_upgrade_${f.orgId}`, { ...event, type: "paymentAttempt.updated" } as WebhookEvent, f.client)
  assert.equal((await getWorkspaceBilling(f.workspaceId)).billing?.seatLimit, 20)
})
test("a transaction failure rolls back billing and seat changes together and retry recovers", async () => {
  const f = await fixture()
  await syncWorkspaceBilling(f.workspaceId, f.client)
  f.state.subscription = subscription("mca_team_test", "active", f.state.subscription.id)
  await assert.rejects(withImmediateTransaction(async () => { await syncWorkspaceBilling(f.workspaceId, f.client); throw new Error("synthetic commit failure") }))
  assert.equal((await getWorkspaceBilling(f.workspaceId)).billing?.seatLimit, 5)
  await syncWorkspaceBilling(f.workspaceId, f.client)
  assert.equal((await getWorkspaceBilling(f.workspaceId)).billing?.seatLimit, 20)
})
test("manual settings cannot bypass plan seats", async () => {
  const f = await fixture()
  await syncWorkspaceBilling(f.workspaceId, f.client)
  await assert.rejects(updateWorkspaceSettings({ authType: "session", userId: f.userId, membershipId: f.membershipId, workspaceId: f.workspaceId, role: "super_admin", scopes: [], sessionId: "test" }, { seatLimit: 99 }), /Plans & Billing/)
})

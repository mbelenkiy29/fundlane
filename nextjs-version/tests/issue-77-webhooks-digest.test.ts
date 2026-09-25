import "./helpers/business-auth"
import test, { after, before, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { hashOpaqueToken } from "../src/lib/mca/crypto"
import { createDeal, transitionDeal } from "../src/lib/mca/deals/service"
import type { DealActor } from "../src/lib/mca/deals/schema"
import { createOffer } from "../src/lib/mca/offers/service"
import {
  createWorkflowWebhookEndpoint,
  listWorkflowWebhookConsole,
  processWebhookOutbox,
  removeWorkflowWebhookEndpoint,
  setWorkflowWebhookFetchForTests,
  signWorkflowWebhookBody,
} from "../src/lib/mca/comms/webhooks"
import { runScheduledCommsJobs } from "../src/lib/mca/comms/scheduler"
import { GET as commsCronGet } from "../src/app/api/cron/comms/route"
import { GET as digestGet, PATCH as digestPatch } from "../src/app/api/mca/comms/digest/route"

let testDatabase: Awaited<ReturnType<typeof createPostgresTestDatabase>>

const SIGNING_SECRET = "issue77-signing-secret-never-leak-32"
const PUBLIC_HOOK = "https://hooks.example.test/issue-77"
const NOW = "2026-01-15T11:00:00.000Z"
const CRON_SECRET = "issue-77-cron-secret"

const ids = {
  workspace: "workspace-issue-77",
  adminUser: "issue77-admin-user",
  adminMember: "issue77-admin-member",
  repUser: "issue77-rep-user",
  repMember: "issue77-rep-member",
}

const actor = (): DealActor => ({
  workspaceId: ids.workspace,
  userId: ids.adminUser,
  membershipId: ids.adminMember,
  role: "admin",
  managedMembershipIds: [],
  activeMembershipIds: [ids.adminMember, ids.repMember],
  source: "user",
  correlationId: "corr-issue-77",
})

type Envelope = { event_id: string; event_type: string; data: Record<string, unknown> }
type Posted = { url: string; body: string; headers: Headers; envelope: Envelope }

const posted: Posted[] = []
let dealCounter = 0
const previousCron = process.env.CRON_SECRET

async function seed() {
  const database = getDatabase()
  const now = new Date().toISOString()
  const visibility = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true })
  const actions = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true })
  const flags = JSON.stringify({ reports: true, payments: true, integrations: true })
  await database.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
    VALUES (?, 'Issue 77', 'America/New_York', 8, ?, ?, ?, ?, ?)`).run(ids.workspace, flags, visibility, actions, now, now)
  for (const [userId, memberId, email, role] of [
    [ids.adminUser, ids.adminMember, "issue77-admin@example.test", "admin"],
    [ids.repUser, ids.repMember, "issue77-rep@example.test", "rep"],
  ] as const) {
    await database.prepare(`INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at)
      VALUES (?, ?, NULL, ?, NULL, ?, ?, ?)`).run(userId, email, email, `APP-${userId}`, now, now)
    await database.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,manager_membership_id,status,sender_association,created_at,updated_at)
      VALUES (?, ?, ?, ?, NULL, 'active', NULL, ?, ?)`).run(memberId, ids.workspace, userId, role, now, now)
  }
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("issue77-admin-session", ids.adminUser, ids.adminMember, hashOpaqueToken("issue77-admin-session"), now, now)
}

before(async () => {
  process.env.CRON_SECRET = CRON_SECRET
  testDatabase = await createPostgresTestDatabase("issue77_webhooks")
  Object.assign(process.env, testDatabase.env())
  await seed()
})

beforeEach(async () => {
  posted.length = 0
  setWorkflowWebhookFetchForTests(async (input, init) => {
    const body = typeof init?.body === "string" ? init.body : ""
    posted.push({
      url: String(input),
      body,
      headers: new Headers(init?.headers as HeadersInit | undefined),
      envelope: body ? JSON.parse(body) as Envelope : {} as Envelope,
    })
    return new Response("ok", { status: 200 })
  })
  const database = getDatabase()
  await database.prepare("DELETE FROM mca_workflow_webhook_deliveries").run()
  await database.prepare("DELETE FROM mca_workflow_webhook_outbox").run()
  await database.prepare("DELETE FROM mca_workflow_webhook_endpoints").run()
  await database.prepare("DELETE FROM mca_digest_deliveries").run()
  await database.prepare("DELETE FROM mca_digest_subscriptions").run()
})

after(async () => {
  setWorkflowWebhookFetchForTests()
  await closeDatabaseForTests()
  await testDatabase.close()
  if (previousCron === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = previousCron
})

function cookieRequest(path: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      cookie: "mca_session=issue77-admin-session",
      origin: "http://localhost",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  })
}

async function seedDeal() {
  dealCounter += 1
  return (await createDeal(actor(), {
    idempotencyKey: `issue77-deal-${dealCounter}`,
    legalName: `Issue 77 Merchant ${dealCounter} LLC`,
    requestedAmount: 25_000,
    assignments: [{ membershipId: ids.adminMember, kind: "originator", isPrimary: true }],
  })).deal
}

test("issue 77: offer create and deal status change enqueue signed, retried webhook deliveries", async () => {
  const endpoint = await createWorkflowWebhookEndpoint(actor(), {
    label: "Ops automation",
    destinationUrl: PUBLIC_HOOK,
    events: ["offer.created", "deal.transitioned"],
    signingSecret: SIGNING_SECRET,
  })
  const deal = await seedDeal()
  const offer = await createOffer(actor(), {
    dealId: deal.id,
    funderName: "Issue 77 Capital",
    terms: { amountCents: 1_500_000, factorRate: 1.2, termMonths: 10, paymentAmountCents: 80_000, paymentFrequency: "weekly" },
  })
  const transitioned = await transitionDeal(actor(), deal.id, { status: "new_application", expectedVersion: deal.version })
  assert.equal(transitioned.deal.status, "new_application")

  const consoleBefore = await listWorkflowWebhookConsole(actor())
  assert.equal(consoleBefore.outbox.length, 2)
  assert.deepEqual(consoleBefore.outbox.map((item) => item.eventType).sort(), ["deal.transitioned", "offer.created"])
  assert.equal(consoleBefore.outbox.every((item) => item.state === "pending"), true)
  assert.equal(posted.length, 0)

  const processed = await processWebhookOutbox({ actor: actor(), nowIso: NOW })
  assert.equal(processed.delivered, 2)
  assert.equal(posted.length, 2)
  const offerPost = posted.find((item) => item.envelope.event_type === "offer.created")
  const statusPost = posted.find((item) => item.envelope.event_type === "deal.transitioned")
  assert.ok(offerPost)
  assert.ok(statusPost)
  assert.equal((offerPost!.envelope.data.offer_id as string | undefined), offer.id)
  assert.equal(statusPost!.envelope.data.from_status, "lead")
  assert.equal(statusPost!.envelope.data.to_status, "new_application")
  for (const item of posted) {
    const timestamp = item.headers.get("x-mca-webhook-timestamp")
    assert.equal(item.headers.get("x-mca-webhook-signature"), signWorkflowWebhookBody(SIGNING_SECRET, timestamp!, item.body))
  }

  const consoleAfter = await listWorkflowWebhookConsole(actor())
  assert.equal(consoleAfter.deliveries.length, 2)
  assert.equal(consoleAfter.deliveries.every((item) => item.state === "delivered"), true)
  assert.equal(consoleAfter.outbox.every((item) => item.state === "delivered"), true)

  const removed = await removeWorkflowWebhookEndpoint(actor(), endpoint.id)
  assert.equal(removed.removed, true)
  const afterRemove = await listWorkflowWebhookConsole(actor())
  assert.equal(afterRemove.endpoints.length, 0)
  assert.equal(afterRemove.deliveries.length, 2)
})

test("issue 77: cron tick retries failed webhook outbox and is runtime-agnostic", async () => {
  setWorkflowWebhookFetchForTests(async () => new Response("no", { status: 500 }))
  await createWorkflowWebhookEndpoint(actor(), {
    label: "Retry hook",
    destinationUrl: PUBLIC_HOOK,
    events: ["deal.transitioned"],
    signingSecret: SIGNING_SECRET,
  })
  const deal = await seedDeal()
  await transitionDeal(actor(), deal.id, { status: "new_application", expectedVersion: deal.version })
  await processWebhookOutbox({ actor: actor(), nowIso: NOW })
  const pending = await listWorkflowWebhookConsole(actor())
  assert.equal(pending.outbox[0]?.state, "pending")
  assert.equal(pending.deliveries[0]?.state, "failed")

  setWorkflowWebhookFetchForTests(async (input, init) => {
    const body = typeof init?.body === "string" ? init.body : ""
    posted.push({
      url: String(input),
      body,
      headers: new Headers(init?.headers as HeadersInit | undefined),
      envelope: body ? JSON.parse(body) as Envelope : {} as Envelope,
    })
    return new Response("ok", { status: 200 })
  })
  const scheduled = await runScheduledCommsJobs(NOW)
  assert.equal(scheduled.workspaces, 1)
  assert.equal(scheduled.webhooks.delivered, 1)
  const afterRetry = await listWorkflowWebhookConsole(actor())
  assert.equal(afterRetry.outbox[0]?.state, "delivered")
  assert.ok(afterRetry.deliveries.some((item) => item.state === "delivered"))

  const unauthorized = await commsCronGet(new Request("http://localhost/api/cron/comms", {
    headers: { authorization: "Bearer wrong" },
  }))
  assert.equal(unauthorized.status, 401)
  const ok = await commsCronGet(new Request(`http://localhost/api/cron/comms?nowIso=${encodeURIComponent(NOW)}`, {
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  }))
  assert.equal(ok.status, 200)
  const body = await ok.json() as { workspaces: number; webhooks: { delivered: number } }
  assert.equal(body.workspaces, 0)
  assert.equal(body.webhooks.delivered, 0)
})

test("issue 77: admins can opt in to a daily report at a set time with role-appropriate preview", async () => {
  const source = readFileSync(resolve(process.cwd(), "src/components/mca/comms/digest-settings.tsx"), "utf8")
  assert.match(source, /Enable daily reports/)
  assert.match(source, /role-appropriate/)
  const webhookSource = readFileSync(resolve(process.cwd(), "src/components/mca/comms/webhook-console.tsx"), "utf8")
  assert.match(webhookSource, /Remove webhook/)
  assert.match(webhookSource, /Delivery log/)
  assert.match(webhookSource, /Deal status updated/)

  const saved = await digestPatch(cookieRequest("/api/mca/comms/digest", {
    method: "PATCH",
    body: JSON.stringify({ enabled: true, timezone: "America/New_York", localSendHour: 6 }),
  }))
  assert.equal(saved.status, 200)
  const savedBody = await saved.json() as { enabled: boolean; localSendHour: number; timezone: string }
  assert.equal(savedBody.enabled, true)
  assert.equal(savedBody.localSendHour, 6)
  assert.equal(savedBody.timezone, "America/New_York")

  const loaded = await digestGet(cookieRequest(`/api/mca/comms/digest?nowIso=${encodeURIComponent(NOW)}`))
  assert.equal(loaded.status, 200)
  const loadedBody = await loaded.json() as { enabled: boolean; preview: { groups: Array<{ stage: string }> } }
  assert.equal(loadedBody.enabled, true)
  assert.deepEqual(loadedBody.preview.groups.map((group) => group.stage), ["new", "submitted", "approved", "funded"])
})

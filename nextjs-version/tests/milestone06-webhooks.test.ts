import "./helpers/business-auth";
import test, { after, before, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { closeDatabaseForTests, getDatabase, newId } from "../src/lib/mca/db"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { hashOpaqueToken } from "../src/lib/mca/crypto"
import { createDeal } from "../src/lib/mca/deals/service"
import type { DealActor } from "../src/lib/mca/deals/schema"
import type { Role } from "../src/lib/mca/types"
import { AppError } from "../src/lib/mca/errors"
import { runCommsJobs } from "../src/lib/mca/comms/jobs"
import {
  WORKFLOW_WEBHOOK_MAX_ATTEMPTS,
  WORKFLOW_WEBHOOK_SPEC_VERSION,
  WORKFLOW_WEBHOOK_TEST_HOOK,
  createWorkflowWebhookEndpoint,
  listWorkflowWebhookConsole,
  processWebhookOutbox,
  publishWorkflowWebhook,
  replayWebhookOutbox,
  setWorkflowWebhookFetchForTests,
  signWorkflowWebhookBody,
  testWorkflowWebhookEndpoint,
  updateWorkflowWebhookEndpoint,
} from "../src/lib/mca/comms/webhooks"
import { GET as webhooksGet, POST as webhooksPost } from "../src/app/api/mca/comms/webhooks/route"
import { DELETE as webhookDelete, GET as webhookGet, PATCH as webhookPatch } from "../src/app/api/mca/comms/webhooks/[id]/route"
import { POST as webhookTestPost } from "../src/app/api/mca/comms/webhooks/[id]/test/route"
import { POST as webhookReplayPost } from "../src/app/api/mca/comms/webhooks/outbox/[id]/replay/route"
import { POST as webhookEventsPost } from "../src/app/api/mca/comms/webhooks/events/route"
import { POST as jobsPost } from "../src/app/api/mca/comms/jobs/run/route"

let testDatabase: Awaited<ReturnType<typeof createPostgresTestDatabase>>

const SIGNING_SECRET = "webhook-signing-secret-never-leak-32ch"
const NOW = "2026-01-15T11:00:00.000Z"
const PUBLIC_HOOK = "https://hooks.example.test/workflow"

const ids = {
  workspace: "workspace-m06-webhooks",
  otherWorkspace: "workspace-m06-webhooks-other",
  adminUser: "webhook-admin-user",
  adminMember: "webhook-admin-member",
  repUser: "webhook-rep-user",
  repMember: "webhook-rep-member",
  closerUser: "webhook-closer-user",
  closerMember: "webhook-closer-member",
  suspendedUser: "webhook-suspended-user",
  suspendedMember: "webhook-suspended-member",
  otherUser: "webhook-other-user",
  otherMember: "webhook-other-member",
}

const actor = (workspaceId = ids.workspace, role: Role | null = "admin"): DealActor => {
  const membershipId = workspaceId === ids.otherWorkspace
    ? ids.otherMember
    : role === "rep"
      ? ids.repMember
      : ids.adminMember
  return {
    workspaceId,
    userId: workspaceId === ids.otherWorkspace ? ids.otherUser : role === "rep" ? ids.repUser : ids.adminUser,
    membershipId,
    role,
    managedMembershipIds: [],
    activeMembershipIds: workspaceId === ids.otherWorkspace ? [ids.otherMember] : [ids.adminMember, ids.repMember, ids.closerMember],
    source: role ? "user" : "api_key",
    correlationId: `corr-${workspaceId}-${role ?? "key"}`,
  }
}

type ErrorBody = { error: { code: string; message: string; fieldErrors?: Record<string, string[]> } }
type Envelope = {
  spec_version: string
  event_id: string
  event_type: string
  occurred_at: string
  workspace_id: string
  deal: { id: string; display_id: string; status: string; legal_name: string; version: number }
  data: Record<string, unknown>
  notifications: { originator: boolean; closer: boolean; recipients: Array<{ membership_id: string; kind: string }> }
}
type Posted = { url: string; body: string; headers: Headers; envelope: Envelope }

const posted: Posted[] = []
let fetchStatus = 200
let dealCounter = 0

async function seed() {
  const database = getDatabase()
  const now = new Date().toISOString()
  const visibility = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true })
  const actions = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true })
  const flags = JSON.stringify({ reports: true, payments: true, integrations: true })
  for (const [id, name] of [[ids.workspace, "Webhook Test"], [ids.otherWorkspace, "Other Workspace"]] as const) {
    await database.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
      VALUES (?, ?, 'America/New_York', 8, ?, ?, ?, ?, ?)`).run(id, name, flags, visibility, actions, now, now)
  }
  for (const [userId, memberId, email, workspaceId, role, status] of [
    [ids.adminUser, ids.adminMember, "webhook-admin@example.test", ids.workspace, "admin", "active"],
    [ids.repUser, ids.repMember, "webhook-rep@example.test", ids.workspace, "rep", "active"],
    [ids.closerUser, ids.closerMember, "webhook-closer@example.test", ids.workspace, "rep", "active"],
    [ids.suspendedUser, ids.suspendedMember, "webhook-suspended@example.test", ids.workspace, "rep", "deactivated"],
    [ids.otherUser, ids.otherMember, "webhook-other@example.test", ids.otherWorkspace, "admin", "active"],
  ] as const) {
    await database.prepare(`INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at)
      VALUES (?, ?, NULL, ?, NULL, ?, ?, ?)`).run(userId, email, email, `APP-${userId}`, now, now)
    await database.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,manager_membership_id,status,sender_association,created_at,updated_at)
      VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?)`).run(memberId, workspaceId, userId, role, status, now, now)
  }
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("webhook-admin-session", ids.adminUser, ids.adminMember, hashOpaqueToken("admin-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("webhook-rep-session", ids.repUser, ids.repMember, hashOpaqueToken("rep-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("webhook-other-session", ids.otherUser, ids.otherMember, hashOpaqueToken("other-session-token"), now, now)
  const addKey = async (id: string, secret: string, scopes: string[], workspaceId: string) => {
    await database.prepare(`INSERT INTO api_keys
      (id,workspace_id,name,prefix,secret_hash,scopes,expires_at,last_used_at,revoked_at,rate_limit_per_minute,created_by,created_at)
      VALUES (?, ?, ?, 'mca_test', ?, ?, NULL, NULL, NULL, 60, ?, ?)`).run(id, workspaceId, id, hashOpaqueToken(`mca_${secret}`), JSON.stringify(scopes), ids.adminUser, now)
  }
  await addKey("webhook-intake-key", "intake-secret", ["intake:write"], ids.workspace)
  await addKey("webhook-read-key", "read-secret", ["deals:read"], ids.workspace)
  await addKey("webhook-write-key", "write-secret", ["deals:write"], ids.workspace)
}

before(async () => {
  testDatabase = await createPostgresTestDatabase("m06_webhooks")
  Object.assign(process.env, testDatabase.env())
  await seed()
})

beforeEach(async () => {
  posted.length = 0
  fetchStatus = 200
  setWorkflowWebhookFetchForTests(async (input, init) => {
    const body = typeof init?.body === "string" ? init.body : ""
    posted.push({
      url: String(input),
      body,
      headers: new Headers(init?.headers as HeadersInit | undefined),
      envelope: body ? JSON.parse(body) as Envelope : {} as Envelope,
    })
    return new Response(fetchStatus >= 200 && fetchStatus < 300 ? "ok" : "no", { status: fetchStatus })
  })
  const database = getDatabase()
  await database.prepare("DELETE FROM mca_workflow_webhook_deliveries").run()
  await database.prepare("DELETE FROM mca_workflow_webhook_outbox").run()
  await database.prepare("DELETE FROM mca_workflow_webhook_endpoints").run()
})

after(async () => {
  setWorkflowWebhookFetchForTests()
  await closeDatabaseForTests()
  await testDatabase.close()
})

function cookieRequest(path: string, token: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      cookie: `mca_session=${token}`,
      origin: "http://localhost",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  })
}

function bearerRequest(path: string, secret: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      authorization: `Bearer mca_${secret}`,
      origin: "http://localhost",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  })
}

function params(id: string) {
  return { params: Promise.resolve({ id }) }
}

function assertNoSecret(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  assert.equal(text.includes(SIGNING_SECRET), false)
  assert.equal(text.includes("signing_secret_cipher"), false)
  assert.equal(text.includes("credentialCipher"), false)
  assert.equal(text.includes("\"commission\""), false)
  assert.equal(text.includes("buy_rate"), false)
  assert.equal(text.includes("buyRate"), false)
}

function assertHmac(item: Posted, secret: string) {
  const timestamp = item.headers.get("x-mca-webhook-timestamp")
  assert.ok(timestamp)
  assert.equal(item.headers.get("x-mca-webhook-signature"), signWorkflowWebhookBody(secret, timestamp!, item.body))
  assert.equal(item.headers.get("x-mca-event-id"), item.envelope.event_id)
  assert.equal(item.headers.get("x-mca-spec-version"), WORKFLOW_WEBHOOK_SPEC_VERSION)
}

async function seedDeal(assignments: Array<{ membershipId: string; kind: "originator" | "closer"; isPrimary?: boolean }>) {
  dealCounter += 1
  return (await createDeal(actor(), {
    idempotencyKey: `webhook-deal-${dealCounter}`,
    legalName: `Webhook Merchant ${dealCounter} LLC`,
    requestedAmount: 40_000,
    assignments,
  })).deal
}

test("MIC-158: replay preserves event identity, transactional outbox, HMAC, bounded retries, and SSRF-safe destinations", async () => {
  for (const destinationUrl of [
    "http://127.0.0.1/hook",
    "https://localhost/workflow",
    "https://192.168.1.20/hook",
    "https://10.0.0.8/hook",
    "https://169.254.169.254/latest",
    "http://hooks.example.test/workflow",
  ]) {
    await assert.rejects(
      () => createWorkflowWebhookEndpoint(actor(), {
        label: `bad-${destinationUrl}`,
        destinationUrl,
        events: ["deal.assigned"],
      }),
      (error: unknown) => error instanceof AppError && error.status === 422,
    )
  }

  const unsafe = await webhooksPost(cookieRequest("/api/mca/comms/webhooks", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ label: "loopback", destinationUrl: "https://127.0.0.1/hook", events: ["offer.created"] }),
  }))
  assert.equal(unsafe.status, 422)
  assert.equal((await unsafe.json() as ErrorBody).error.fieldErrors?.destinationUrl?.[0], "Webhook destinations cannot target localhost or a private IP.")

  const endpoint = await createWorkflowWebhookEndpoint(actor(), {
    label: "Ops hook",
    destinationUrl: PUBLIC_HOOK,
    events: ["offer.created", "deal.transitioned"],
    signingSecret: SIGNING_SECRET,
  })
  const testHook = await createWorkflowWebhookEndpoint(actor(), {
    label: "Local test hook",
    destinationUrl: WORKFLOW_WEBHOOK_TEST_HOOK,
    events: ["offer.created"],
  })
  assert.equal(testHook.destinationUrl, WORKFLOW_WEBHOOK_TEST_HOOK)

  const deal = await seedDeal([{ membershipId: ids.repMember, kind: "originator", isPrimary: true }])
  const eventId = "offer.created:stable-replay-1"
  const first = await publishWorkflowWebhook(actor(), {
    eventType: "offer.created",
    eventId,
    dealId: deal.id,
    occurredAt: NOW,
    offer: {
      offerId: "offer-1",
      revisionId: "rev-1",
      revisionNumber: 1,
      funderName: "North Capital",
      source: "manual",
      amountCents: 50_000,
    },
  })
  assert.equal(first.enqueued, 2)
  const replayPublish = await publishWorkflowWebhook(actor(), {
    eventType: "offer.created",
    eventId,
    dealId: deal.id,
    occurredAt: NOW,
    offer: {
      offerId: "offer-1",
      revisionId: "rev-1",
      revisionNumber: 1,
      funderName: "North Capital",
      source: "manual",
      amountCents: 50_000,
    },
  })
  assert.equal(replayPublish.eventId, eventId)
  assert.equal(replayPublish.enqueued, 0)

  const opened = await webhooksGet(cookieRequest("/api/mca/comms/webhooks", "admin-session-token"))
  assert.equal(opened.status, 200)
  const openedBody = await opened.json() as { outbox: Array<{ eventId: string; state: string }> }
  assert.ok(openedBody.outbox.every((item) => item.state === "pending"))
  assert.equal(posted.length, 0)

  const tested = await testWorkflowWebhookEndpoint(actor(), endpoint.id, NOW)
  assert.equal(tested.markedDelivered, false)
  assert.equal(tested.delivered, true)
  assert.equal(posted.length, 1)
  assert.equal(posted[0]?.envelope.event_id, `webhook.test:${endpoint.id}`)
  const stillPending = await listWorkflowWebhookConsole(actor())
  assert.ok(stillPending.outbox.every((item) => item.state === "pending"))
  posted.length = 0

  fetchStatus = 500
  for (let attempt = 1; attempt <= WORKFLOW_WEBHOOK_MAX_ATTEMPTS; attempt += 1) {
    const run = await processWebhookOutbox({ actor: actor(), nowIso: NOW })
    if (attempt < WORKFLOW_WEBHOOK_MAX_ATTEMPTS) {
      assert.equal(run.failed, 2)
      assert.equal(run.delivered, 0)
    }
  }
  const exhausted = await listWorkflowWebhookConsole(actor())
  assert.ok(exhausted.outbox.every((item) => item.state === "failed" && item.attempts === WORKFLOW_WEBHOOK_MAX_ATTEMPTS))
  assert.equal(exhausted.outbox.every((item) => item.eventId === eventId), true)

  fetchStatus = 200
  posted.length = 0
  const jobs = await runCommsJobs({ actor: actor(), nowIso: NOW, kinds: ["webhook_outbox"] })
  assert.equal(jobs.webhooks.attempted, 0)
  assert.equal(posted.length, 0)

  const publicOutbox = exhausted.outbox.find((item) => item.endpointId === endpoint.id)
  assert.ok(publicOutbox)
  const replayed = await replayWebhookOutbox(actor(), publicOutbox!.id, NOW)
  assert.equal(replayed.eventId, eventId)
  assert.equal(replayed.state, "delivered")
  assert.equal(posted.length, 1)
  assert.equal(posted[0]?.url, PUBLIC_HOOK)
  assert.equal(posted[0]?.envelope.event_id, eventId)
  assert.equal(posted[0]?.envelope.spec_version, WORKFLOW_WEBHOOK_SPEC_VERSION)
  assertHmac(posted[0]!, SIGNING_SECRET)
  assertNoSecret(posted[0]!.envelope)
  assert.equal(posted[0]?.headers.get("x-mca-webhook-signature")?.includes(SIGNING_SECRET), false)

  const httpJobs = await jobsPost(cookieRequest("/api/mca/comms/jobs/run", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ nowIso: NOW, kinds: ["webhook_outbox"] }),
  }))
  assert.equal(httpJobs.status, 200)
  const jobBody = await httpJobs.json() as { webhooks: { attempted: number; delivered: number } }
  assert.equal(jobBody.webhooks.attempted, 0)
})

test("MIC-158: assigning a rep notifies only authorized configured recipients and versioned envelopes cover offers, transitions, assignments, and submissions", async () => {
  const assignmentHook = await createWorkflowWebhookEndpoint(actor(), {
    label: "Assignment notify originators",
    destinationUrl: "https://hooks.example.test/assigned",
    events: ["deal.assigned"],
    notifyOriginator: true,
    notifyCloser: false,
    signingSecret: SIGNING_SECRET,
  })
  const allHook = await createWorkflowWebhookEndpoint(actor(), {
    label: "All workflow events",
    destinationUrl: "https://hooks.example.test/all",
    events: ["offer.created", "deal.transitioned", "deal.assigned", "submission.created"],
    notifyOriginator: true,
    notifyCloser: true,
    signingSecret: SIGNING_SECRET,
  })
  await createWorkflowWebhookEndpoint(actor(), {
    label: "Disabled hook",
    destinationUrl: "https://hooks.example.test/disabled",
    events: ["deal.assigned", "offer.created"],
    notifyOriginator: true,
    notifyCloser: true,
    enabled: false,
  })
  await createWorkflowWebhookEndpoint(actor(), {
    label: "Offers only",
    destinationUrl: "https://hooks.example.test/offers",
    events: ["offer.created"],
  })

  const deal = await seedDeal([
    { membershipId: ids.repMember, kind: "originator", isPrimary: true },
    { membershipId: ids.closerMember, kind: "closer", isPrimary: true },
  ])
  const now = NOW
  await getDatabase().prepare(`INSERT INTO deal_assignments (id,workspace_id,deal_id,membership_id,kind,is_primary,assigned_at)
    VALUES (?, ?, ?, ?, 'originator', 0, ?)`).run(newId(), ids.workspace, deal.id, ids.suspendedMember, now)
  await getDatabase().prepare(`INSERT INTO deal_assignments (id,workspace_id,deal_id,membership_id,kind,is_primary,assigned_at)
    VALUES (?, ?, ?, ?, 'originator', 0, ?)`).run(newId(), ids.workspace, deal.id, ids.otherMember, now)

  const assigned = await publishWorkflowWebhook(actor(), {
    eventType: "deal.assigned",
    eventId: "deal.assigned:rep-only",
    dealId: deal.id,
    occurredAt: NOW,
  })
  assert.equal(assigned.enqueued, 2)

  await processWebhookOutbox({ actor: actor(), nowIso: NOW })
  const assignmentPosts = posted.filter((item) => item.envelope.event_type === "deal.assigned")
  assert.equal(assignmentPosts.length, 2)
  const originatorOnly = assignmentPosts.find((item) => item.url === "https://hooks.example.test/assigned")
  const both = assignmentPosts.find((item) => item.url === "https://hooks.example.test/all")
  assert.ok(originatorOnly)
  assert.ok(both)
  assert.equal(originatorOnly!.envelope.notifications.originator, true)
  assert.equal(originatorOnly!.envelope.notifications.closer, false)
  assert.deepEqual(
    originatorOnly!.envelope.notifications.recipients.map((item) => `${item.kind}:${item.membership_id}`).sort(),
    [`originator:${ids.repMember}`],
  )
  assert.deepEqual(
    both!.envelope.notifications.recipients.map((item) => `${item.kind}:${item.membership_id}`).sort(),
    [`closer:${ids.closerMember}`, `originator:${ids.repMember}`],
  )
  const assignmentIds = (originatorOnly!.envelope.data.assignments as Array<{ membership_id: string }>).map((item) => item.membership_id).sort()
  assert.deepEqual(assignmentIds, [ids.closerMember, ids.repMember].sort())
  assert.equal(assignmentIds.includes(ids.suspendedMember), false)
  assert.equal(assignmentIds.includes(ids.otherMember), false)
  assert.equal(posted.some((item) => item.url === "https://hooks.example.test/disabled"), false)
  assert.equal(posted.some((item) => item.url === "https://hooks.example.test/offers"), false)

  posted.length = 0
  const offer = await publishWorkflowWebhook(actor(), {
    eventType: "offer.created",
    eventId: "offer.created:north-1",
    dealId: deal.id,
    offer: { offerId: "offer-north", revisionId: "rev-2", revisionNumber: 2, funderName: "North Capital", source: "email", amountCents: 75_000 },
  })
  const transition = await publishWorkflowWebhook(actor(), {
    eventType: "deal.transitioned",
    eventId: "deal.transitioned:lead-offer",
    dealId: deal.id,
    fromStatus: "lead",
    toStatus: "offer",
  })
  const submission = await publishWorkflowWebhook(actor(), {
    eventType: "submission.created",
    eventId: "submission.created:job-1",
    dealId: deal.id,
    submission: { jobId: "job-1", funderId: "funder-north", funderName: "North Capital", routeKind: "email", state: "queued" },
  })
  assert.equal(offer.enqueued, 2)
  assert.equal(transition.enqueued, 1)
  assert.equal(submission.enqueued, 1)
  await processWebhookOutbox({ actor: actor(), nowIso: NOW })
  const types = posted.map((item) => `${item.envelope.event_type}@${item.url}`).sort()
  assert.ok(types.includes("offer.created@https://hooks.example.test/all"))
  assert.ok(types.includes("offer.created@https://hooks.example.test/offers"))
  assert.ok(types.includes("deal.transitioned@https://hooks.example.test/all"))
  assert.ok(types.includes("submission.created@https://hooks.example.test/all"))
  assert.equal(posted.some((item) => item.envelope.event_type === "offer.created" && item.url === "https://hooks.example.test/assigned"), false)
  const offerEnvelope = posted.find((item) => item.envelope.event_type === "offer.created")!.envelope
  assert.equal(offerEnvelope.spec_version, WORKFLOW_WEBHOOK_SPEC_VERSION)
  assert.equal((offerEnvelope.data as { amount_cents?: number }).amount_cents, 75_000)
  assert.equal((offerEnvelope.data as { offer_id?: string }).offer_id, "offer-north")
  assertNoSecret(offerEnvelope)
  assert.equal(JSON.stringify(offerEnvelope.data).includes("commission"), false)

  const closerOnly = await seedDeal([{ membershipId: ids.closerMember, kind: "closer", isPrimary: true }])
  posted.length = 0
  await publishWorkflowWebhook(actor(), {
    eventType: "deal.assigned",
    eventId: "deal.assigned:closer-only",
    dealId: closerOnly.id,
  })
  await processWebhookOutbox({ actor: actor(), nowIso: NOW })
  const closerOriginatorHook = posted.find((item) => item.url === assignmentHook.destinationUrl)
  assert.ok(closerOriginatorHook)
  assert.deepEqual(closerOriginatorHook!.envelope.notifications.recipients, [])
  const allCloser = posted.find((item) => item.url === allHook.destinationUrl)
  assert.deepEqual(allCloser!.envelope.notifications.recipients.map((item) => item.membership_id), [ids.closerMember])
})

test("MIC-158: webhook console states, API permissions match the UI, and secrets stay out of JSON", async () => {
  const source = readFileSync(resolve(process.cwd(), "src/components/mca/comms/webhook-console.tsx"), "utf8")
  assert.match(source, /Loading webhook console/)
  assert.match(source, /No webhook endpoints yet/)
  assert.match(source, /Enter a valid HTTPS webhook URL/)
  assert.match(source, /Choose at least one event/)
  assert.match(source, /Webhook endpoint saved/)
  assert.match(source, /Webhook delivered/)
  assert.match(source, /role="alert"/)
  assert.match(source, /> Replay/)
  assert.match(source, /Signing secret is shown once/)
  assert.match(source, /Test delivery does not mark workflow events delivered/)
  assert.match(source, /Notify originators/)
  assert.match(source, /Replay preserves event identity/)
  assert.match(source, /Remove webhook/)
  assert.match(source, /Delivery log/)
  assert.match(source, /Deal status updated/)

  const empty = await webhooksGet(cookieRequest("/api/mca/comms/webhooks", "admin-session-token"))
  assert.equal(empty.status, 200)
  const emptyBody = await empty.json() as { endpoints: unknown[] }
  assert.equal(emptyBody.endpoints.length, 0)
  assertNoSecret(emptyBody)

  const missingEvents = await webhooksPost(cookieRequest("/api/mca/comms/webhooks", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ label: "No events", destinationUrl: PUBLIC_HOOK, events: [] }),
  }))
  assert.equal(missingEvents.status, 422)
  assert.equal((await missingEvents.json() as ErrorBody).error.fieldErrors?.events?.[0], "Choose at least one event.")

  const invalidJson = await webhooksPost(cookieRequest("/api/mca/comms/webhooks", "admin-session-token", {
    method: "POST",
    body: "{",
  }))
  assert.equal(invalidJson.status, 400)

  const created = await webhooksPost(cookieRequest("/api/mca/comms/webhooks", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({
      label: "Console hook",
      destinationUrl: PUBLIC_HOOK,
      events: ["deal.assigned"],
      notifyOriginator: true,
      notifyCloser: false,
      signingSecret: SIGNING_SECRET,
    }),
  }))
  assert.equal(created.status, 201)
  const createdBody = await created.json() as { id: string; signingSecret?: string; destinationUrl: string }
  assert.equal(createdBody.signingSecret, SIGNING_SECRET)
  assert.equal(createdBody.destinationUrl, PUBLIC_HOOK)

  const listed = await webhooksGet(cookieRequest("/api/mca/comms/webhooks", "admin-session-token"))
  const listedBody = await listed.json() as { endpoints: Array<{ id: string; signingSecret?: string }> }
  assert.equal(listedBody.endpoints[0]?.signingSecret, undefined)
  assertNoSecret(listedBody)

  const one = await webhookGet(cookieRequest(`/api/mca/comms/webhooks/${createdBody.id}`, "admin-session-token"), params(createdBody.id))
  assert.equal(one.status, 200)
  assertNoSecret(await one.json())

  const patched = await webhookPatch(cookieRequest(`/api/mca/comms/webhooks/${createdBody.id}`, "admin-session-token", {
    method: "PATCH",
    body: JSON.stringify({ notifyCloser: true, rotateSecret: true }),
  }), params(createdBody.id))
  assert.equal(patched.status, 200)
  const patchedBody = await patched.json() as { notifyCloser: boolean; signingSecret?: string }
  assert.equal(patchedBody.notifyCloser, true)
  assert.ok(patchedBody.signingSecret)
  assert.notEqual(patchedBody.signingSecret, SIGNING_SECRET)

  const deal = await seedDeal([{ membershipId: ids.repMember, kind: "originator", isPrimary: true }])
  const published = await webhookEventsPost(cookieRequest("/api/mca/comms/webhooks/events", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ eventType: "deal.assigned", eventId: "deal.assigned:api-1", dealId: deal.id }),
  }))
  assert.equal(published.status, 201)

  const preview = await webhooksGet(cookieRequest("/api/mca/comms/webhooks", "admin-session-token"))
  const previewBody = await preview.json() as { outbox: Array<{ id: string; eventId: string; state: string }> }
  assert.equal(previewBody.outbox[0]?.state, "pending")
  assert.equal(previewBody.outbox[0]?.eventId, "deal.assigned:api-1")
  assert.equal(posted.length, 0)

  const tested = await webhookTestPost(cookieRequest(`/api/mca/comms/webhooks/${createdBody.id}/test`, "admin-session-token", { method: "POST" }), params(createdBody.id))
  assert.equal(tested.status, 200)
  const testedBody = await tested.json() as { delivered: boolean; markedDelivered: boolean }
  assert.equal(testedBody.delivered, true)
  assert.equal(testedBody.markedDelivered, false)
  const afterTest = await listWorkflowWebhookConsole(actor())
  assert.equal(afterTest.outbox[0]?.state, "pending")

  posted.length = 0
  const replayed = await webhookReplayPost(cookieRequest(`/api/mca/comms/webhooks/outbox/${previewBody.outbox[0]!.id}/replay?nowIso=${encodeURIComponent(NOW)}`, "admin-session-token", { method: "POST" }), params(previewBody.outbox[0]!.id))
  assert.equal(replayed.status, 200)
  const replayBody = await replayed.json() as { eventId: string; state: string }
  assert.equal(replayBody.eventId, "deal.assigned:api-1")
  assert.equal(replayBody.state, "delivered")
  assert.equal(posted[0]?.envelope.event_id, "deal.assigned:api-1")
  assertHmac(posted[0]!, patchedBody.signingSecret!)
  assertNoSecret(posted[0]!.envelope)

  const removed = await webhookDelete(cookieRequest(`/api/mca/comms/webhooks/${createdBody.id}`, "admin-session-token", { method: "DELETE" }), params(createdBody.id))
  assert.equal(removed.status, 200)
  assert.equal((await removed.json() as { removed: boolean; id: string }).removed, true)
  const afterRemove = await webhookGet(cookieRequest(`/api/mca/comms/webhooks/${createdBody.id}`, "admin-session-token"), params(createdBody.id))
  assert.equal(afterRemove.status, 404)

  const repGet = await webhooksGet(cookieRequest("/api/mca/comms/webhooks", "rep-session-token"))
  assert.equal(repGet.status, 403)
  const repPost = await webhooksPost(cookieRequest("/api/mca/comms/webhooks", "rep-session-token", {
    method: "POST",
    body: JSON.stringify({ label: "rep", destinationUrl: PUBLIC_HOOK, events: ["deal.assigned"] }),
  }))
  assert.equal(repPost.status, 403)

  for (const secret of ["intake-secret", "read-secret", "write-secret"]) {
    const keyGet = await webhooksGet(bearerRequest("/api/mca/comms/webhooks", secret))
    assert.equal(keyGet.status, 403)
    const keyPost = await webhooksPost(bearerRequest("/api/mca/comms/webhooks", secret, {
      method: "POST",
      body: JSON.stringify({ label: "key", destinationUrl: PUBLIC_HOOK, events: ["deal.assigned"] }),
    }))
    assert.equal(keyPost.status, 403)
  }

  const otherGet = await webhookGet(cookieRequest(`/api/mca/comms/webhooks/${createdBody.id}`, "other-session-token"), params(createdBody.id))
  assert.equal(otherGet.status, 404)
})

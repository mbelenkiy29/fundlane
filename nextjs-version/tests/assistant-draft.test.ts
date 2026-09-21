import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { randomUUID } from "node:crypto"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { closeDatabaseForTests, getDatabase, newId } from "../src/lib/mca/db"
import { createWorkspaceWithAdmin } from "../src/lib/mca/workspaces"
import { actorForDeals, createDeal } from "../src/lib/mca/deals/service"
import { assistantContext } from "../src/lib/mca/assistant/chatkit-context"
import {
  merchantDraftSchema,
  prepareMerchantDraft,
  runTool,
  toolRequest,
} from "../src/lib/mca/assistant/tools"
import { storeOperation, storeRequest } from "../src/lib/mca/assistant/store"
import { AppError } from "../src/lib/mca/errors"
import type { MembershipContext } from "../src/lib/mca/types"

let fixture: Awaited<ReturnType<typeof createPostgresTestDatabase>>
let admin: MembershipContext
let threadId: string

const phone = "+14155550123"
const email = "merchant@example.test"

before(async () => {
  fixture = await createPostgresTestDatabase("assistant_draft")
  process.env.DATABASE_URL = fixture.databaseUrl
  const data = await createWorkspaceWithAdmin({
    workspaceName: "Draft",
    adminName: "Test",
    adminEmail: `${randomUUID()}@example.test`,
    password: "Synthetic password 2026!",
    role: "admin",
  })
  admin = { ...data, authType: "session", role: "admin", sessionId: randomUUID(), scopes: [] }
  await getDatabase()
    .prepare("UPDATE users SET supabase_user_id=? WHERE id=?")
    .run(randomUUID(), data.userId)
  threadId = `thread_${randomUUID()}`
  const c = await assistantContext(admin)
  await storeOperation(c, storeRequest.parse({ op: "save_thread", payload: { id: threadId, title: "Draft chat", created_at: new Date().toISOString() } }))
})

after(async () => {
  await closeDatabaseForTests()
  await fixture?.close()
})

async function dealWith(overrides: Record<string, unknown> = {}) {
  const actor = await actorForDeals(admin)
  return (
    await createDeal(actor, {
      idempotencyKey: newId(),
      legalName: "Synthetic Merchant",
      contactPhone: phone,
      contactEmail: email,
      assignments: [{ membershipId: admin.membershipId, kind: "originator", isPrimary: true }],
      ...overrides,
    })
  ).deal
}

test("draft schema accepts only sms/email with bounded text", () => {
  assert.equal(merchantDraftSchema.parse({ dealId: "d1", channel: "sms", body: "hi" }).channel, "sms")
  assert.equal(merchantDraftSchema.parse({ dealId: "d1", channel: "email", body: "hi" }).body, "hi")
  assert.throws(() => merchantDraftSchema.parse({ dealId: "d1", channel: "fax", body: "hi" }))
  assert.throws(() => merchantDraftSchema.parse({ dealId: "d1", channel: "sms", body: "" }))
})

test("prepareMerchantDraft resolves the deal mobile number and never alters the body", async () => {
  const c = await assistantContext(admin)
  const deal = await dealWith()
  const draft = await prepareMerchantDraft(c, {
    threadId,
    dealId: deal.id,
    channel: "sms",
    body: "Follow up on the missing tax return.",
  })
  assert.equal(draft.channel, "sms")
  assert.equal(draft.recipient, phone)
  assert.equal(draft.body, "Follow up on the missing tax return.")
  assert.equal(draft.merchantName, "Synthetic Merchant")
  assert.equal(draft.note, undefined)
  assert.match(draft.draftId, /^draft_/)
})

test("email channel resolves the deal contact email", async () => {
  const c = await assistantContext(admin)
  const deal = await dealWith()
  const draft = await prepareMerchantDraft(c, {
    threadId,
    dealId: deal.id,
    channel: "email",
    body: "Hello,",
  })
  assert.equal(draft.recipient, email)
})

test("missing merchant contact yields null recipient with an explanatory note", async () => {
  const c = await assistantContext(admin)
  const deal = await dealWith({ contactPhone: undefined, contactEmail: undefined })
  const sms = await prepareMerchantDraft(c, { threadId, dealId: deal.id, channel: "sms", body: "Hi" })
  assert.equal(sms.recipient, null)
  assert.match(sms.note ?? "", /no merchant mobile number/)
  const mail = await prepareMerchantDraft(c, { threadId, dealId: deal.id, channel: "email", body: "Hi" })
  assert.equal(mail.recipient, null)
  assert.match(mail.note ?? "", /no merchant email/)
})

test("sms drafts longer than 1600 characters are rejected", async () => {
  const c = await assistantContext(admin)
  const deal = await dealWith()
  await assert.rejects(
    () =>
      prepareMerchantDraft(c, {
        threadId,
        dealId: deal.id,
        channel: "sms",
        body: "x".repeat(1601),
      }),
    (error: unknown) => error instanceof AppError && error.code === "draft_too_long"
  )
})

test("runTool handles the draft tool read-only and tracks the thread reference", async () => {
  const c = await assistantContext(admin)
  const deal = await dealWith()
  const result = await runTool(
    c,
    toolRequest.parse({
      name: "draft_merchant_message",
      threadId,
      args: { dealId: deal.id, channel: "sms", body: "Hello" },
    })
  )
  assert.equal(result.intent, "draft")
  assert.equal(result.channel, "sms")
  assert.equal(result.recipient, phone)
  const refs = await getDatabase()
    .prepare("SELECT deal_id FROM mca_chatkit_references WHERE thread_id=? AND deal_id=?")
    .all(threadId, deal.id)
  assert.equal(refs.length, 1)
})
import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { closeDatabaseForTests, getDatabase, newId } from "../src/lib/mca/db"
import { encryptSensitive } from "../src/lib/mca/crypto"
import { createDeal } from "../src/lib/mca/deals/service"
import type { DealActor } from "../src/lib/mca/deals/schema"
import { normalizeEin } from "../src/lib/mca/merchants/normalize"
import { einLookupHash } from "../src/lib/mca/merchants/lookup-hash"
import { lookupMerchants } from "../src/lib/mca/merchants/service"
import { backfillMerchantHashes } from "../src/lib/mca/merchants/backfill"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"

let testDatabase: Awaited<ReturnType<typeof createPostgresTestDatabase>>

const workspaceId = "workspace-merchants"
const actor = (overrides: Partial<DealActor> = {}): DealActor => ({
  workspaceId,
  userId: "merchant-admin",
  membershipId: "merchant-admin-member",
  role: "admin",
  managedMembershipIds: [],
  activeMembershipIds: ["merchant-admin-member"],
  source: "user",
  correlationId: "corr-merchants",
  ...overrides,
})

async function addWorkspace(id: string) {
  const now = new Date().toISOString()
  await getDatabase().prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
    VALUES (?, ?, 'America/New_York', 5, ?, ?, ?, ?, ?)`).run(
    id, id,
    JSON.stringify({ reports: true, payments: true, integrations: true }),
    JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true }),
    JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true }),
    now, now,
  )
}

let dealCounter = 0
function nextKey(label: string): string {
  dealCounter += 1
  return `${label}-${dealCounter}`
}

before(async () => {
  testDatabase = await createPostgresTestDatabase("merchants_lookup")
  process.env.DATABASE_URL = testDatabase.databaseUrl
  await addWorkspace(workspaceId)
  await addWorkspace("workspace-merchants-other")
  const now = new Date().toISOString()
  await getDatabase().prepare(`INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at)
    VALUES ('merchant-admin','merchant-admin@example.test',NULL,'Merchant Admin',NULL,'MERCH-ADMIN',?,?)`).run(now, now)
  await getDatabase().prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,manager_membership_id,status,sender_association,created_at,updated_at)
    VALUES ('merchant-admin-member', ?, 'merchant-admin', 'admin', NULL, 'active', NULL, ?, ?)`).run(workspaceId, now, now)
})

after(async () => {
  await closeDatabaseForTests()
  await testDatabase.close()
})

test("normalizeEin strips dashes and rejects non-9-digit values", () => {
  assert.equal(normalizeEin("12-3456789"), "123456789")
  assert.equal(normalizeEin("123456789"), "123456789")
  assert.equal(normalizeEin("12-345"), undefined)
})

test("AES ciphertext is not used as the query key", () => {
  const a = einLookupHash(workspaceId, "123456789")
  const b = einLookupHash(workspaceId, "12-3456789")
  assert.equal(a, b)
  assert.equal(typeof a, "string")
  assert.notEqual(encryptSensitive("123456789", workspaceId), encryptSensitive("123456789", workspaceId))
})

test("lookup by EIN finds existing merchant after create", async () => {
  await createDeal(actor(), { idempotencyKey: nextKey("acme"), legalName: "Acme LLC", ein: "12-3456789" })
  const found = await lookupMerchants(actor(), { ein: "123456789" })
  assert.equal(found.matches[0].legalName, "Acme LLC")
  assert.equal(found.matches[0].match, "ein")
})

test("lookup by owner last4 matches a merchant with a different EIN", async () => {
  await createDeal(actor(), {
    idempotencyKey: nextKey("last4-a"),
    legalName: "Harbor Bakery LLC",
    ein: "11-2233445",
    owners: [{ firstName: "Ada", lastName: "Cole", isPrimary: true, identityLast4: "7788" }],
  })
  await createDeal(actor(), {
    idempotencyKey: nextKey("last4-b"),
    legalName: "Pine Street LLC",
    ein: "98-7654321",
    owners: [{ firstName: "Ada", lastName: "Cole", isPrimary: true, identityLast4: "7788" }],
  })
  const found = await lookupMerchants(actor(), { owners: [{ identityLast4: "7788" }] })
  assert.equal(found.matches[0].match, "identity_last4")
  assert.ok(found.matches.some((match) => match.legalName === "Harbor Bakery LLC"))
  assert.ok(found.matches.some((match) => match.legalName === "Pine Street LLC"))
})

test("running merchant hash backfill twice does not duplicate merchants", async () => {
  const now = new Date().toISOString()
  const dealId = newId()
  const ownerId = newId()
  await getDatabase().prepare(`INSERT INTO deals
    (id, workspace_id, display_id, legal_name, ein_cipher, address_json, status, pipeline_version, draft_state,
     missing_required_json, field_sources_json, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, '{}', 'lead', 1, 'partial', '[]', '{}', 1, ?, ?)`).run(
    dealId, workspaceId, `MCA-${dealId.slice(0, 8).toUpperCase()}`, "Backfill Merchant LLC",
    encryptSensitive("55-6677889", workspaceId), now, now,
  )
  await getDatabase().prepare(`INSERT INTO deal_owners
    (id, workspace_id, deal_id, first_name, last_name, ownership_percent, is_primary, identity_last4_cipher)
    VALUES (?, ?, ?, 'Sam', 'Lee', 100, 1, ?)`).run(
    ownerId, workspaceId, dealId, encryptSensitive("3344", workspaceId),
  )

  const first = await backfillMerchantHashes({ workspaceId })
  const second = await backfillMerchantHashes({ workspaceId })
  const merchants = await getDatabase().prepare<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM mca_merchants WHERE workspace_id = ? AND legal_name = ?",
  ).get(workspaceId, "Backfill Merchant LLC")
  const deal = await getDatabase().prepare<{ ein_lookup_hash: string | null; merchant_id: string | null }>(
    "SELECT ein_lookup_hash, merchant_id FROM deals WHERE id = ?",
  ).get(dealId)
  const owner = await getDatabase().prepare<{ identity_last4_lookup_hash: string | null }>(
    "SELECT identity_last4_lookup_hash FROM deal_owners WHERE id = ?",
  ).get(ownerId)

  assert.equal(merchants?.count, 1)
  assert.ok(deal?.ein_lookup_hash)
  assert.ok(deal?.merchant_id)
  assert.ok(owner?.identity_last4_lookup_hash)
  assert.equal(first.merchantCount, second.merchantCount)
  const found = await lookupMerchants(actor(), { ein: "556677889" })
  assert.equal(found.matches[0].legalName, "Backfill Merchant LLC")
  assert.equal(found.matches[0].match, "ein")
})

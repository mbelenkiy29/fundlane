import "./helpers/business-auth"
import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { closeDatabaseForTests, getDatabase, newId } from "../src/lib/mca/db"
import { encryptSensitive, hashOpaqueToken } from "../src/lib/mca/crypto"
import { createDeal, getDealForDocument } from "../src/lib/mca/deals/service"
import type { DealActor } from "../src/lib/mca/deals/schema"
import { normalizeEin } from "../src/lib/mca/merchants/normalize"
import { einLookupHash, identityLookupHash } from "../src/lib/mca/merchants/lookup-hash"
import { lookupMerchants } from "../src/lib/mca/merchants/service"
import { findMerchantById } from "../src/lib/mca/merchants/repository"
import { backfillMerchantHashes } from "../src/lib/mca/merchants/backfill"
import { POST as lookupMerchantsPost } from "../src/app/api/mca/merchants/lookup/route"
import { GET as getMerchant } from "../src/app/api/mca/merchants/[id]/route"
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
  await getDatabase().prepare(`INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at)
    VALUES ('merchant-rep','merchant-rep@example.test',NULL,'Merchant Rep',NULL,'MERCH-REP',?,?)`).run(now, now)
  await getDatabase().prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,manager_membership_id,status,sender_association,created_at,updated_at)
    VALUES ('merchant-admin-member', ?, 'merchant-admin', 'admin', NULL, 'active', NULL, ?, ?)`).run(workspaceId, now, now)
  await getDatabase().prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,manager_membership_id,status,sender_association,created_at,updated_at)
    VALUES ('merchant-rep-member', ?, 'merchant-rep', 'rep', NULL, 'active', NULL, ?, ?)`).run(workspaceId, now, now)
  await getDatabase().prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES ('merchant-admin-session', 'merchant-admin', 'merchant-admin-member', ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run(
    hashOpaqueToken("merchant-admin-token"), now, now,
  )
  await getDatabase().prepare(`INSERT INTO api_keys
    (id,workspace_id,name,prefix,secret_hash,scopes,expires_at,last_used_at,revoked_at,rate_limit_per_minute,created_by,created_at)
    VALUES ('merchant-write-key', ?, 'write', 'mca_test', ?, ?, NULL, NULL, NULL, 60, 'merchant-admin', ?)`).run(
    workspaceId, hashOpaqueToken("mca_write-secret"), JSON.stringify(["deals:write"]), now,
  )
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

test("same EIN across workspaceIds produces different lookup hashes; same workspace is stable", () => {
  const ein = "12-3456789"
  const last4 = "7788"
  const workspaceA = "workspace-hmac-a"
  const workspaceB = "workspace-hmac-b"

  const einA1 = einLookupHash(workspaceA, ein)
  const einA2 = einLookupHash(workspaceA, ein)
  const einB = einLookupHash(workspaceB, ein)
  assert.equal(typeof einA1, "string")
  assert.equal(einA1, einA2)
  assert.notEqual(einA1, einB)

  const idA1 = identityLookupHash(workspaceA, last4)
  const idA2 = identityLookupHash(workspaceA, last4)
  const idB = identityLookupHash(workspaceB, last4)
  assert.equal(typeof idA1, "string")
  assert.equal(idA1, idA2)
  assert.notEqual(idA1, idB)
})

test("merchant hash backfill rewrites legacy unscoped hashes to workspace-scoped values", async () => {
  const { createHmac, createHash } = await import("node:crypto")
  const ein = "55-6677001"
  const last4 = "9001"
  const normalizedEin = normalizeEin(ein)!
  const key = process.env.MCA_DATA_ENCRYPTION_KEY
    ? Buffer.from(process.env.MCA_DATA_ENCRYPTION_KEY, "base64url")
    : createHash("sha256").update("mca-local-development-encryption-key").digest()
  const legacyEinHash = createHmac("sha256", key).update(`ein:${normalizedEin}`, "utf8").digest("hex")
  const legacyIdHash = createHmac("sha256", key).update(`id4:${last4}`, "utf8").digest("hex")
  const scopedEinHash = einLookupHash(workspaceId, ein)!
  const scopedIdHash = identityLookupHash(workspaceId, last4)!
  assert.notEqual(legacyEinHash, scopedEinHash)
  assert.notEqual(legacyIdHash, scopedIdHash)

  const now = new Date().toISOString()
  const dealId = newId()
  const ownerId = newId()
  const merchantId = newId()
  const merchantOwnerId = newId()
  await getDatabase().prepare(`INSERT INTO mca_merchants
    (id, workspace_id, legal_name, ein_cipher, ein_lookup_hash, address_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, '{}', ?, ?)`).run(
    merchantId, workspaceId, "Legacy Hash Merchant LLC", encryptSensitive(ein, workspaceId), legacyEinHash, now, now,
  )
  await getDatabase().prepare(`INSERT INTO mca_merchant_owners
    (id, workspace_id, merchant_id, first_name, last_name, ownership_percent, is_primary, identity_last4_cipher, identity_last4_lookup_hash)
    VALUES (?, ?, ?, 'Les', 'Hash', 100, 1, ?, ?)`).run(
    merchantOwnerId, workspaceId, merchantId, encryptSensitive(last4, workspaceId), legacyIdHash,
  )
  await getDatabase().prepare(`INSERT INTO deals
    (id, workspace_id, merchant_id, display_id, legal_name, ein_cipher, ein_lookup_hash, address_json, status, pipeline_version, draft_state,
     missing_required_json, field_sources_json, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, '{}', 'lead', 1, 'partial', '[]', '{}', 1, ?, ?)`).run(
    dealId, workspaceId, merchantId, `MCA-${dealId.slice(0, 8).toUpperCase()}`, "Legacy Hash Merchant LLC",
    encryptSensitive(ein, workspaceId), legacyEinHash, now, now,
  )
  await getDatabase().prepare(`INSERT INTO deal_owners
    (id, workspace_id, deal_id, first_name, last_name, ownership_percent, is_primary, identity_last4_cipher, identity_last4_lookup_hash)
    VALUES (?, ?, ?, 'Les', 'Hash', 100, 1, ?, ?)`).run(
    ownerId, workspaceId, dealId, encryptSensitive(last4, workspaceId), legacyIdHash,
  )

  await backfillMerchantHashes({ workspaceId })
  const deal = await getDatabase().prepare<{ ein_lookup_hash: string | null }>(
    "SELECT ein_lookup_hash FROM deals WHERE id = ?",
  ).get(dealId)
  const owner = await getDatabase().prepare<{ identity_last4_lookup_hash: string | null }>(
    "SELECT identity_last4_lookup_hash FROM deal_owners WHERE id = ?",
  ).get(ownerId)
  const merchant = await getDatabase().prepare<{ ein_lookup_hash: string | null }>(
    "SELECT ein_lookup_hash FROM mca_merchants WHERE id = ?",
  ).get(merchantId)
  const merchantOwner = await getDatabase().prepare<{ identity_last4_lookup_hash: string | null }>(
    "SELECT identity_last4_lookup_hash FROM mca_merchant_owners WHERE id = ?",
  ).get(merchantOwnerId)
  assert.equal(deal?.ein_lookup_hash, scopedEinHash)
  assert.equal(owner?.identity_last4_lookup_hash, scopedIdHash)
  assert.equal(merchant?.ein_lookup_hash, scopedEinHash)
  assert.equal(merchantOwner?.identity_last4_lookup_hash, scopedIdHash)

  await backfillMerchantHashes({ workspaceId })
  const dealAgain = await getDatabase().prepare<{ ein_lookup_hash: string | null }>(
    "SELECT ein_lookup_hash FROM deals WHERE id = ?",
  ).get(dealId)
  const merchantAgain = await getDatabase().prepare<{ ein_lookup_hash: string | null }>(
    "SELECT ein_lookup_hash FROM mca_merchants WHERE id = ?",
  ).get(merchantId)
  assert.equal(dealAgain?.ein_lookup_hash, scopedEinHash)
  assert.equal(merchantAgain?.ein_lookup_hash, scopedEinHash)
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

test("lookup by owner last4 unions merchant owners and unbackfilled deal owners", async () => {
  await createDeal(actor(), {
    idempotencyKey: nextKey("union-a"),
    legalName: "Union Merchant A",
    ein: "44-5566778",
    owners: [{ firstName: "Uma", lastName: "Able", isPrimary: true, identityLast4: "6677" }],
  })
  const now = new Date().toISOString()
  const dealId = newId()
  await getDatabase().prepare(`INSERT INTO deals
    (id, workspace_id, display_id, legal_name, ein_cipher, ein_lookup_hash, address_json, status, pipeline_version, draft_state,
     missing_required_json, field_sources_json, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, '{}', 'lead', 1, 'partial', '[]', '{}', 1, ?, ?)`).run(
    dealId, workspaceId, `MCA-${dealId.slice(0, 8).toUpperCase()}`, "Union Merchant B",
    encryptSensitive("77-8899001", workspaceId), einLookupHash(workspaceId, "778899001") ?? null, now, now,
  )
  await getDatabase().prepare(`INSERT INTO deal_owners
    (id, workspace_id, deal_id, first_name, last_name, ownership_percent, is_primary, identity_last4_cipher, identity_last4_lookup_hash)
    VALUES (?, ?, ?, 'Uma', 'Bee', 100, 1, ?, ?)`).run(
    newId(), workspaceId, dealId, encryptSensitive("6677", workspaceId), identityLookupHash(workspaceId, "6677") ?? null,
  )

  const found = await lookupMerchants(actor(), { owners: [{ identityLast4: "6677" }] })
  assert.ok(found.matches.some((match) => match.legalName === "Union Merchant A"))
  assert.ok(found.matches.some((match) => match.legalName === "Union Merchant B"))
})

test("a rep does not receive merchants whose deals they cannot see", async () => {
  const admin = actor({ activeMembershipIds: ["merchant-admin-member", "merchant-rep-member"] })
  const rep = actor({
    userId: "merchant-rep",
    membershipId: "merchant-rep-member",
    role: "rep",
    activeMembershipIds: ["merchant-rep-member"],
  })
  await createDeal(admin, {
    idempotencyKey: nextKey("hidden-linked"),
    legalName: "Hidden Merchant LLC",
    ein: "22-1113334",
    owners: [{ firstName: "Hid", lastName: "Den", isPrimary: true, identityLast4: "9911" }],
    assignments: [{ membershipId: "merchant-admin-member", kind: "originator", isPrimary: true }],
  })
  await createDeal(admin, {
    idempotencyKey: nextKey("visible-linked"),
    legalName: "Visible Merchant LLC",
    ein: "33-4445556",
    owners: [{ firstName: "Vis", lastName: "Able", isPrimary: true, identityLast4: "1122" }],
    assignments: [{ membershipId: "merchant-rep-member", kind: "originator", isPrimary: true }],
  })

  const now = new Date().toISOString()
  const hiddenDealId = newId()
  await getDatabase().prepare(`INSERT INTO deals
    (id, workspace_id, display_id, legal_name, ein_cipher, ein_lookup_hash, address_json, status, pipeline_version, draft_state,
     missing_required_json, field_sources_json, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, '{}', 'lead', 1, 'partial', '[]', '{}', 1, ?, ?)`).run(
    hiddenDealId, workspaceId, `MCA-${hiddenDealId.slice(0, 8).toUpperCase()}`, "Hidden Unlinked LLC",
    encryptSensitive("66-7778889", workspaceId), einLookupHash(workspaceId, "667778889") ?? null, now, now,
  )
  await getDatabase().prepare(`INSERT INTO deal_owners
    (id, workspace_id, deal_id, first_name, last_name, ownership_percent, is_primary, identity_last4_cipher, identity_last4_lookup_hash)
    VALUES (?, ?, ?, 'Una', 'Linked', 100, 1, ?, ?)`).run(
    newId(), workspaceId, hiddenDealId, encryptSensitive("8833", workspaceId), identityLookupHash(workspaceId, "8833") ?? null,
  )
  await getDatabase().prepare(`INSERT INTO deal_assignments
    (id, workspace_id, deal_id, membership_id, kind, is_primary, assigned_at, assigned_by_user_id)
    VALUES (?, ?, ?, 'merchant-admin-member', 'originator', 1, ?, NULL)`).run(newId(), workspaceId, hiddenDealId, now)

  assert.equal((await lookupMerchants(rep, { ein: "221113334" })).matches.length, 0)
  assert.equal((await lookupMerchants(rep, { owners: [{ identityLast4: "9911" }] })).matches.length, 0)
  assert.equal((await lookupMerchants(rep, { ein: "667778889" })).matches.length, 0)
  assert.equal((await lookupMerchants(rep, { owners: [{ identityLast4: "8833" }] })).matches.length, 0)
  assert.equal((await getDatabase().prepare<{ merchant_id: string | null }>("SELECT merchant_id FROM deals WHERE id = ?").get(hiddenDealId))?.merchant_id, null)
  assert.equal((await lookupMerchants(rep, { ein: "334445556" })).matches[0]?.legalName, "Visible Merchant LLC")
  assert.equal((await lookupMerchants(rep, { owners: [{ identityLast4: "1122" }] })).matches[0]?.legalName, "Visible Merchant LLC")
})

test("a rep is 409'd on a hidden merchant EIN even when lookup returns no matches", async () => {
  const admin = actor({ activeMembershipIds: ["merchant-admin-member", "merchant-rep-member"] })
  const rep = actor({
    userId: "merchant-rep",
    membershipId: "merchant-rep-member",
    role: "rep",
    activeMembershipIds: ["merchant-rep-member"],
  })
  await createDeal(admin, {
    idempotencyKey: nextKey("gate-hidden"),
    legalName: "Gate Hidden LLC",
    ein: "12-1101001",
    assignments: [{ membershipId: "merchant-admin-member", kind: "originator", isPrimary: true }],
  })
  assert.equal((await lookupMerchants(rep, { ein: "12-1101001" })).matches.length, 0)
  const beforeDeals = await dealCountForEin("12-1101001")
  const beforeMerchants = await merchantCountForEin("12-1101001")
  await assert.rejects(
    () => createDeal(rep, {
      idempotencyKey: nextKey("gate-hidden-rep"),
      legalName: "Rep Should Not Exist LLC",
      ein: "12-1101001",
    }),
    (error: unknown) => {
      assert.equal(isMerchantExists(error), true)
      if (!isMerchantExists(error)) return false
      assert.equal(error.matches.every((match) => match.match === "ein"), true)
      assert.equal(error.matches.some((match) => match.legalName === "Gate Hidden LLC"), false)
      return true
    },
  )
  assert.equal(await dealCountForEin("12-1101001"), beforeDeals)
  assert.equal(await merchantCountForEin("12-1101001"), beforeMerchants)
  assert.equal((await getDatabase().prepare<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM deals WHERE workspace_id = ? AND legal_name = ?",
  ).get(workspaceId, "Rep Should Not Exist LLC"))?.count, 0)
})

function isMerchantExists(error: unknown): error is { code: string; status: number; matches: Array<{ legalName: string; match: string }> } {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && error.code === "merchant_exists"
    && "status" in error
    && error.status === 409
    && "matches" in error
    && Array.isArray(error.matches),
  )
}

async function dealCountForEin(ein: string): Promise<number> {
  const hash = einLookupHash(workspaceId, ein)
  return (await getDatabase().prepare<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM deals WHERE workspace_id = ? AND ein_lookup_hash = ?",
  ).get(workspaceId, hash))?.count ?? 0
}

async function merchantCountForEin(ein: string): Promise<number> {
  const hash = einLookupHash(workspaceId, ein)
  return (await getDatabase().prepare<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM mca_merchants WHERE workspace_id = ? AND ein_lookup_hash = ?",
  ).get(workspaceId, hash))?.count ?? 0
}

test("creating a deal with an existing EIN and no flags returns 409 and does not insert", async () => {
  await createDeal(actor(), { idempotencyKey: nextKey("dup-ein-seed"), legalName: "Blocked Merchant LLC", ein: "12-1100220" })
  const beforeDeals = await dealCountForEin("12-1100220")
  const beforeMerchants = await merchantCountForEin("12-1100220")
  await assert.rejects(
    () => createDeal(actor(), { idempotencyKey: nextKey("dup-ein-blocked"), legalName: "Should Not Exist LLC", ein: "12-1100220" }),
    (error: unknown) => {
      assert.equal(isMerchantExists(error), true)
      if (!isMerchantExists(error)) return false
      assert.equal(error.matches[0]?.legalName, "Blocked Merchant LLC")
      assert.equal(error.matches[0]?.match, "ein")
      assert.equal(error.matches.every((match) => match.match === "ein"), true)
      return true
    },
  )
  assert.equal(await dealCountForEin("12-1100220"), beforeDeals)
  assert.equal(await merchantCountForEin("12-1100220"), beforeMerchants)
  assert.equal((await getDatabase().prepare<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM deals WHERE workspace_id = ? AND legal_name = ?",
  ).get(workspaceId, "Should Not Exist LLC"))?.count, 0)
})

test("attachMerchantId creates a new deal on the same merchant and copies omitted contact/owners", async () => {
  const first = await createDeal(actor(), {
    idempotencyKey: nextKey("attach-src"),
    legalName: "Attach Source LLC",
    ein: "12-1100660",
    contactName: "Pat Source",
    contactEmail: "pat@example.test",
    contactPhone: "2125550100",
    owners: [{ firstName: "Pat", lastName: "Source", isPrimary: true, identityLast4: "3210" }],
  })
  assert.ok(first.deal.merchantId)
  const attached = await createDeal(actor(), {
    idempotencyKey: nextKey("attach-new"),
    attachMerchantId: first.deal.merchantId,
  })
  assert.notEqual(attached.deal.id, first.deal.id)
  assert.equal(attached.deal.merchantId, first.deal.merchantId)
  assert.equal(attached.deal.legalName, "Attach Source LLC")
  const full = await getDealForDocument(actor(), attached.deal.id)
  assert.equal(full.merchantId, first.deal.merchantId)
  assert.equal(full.contactName, "Pat Source")
  assert.equal(full.contactEmail, "pat@example.test")
  assert.equal(full.contactPhone, "2125550100")
  assert.equal(full.owners[0]?.firstName, "Pat")
  assert.equal(full.owners[0]?.lastName, "Source")
  assert.equal(full.owners[0]?.identityLast4, "3210")
})

test("attach with a different EIN does not rewrite the original merchant identity", async () => {
  const first = await createDeal(actor(), {
    idempotencyKey: nextKey("attach-keep-src"),
    legalName: "Keep Identity LLC",
    ein: "12-1199001",
    contactName: "Kim Keep",
    owners: [{ firstName: "Kim", lastName: "Keep", isPrimary: true, identityLast4: "1111" }],
  })
  const merchantId = first.deal.merchantId
  assert.ok(merchantId)
  const attached = await createDeal(actor(), {
    idempotencyKey: nextKey("attach-keep-new"),
    attachMerchantId: merchantId,
    legalName: "Rewrite Attempt LLC",
    ein: "12-1199002",
    contactName: "Other Contact",
    owners: [{ firstName: "Oth", lastName: "Er", isPrimary: true, identityLast4: "2222" }],
  })
  assert.notEqual(attached.deal.id, first.deal.id)
  assert.equal(attached.deal.merchantId, merchantId)
  const full = await getDealForDocument(actor(), attached.deal.id)
  assert.equal(full.legalName, "Rewrite Attempt LLC")
  assert.equal(full.ein, "12-1199002")
  assert.equal(full.contactName, "Other Contact")
  assert.equal(full.owners[0]?.identityLast4, "2222")
  const merchant = await findMerchantById(workspaceId, merchantId)
  assert.equal(merchant?.legalName, "Keep Identity LLC")
  assert.equal(merchant?.ein, "12-1199001")
  assert.equal(merchant?.contactName, "Kim Keep")
  assert.equal(merchant?.owners[0]?.firstName, "Kim")
  assert.equal(merchant?.owners[0]?.identityLast4, "1111")
})

test("forceDuplicate inserts a new merchant even when the EIN hash collides", async () => {
  const first = await createDeal(actor(), {
    idempotencyKey: nextKey("force-one"),
    legalName: "Force One LLC",
    ein: "12-1100110",
  })
  const second = await createDeal(actor(), {
    idempotencyKey: nextKey("force-two"),
    legalName: "Force Two LLC",
    ein: "12-1100110",
    forceDuplicate: true,
  })
  assert.notEqual(second.deal.id, first.deal.id)
  assert.notEqual(second.deal.merchantId, first.deal.merchantId)
  assert.equal(await dealCountForEin("12-1100110"), 2)
  assert.equal(await merchantCountForEin("12-1100110"), 2)
})

test("owner last4 matches do not 409 create and are returned as lookup-only plus create warnings", async () => {
  await createDeal(actor(), {
    idempotencyKey: nextKey("last4-warn-a"),
    legalName: "Last4 Existing LLC",
    ein: "12-1100770",
    owners: [{ firstName: "Lee", lastName: "Four", isPrimary: true, identityLast4: "4455" }],
  })
  const lookup = await lookupMerchants(actor(), { owners: [{ identityLast4: "4455" }] })
  assert.ok(lookup.matches.some((match) => match.match === "identity_last4" && match.legalName === "Last4 Existing LLC"))
  const second = await createDeal(actor(), {
    idempotencyKey: nextKey("last4-warn-b"),
    legalName: "Last4 New Ein LLC",
    ein: "12-1100880",
    owners: [{ firstName: "Lee", lastName: "Four", isPrimary: true, identityLast4: "4455" }],
  })
  assert.equal(second.deal.legalName, "Last4 New Ein LLC")
  assert.notEqual(second.deal.merchantId, lookup.matches[0]?.merchantId)
  assert.ok(second.warnings.some((warning) => warning.includes("Last4 Existing LLC")))
})

function lookupRequest(body: unknown, init: { cookie?: string; bearer?: string; origin?: string } = {}) {
  return new Request("http://localhost/api/mca/merchants/lookup", {
    method: "POST",
    headers: {
      origin: init.origin ?? "http://localhost",
      "content-type": "application/json",
      ...(init.cookie ? { cookie: `mca_session=${init.cookie}` } : {}),
      ...(init.bearer ? { authorization: `Bearer mca_${init.bearer}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

function merchantRequest(id: string, init: { cookie?: string; bearer?: string } = {}) {
  return new Request(`http://localhost/api/mca/merchants/${id}`, {
    headers: {
      ...(init.cookie ? { cookie: `mca_session=${init.cookie}` } : {}),
      ...(init.bearer ? { authorization: `Bearer mca_${init.bearer}` } : {}),
    },
  })
}

test("GET /api/mca/merchants/:id returns attach fields for deals:read actors", async () => {
  const created = await createDeal(actor(), {
    idempotencyKey: nextKey("attach-http"),
    legalName: "Attach Http LLC",
    ein: "12-1100330",
    contactName: "Ada Attach",
    contactEmail: "ada@example.test",
    owners: [{ firstName: "Ada", lastName: "Attach", isPrimary: true, identityLast4: "5566" }],
  })
  if (!created.deal.merchantId) throw new Error("expected merchant id")
  const merchantId = created.deal.merchantId
  const context = { params: Promise.resolve({ id: merchantId }) }

  const unauth = await getMerchant(merchantRequest(merchantId), context)
  assert.equal(unauth.status, 401)

  const now = new Date().toISOString()
  await getDatabase().prepare(`INSERT INTO api_keys
    (id,workspace_id,name,prefix,secret_hash,scopes,expires_at,last_used_at,revoked_at,rate_limit_per_minute,created_by,created_at)
    VALUES ('merchant-read-key', ?, 'read', 'mca_test', ?, ?, NULL, NULL, NULL, 60, 'merchant-admin', ?)`).run(
    workspaceId, hashOpaqueToken("mca_read-secret"), JSON.stringify(["deals:read"]), now,
  )

  const sessionRes = await getMerchant(merchantRequest(merchantId, { cookie: "merchant-admin-token" }), context)
  assert.equal(sessionRes.status, 200)
  assert.equal(sessionRes.headers.get("cache-control"), "no-store")
  const sessionBody = await sessionRes.json() as {
    merchantId: string
    fields: { legalName?: string; ein?: string; contactName?: string; owners?: Array<{ identityLast4?: string }> }
    documentSummaries: unknown[]
  }
  assert.equal(sessionBody.merchantId, merchantId)
  assert.equal(sessionBody.fields.legalName, "Attach Http LLC")
  assert.equal(sessionBody.fields.ein, "12-1100330")
  assert.equal(sessionBody.fields.contactName, "Ada Attach")
  assert.equal(sessionBody.fields.owners?.[0]?.identityLast4, "5566")
  assert.equal(Array.isArray(sessionBody.documentSummaries), true)

  const readRes = await getMerchant(merchantRequest(merchantId, { bearer: "read-secret" }), context)
  assert.equal(readRes.status, 200)
  const missing = await getMerchant(merchantRequest("missing-merchant", { cookie: "merchant-admin-token" }), { params: Promise.resolve({ id: "missing-merchant" }) })
  assert.equal(missing.status, 404)
})

test("GET /api/mca/merchants/:id hides merchants a rep cannot see", async () => {
  const created = await createDeal(actor(), {
    idempotencyKey: nextKey("attach-hidden-http"),
    legalName: "Hidden Attach Http LLC",
    ein: "12-1100440",
    assignments: [{ membershipId: "merchant-admin-member", kind: "originator", isPrimary: true }],
  })
  if (!created.deal.merchantId) throw new Error("expected merchant id")
  const now = new Date().toISOString()
  await getDatabase().prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES ('merchant-rep-session', 'merchant-rep', 'merchant-rep-member', ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run(
    hashOpaqueToken("merchant-rep-token"), now, now,
  )
  const hidden = await getMerchant(
    merchantRequest(created.deal.merchantId, { cookie: "merchant-rep-token" }),
    { params: Promise.resolve({ id: created.deal.merchantId }) },
  )
  assert.equal(hidden.status, 404)
})

test("POST /api/mca/merchants/lookup returns matches for session and deals:write actors", async () => {
  await createDeal(actor(), { idempotencyKey: nextKey("http-ein"), legalName: "Http Lookup LLC", ein: "12-1100990" })
  const unauth = await lookupMerchantsPost(lookupRequest({ ein: "12-1100990" }))
  assert.equal(unauth.status, 401)

  const sessionRes = await lookupMerchantsPost(lookupRequest({ ein: "12-1100990" }, { cookie: "merchant-admin-token" }))
  assert.equal(sessionRes.status, 200)
  assert.equal(sessionRes.headers.get("cache-control"), "no-store")
  const sessionBody = await sessionRes.json() as { matches: Array<{ legalName: string; match: string }> }
  assert.equal(sessionBody.matches[0]?.legalName, "Http Lookup LLC")
  assert.equal(sessionBody.matches[0]?.match, "ein")

  const writeRes = await lookupMerchantsPost(lookupRequest({ ein: "121100990" }, { bearer: "write-secret" }))
  assert.equal(writeRes.status, 200)
  const writeBody = await writeRes.json() as { matches: Array<{ legalName: string; match: string }> }
  assert.equal(writeBody.matches[0]?.legalName, "Http Lookup LLC")
})

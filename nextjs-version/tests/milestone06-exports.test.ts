import "./helpers/business-auth";
import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { hashOpaqueToken } from "../src/lib/mca/crypto"
import { AppError } from "../src/lib/mca/errors"
import type { DealActor } from "../src/lib/mca/deals/schema"
import { createDeal, listDeals } from "../src/lib/mca/deals/service"
import { createOffer, selectOfferRevision } from "../src/lib/mca/offers/service"
import { confirmOfferFunding } from "../src/lib/mca/funding/service"
import { csvEscape, parseCsvRowCount } from "../src/lib/mca/exports/csv"
import { EXPORT_PANEL_COPY, PAYMENT_EXPORT_DENIED_KEYS } from "../src/lib/mca/exports/contracts"
import { FIELD_MANIFESTS } from "../src/lib/mca/exports/manifests"
import { exportPanelView } from "../src/lib/mca/exports/panel-state"
import {
  createExportJob,
  getExportCapabilities,
  listExportJobs,
  mintExportDownload,
  processExportJob,
  redeemExportDownload,
} from "../src/lib/mca/exports/service"
import { GET as listGet, POST as listPost } from "../src/app/api/mca/exports/route"
import { GET as jobGet } from "../src/app/api/mca/exports/[id]/route"
import { POST as processPost } from "../src/app/api/mca/exports/[id]/process/route"
import { POST as tokenPost } from "../src/app/api/mca/exports/[id]/token/route"
import { GET as downloadGet } from "../src/app/api/mca/exports/download/[token]/route"

let fixture: Awaited<ReturnType<typeof createPostgresTestDatabase>>

const ids = {
  workspace: "ws-exports",
  otherWorkspace: "ws-exports-other",
  adminUser: "user-export-admin",
  adminMember: "member-export-admin",
  managerUser: "user-export-manager",
  managerMember: "member-export-manager",
  repUser: "user-export-rep",
  repMember: "member-export-rep",
  outsiderUser: "user-export-outsider",
  outsiderMember: "member-export-outsider",
  otherUser: "user-export-other",
  otherMember: "member-export-other",
}

const now = "2026-03-04T12:00:00.000Z"
const IDENTITY = "4321"
const FORMULA_NAME = "=2+3"
const OWNER_FORMULA = "=1+2"
const TOKEN_SECRET = "export-secret"
const READ_SECRET = "read-secret"

const admin: DealActor = {
  workspaceId: ids.workspace, userId: ids.adminUser, membershipId: ids.adminMember, role: "admin",
  managedMembershipIds: [], activeMembershipIds: [ids.adminMember, ids.managerMember, ids.repMember, ids.outsiderMember],
  source: "user", correlationId: "corr-export-admin",
}
const manager: DealActor = {
  ...admin, userId: ids.managerUser, membershipId: ids.managerMember, role: "manager",
  managedMembershipIds: [ids.repMember], correlationId: "corr-export-manager",
}
const rep: DealActor = {
  ...admin, userId: ids.repUser, membershipId: ids.repMember, role: "rep",
  managedMembershipIds: [], correlationId: "corr-export-rep",
}
const outsider: DealActor = {
  ...admin, userId: ids.outsiderUser, membershipId: ids.outsiderMember, role: "rep",
  managedMembershipIds: [], correlationId: "corr-export-outsider",
}
const otherAdmin: DealActor = {
  workspaceId: ids.otherWorkspace, userId: ids.otherUser, membershipId: ids.otherMember, role: "admin",
  managedMembershipIds: [], activeMembershipIds: [ids.otherMember], source: "user", correlationId: "corr-export-other",
}

const seeded = {
  visibleDealId: "",
  hiddenDealId: "",
  fundedDealId: "",
  otherDealId: "",
  visibleOfferId: "",
  hiddenOfferId: "",
  paymentIds: [] as string[],
}

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

function params(value: string, key: "id" | "token" = "id") {
  return { params: Promise.resolve({ [key]: value }) as Promise<{ id: string; token: string }> }
}

async function seed() {
  const db = getDatabase()
  const visibility = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true })
  const actions = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true })
  const flags = JSON.stringify({ reports: true, payments: true, integrations: true })
  for (const [id, name] of [[ids.workspace, "Export Test"], [ids.otherWorkspace, "Other Export"]] as const) {
    await db.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
      VALUES (?, ?, 'America/New_York', 8, ?, ?, ?, ?, ?)`).run(id, name, flags, visibility, actions, now, now)
  }
  for (const [userId, memberId, email, workspaceId, role, managerId] of [
    [ids.adminUser, ids.adminMember, "export-admin@example.test", ids.workspace, "admin", null],
    [ids.managerUser, ids.managerMember, "export-manager@example.test", ids.workspace, "manager", null],
    [ids.repUser, ids.repMember, "export-rep@example.test", ids.workspace, "rep", ids.managerMember],
    [ids.outsiderUser, ids.outsiderMember, "export-outsider@example.test", ids.workspace, "rep", null],
    [ids.otherUser, ids.otherMember, "export-other@example.test", ids.otherWorkspace, "admin", null],
  ] as const) {
    await db.prepare(`INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at)
      VALUES (?, ?, NULL, ?, NULL, ?, ?, ?)`).run(userId, email, email, `APP-${userId.slice(-6)}`, now, now)
    await db.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,manager_membership_id,status,sender_association,created_at,updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', NULL, ?, ?)`).run(memberId, workspaceId, userId, role, managerId, now, now)
  }
  await db.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("export-admin-session", ids.adminUser, ids.adminMember, hashOpaqueToken("admin-session-token"), now, now)
  await db.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("export-rep-session", ids.repUser, ids.repMember, hashOpaqueToken("rep-session-token"), now, now)
  await db.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("export-other-session", ids.otherUser, ids.otherMember, hashOpaqueToken("other-session-token"), now, now)
  await db.prepare(`INSERT INTO api_keys
    (id,workspace_id,name,prefix,secret_hash,scopes,expires_at,last_used_at,revoked_at,rate_limit_per_minute,created_by,created_at)
    VALUES (?, ?, 'export', 'mca_test', ?, ?, NULL, NULL, NULL, 60, ?, ?)`).run("export-key", ids.workspace, hashOpaqueToken(`mca_${TOKEN_SECRET}`), JSON.stringify(["deals:export"]), ids.adminUser, now)
  await db.prepare(`INSERT INTO api_keys
    (id,workspace_id,name,prefix,secret_hash,scopes,expires_at,last_used_at,revoked_at,rate_limit_per_minute,created_by,created_at)
    VALUES (?, ?, 'read', 'mca_test', ?, ?, NULL, NULL, NULL, 60, ?, ?)`).run("read-key", ids.workspace, hashOpaqueToken(`mca_${READ_SECRET}`), JSON.stringify(["deals:read"]), ids.adminUser, now)

  const visible = await createDeal(admin, {
    idempotencyKey: "export-visible",
    legalName: FORMULA_NAME,
    dbaName: "+cmd",
    ein: "12-3456789",
    entityType: "llc",
    contactName: "@SUM(1,1)",
    contactEmail: "merchant@harbor.test",
    contactPhone: "2125550199",
    fundingPurpose: "-total()",
    requestedAmount: 75000,
    monthlyRevenue: 40000,
    owners: [{ firstName: OWNER_FORMULA, lastName: "Harbor", ownershipPercent: 100, isPrimary: true, identityLast4: IDENTITY, email: "ari@harbor.test", dateOfBirth: "1988-04-03" }],
    assignments: [{ membershipId: ids.repMember, kind: "originator", isPrimary: true }],
  })
  const hidden = await createDeal(admin, {
    idempotencyKey: "export-hidden",
    legalName: "Hidden Admin Merchant",
    requestedAmount: 120000,
    assignments: [{ membershipId: ids.adminMember, kind: "originator", isPrimary: true }],
  })
  const funded = await createDeal(admin, {
    idempotencyKey: "export-funded",
    legalName: "Funded Merchant LLC",
    requestedAmount: 90000,
    assignments: [{ membershipId: ids.adminMember, kind: "originator", isPrimary: true }],
  })
  const other = await createDeal(otherAdmin, {
    idempotencyKey: "export-other",
    legalName: "Other Workspace Merchant",
    assignments: [{ membershipId: ids.otherMember, kind: "originator", isPrimary: true }],
  })
  seeded.visibleDealId = visible.deal.id
  seeded.hiddenDealId = hidden.deal.id
  seeded.fundedDealId = funded.deal.id
  seeded.otherDealId = other.deal.id

  const visibleOffer = await createOffer(admin, {
    dealId: visible.deal.id, funderName: "Northstar Capital", externalId: "export-offer-visible",
    terms: { product: "MCA", amountCents: 5_000_000, factorRate: 1.35, termMonths: 8, paymentAmountCents: 37_500, paymentFrequency: "daily", commissionCents: 400_000, buyRate: 1.2, feeCents: 10_000 },
  })
  const hiddenOffer = await createOffer(admin, {
    dealId: hidden.deal.id, funderName: "Quiet Capital", externalId: "export-offer-hidden",
    terms: { amountCents: 8_000_000, commissionCents: 700_000, buyRate: 1.1 },
  })
  seeded.visibleOfferId = visibleOffer.id
  seeded.hiddenOfferId = hiddenOffer.id

  const fundedOffer = await createOffer(admin, {
    dealId: funded.deal.id, funderName: "Summit Funding", externalId: "export-offer-funded",
    terms: { amountCents: 6_000_000, factorRate: 1.28, termMonths: 10, paymentAmountCents: 40_000, paymentFrequency: "weekly", commissionCents: 480_000 },
  })
  await selectOfferRevision(admin, { dealId: funded.deal.id, offerId: fundedOffer.id, revisionId: fundedOffer.currentRevisionId, selected: true })
  const funding = await confirmOfferFunding(admin, {
    dealId: funded.deal.id, offerId: fundedOffer.id, offerRevisionId: fundedOffer.currentRevisionId,
    idempotencyKey: "export-fund-1", fundedAt: "2026-03-01",
    splits: [{ recipientMembershipId: ids.adminMember, percentageBasisPoints: 10000 }],
  })
  seeded.paymentIds = (await db.prepare<{ id: string }>("SELECT id FROM mca_accounting_payments WHERE workspace_id = ?").all(ids.workspace)).map((row) => row.id)
  assert.ok(seeded.paymentIds.length > 0)
  assert.equal(funding.state, "committed")
}

before(async () => {
  fixture = await createPostgresTestDatabase("milestone06_exports")
  Object.assign(process.env, fixture.env())
  await seed()
})

after(async () => {
  await closeDatabaseForTests()
  await fixture.close()
})

test("MIC-100: formula text is inert and identifier strings stay text", () => {
  assert.equal(csvEscape("=2+3"), "'=2+3")
  assert.equal(csvEscape("+cmd"), "'+cmd")
  assert.equal(csvEscape("-total()"), "'-total()")
  assert.equal(csvEscape("@SUM(1,1)"), "\"'@SUM(1,1)\"")
  assert.equal(csvEscape("\t=1+1"), "'\t=1+1")
  assert.equal(csvEscape("\r=1+1"), "\"'\r=1+1\"")
  const id = "550e8400-e29b-41d4-a716-446655440000"
  const escaped = csvEscape(id, { identifier: true })
  assert.equal(escaped.includes(id), true)
  assert.equal(escaped.startsWith("'\t") || escaped.includes("'\t"), true)
  assert.equal(Number.isNaN(Number(escaped.replace(/['"\t]/g, ""))), true)
})

test("MIC-100: field manifests omit payment and ledger keys", () => {
  for (const manifest of Object.values(FIELD_MANIFESTS)) {
    assert.equal(manifest.isPaymentExport, false)
    const keys = new Set(manifest.fields.map((field) => field.key))
    for (const denied of PAYMENT_EXPORT_DENIED_KEYS) assert.equal(keys.has(denied), false)
  }
})

test("MIC-100: export panel states cover loading, empty, validation, success and failure", () => {
  assert.equal(exportPanelView({ loading: true }).status, "loading")
  assert.equal(exportPanelView({ loading: true }).message, EXPORT_PANEL_COPY.loading)
  assert.equal(exportPanelView({ loading: false, capabilities: { exportEnabled: false, roleScoped: false, workspace: false, kinds: [], isPaymentExport: false, asyncThreshold: 250 } }).status, "disabled")
  assert.equal(exportPanelView({ loading: false, capabilities: { exportEnabled: true, roleScoped: true, workspace: false, kinds: ["deals"], isPaymentExport: false, asyncThreshold: 250 } }).status, "empty")
  assert.equal(exportPanelView({ loading: false, fieldErrors: { kind: ["Choose a supported export kind."] }, jobs: [] }).status, "validation")
  assert.equal(exportPanelView({
    loading: false,
    jobs: [{ id: "1", kind: "deals", kindLabel: "Visible deals", state: "queued", rowCount: 1, checksum: null, filename: "x.csv", fieldManifest: [], isPaymentExport: false, replayed: false, createdAt: now, updatedAt: now, correlationId: "a" }],
  }).status, "queued")
  assert.equal(exportPanelView({
    loading: false,
    jobs: [{ id: "1", kind: "deals", kindLabel: "Visible deals", state: "failed", rowCount: 1, checksum: null, filename: "x.csv", fieldManifest: [], isPaymentExport: false, replayed: false, createdAt: now, updatedAt: now, correlationId: "a" }],
  }).status, "failed")
  assert.equal(exportPanelView({
    loading: false,
    jobs: [{ id: "1", kind: "deals", kindLabel: "Visible deals", state: "ready", rowCount: 1, checksum: "abc", filename: "x.csv", fieldManifest: [], isPaymentExport: false, replayed: false, createdAt: now, updatedAt: now, correlationId: "a" }],
  }).status, "ready")
})

test("MIC-100: a rep export contains only visible records and allowed fields", async () => {
  const listed = await listDeals(rep, {})
  const created = await createExportJob(rep, { kind: "deals", correlationId: "rep-deals-1" })
  assert.equal(created.job.state, "ready")
  assert.equal(created.job.isPaymentExport, false)
  assert.equal(created.job.rowCount, listed.total)
  assert.equal(listed.deals.some((deal) => deal.id === seeded.visibleDealId), true)
  assert.equal(listed.deals.some((deal) => deal.id === seeded.hiddenDealId), false)
  assert.ok(created.download)
  const token = created.download.url.split("/").pop() ?? ""
  const file = await redeemExportDownload(rep, token)
  assert.equal(parseCsvRowCount(file.csv), listed.total)
  assert.match(file.csv, /'=2\+3/)
  assert.match(file.csv, /'\+cmd/)
  assert.match(file.csv, /'@SUM\(1,1\)/)
  assert.equal(file.csv.includes(IDENTITY), false)
  assert.equal(file.csv.includes("ari@harbor.test"), false)
  assert.equal(file.csv.includes("Hidden Admin Merchant"), false)
  assert.equal(file.csv.includes("Other Workspace Merchant"), false)
  assert.equal(file.csv.includes(seeded.visibleDealId) && file.csv.includes(`'\t${seeded.visibleDealId}`), true)
  for (const denied of ["commissionCents", "buyRate", "accountingRecordIds", "ledger"]) {
    assert.equal(file.csv.includes(denied), false)
  }
  for (const paymentId of seeded.paymentIds) assert.equal(file.csv.includes(paymentId), false)

  const offers = await createExportJob(rep, { kind: "offers", correlationId: "rep-offers-1" })
  const offerFile = await redeemExportDownload(rep, offers.download!.url.split("/").pop() ?? "")
  assert.equal(offerFile.csv.includes(seeded.visibleOfferId) && offerFile.csv.includes(`'\t${seeded.visibleOfferId}`), true)
  assert.equal(offerFile.csv.includes(seeded.hiddenOfferId), false)
  assert.equal(offerFile.csv.includes("400000"), false)
  assert.equal(offerFile.csv.includes("commission"), false)
  assert.match(offerFile.csv, /Northstar Capital/)

  await assert.rejects(
    () => createExportJob(rep, { kind: "all_deals_owners", correlationId: "rep-owners-denied" }),
    (error: unknown) => error instanceof AppError && error.code === "permission_denied",
  )
  await assert.rejects(
    () => createExportJob(rep, { kind: "funded_deals", correlationId: "rep-funded-denied" }),
    (error: unknown) => error instanceof AppError && error.code === "permission_denied",
  )
  assert.deepEqual((await getExportCapabilities(rep)).kinds, ["deals", "offers"])
  assert.equal((await listExportJobs(outsider)).jobs.some((job) => job.id === created.job.id), false)
})

test("MIC-100: manager visibility matches the Deals screen originator hierarchy", async () => {
  const listed = await listDeals(manager, {})
  const created = await createExportJob(manager, { kind: "deals", correlationId: "manager-deals-1" })
  const file = await redeemExportDownload(manager, created.download!.url.split("/").pop() ?? "")
  assert.equal(created.job.rowCount, listed.total)
  assert.equal(file.csv.includes(FORMULA_NAME) || file.csv.includes("'=2+3"), true)
  assert.equal(file.csv.includes("Hidden Admin Merchant"), false)
})

test("MIC-100: admin all-deals-and-owners and funded-deals use the explicit field manifest", async () => {
  const owners = await createExportJob(admin, { kind: "all_deals_owners", correlationId: "admin-owners-1" })
  const ownersFile = await redeemExportDownload(admin, owners.download!.url.split("/").pop() ?? "")
  assert.ok((owners.job.rowCount ?? 0) >= 3)
  assert.match(ownersFile.csv, /Company name/)
  assert.match(ownersFile.csv, /Owner 1 identity last 4/)
  assert.match(ownersFile.csv, /'=2\+3/)
  assert.match(ownersFile.csv, /'=1\+2/)
  assert.match(ownersFile.csv, /'-total\(\)/)
  assert.equal(ownersFile.csv.includes(IDENTITY), true)
  assert.equal(ownersFile.csv.includes("12-3456789"), true)
  assert.equal(ownersFile.csv.includes("Hidden Admin Merchant"), true)
  assert.equal(ownersFile.csv.includes("Other Workspace Merchant"), false)
  assert.equal(ownersFile.csv.includes("commission"), false)
  for (const paymentId of seeded.paymentIds) assert.equal(ownersFile.csv.includes(paymentId), false)

  const funded = await createExportJob(admin, { kind: "funded_deals", correlationId: "admin-funded-1" })
  const fundedFile = await redeemExportDownload(admin, funded.download!.url.split("/").pop() ?? "")
  assert.equal(funded.job.rowCount, 1)
  assert.match(fundedFile.csv, /Funded Merchant LLC/)
  assert.match(fundedFile.csv, /Summit Funding/)
  assert.equal(fundedFile.csv.includes("Hidden Admin Merchant"), false)
  assert.equal(fundedFile.csv.includes("commission"), false)
  assert.equal(fundedFile.csv.includes("accounting"), false)
  for (const paymentId of seeded.paymentIds) assert.equal(fundedFile.csv.includes(paymentId), false)
})

test("MIC-100: large exports are asynchronous, retries preserve job identity, and downloads expire", async () => {
  const queued = await createExportJob(admin, { kind: "deals", correlationId: "async-deals-1", async: true })
  assert.equal(queued.job.state, "queued")
  assert.equal(queued.download, null)
  const replay = await createExportJob(admin, { kind: "deals", correlationId: "async-deals-1", async: true })
  assert.equal(replay.job.id, queued.job.id)
  assert.equal(replay.job.replayed, true)
  const processed = await processExportJob(admin, queued.job.id)
  assert.equal(processed.id, queued.job.id)
  assert.equal(processed.state, "ready")
  assert.equal(processed.rowCount, (await listDeals(admin, {})).total)
  const again = await processExportJob(admin, queued.job.id)
  assert.equal(again.id, queued.job.id)
  assert.equal(again.checksum, processed.checksum)

  const empty = await createExportJob(admin, { kind: "deals", correlationId: "empty-closed", filters: { statuses: ["closed"] } })
  assert.equal(empty.job.rowCount, 0)
  assert.equal(empty.job.state, "ready")
  const emptyFile = await redeemExportDownload(admin, empty.download!.url.split("/").pop() ?? "")
  assert.equal(parseCsvRowCount(emptyFile.csv), 0)
  assert.match(emptyFile.csv, /Legal name/)

  const minted = await mintExportDownload(admin, processed.id, { ttlMs: 1000, nowIso: "2026-01-01T00:00:00.000Z" })
  const expiredToken = minted.url.split("/").pop() ?? ""
  await assert.rejects(
    () => redeemExportDownload(admin, expiredToken, { nowIso: "2026-01-01T00:00:02.000Z" }),
    (error: unknown) => error instanceof AppError && error.code === "export_download_expired",
  )
  const foreignToken = (await mintExportDownload(admin, processed.id)).url.split("/").pop() ?? ""
  await assert.rejects(
    () => redeemExportDownload(otherAdmin, foreignToken),
    (error: unknown) => error instanceof AppError && error.code === "export_download_not_found",
  )
})

test("MIC-100: direct API requests match UI permissions and audits omit secrets", async () => {
  const unauth = await listGet(new Request("http://localhost/api/mca/exports"))
  assert.equal(unauth.status, 401)

  const readDenied = await listPost(bearerRequest("/api/mca/exports", READ_SECRET, {
    method: "POST",
    body: JSON.stringify({ kind: "deals", correlationId: "read-key-denied" }),
  }))
  assert.equal(readDenied.status, 403)

  const repWorkspace = await listPost(cookieRequest("/api/mca/exports", "rep-session-token", {
    method: "POST",
    body: JSON.stringify({ kind: "funded_deals", correlationId: "rep-http-funded" }),
  }))
  assert.equal(repWorkspace.status, 403)
  assert.equal(((await repWorkspace.json()) as { error: { code: string } }).error.code, "permission_denied")

  const repOk = await listPost(cookieRequest("/api/mca/exports", "rep-session-token", {
    method: "POST",
    body: JSON.stringify({ kind: "deals", correlationId: "rep-http-deals" }),
  }))
  assert.equal(repOk.status, 201)
  const repBody = await repOk.json() as { job: { id: string; rowCount: number }; download: { url: string } }
  assert.equal(repBody.job.rowCount, (await listDeals(rep, {})).total)

  const listed = await listGet(cookieRequest("/api/mca/exports", "rep-session-token"))
  const listedBody = await listed.json() as { capabilities: { workspace: boolean; kinds: string[] }; jobs: Array<{ id: string }> }
  assert.equal(listed.status, 200)
  assert.equal(listedBody.capabilities.workspace, false)
  assert.deepEqual(listedBody.capabilities.kinds, ["deals", "offers"])
  assert.equal(listedBody.jobs.some((job) => job.id === repBody.job.id), true)

  const tokenRes = await tokenPost(cookieRequest(`/api/mca/exports/${repBody.job.id}/token`, "rep-session-token", {
    method: "POST",
    body: "{}",
  }), params(repBody.job.id))
  assert.equal(tokenRes.status, 200)
  const download = await tokenRes.json() as { download: { url: string } }
  const token = download.download.url.split("/").pop() ?? ""
  const file = await downloadGet(cookieRequest(download.download.url, "rep-session-token"), params(token, "token"))
  assert.equal(file.status, 200)
  assert.match(file.headers.get("content-type") ?? "", /text\/csv/)
  assert.match(file.headers.get("cache-control") ?? "", /no-store/)
  const csv = await file.text()
  assert.match(csv, /'=2\+3/)
  assert.equal(csv.includes(IDENTITY), false)

  const keyExport = await listPost(bearerRequest("/api/mca/exports", TOKEN_SECRET, {
    method: "POST",
    body: JSON.stringify({ kind: "all_deals_owners", correlationId: "key-owners" }),
  }))
  assert.equal(keyExport.status, 201)

  const otherForbidden = await jobGet(cookieRequest(`/api/mca/exports/${repBody.job.id}`, "other-session-token"), params(repBody.job.id))
  assert.equal(otherForbidden.status, 404)

  const queued = await listPost(cookieRequest("/api/mca/exports", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ kind: "offers", correlationId: "admin-async-offers", async: true }),
  }))
  const queuedBody = await queued.json() as { job: { id: string; state: string } }
  assert.equal(queuedBody.job.state, "queued")
  const processed = await processPost(cookieRequest(`/api/mca/exports/${queuedBody.job.id}/process`, "admin-session-token", {
    method: "POST",
    body: "{}",
  }), params(queuedBody.job.id))
  assert.equal(processed.status, 200)
  assert.equal(((await processed.json()) as { job: { state: string; id: string } }).job.id, queuedBody.job.id)

  await getDatabase().prepare("UPDATE workspaces SET action_visibility = ? WHERE id = ?").run(
    JSON.stringify({ createDeal: true, exportDeals: false, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true }),
    ids.workspace,
  )
  const disabled = await listPost(cookieRequest("/api/mca/exports", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ kind: "deals", correlationId: "disabled-export" }),
  }))
  assert.equal(disabled.status, 403)
  assert.equal(((await disabled.json()) as { error: { code: string } }).error.code, "action_disabled")
  await getDatabase().prepare("UPDATE workspaces SET action_visibility = ? WHERE id = ?").run(
    JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true }),
    ids.workspace,
  )

  const audits = await getDatabase().prepare<{ action: string; metadata: string; correlation_id: string }>(
    "SELECT action, metadata, correlation_id FROM audit_events WHERE workspace_id = ? AND resource_type = 'export_job'",
  ).all(ids.workspace)
  assert.ok(audits.some((row) => row.action === "export.created"))
  assert.ok(audits.some((row) => row.action === "export.downloaded"))
  const blob = JSON.stringify(audits)
  assert.equal(blob.includes(token), false)
  assert.equal(blob.includes(TOKEN_SECRET), false)
  assert.equal(blob.includes(IDENTITY), false)
  assert.equal(blob.includes("ari@harbor.test"), false)
})

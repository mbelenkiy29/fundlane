import "./helpers/business-auth";
import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { closeDatabaseForTests, getDatabase, newId } from "../src/lib/mca/db"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { hashOpaqueToken } from "../src/lib/mca/crypto"
import { AppError } from "../src/lib/mca/errors"
import type { DealActor } from "../src/lib/mca/deals/schema"
import { addDealNote, createDeal, getDeal } from "../src/lib/mca/deals/service"
import { createOffer, selectOfferRevision } from "../src/lib/mca/offers/service"
import { acceptOfferForClosing, createStipulation, recordPhonePitch, updateStipulation } from "../src/lib/mca/closing/service"
import { confirmOfferFunding } from "../src/lib/mca/funding/service"
import {
  HOME_COPY,
  HOME_SLA_HOURS,
  type HomeDealFacts,
  type HomeQueueResult,
} from "../src/lib/mca/home/contracts"
import { deriveHomeReasons } from "../src/lib/mca/home/derive"
import { homeQueueView } from "../src/lib/mca/home/panel-state"
import { getHomeDealPanel, getHomeNeedsActionQueue } from "../src/lib/mca/home/service"
import { GET as queueGet } from "../src/app/api/mca/home/needs-action/route"
import { GET as panelGet } from "../src/app/api/mca/home/needs-action/[dealId]/route"

let fixture: Awaited<ReturnType<typeof createPostgresTestDatabase>>

const now = "2026-01-15T12:00:00.000Z"
const daysAgo = (days: number) => new Date(Date.parse(now) - days * 86_400_000).toISOString()

const ids = {
  workspace: "ws-home",
  otherWorkspace: "ws-home-other",
  adminUser: "user-home-admin",
  adminMember: "member-home-admin",
  managerUser: "user-home-manager",
  managerMember: "member-home-manager",
  repUser: "user-home-rep",
  repMember: "member-home-rep",
  outsiderUser: "user-home-outsider",
  outsiderMember: "member-home-outsider",
  otherUser: "user-home-other",
  otherMember: "member-home-other",
}

const admin: DealActor = {
  workspaceId: ids.workspace, userId: ids.adminUser, membershipId: ids.adminMember, role: "admin",
  managedMembershipIds: [], activeMembershipIds: [ids.adminMember, ids.managerMember, ids.repMember, ids.outsiderMember],
  source: "user", correlationId: "corr-home-admin",
}
const manager: DealActor = {
  ...admin, userId: ids.managerUser, membershipId: ids.managerMember, role: "manager",
  managedMembershipIds: [ids.repMember], correlationId: "corr-home-manager",
}
const rep: DealActor = {
  ...admin, userId: ids.repUser, membershipId: ids.repMember, role: "rep",
  managedMembershipIds: [], correlationId: "corr-home-rep",
}
const outsider: DealActor = {
  ...admin, userId: ids.outsiderUser, membershipId: ids.outsiderMember, role: "rep",
  managedMembershipIds: [], correlationId: "corr-home-outsider",
}
const otherAdmin: DealActor = {
  workspaceId: ids.otherWorkspace, userId: ids.otherUser, membershipId: ids.otherMember, role: "admin",
  managedMembershipIds: [], activeMembershipIds: [ids.otherMember], source: "user", correlationId: "corr-home-other",
}

const seeded = {
  submitId: "",
  resubmitId: "",
  comboId: "",
  comboOfferId: "",
  comboRevisionId: "",
  comboStipId: "",
  merchantId: "",
  funderId: "",
  contractId: "",
  signatureId: "",
  repriceId: "",
  fundingId: "",
  fundingOfferId: "",
  fundingRevisionId: "",
  missingId: "",
  renewalId: "",
  hiddenId: "",
  waitingId: "",
  closedId: "",
  otherId: "",
}

function facts(overrides: Partial<HomeDealFacts> = {}): HomeDealFacts {
  return {
    dealId: "deal-1",
    displayId: "MCA-1",
    legalName: "Harbor Bakery",
    status: "offer",
    draftState: "submission_ready",
    version: 1,
    createdAt: now,
    updatedAt: now,
    statusChangedAt: now,
    assignments: [],
    offers: [],
    submissions: [],
    stipulations: [],
    contracts: [],
    fundingEvents: [],
    renewals: [],
    advances: [],
    notes: [],
    ...overrides,
  }
}

function codes(input: HomeDealFacts, clock = now) {
  return deriveHomeReasons(input, clock).map((item) => item.code)
}

function application(legalName: string, extra: Record<string, unknown> = {}) {
  return {
    legalName,
    entityType: "llc" as const,
    address: { line1: "1 Main St", city: "New York", state: "NY", postalCode: "10001" },
    contactName: "Mira Harbor",
    contactEmail: "mira@harbor.test",
    contactPhone: "2125550100",
    startDate: "2020-01-15",
    industry: "Food",
    monthlyRevenue: 40000,
    requestedAmount: 50000,
    fundingPurpose: "expansion",
    owners: [{ firstName: "Mira", lastName: "Harbor", ownershipPercent: 100, isPrimary: true }],
    ...extra,
  }
}

function cookieRequest(path: string, token: string) {
  return new Request(`http://localhost${path}`, { headers: { cookie: `mca_session=${token}`, origin: "http://localhost" } })
}

function bearerRequest(path: string, secret: string) {
  return new Request(`http://localhost${path}`, { headers: { authorization: `Bearer mca_${secret}`, origin: "http://localhost" } })
}

async function setStatus(dealId: string, status: string, at = now) {
  const db = getDatabase()
  await db.prepare("UPDATE deals SET status=?, updated_at=? WHERE id=?").run(status, at, dealId)
  await db.prepare(`INSERT INTO deal_activity
    (id, workspace_id, deal_id, action, actor_user_id, source, summary, from_status, to_status, record_version, correlation_id, created_at)
    VALUES (?, ?, ?, 'status_changed', ?, 'manual', ?, NULL, ?, 2, ?, ?)`).run(
    newId(), ids.workspace, dealId, ids.adminUser, `Status changed to ${status}`, status, "corr-home-status", at,
  )
}

async function insertSentJob(dealId: string, funder: string, sentAt: string, jobId: string) {
  const db = getDatabase()
  const funderId = `funder-${jobId}`
  await db.prepare(`INSERT INTO mca_funders
    (id, workspace_id, idempotency_key, legal_name, domains, products, active, contacts, routes, criteria_version, profile_version, created_at, updated_at)
    VALUES (?, ?, ?, ?, '[]', '[]', 1, '[]', '[]', 1, 1, ?, ?)`).run(funderId, ids.workspace, funderId, funder, sentAt, sentAt)
  await db.prepare(`INSERT INTO mca_submission_jobs
    (id, workspace_id, deal_id, funder_id, display_funder_name, route_kind, route_json, state, confirmation_key, attempt_key,
     deal_version, document_versions_json, package_json, preflight_errors_json, created_by_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'email', '{}', 'sent', ?, ?, 1, '[]', '{"documentIds":[]}', '[]', ?, ?, ?)`).run(
    jobId, ids.workspace, dealId, funderId, funder, `confirm-${jobId}`, `attempt-${jobId}`, ids.adminUser, sentAt, sentAt,
  )
  await db.prepare("INSERT INTO deal_submissions (id, workspace_id, deal_id, funder_name, status, funder_id, job_id, route_kind) VALUES (?, ?, ?, ?, 'sent', ?, ?, 'email')")
    .run(`sub-${jobId}`, ids.workspace, dealId, funder, funderId, jobId)
}

async function seed() {
  const db = getDatabase()
  const visibility = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true })
  const actions = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true })
  const flags = JSON.stringify({ reports: true, payments: true, integrations: true })
  for (const [id, name] of [[ids.workspace, "Home Test"], [ids.otherWorkspace, "Other Home"]] as const) {
    await db.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
      VALUES (?, ?, 'America/New_York', 8, ?, ?, ?, ?, ?)`).run(id, name, flags, visibility, actions, now, now)
  }
  for (const [userId, memberId, email, workspaceId, role, managerId] of [
    [ids.adminUser, ids.adminMember, "home-admin@example.test", ids.workspace, "admin", null],
    [ids.managerUser, ids.managerMember, "home-manager@example.test", ids.workspace, "manager", null],
    [ids.repUser, ids.repMember, "home-rep@example.test", ids.workspace, "rep", ids.managerMember],
    [ids.outsiderUser, ids.outsiderMember, "home-outsider@example.test", ids.workspace, "rep", null],
    [ids.otherUser, ids.otherMember, "home-other@example.test", ids.otherWorkspace, "admin", null],
  ] as const) {
    await db.prepare(`INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at)
      VALUES (?, ?, NULL, ?, NULL, ?, ?, ?)`).run(userId, email, email, `APP-${userId.slice(-6)}`, now, now)
    await db.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,manager_membership_id,status,sender_association,created_at,updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', NULL, ?, ?)`).run(memberId, workspaceId, userId, role, managerId, now, now)
  }
  await db.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("home-admin-session", ids.adminUser, ids.adminMember, hashOpaqueToken("admin-session-token"), now, now)
  await db.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("home-rep-session", ids.repUser, ids.repMember, hashOpaqueToken("rep-session-token"), now, now)
  await db.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("home-other-session", ids.otherUser, ids.otherMember, hashOpaqueToken("other-session-token"), now, now)
  await db.prepare(`INSERT INTO api_keys
    (id,workspace_id,name,prefix,secret_hash,scopes,expires_at,last_used_at,revoked_at,rate_limit_per_minute,created_by,created_at)
    VALUES (?, ?, 'read', 'mca_test', ?, ?, NULL, NULL, NULL, 60, ?, ?)`).run("home-read-key", ids.workspace, hashOpaqueToken("mca_read-secret"), JSON.stringify(["deals:read"]), ids.adminUser, now)
  await db.prepare(`INSERT INTO api_keys
    (id,workspace_id,name,prefix,secret_hash,scopes,expires_at,last_used_at,revoked_at,rate_limit_per_minute,created_by,created_at)
    VALUES (?, ?, 'intake', 'mca_test', ?, ?, NULL, NULL, NULL, 60, ?, ?)`).run("home-intake-key", ids.workspace, hashOpaqueToken("mca_intake-secret"), JSON.stringify(["intake:write"]), ids.adminUser, now)

  const submit = await createDeal(admin, { idempotencyKey: "home-submit", ...application("Submit Ready LLC"), assignments: [{ membershipId: ids.repMember, kind: "originator", isPrimary: true }] })
  seeded.submitId = submit.deal.id
  await setStatus(seeded.submitId, "ready_to_submit")

  const resubmit = await createDeal(admin, { idempotencyKey: "home-resubmit", ...application("Resubmit Shop LLC"), assignments: [{ membershipId: ids.repMember, kind: "originator", isPrimary: true }] })
  seeded.resubmitId = resubmit.deal.id
  await setStatus(seeded.resubmitId, "submitted")
  await db.prepare("INSERT INTO deal_submissions (id, workspace_id, deal_id, funder_name, status) VALUES (?, ?, ?, 'Declined Capital', 'declined')")
    .run("declined-sub", ids.workspace, seeded.resubmitId)

  const combo = await createDeal(admin, { idempotencyKey: "home-combo", ...application("Pitch Combo LLC"), assignments: [{ membershipId: ids.repMember, kind: "originator", isPrimary: true }] })
  seeded.comboId = combo.deal.id
  await setStatus(seeded.comboId, "submitted")
  const comboOffer = await createOffer(admin, {
    dealId: seeded.comboId, funderName: "Northstar Capital",
    terms: { amountCents: 4000000, factorRate: 1.25, termMonths: 10, paymentAmountCents: 250000, paymentFrequency: "weekly" },
  })
  seeded.comboOfferId = comboOffer.id
  seeded.comboRevisionId = comboOffer.currentRevisionId
  await selectOfferRevision(admin, { dealId: seeded.comboId, offerId: comboOffer.id, revisionId: comboOffer.currentRevisionId, selected: true })
  const stip = await createStipulation(admin, { dealId: seeded.comboId, documentCategory: "driver_license", label: "Owner driver license", idempotencyKey: "home-combo-stip" })
  seeded.comboStipId = stip.id
  await addDealNote(admin, seeded.comboId, { body: "Call after banking hours.", expectedVersion: (await getDeal(admin, seeded.comboId)).version })

  const merchant = await createDeal(admin, { idempotencyKey: "home-merchant", ...application("Merchant Wait LLC"), assignments: [{ membershipId: ids.repMember, kind: "originator", isPrimary: true }] })
  seeded.merchantId = merchant.deal.id
  await setStatus(seeded.merchantId, "submitted")
  const merchantOffer = await createOffer(admin, {
    dealId: seeded.merchantId, funderName: "Harbor Funding",
    terms: { amountCents: 3500000, factorRate: 1.2, termMonths: 9, paymentAmountCents: 220000, paymentFrequency: "weekly" },
  })
  await selectOfferRevision(admin, { dealId: seeded.merchantId, offerId: merchantOffer.id, revisionId: merchantOffer.currentRevisionId, selected: true })
  await recordPhonePitch(admin, { dealId: seeded.merchantId, offerId: merchantOffer.id, revisionId: merchantOffer.currentRevisionId, idempotencyKey: "home-merchant-pitch" })
  await db.prepare("UPDATE mca_pitch_events SET pitched_at=? WHERE workspace_id=? AND deal_id=?").run(daysAgo(3), ids.workspace, seeded.merchantId)

  const funder = await createDeal(admin, { idempotencyKey: "home-funder", ...application("Funder Wait LLC"), assignments: [{ membershipId: ids.repMember, kind: "originator", isPrimary: true }] })
  seeded.funderId = funder.deal.id
  await setStatus(seeded.funderId, "submitted")
  await insertSentJob(seeded.funderId, "Quiet Capital", daysAgo(4), "job-funder-wait")

  const waiting = await createDeal(admin, { idempotencyKey: "home-waiting", ...application("Fresh Send LLC"), assignments: [{ membershipId: ids.repMember, kind: "originator", isPrimary: true }] })
  seeded.waitingId = waiting.deal.id
  await setStatus(seeded.waitingId, "submitted")
  await insertSentJob(seeded.waitingId, "Same-day Capital", "2026-01-15T06:00:00.000Z", "job-fresh-send")

  async function offerDeal(key: string, name: string, member: string) {
    const created = await createDeal(admin, { idempotencyKey: key, ...application(name), assignments: [{ membershipId: member, kind: "originator", isPrimary: true }] })
    await setStatus(created.deal.id, "submitted")
    const offer = await createOffer(admin, {
      dealId: created.deal.id, funderName: "Northstar Capital",
      terms: { amountCents: 4000000, factorRate: 1.25, termMonths: 10, paymentAmountCents: 250000, paymentFrequency: "weekly" },
    })
    await selectOfferRevision(admin, { dealId: created.deal.id, offerId: offer.id, revisionId: offer.currentRevisionId, selected: true })
    return { dealId: created.deal.id, offerId: offer.id, revisionId: offer.currentRevisionId }
  }

  const contract = await offerDeal("home-contract", "Contract Ask LLC", ids.adminMember)
  seeded.contractId = contract.dealId
  await acceptOfferForClosing(admin, { dealId: contract.dealId, offerId: contract.offerId, revisionId: contract.revisionId, idempotencyKey: "home-accept-contract" })

  const signature = await offerDeal("home-signature", "Signature Chase LLC", ids.adminMember)
  seeded.signatureId = signature.dealId
  await acceptOfferForClosing(admin, { dealId: signature.dealId, offerId: signature.offerId, revisionId: signature.revisionId, idempotencyKey: "home-accept-sign" })
  await db.prepare("UPDATE mca_contract_workflows SET state='contract_sent', contract_requested_at=?, contract_sent_at=? WHERE deal_id=?")
    .run(daysAgo(4), daysAgo(3), seeded.signatureId)

  const reprice = await offerDeal("home-reprice", "Reprice Follow LLC", ids.adminMember)
  seeded.repriceId = reprice.dealId
  await acceptOfferForClosing(admin, { dealId: reprice.dealId, offerId: reprice.offerId, revisionId: reprice.revisionId, idempotencyKey: "home-accept-reprice" })
  await db.prepare("UPDATE mca_contract_workflows SET state='repricing_requested', repricing_requested_at=? WHERE deal_id=?")
    .run(daysAgo(3), seeded.repriceId)

  const funding = await offerDeal("home-funding", "Funding Final LLC", ids.adminMember)
  seeded.fundingId = funding.dealId
  seeded.fundingOfferId = funding.offerId
  seeded.fundingRevisionId = funding.revisionId
  await acceptOfferForClosing(admin, { dealId: funding.dealId, offerId: funding.offerId, revisionId: funding.revisionId, idempotencyKey: "home-accept-fund" })
  await db.prepare("UPDATE mca_contract_workflows SET state='signed', signed_at=? WHERE deal_id=?").run(now, seeded.fundingId)

  const missing = await createDeal(admin, { idempotencyKey: "home-missing", ...application("Missing Docs LLC"), assignments: [{ membershipId: ids.adminMember, kind: "originator", isPrimary: true }] })
  seeded.missingId = missing.deal.id
  await setStatus(seeded.missingId, "missing_documents")

  const renewal = await offerDeal("home-renewal", "Renewal Bakery LLC", ids.adminMember)
  seeded.renewalId = renewal.dealId
  await setStatus(seeded.renewalId, "funded")
  const advanceId = "adv-renewal"
  const eventId = "fund-renewal"
  await db.prepare(`INSERT INTO mca_funding_events
    (id, workspace_id, deal_id, offer_id, offer_revision_id, advance_id, idempotency_key, funded_at, amount_cents, commission_cents, fee_cents,
     splits_json, accounting_record_ids_json, source, state, created_by_user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'home-renewal-fund', ?, 4000000, 0, 0, '[]', '[]', 'live', 'committed', ?, ?)`).run(
    eventId, ids.workspace, seeded.renewalId, renewal.offerId, renewal.revisionId, advanceId, daysAgo(40), ids.adminUser, now,
  )
  await db.prepare(`INSERT INTO mca_advances
    (id, workspace_id, funding_event_id, deal_id, offer_id, offer_revision_id, funded_at, principal_cents, commission_cents, fee_cents,
     source, calculation_snapshot_json, status, status_version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 4000000, 0, 0, 'live', '{}', 'active', 1, ?, ?)`).run(
    advanceId, ids.workspace, eventId, seeded.renewalId, renewal.offerId, renewal.revisionId, daysAgo(40), now, now,
  )
  await db.prepare(`INSERT INTO mca_renewal_actions
    (id, workspace_id, source_advance_id, renewed_deal_id, policy_version, eligible_at, state, message_subject, message_body,
     documentation_requested_at, idempotency_key, created_by_user_id, created_at, updated_at)
    VALUES ('renew-1', ?, ?, NULL, 1, ?, 'eligible', 'Renewal review', 'Eligible for renewal.', NULL, 'eligibility:v1:adv-renewal', ?, ?, ?)`).run(
    ids.workspace, advanceId, daysAgo(1), ids.adminUser, now, now,
  )

  const hidden = await createDeal(admin, { idempotencyKey: "home-hidden", ...application("Hidden Admin LLC"), assignments: [{ membershipId: ids.adminMember, kind: "originator", isPrimary: true }] })
  seeded.hiddenId = hidden.deal.id
  await setStatus(seeded.hiddenId, "ready_to_submit")

  const closed = await createDeal(admin, { idempotencyKey: "home-closed", ...application("Closed LLC"), assignments: [{ membershipId: ids.repMember, kind: "originator", isPrimary: true }] })
  seeded.closedId = closed.deal.id
  await setStatus(seeded.closedId, "closed")

  const other = await createDeal(otherAdmin, { idempotencyKey: "home-other", ...application("Other Workspace LLC"), assignments: [{ membershipId: ids.otherMember, kind: "originator", isPrimary: true }] })
  seeded.otherId = other.deal.id
  await getDatabase().prepare("UPDATE deals SET status='ready_to_submit', updated_at=? WHERE id=?").run(now, seeded.otherId)
}

before(async () => {
  fixture = await createPostgresTestDatabase("milestone06_home")
  Object.assign(process.env, fixture.env())
  await seed()
})
after(async () => {
  await closeDatabaseForTests()
  await fixture.close()
})

test("MIC-102 derives every action reason from underlying state with action-since timestamps", () => {
  assert.equal(codes(facts({ status: "ready_to_submit" })).join(), "submit")
  assert.equal(codes(facts({ status: "new_application", draftState: "submission_ready" })).join(), "submit")
  assert.equal(codes(facts({
    status: "submitted",
    submissions: [{ id: "s1", dealId: "deal-1", funderName: "X", status: "declined", sentAt: daysAgo(2), hasResponse: true }],
  })).join(), "resubmit")
  assert.equal(codes(facts({
    offers: [{ id: "o1", dealId: "deal-1", funderName: "Northstar", currentRevisionId: "r1", currentRevisionState: "active", selected: true, createdAt: daysAgo(1) }],
  })).join(), "pitch")
  assert.equal(codes(facts({
    offers: [{ id: "o1", dealId: "deal-1", funderName: "Northstar", currentRevisionId: "r1", currentRevisionState: "active", selected: true, createdAt: daysAgo(5), pitchedAt: daysAgo(3) }],
  })).join(), "merchant_follow_up")
  assert.equal(codes(facts({
    status: "submitted",
    submissions: [{ id: "s1", dealId: "deal-1", jobId: "j1", funderName: "Quiet", status: "sent", jobState: "sent", sentAt: daysAgo(4), hasResponse: false }],
  })).join(), "funder_follow_up")
  assert.equal(codes(facts({
    contracts: [{ id: "c1", dealId: "deal-1", offerId: "o1", offerRevisionId: "r1", funderName: "Northstar", state: "accepted", acceptedAt: now }],
  })).join(), "contract")
  assert.equal(codes(facts({
    status: "missing_documents",
  })).join(), "missing_doc")
  assert.equal(codes(facts({
    contracts: [{ id: "c1", dealId: "deal-1", offerId: "o1", offerRevisionId: "r1", funderName: "Northstar", state: "contract_sent", contractSentAt: daysAgo(3) }],
  })).join(), "signature")
  assert.equal(codes(facts({
    contracts: [{ id: "c1", dealId: "deal-1", offerId: "o1", offerRevisionId: "r1", funderName: "Northstar", state: "repricing_requested", repricingRequestedAt: daysAgo(3) }],
  })).join(), "repricing")
  assert.equal(codes(facts({
    contracts: [{ id: "c1", dealId: "deal-1", offerId: "o1", offerRevisionId: "r1", funderName: "Northstar", state: "signed", signedAt: now }],
  })).join(), "funding")
  assert.equal(codes(facts({
    status: "funded",
    renewals: [{ id: "rn1", dealId: "deal-1", sourceAdvanceId: "a1", state: "eligible", eligibleAt: daysAgo(1) }],
  })).join(), "renewal")
  assert.deepEqual(codes(facts({
    status: "submitted",
    submissions: [{ id: "s1", dealId: "deal-1", jobId: "j1", funderName: "Quiet", status: "sent", jobState: "sent", sentAt: "2026-01-15T06:00:00.000Z", hasResponse: false }],
  })), [])
  assert.ok(HOME_SLA_HOURS.funder_follow_up >= 72)
})

test("MIC-102 completing one required action removes only that reason", () => {
  const combo = facts({
    offers: [{ id: "o1", dealId: "deal-1", funderName: "Northstar", currentRevisionId: "r1", currentRevisionState: "active", selected: true, createdAt: now }],
    stipulations: [{ id: "st1", dealId: "deal-1", status: "open", label: "DL", documentCategory: "driver_license", createdAt: now }],
  })
  const before = deriveHomeReasons(combo, now)
  assert.deepEqual(before.map((item) => item.code).sort(), ["missing_doc", "pitch"])
  const afterPitch = deriveHomeReasons({
    ...combo,
    offers: combo.offers.map((item) => ({ ...item, pitchedAt: now })),
  }, now)
  assert.deepEqual(afterPitch.map((item) => item.code), ["missing_doc"])
  const afterDocs = deriveHomeReasons({
    ...combo,
    offers: combo.offers.map((item) => ({ ...item, pitchedAt: now })),
    stipulations: combo.stipulations.map((item) => ({ ...item, status: "waived" })),
  }, now)
  assert.deepEqual(afterDocs.map((item) => item.code), [])
})

test("MIC-102 queue and panel obey deal visibility and live source state", async () => {
  const queue = await getHomeNeedsActionQueue(admin, { nowIso: now })
  const byName = new Map(queue.items.map((item) => [item.legalName, item]))
  assert.equal(byName.get("Submit Ready LLC")?.primaryReason.code, "submit")
  assert.equal(byName.get("Resubmit Shop LLC")?.primaryReason.code, "resubmit")
  assert.ok(byName.get("Pitch Combo LLC")?.reasons.map((item) => item.code).includes("pitch"))
  assert.ok(byName.get("Pitch Combo LLC")?.reasons.map((item) => item.code).includes("missing_doc"))
  assert.equal(byName.get("Merchant Wait LLC")?.primaryReason.code, "merchant_follow_up")
  assert.equal(byName.get("Merchant Wait LLC")?.category, "overdue_waiting")
  assert.equal(byName.get("Funder Wait LLC")?.primaryReason.code, "funder_follow_up")
  assert.equal(byName.get("Contract Ask LLC")?.primaryReason.code, "contract")
  assert.equal(byName.get("Signature Chase LLC")?.primaryReason.code, "signature")
  assert.equal(byName.get("Reprice Follow LLC")?.primaryReason.code, "repricing")
  assert.equal(byName.get("Funding Final LLC")?.primaryReason.code, "funding")
  assert.equal(byName.get("Missing Docs LLC")?.primaryReason.code, "missing_doc")
  assert.equal(byName.get("Renewal Bakery LLC")?.primaryReason.code, "renewal")
  assert.equal(byName.get("Hidden Admin LLC")?.primaryReason.code, "submit")
  assert.equal(byName.has("Fresh Send LLC"), false)
  assert.equal(byName.has("Closed LLC"), false)
  assert.equal(byName.has("Other Workspace LLC"), false)

  const payload = JSON.stringify(queue)
  assert.equal(payload.includes("12-3456789"), false)
  assert.equal(payload.includes("commission"), false)
  assert.equal(payload.includes("password"), false)

  const repQueue = await getHomeNeedsActionQueue(rep, { nowIso: now })
  const repNames = new Set(repQueue.items.map((item) => item.legalName))
  assert.equal(repNames.has("Submit Ready LLC"), true)
  assert.equal(repNames.has("Pitch Combo LLC"), true)
  assert.equal(repNames.has("Hidden Admin LLC"), false)
  assert.equal(repNames.has("Contract Ask LLC"), false)

  const managerQueue = await getHomeNeedsActionQueue(manager, { nowIso: now })
  assert.equal(managerQueue.items.some((item) => item.legalName === "Submit Ready LLC"), true)
  assert.equal(managerQueue.items.some((item) => item.legalName === "Hidden Admin LLC"), false)

  const outsiderQueue = await getHomeNeedsActionQueue(outsider, { nowIso: now })
  assert.equal(outsiderQueue.items.some((item) => item.dealId === seeded.comboId), false)

  const otherQueue = await getHomeNeedsActionQueue(otherAdmin, { nowIso: now })
  assert.deepEqual(otherQueue.items.map((item) => item.legalName), ["Other Workspace LLC"])

  const panel = await getHomeDealPanel(rep, seeded.comboId, now)
  assert.equal(panel.contacts.email, "mira@harbor.test")
  assert.equal(panel.contacts.phone, "2125550100")
  assert.equal(panel.offers[0]?.funderName, "Northstar Capital")
  assert.equal(panel.offers[0]?.pitched, false)
  assert.ok(panel.notes.some((item) => item.body === "Call after banking hours."))
  assert.ok(panel.workflowActions.some((item) => item.id === "pitched" && item.enabled))
  assert.ok(panel.stipulations.some((item) => item.label === "Owner driver license"))
  assert.equal(JSON.stringify(panel).includes("commissionCents"), false)

  await assert.rejects(() => getHomeDealPanel(rep, seeded.hiddenId, now), (error: AppError) => error.status === 404 && error.code === "deal_not_found")
  await assert.rejects(() => getHomeDealPanel(outsider, seeded.comboId, now), (error: AppError) => error.status === 404)

  await recordPhonePitch(admin, {
    dealId: seeded.comboId, offerId: seeded.comboOfferId, revisionId: seeded.comboRevisionId, idempotencyKey: "home-combo-pitch",
  })
  const afterPitch = await getHomeNeedsActionQueue(admin, { nowIso: now })
  const comboAfterPitch = afterPitch.items.find((item) => item.dealId === seeded.comboId)
  assert.ok(comboAfterPitch)
  assert.deepEqual(comboAfterPitch.reasons.map((item) => item.code), ["missing_doc"])
  await recordPhonePitch(admin, {
    dealId: seeded.comboId, offerId: seeded.comboOfferId, revisionId: seeded.comboRevisionId, idempotencyKey: "home-combo-pitch",
  })
  const replay = await getHomeNeedsActionQueue(admin, { nowIso: now })
  assert.deepEqual(replay.items.find((item) => item.dealId === seeded.comboId)?.reasons.map((item) => item.code), ["missing_doc"])

  await updateStipulation(admin, seeded.comboStipId, { status: "waived", exceptionReason: "Collected in person." })
  const afterDocs = await getHomeNeedsActionQueue(admin, { nowIso: now })
  assert.equal(afterDocs.items.some((item) => item.dealId === seeded.comboId), false)

  await confirmOfferFunding(admin, {
    dealId: seeded.fundingId, offerId: seeded.fundingOfferId, offerRevisionId: seeded.fundingRevisionId,
    idempotencyKey: "home-fund-confirm", fundedAt: now,
  }, async () => ({ recordIds: [] }))
  const afterFund = await getHomeNeedsActionQueue(admin, { nowIso: now })
  assert.equal(afterFund.items.some((item) => item.dealId === seeded.fundingId), false)
})

test("MIC-102 API matches UI permissions, validation, and retry identity", async () => {
  const unauth = await queueGet(new Request("http://localhost/api/mca/home/needs-action"))
  assert.equal(unauth.status, 401)

  const invalid = await queueGet(cookieRequest("/api/mca/home/needs-action?now=yesterday", "admin-session-token"))
  assert.equal(invalid.status, 422)
  const invalidBody = await invalid.json() as { error: { code: string; fieldErrors?: Record<string, string[]> } }
  assert.equal(invalidBody.error.code, "invalid_filter")
  assert.ok(invalidBody.error.fieldErrors?.now)

  const adminRes = await queueGet(cookieRequest(`/api/mca/home/needs-action?now=${encodeURIComponent(now)}`, "admin-session-token"))
  assert.equal(adminRes.status, 200)
  assert.equal(adminRes.headers.get("cache-control"), "no-store")
  const adminQueue = await adminRes.json() as HomeQueueResult
  const adminIds = adminQueue.items.map((item) => item.dealId).sort()
  const retry = await queueGet(cookieRequest(`/api/mca/home/needs-action?now=${encodeURIComponent(now)}`, "admin-session-token"))
  const retryQueue = await retry.json() as HomeQueueResult
  assert.deepEqual(retryQueue.items.map((item) => item.dealId).sort(), adminIds)

  const repRes = await queueGet(cookieRequest(`/api/mca/home/needs-action?now=${encodeURIComponent(now)}`, "rep-session-token"))
  const repQueue = await repRes.json() as HomeQueueResult
  assert.equal(repQueue.items.some((item) => item.dealId === seeded.hiddenId), false)
  assert.equal(repQueue.items.some((item) => item.dealId === seeded.submitId), true)

  const otherRes = await queueGet(cookieRequest(`/api/mca/home/needs-action?now=${encodeURIComponent(now)}`, "other-session-token"))
  const otherQueue = await otherRes.json() as HomeQueueResult
  assert.equal(otherQueue.items.some((item) => item.dealId === seeded.submitId), false)

  const keyRes = await queueGet(bearerRequest(`/api/mca/home/needs-action?now=${encodeURIComponent(now)}`, "read-secret"))
  assert.equal(keyRes.status, 200)
  const denied = await queueGet(bearerRequest(`/api/mca/home/needs-action?now=${encodeURIComponent(now)}`, "intake-secret"))
  assert.equal(denied.status, 403)

  const hiddenPanel = await panelGet(cookieRequest(`/api/mca/home/needs-action/${seeded.hiddenId}?now=${encodeURIComponent(now)}`, "rep-session-token"), {
    params: Promise.resolve({ dealId: seeded.hiddenId }),
  })
  assert.equal(hiddenPanel.status, 404)

  const visiblePanel = await panelGet(cookieRequest(`/api/mca/home/needs-action/${seeded.submitId}?now=${encodeURIComponent(now)}`, "rep-session-token"), {
    params: Promise.resolve({ dealId: seeded.submitId }),
  })
  assert.equal(visiblePanel.status, 200)
  const panel = await visiblePanel.json() as { contacts: { email?: string }; workflowActions: Array<{ id: string }> }
  assert.equal(panel.contacts.email, "mira@harbor.test")
  assert.ok(panel.workflowActions.some((item) => item.id === "submit"))
})

test("MIC-102 loading, empty, validation, success and failure states stay usable", () => {
  assert.equal(homeQueueView({ loading: true }).status, "loading")
  assert.equal(homeQueueView({ loading: true }).message, HOME_COPY.loading)
  assert.equal(homeQueueView({ loading: false, items: [] }).status, "empty")
  assert.equal(homeQueueView({ loading: false, items: [] }).message, HOME_COPY.empty)
  assert.equal(homeQueueView({ loading: false, fieldErrors: { now: ["Use a UTC timestamp."] } }).status, "validation")
  assert.equal(homeQueueView({ loading: false, error: "boom" }).status, "error")
  assert.equal(homeQueueView({ loading: false, error: "boom" }).message, "boom")
  const success = homeQueueView({
    loading: false,
    items: [{
      dealId: "d1", displayId: "MCA-1", legalName: "Harbor", status: "offer", version: 1, category: "own_action", actionSince: now, updatedAt: now,
      reasons: [{ id: "d1:pitch", code: "pitch", category: "own_action", label: "Pitch offer", since: now, sourceIds: [] }],
      primaryReason: { id: "d1:pitch", code: "pitch", category: "own_action", label: "Pitch offer", since: now, sourceIds: [] },
    }],
  })
  assert.equal(success.status, "success")
  assert.equal(success.items[0]?.dealId, "d1")
})

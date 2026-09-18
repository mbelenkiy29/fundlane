import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { getDatabase, newId, nowIso } from "../../src/lib/mca/db"
import { createDeal } from "../../src/lib/mca/deals/service"
import type { DealActor } from "../../src/lib/mca/deals/schema"
import { createOffer, selectOfferRevision } from "../../src/lib/mca/offers/service"
import { createWorkspaceWithAdmin } from "../../src/lib/mca/workspaces"

const EMAIL = "home-review-admin@example.test"
const PASSWORD = "HomeReview-2026!verify"
const WORKSPACE_NAME = "Home Review Demo"
const BATCH = "home-review-demo-20260918"

function adminClient() {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error("Supabase server configuration is missing.")
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } })
}

function actor(workspaceId: string, userId: string, membershipId: string): DealActor {
  return {
    workspaceId, userId, membershipId, role: "admin",
    managedMembershipIds: [], activeMembershipIds: [membershipId],
    source: "user", correlationId: BATCH,
  }
}

const application = (legalName: string) => ({
  legalName,
  entityType: "llc" as const,
  address: { line1: "1 Demo Street", city: "New York", state: "NY", postalCode: "10001" },
  contactName: "Mira Harbor",
  contactEmail: "mira@harbor.test",
  contactPhone: "2125550100",
  startDate: "2020-01-15",
  industry: "Food",
  monthlyRevenue: 40000,
  requestedAmount: 50000,
  fundingPurpose: "working capital",
  owners: [{ firstName: "Mira", lastName: "Harbor", ownershipPercent: 100, isPrimary: true }],
})

async function setStatus(workspaceId: string, dealId: string, userId: string, status: string, at: string) {
  const db = getDatabase()
  await db.prepare("UPDATE deals SET status=?, updated_at=? WHERE id=?").run(status, at, dealId)
  await db.prepare(`INSERT INTO deal_activity
    (id, workspace_id, deal_id, action, actor_user_id, source, summary, from_status, to_status, record_version, correlation_id, created_at)
    VALUES (?, ?, ?, 'status_changed', ?, 'manual', ?, NULL, ?, 2, ?, ?)`).run(
    newId(), workspaceId, dealId, userId, `Status changed to ${status}`, status, BATCH, at,
  )
}

async function fundDeal(input: {
  workspaceId: string
  userId: string
  dealId: string
  offerId: string
  revisionId: string
  fundedAt: string
  amountCents: number
  key: string
  eligible?: boolean
}) {
  const db = getDatabase()
  const now = nowIso()
  const eventId = newId()
  const advanceId = newId()
  await db.prepare(`INSERT INTO mca_funding_events
    (id, workspace_id, deal_id, offer_id, offer_revision_id, advance_id, idempotency_key, funded_at, amount_cents, commission_cents, fee_cents,
     splits_json, accounting_record_ids_json, source, state, created_by_user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, '[]', '[]', 'live', 'committed', ?, ?)
    ON CONFLICT (workspace_id, idempotency_key) DO NOTHING`).run(
    eventId, input.workspaceId, input.dealId, input.offerId, input.revisionId, advanceId,
    `${BATCH}:${input.key}`, input.fundedAt, input.amountCents, input.userId, now,
  )
  const event = await db.prepare<{ id: string; advance_id: string }>(
    "SELECT id, advance_id FROM mca_funding_events WHERE workspace_id=? AND idempotency_key=?",
  ).get(input.workspaceId, `${BATCH}:${input.key}`)
  if (!event) throw new Error(`Funding event missing for ${input.key}`)
  await db.prepare(`INSERT INTO mca_advances
    (id, workspace_id, funding_event_id, deal_id, offer_id, offer_revision_id, funded_at, principal_cents, commission_cents, fee_cents,
     source, calculation_snapshot_json, status, status_version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'live', '{}', 'active', 1, ?, ?)
    ON CONFLICT (workspace_id, funding_event_id) DO NOTHING`).run(
    event.advance_id, input.workspaceId, event.id, input.dealId, input.offerId, input.revisionId, input.fundedAt, input.amountCents, now, now,
  )
  if (input.eligible) {
    await db.prepare(`INSERT INTO mca_renewal_actions
      (id, workspace_id, source_advance_id, renewed_deal_id, policy_version, eligible_at, state, message_subject, message_body,
       documentation_requested_at, idempotency_key, created_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, NULL, 1, ?, 'eligible', 'Renewal review', 'Eligible for renewal.', NULL, ?, ?, ?, ?)
      ON CONFLICT (workspace_id, source_advance_id, idempotency_key) DO NOTHING`).run(
      newId(), input.workspaceId, event.advance_id, now, `eligibility:v1:${event.advance_id}`, input.userId, now, now,
    )
  }
}

async function main() {
  const db = getDatabase()
  const now = nowIso()
  let workspaceId: string
  let userId: string
  let membershipId: string

  const existing = await db.prepare<{ id: string }>("SELECT id FROM users WHERE lower(email)=lower(?)").get(EMAIL)
  if (existing) {
    userId = existing.id
    const membership = await db.prepare<{ id: string; workspace_id: string }>(
      `SELECT m.id, m.workspace_id FROM memberships m
       JOIN workspaces w ON w.id=m.workspace_id
       WHERE m.user_id=? AND m.status='active' AND w.name=?
       ORDER BY m.created_at DESC LIMIT 1`,
    ).get(userId, WORKSPACE_NAME)
    if (membership) {
      membershipId = membership.id
      workspaceId = membership.workspace_id
    } else {
      const created = await createWorkspaceWithAdmin({
        workspaceName: WORKSPACE_NAME, adminName: "Home Review Admin", adminEmail: EMAIL, password: PASSWORD, role: "admin",
      })
      workspaceId = created.workspaceId
      userId = created.userId
      membershipId = created.membershipId
    }
  } else {
    const created = await createWorkspaceWithAdmin({
      workspaceName: WORKSPACE_NAME, adminName: "Home Review Admin", adminEmail: EMAIL, password: PASSWORD, role: "admin",
    })
    workspaceId = created.workspaceId
    userId = created.userId
    membershipId = created.membershipId
  }

  await db.prepare(`UPDATE workspaces SET feature_flags=?, action_visibility=?, page_visibility=?, updated_at=? WHERE id=?`).run(
    JSON.stringify({ reports: true, payments: true, integrations: true }),
    JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true }),
    JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true }),
    now, workspaceId,
  )

  const supabase = adminClient()
  const listed = await supabase.auth.admin.listUsers({ page: 1, perPage: 200 })
  if (listed.error) throw new Error(listed.error.message)
  let remote = listed.data.users.find((user) => user.email?.toLowerCase() === EMAIL)
  if (!remote) {
    const created = await supabase.auth.admin.createUser({
      email: EMAIL, password: PASSWORD, email_confirm: true,
      user_metadata: { name: "Home Review Admin" },
      app_metadata: { mca_user_id: userId },
    })
    if (created.error || !created.data.user) throw new Error(created.error?.message ?? "Supabase user create failed.")
    remote = created.data.user
  } else {
    const updated = await supabase.auth.admin.updateUserById(remote.id, {
      password: PASSWORD, email_confirm: true, app_metadata: { ...remote.app_metadata, mca_user_id: userId, mca_migration_pending: false },
    })
    if (updated.error) throw new Error(updated.error.message)
  }
  await db.prepare("UPDATE users SET supabase_user_id=?, updated_at=? WHERE id=?").run(remote.id, now, userId)

  const admin = actor(workspaceId, userId, membershipId)

  const newDeal = await createDeal(admin, { idempotencyKey: `${BATCH}:new`, ...application("Northstar New Deals LLC") })
  await setStatus(workspaceId, newDeal.deal.id, userId, "new_application", now)

  const missing = await createDeal(admin, { idempotencyKey: `${BATCH}:missing`, ...application("Statement Gap LLC") })
  await setStatus(workspaceId, missing.deal.id, userId, "missing_documents", now)
  const findings = [
    { code: "missing_statement_2025-10", message: "Missing checking statement for 2025-10.", period: "2025-10" },
    { code: "missing_statement_2025-11", message: "Missing checking statement for 2025-11.", period: "2025-11" },
    { code: "missing_statement_2025-12", message: "Missing checking statement for 2025-12.", period: "2025-12" },
  ]
  const existingCompleteness = await db.prepare<{ id: string }>(
    "SELECT id FROM mca_completeness_results WHERE workspace_id=? AND deal_id=? AND version=1",
  ).get(workspaceId, missing.deal.id)
  if (!existingCompleteness) {
    await db.prepare(`INSERT INTO mca_completeness_results
      (id, workspace_id, deal_id, ready, version, rule_snapshot, findings_json, findings_fingerprint, checked_at)
      VALUES (?, ?, ?, 0, 1, '{"requiredStatementMonths":3}', ?, 'home-review-gap-v1', ?)`).run(
      newId(), workspaceId, missing.deal.id, JSON.stringify(findings), now,
    )
  }

  const first = await createDeal(admin, { idempotencyKey: `${BATCH}:first-funding`, ...application("Cedar Repeat Funding LLC") })
  await setStatus(workspaceId, first.deal.id, userId, "submitted", now)
  const firstOffer = await createOffer(admin, {
    dealId: first.deal.id, funderName: "Cedar Capital",
    terms: { amountCents: 4_000_000, factorRate: 1.25, termMonths: 10, paymentAmountCents: 250_000, paymentFrequency: "weekly" },
  })
  await selectOfferRevision(admin, { dealId: first.deal.id, offerId: firstOffer.id, revisionId: firstOffer.currentRevisionId, selected: true, reason: "Home review seed" })
  await setStatus(workspaceId, first.deal.id, userId, "funded", "2025-08-12T16:00:00.000Z")
  await fundDeal({
    workspaceId, userId, dealId: first.deal.id, offerId: firstOffer.id, revisionId: firstOffer.currentRevisionId,
    fundedAt: "2025-08-12T16:00:00.000Z", amountCents: 4_000_000, key: "first-funding",
  })

  const merchantId = (await db.prepare<{ merchant_id: string | null }>("SELECT merchant_id FROM deals WHERE id=?").get(first.deal.id))?.merchant_id
  const second = await createDeal(admin, {
    idempotencyKey: `${BATCH}:second-funding`, ...application("Cedar Repeat Funding LLC"),
    ...(merchantId ? { attachMerchantId: merchantId } : { forceDuplicate: true }),
  })
  await setStatus(workspaceId, second.deal.id, userId, "submitted", now)
  const secondOffer = await createOffer(admin, {
    dealId: second.deal.id, funderName: "Cedar Capital",
    terms: { amountCents: 5_000_000, factorRate: 1.3, termMonths: 10, paymentAmountCents: 280_000, paymentFrequency: "weekly" },
  })
  await selectOfferRevision(admin, { dealId: second.deal.id, offerId: secondOffer.id, revisionId: secondOffer.currentRevisionId, selected: true, reason: "Home review seed" })
  await setStatus(workspaceId, second.deal.id, userId, "renewed", now)
  await fundDeal({
    workspaceId, userId, dealId: second.deal.id, offerId: secondOffer.id, revisionId: secondOffer.currentRevisionId,
    fundedAt: now, amountCents: 5_000_000, key: "second-funding",
  })

  const renewal = await createDeal(admin, { idempotencyKey: `${BATCH}:renewal-eligible`, ...application("Renewal Bakery LLC") })
  await setStatus(workspaceId, renewal.deal.id, userId, "submitted", now)
  const renewalOffer = await createOffer(admin, {
    dealId: renewal.deal.id, funderName: "Harbor Funding",
    terms: { amountCents: 3_500_000, factorRate: 1.2, termMonths: 9, paymentAmountCents: 220_000, paymentFrequency: "weekly" },
  })
  await selectOfferRevision(admin, { dealId: renewal.deal.id, offerId: renewalOffer.id, revisionId: renewalOffer.currentRevisionId, selected: true, reason: "Home review seed" })
  await setStatus(workspaceId, renewal.deal.id, userId, "funded", now)
  await fundDeal({
    workspaceId, userId, dealId: renewal.deal.id, offerId: renewalOffer.id, revisionId: renewalOffer.currentRevisionId,
    fundedAt: "2025-07-01T16:00:00.000Z", amountCents: 3_500_000, key: "renewal-eligible", eligible: true,
  })

  const credentials = {
    url: "http://localhost:3010/sign-in",
    email: EMAIL,
    password: PASSWORD,
    workspace: WORKSPACE_NAME,
    workspaceId,
    role: "admin",
  }
  const out = resolve(process.cwd(), ".migration/home-review-credentials.json")
  await writeFile(out, `${JSON.stringify(credentials, null, 2)}\n`)
  console.log(`Created/updated ${EMAIL} as admin of ${WORKSPACE_NAME} (${workspaceId})`)
  console.log(`Sign in: ${credentials.url}`)
  console.log(`Email: ${EMAIL}`)
  console.log(`Password: ${PASSWORD}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})

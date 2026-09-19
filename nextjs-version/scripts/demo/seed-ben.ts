import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import pg from "pg"
import { postgresConnection } from "../../src/lib/mca/db-connection"
import { encryptSensitive } from "../../src/lib/mca/crypto"
import { calculateOffer } from "../../src/lib/mca/accounting/calculations"
import { generateExpectedInstallments } from "../../src/lib/mca/advances/performance"
import { paidDown } from "../../src/lib/mca/deals/book-math"

export const BATCH = "ben-demo-20260916-v1"
export const EMAIL = "ben@sentineltechsolutions.io"
export const WORKSPACE = "c880cbaf-f18d-4050-beab-840220624406"
type Row = Record<string, string | number | null>
type Target = { user_id: string; membership_id: string; workspace_id: string; role: string; name: string }
type Manifest = { batch: string; asOf: string; target: Target; ids: Record<string, string[]>; counts: Record<string, number>; paymentsFeature?: { before: string; after: string } }
const tables = ["deals", "deal_assignments", "mca_offers", "mca_offer_revisions", "mca_offer_selections", "mca_manual_submissions", "mca_funding_events", "mca_advances", "mca_advance_status_history", "mca_accounting_payments", "mca_merchant_installments", "mca_merchant_receipts"]
const id = (workspace: string, key: string) => {
  const hex = createHash("sha256").update(`${BATCH}:${workspace}:${key}`).digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
const day = (value: Date) => value.toISOString().slice(0, 10)
const timestamp = (value: string) => `${value}T16:00:00.000Z`
function backwards(date: string, count: number, business: boolean) {
  const cursor = new Date(timestamp(date))
  while (count > 0) {
    cursor.setUTCDate(cursor.getUTCDate() - 1)
    if (!business || ![0, 6].includes(cursor.getUTCDay())) count--
  }
  return day(cursor)
}

export async function resolveTarget(client: pg.Client, expectedWorkspace: string): Promise<Target> {
  const result = await client.query<Target>(`SELECT u.id user_id,m.id membership_id,m.workspace_id,m.role,w.name
    FROM users u JOIN memberships m ON m.user_id=u.id JOIN workspaces w ON w.id=m.workspace_id
    WHERE lower(u.email)=$1 AND m.status='active'`, [EMAIL])
  assert.equal(result.rows.length, 1, "Ben must have exactly one active workspace membership")
  const target = result.rows[0]
  assert.equal(target.workspace_id, expectedWorkspace, "Unexpected destination workspace")
  assert.ok(["admin", "super_admin"].includes(target.role), "Ben needs access to historical submissions and financial views")
  return target
}

export function buildSeed(target: Target, asOf: string) {
  assert.match(asOf, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(day(new Date(timestamp(asOf))), asOf)
  const rows: Record<string, Row[]> = Object.fromEntries(tables.map(table => [table, []]))
  const key = (label: string) => id(target.workspace_id, label)
  const now = timestamp(asOf)
  const add = (table: string, row: Row) => rows[table].push({ ...row, workspace_id: target.workspace_id })
  const stages = [...Array(8).fill("new_application"), ...Array(6).fill("missing_documents"), ...Array(6).fill("ready_to_submit"), ...Array(8).fill("submitted"), ...Array(6).fill("offer"), ...Array(6).fill("contract")]
  const industries = ["Bakery", "Auto Repair", "Landscaping", "Dental", "Logistics", "Restaurant", "Retail", "Plumbing"]
  const names = ["Harbor", "Cedar", "Summit", "Willow", "Orchard", "Maple", "Juniper", "Bluebird", "Stonebridge", "Evergreen", "Lakeside", "Northstar", "Oakwood", "Riverbend", "Meadow"]
  for (let i = 0; i < 120; i++) {
    const dealId = key(`deal-${i}`), funded = i < 80
    const status = funded ? "funded" : stages[i - 80]
    const percent = i < 20 ? 100 : i < 40 ? 50 : i < 70 ? [10,20,30,40,60,70,80,90][(i - 40) % 8] : 0
    const weekly = i % 2 === 0, paymentCount = weekly ? 20 : 100
    const paidCount = paymentCount * percent / 100
    // Anchor on a weekday so every fully paid installment precedes the observation date.
    let anchor = backwards(asOf, i < 20 ? 7 + i : 0, false)
    while ([0,6].includes(new Date(timestamp(anchor)).getUTCDay())) anchor = backwards(anchor, 1, false)
    const fundedDate = funded ? backwards(anchor, weekly ? paidCount * 7 : paidCount, !weekly) : backwards(asOf, 10 + i % 25, false)
    const fundedAt = timestamp(fundedDate), createdAt = timestamp(backwards(fundedDate, 7, false))
    const principalCents = (25000 + (i * 7500) % 180000) * 100
    const factor = ["1.20", "1.25", "1.30", "1.35"][i % 4]
    const frequency = weekly ? "weekly" : "daily", calendar = weekly ? "calendar_days" : "business_days"
    const calc = calculateOffer({ principalCents, factorRate: factor, commissionBasis: "principal", commissionPointsBasisPoints: 800 + (i % 3) * 100, paymentCount, paymentFrequency: frequency, paymentCalendar: calendar })
    const offerId = key(`offer-${i}`), revisionId = key(`revision-${i}`), advanceId = key(`advance-${i}`), eventId = key(`event-${i}`), paymentId = key(`commission-${i}`)
    const hasOffer = funded || ["offer", "contract"].includes(status)
    const funder = `TEST ${["Cedar Capital", "Harbor Funding", "Summit Finance", "Willow Capital"][i % 4]}`
    add("deals", { id: dealId, display_id: `TEST-BEN-${String(i + 1).padStart(3,"0")}`, legal_name: `TEST ${names[Math.floor(i / 8)]} ${industries[i % 8]} ${String(i + 1).padStart(3,"0")}`, entity_type: "llc",
      address_json: JSON.stringify({ line1: `${100 + i} Example Lane`, city: "New York", state: "NY", postalCode: "10001", country: "US" }), contact_name: `Test Contact ${i + 1}`,
      contact_email_cipher: encryptSensitive(`ben-demo-${i + 1}@example.invalid`, target.workspace_id), start_date: `${2016 + i % 8}-03-15`, industry: industries[i % 8], monthly_revenue: 60000 + i * 1750, fico_score: 610 + i % 150,
      funding_purpose: "TEST ONLY — working capital demonstration", requested_amount: principalCents / 100, status, draft_state: "partial", missing_required_json: '["owners","contactPhone"]', field_sources_json: "{}", idempotency_key: `${BATCH}:deal:${i}`, created_at: createdAt, updated_at: now })
    add("deal_assignments", { id: key(`assignment-${i}`), deal_id: dealId, membership_id: target.membership_id, kind: "originator", is_primary: 1, assigned_at: createdAt, assigned_by_user_id: target.user_id })
    if (hasOffer) {
      add("mca_offers", { id: offerId, deal_id: dealId, funder_name: funder, source: "historical", external_id: `${BATCH}:offer:${i}`, current_revision_id: revisionId, created_by_user_id: target.user_id, created_at: createdAt, updated_at: now })
      add("mca_offer_revisions", { id: revisionId, offer_id: offerId, revision_number: 1, state: funded ? "funded" : "active", product: "mca", amount_cents: principalCents, factor_rate_millionths: Math.round(Number(factor) * 1000000), term_months: 5, payment_amount_cents: calc.periodicPaymentEstimateCents, payment_frequency: frequency, fee_cents: 0, commission_cents: calc.commissionCents, effective_at: fundedAt, expires_at: new Date(Date.parse(createdAt) + 14 * 86_400_000).toISOString(), created_by_user_id: target.user_id, created_at: createdAt })
      add("mca_offer_selections", { id: key(`selection-${i}`), deal_id: dealId, offer_id: offerId, offer_revision_id: revisionId, active: 1, selected_by_user_id: target.user_id, selected_at: fundedAt, reason: "TEST historical selection" })
    }
    // 80 funded deals × 2 funders + 20 submitted/offer/contract deals × 1 = 180.
    const submissionCount = funded ? 2 : ["submitted", "offer", "contract"].includes(status) ? 1 : 0
    for (let n = 0; n < submissionCount; n++) add("mca_manual_submissions", { id: key(`submission-${i}-${n}`), deal_id: dealId, funder_name: n ? "TEST Meadow Finance" : funder,
      historical_at: timestamp(backwards(fundedDate, 3, false)), reason: `TEST ONLY ${BATCH}; synthetic history, no delivery`, state: n ? "submitted" : funded ? "funded" : hasOffer ? "approved" : "submitted",
      offer_id: !n && hasOffer ? offerId : null, source: "historical", idempotency_key: `${BATCH}:submission:${i}:${n}`, created_by_user_id: target.user_id, created_at: createdAt, updated_at: now })
    if (!funded) continue
    add("mca_funding_events", { id: eventId, deal_id: dealId, offer_id: offerId, offer_revision_id: revisionId, advance_id: advanceId, manual_submission_id: key(`submission-${i}-0`), idempotency_key: `${BATCH}:funding:${i}`, funded_at: fundedAt, amount_cents: principalCents, commission_cents: calc.commissionCents, fee_cents: 0, accounting_record_ids_json: JSON.stringify([paymentId]), source: "historical", state: "committed", created_by_user_id: target.user_id, created_at: now })
    add("mca_advances", { id: advanceId, funding_event_id: eventId, deal_id: dealId, offer_id: offerId, offer_revision_id: revisionId, funded_at: fundedAt, principal_cents: principalCents, payback_cents: calc.paybackCents, periodic_payment_cents: calc.periodicPaymentEstimateCents, payment_count: paymentCount, payment_frequency: frequency, calendar_convention: calendar, commission_cents: calc.commissionCents, fee_cents: 0, source: "historical", calculation_snapshot_json: JSON.stringify(calc), status: "active", created_at: now, updated_at: now })
    add("mca_advance_status_history", { id: key(`status-${i}`), advance_id: advanceId, status: percent === 100 ? "closed" : "on_track", reason: `TEST ${percent}% repaid`, effective_at: percent === 100 ? timestamp(anchor) : fundedAt, actor_user_id: target.user_id, correlation_id: `${BATCH}:status:${i}`, created_at: now })
    const received = i < 30 ? calc.commissionCents : i < 60 ? calc.commissionCents / 2 : 0
    add("mca_accounting_payments", { id: paymentId, advance_id: advanceId, funding_event_id: eventId, type: "commission", origin: "historical", originator_membership_id: target.membership_id, expected_amount_cents: calc.commissionCents, received_amount_cents: received, expected_at: fundedAt, received_at: received ? fundedAt : null, status: i < 30 ? "received" : i < 60 ? "partial" : "expected", idempotency_key: `${BATCH}:commission:${i}`, created_by_user_id: target.user_id, created_at: now, updated_at: now })
    const installments = generateExpectedInstallments({ fundedAt, paymentCount, paymentFrequency: frequency, calendarConvention: calendar, periodicPaymentCents: calc.periodicPaymentEstimateCents, paybackCents: calc.paybackCents })
    for (const installment of installments) {
      const installmentId = key(`installment-${i}-${installment.sequence}`)
      add("mca_merchant_installments", { id: installmentId, advance_id: advanceId, sequence: installment.sequence, occurrence_date: installment.occurrenceDate, amount_cents: installment.amountCents, created_at: now })
      if (installment.sequence <= paidCount) add("mca_merchant_receipts", { id: key(`receipt-${i}-${installment.sequence}`), advance_id: advanceId, installment_id: installmentId, amount_cents: installment.amountCents, received_at: timestamp(installment.occurrenceDate), origin: "system", status: "received", idempotency_key: `${BATCH}:receipt:${i}:${installment.sequence}`, created_by_user_id: target.user_id, created_at: now })
    }
    assert.equal(installments.slice(0, paidCount).reduce((sum, r) => sum + r.amountCents, 0), calc.paybackCents * percent / 100)
  }
  const manifest: Manifest = { batch: BATCH, asOf, target, ids: Object.fromEntries(tables.map(t => [t, rows[t].map(r => String(r.id))])), counts: Object.fromEntries(tables.map(t => [t, rows[t].length])) }
  return { rows, manifest }
}

async function insertRows(client: pg.Client, table: string, rows: Row[]) {
  assert.ok(tables.includes(table) || table === "audit_events")
  for (let start = 0; start < rows.length; start += 200) {
    const chunk = rows.slice(start, start + 200), columns = Object.keys(chunk[0]), values: unknown[] = []
    const tuples = chunk.map(row => `(${columns.map(column => { values.push(row[column]); return `$${values.length}` }).join(",")})`)
    await client.query(`INSERT INTO ${table} (${columns.join(",")}) VALUES ${tuples.join(",")}`, values)
  }
}

export async function verifySeed(client: pg.Client, manifest: Manifest) {
  for (const table of tables) {
    const result = await client.query(`SELECT count(*)::int count FROM ${table} WHERE workspace_id=$1 AND id=ANY($2::text[])`, [manifest.target.workspace_id, manifest.ids[table]])
    assert.equal(result.rows[0].count, manifest.counts[table], `${table} batch count`)
  }
  const repayments = await client.query(`SELECT a.id,a.payback_cents,coalesce(sum(r.amount_cents),0)::int received FROM mca_advances a
    LEFT JOIN mca_merchant_receipts r ON r.advance_id=a.id AND r.workspace_id=a.workspace_id AND r.status='received'
    WHERE a.workspace_id=$1 AND a.id=ANY($2::text[]) GROUP BY a.id`, [manifest.target.workspace_id, manifest.ids.mca_advances])
  const percentages = repayments.rows.map(r => paidDown({ paybackCents: r.payback_cents, receivedCents: r.received, scheduledPaidInCents: 0, scheduledPaidInBasisPoints: 0 }).paidDownBasisPoints)
  assert.equal(percentages.filter(p => p === 10000).length, 20)
  assert.equal(percentages.filter(p => p === 5000).length, 20)
  assert.equal(percentages.filter(p => p === 0).length, 10)
  const commissions = await client.query(`SELECT status,count(*)::int count FROM mca_accounting_payments WHERE workspace_id=$1 AND id=ANY($2::text[]) GROUP BY status`, [manifest.target.workspace_id, manifest.ids.mca_accounting_payments])
  assert.deepEqual(Object.fromEntries(commissions.rows.map(r => [r.status,r.count])), { received: 30, partial: 30, expected: 20 })
  const invalid = await client.query(`SELECT count(*)::int count FROM mca_merchant_receipts r JOIN mca_merchant_installments i ON i.id=r.installment_id
    WHERE r.id=ANY($1::text[]) AND (r.advance_id<>i.advance_id OR r.workspace_id<>i.workspace_id OR left(r.received_at,10)<>i.occurrence_date OR left(r.received_at,10)>$2)`, [manifest.ids.mca_merchant_receipts, manifest.asOf])
  assert.equal(invalid.rows[0].count, 0, "Receipt dates and relationships")
  return { funded: 80, fullyRepaid: 20, halfRepaid: 20, partiallyRepaid: 30, newlyFunded: 10, commissions: Object.fromEntries(commissions.rows.map(r => [r.status,r.count])) }
}

export async function seedBen(client: pg.Client, options: { apply?: boolean; expectedWorkspace: string; asOf?: string }) {
  await client.query(options.apply ? "BEGIN ISOLATION LEVEL REPEATABLE READ" : "BEGIN READ ONLY")
  try {
    if (options.apply) await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [BATCH])
    const target = await resolveTarget(client, options.expectedWorkspace)
    const auditId = id(target.workspace_id, "manifest")
    const saved = await client.query("SELECT metadata FROM audit_events WHERE workspace_id=$1 AND id=$2", [target.workspace_id, auditId])
    if (saved.rows.length) {
      const manifest: Manifest = JSON.parse(saved.rows[0].metadata)
      const verification = await verifySeed(client, manifest)
      await client.query("ROLLBACK")
      return { mode: "existing", manifest, verification }
    }
    const { rows, manifest } = buildSeed(target, options.asOf ?? day(new Date()))
    const workspace = (await client.query("SELECT feature_flags FROM workspaces WHERE id=$1", [target.workspace_id])).rows[0]
    const flags = JSON.parse(workspace.feature_flags)
    if (!flags.payments) manifest.paymentsFeature = { before: workspace.feature_flags, after: JSON.stringify({ ...flags, payments: true }) }
    if (!options.apply) { await client.query("ROLLBACK"); return { mode: "dry-run", manifest } }
    const outbound = await client.query(`SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='workspace_id'
      AND table_name ~ '(outbox|jobs|messages|deliveries|queue)' ORDER BY table_name`)
    const checked = [...new Set([...tables, ...outbound.rows.map(r => String(r.table_name))])]
    const snapshot = async () => {
      const result: Record<string, unknown> = {}
      for (const table of checked) {
        assert.match(table, /^[a-z_]+$/)
        result[table] = (await client.query(`SELECT count(*)::int count,md5(coalesce(string_agg(row_to_json(t)::text,'' ORDER BY row_to_json(t)::text),'')) digest
          FROM ${table} t WHERE workspace_id=$1 ${tables.includes(table) ? "AND NOT (id=ANY($2::text[]))" : ""}`,
          tables.includes(table) ? [target.workspace_id, manifest.ids[table]] : [target.workspace_id])).rows[0]
      }
      return result
    }
    const before = await snapshot()
    for (const table of tables) await insertRows(client, table, rows[table])
    const verification = await verifySeed(client, manifest)
    assert.deepEqual(await snapshot(), before, "Existing records and outbound queues must remain unchanged")
    if (manifest.paymentsFeature) {
      const changed = await client.query("UPDATE workspaces SET feature_flags=$1,updated_at=$2 WHERE id=$3 AND feature_flags=$4", [manifest.paymentsFeature.after, new Date().toISOString(), target.workspace_id, manifest.paymentsFeature.before])
      assert.equal(changed.rowCount, 1, "Workspace settings changed concurrently")
    }
    await insertRows(client, "audit_events", [{ id: auditId, workspace_id: target.workspace_id, actor_user_id: null, source: "system", action: "demo.seed.completed", resource_type: "demo_batch", resource_id: BATCH, metadata: JSON.stringify({ ...manifest, verification, preserved: before }), correlation_id: BATCH, created_at: new Date().toISOString() }])
    await client.query("COMMIT")
    return { mode: "created", manifest, verification }
  } catch (error) { await client.query("ROLLBACK"); throw error }
}

async function main() {
  const apply = process.argv.includes("--apply")
  const expectedWorkspace = process.argv.find(a => a.startsWith("--workspace="))?.slice(12) ?? WORKSPACE
  const output = process.argv.find(a => a.startsWith("--manifest="))?.slice(11)
  if (apply) assert.ok(output, "--apply requires --manifest=/absolute/output/path.json")
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL required")
  const client = new pg.Client({ ...postgresConnection(process.env.DATABASE_URL), connectionTimeoutMillis: 15000 })
  await client.connect()
  try {
    const result = await seedBen(client, { apply, expectedWorkspace })
    if (output) { await mkdir(dirname(resolve(output)), { recursive: true }); await writeFile(resolve(output), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 }) }
    console.log(JSON.stringify({ mode: result.mode, target: result.manifest.target, batch: BATCH, asOf: result.manifest.asOf, counts: result.manifest.counts, paymentsFeature: result.manifest.paymentsFeature, verification: result.verification }, null, 2))
  } finally { await client.end() }
}
if (process.argv[1] && resolve(process.argv[1]) === resolve("scripts/demo/seed-ben.ts")) main().catch(error => { console.error(error.message); process.exitCode = 1 })

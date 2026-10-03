import "server-only"
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { getDatabase, withTransaction, type DbExecutor } from "../db"
import { decryptSensitive, encryptSensitive } from "../crypto"
import { einLookupHash } from "../merchants/lookup-hash"
import { submissionMissingFields } from "../deals/validation"
import type { DealRecord } from "../deals/schema"
import { FUNDER_NAMES, buildProfile, parseBusinessesCsv, type DealProfile } from "./profiles"
import { bankStatementPdf, signedApplicationPdf, type PdfDeal } from "./pdfs"
import { BUSINESSES_CSV } from "./data"

/**
 * One-time job: turn the 120 seeded "TEST … 0NN" deals of one company into the client's sample businesses.
 * Runs inside the app so it uses the deployment's own encryption key and document storage.
 * Only rows whose idempotency_key starts with SEED_BATCH in the given workspace are read or written.
 */
export const SEED_BATCH = "ben-demo-20260916-v1"
export const EXPECTED_DEALS = 120
const VERSION = "humanize-demo-v1"
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw DB rows of several tables
type Row = Record<string, any>
type Q = Pick<DbExecutor, "query">
type OwnerRow = { id: string; first_name: string; last_name: string; ownership_percent: number; is_primary: number; email: string; phone: string }
type Plan = {
  deal: Row; profile: DealProfile; displayId: string; merchantId: string; missing: string[]; draftState: string
  owners: OwnerRow[]; merchantOwners: OwnerRow[]; dealChanged: boolean; ownersChanged: boolean; merchantChanged: boolean
  startDate: string; monthlyRevenue: number; requestedAmount: number
}

const detId = (ws: string, key: string) => {
  const hex = createHash("sha256").update(`${VERSION}:${ws}:${key}`).digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
const dec = (value: unknown, ws: string) => (typeof value === "string" && value ? decryptSensitive(value, ws) : undefined)
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const businesses = () => parseBusinessesCsv(BUSINESSES_CSV)
const STAGING_REF = "djnhfcxbuigsnqwcpdrz"
/** Writes run only in the production deployment, or in an explicit staging rehearsal whose database is the staging project. */
function assertWritesAllowed() {
  if (process.env.VERCEL_ENV === "production") return
  const rehearsal = process.env.MCA_DEMO_HUMANIZE_STAGING_REHEARSAL === STAGING_REF && (process.env.DATABASE_URL ?? "").includes(STAGING_REF)
  assert.ok(rehearsal, "Write modes run only in the production deployment")
}

/** The seeded deals, in seed order. Fails unless there are exactly EXPECTED_DEALS of them. */
async function targetDeals(db: Q, ws: string): Promise<Row[]> {
  const rows = (await db.query(`SELECT * FROM deals WHERE workspace_id=$1 AND idempotency_key LIKE $2 ORDER BY split_part(idempotency_key, ':', 3)::int`, [ws, `${SEED_BATCH}:deal:%`])).rows
  assert.equal(rows.length, EXPECTED_DEALS, `Expected ${EXPECTED_DEALS} seeded deals in workspace ${ws}, found ${rows.length}`)
  rows.forEach((d, i) => assert.equal(d.idempotency_key, `${SEED_BATCH}:deal:${i}`, `Seeded deals are not contiguous at position ${i}`))
  return rows
}

function ownersFor(ws: string, prefix: string, profile: DealProfile): OwnerRow[] {
  return profile.owners.map((o, n) => ({ id: detId(ws, `${prefix}:${n}`), first_name: o.firstName, last_name: o.lastName, ownership_percent: o.ownershipPercent, is_primary: o.isPrimary ? 1 : 0, email: o.email, phone: o.phone }))
}
function sameOwners(ws: string, current: Row[], desired: OwnerRow[]) {
  const norm = (rows: Row[], decrypt: boolean) => JSON.stringify(rows.map(r => [r.id, r.first_name, r.last_name, Number(r.ownership_percent), Number(r.is_primary), decrypt ? dec(r.email_cipher, ws) : r.email, decrypt ? dec(r.phone_cipher, ws) : r.phone]).sort())
  return norm(current, true) === norm(desired, false)
}

async function plan(db: Q, ws: string): Promise<Plan[]> {
  const rows = businesses()
  assert.equal(rows.length, EXPECTED_DEALS, "Bundled CSV must have one row per seeded deal")
  const deals = await targetDeals(db, ws)
  const dealIds = deals.map(d => d.id)
  const ownerRows = (await db.query(`SELECT * FROM deal_owners WHERE workspace_id=$1 AND deal_id=ANY($2::text[])`, [ws, dealIds])).rows
  const merchants = new Map((await db.query(`SELECT * FROM mca_merchants WHERE workspace_id=$1 AND id IN (SELECT merchant_id FROM deals WHERE workspace_id=$1 AND id=ANY($2::text[]))`, [ws, dealIds])).rows.map(m => [m.id, m]))
  const merchantOwnerRows = (await db.query(`SELECT * FROM mca_merchant_owners WHERE workspace_id=$1 AND merchant_id=ANY($2::text[])`, [ws, [...merchants.keys()]])).rows
  const outsideEinHashes = new Set((await db.query(`SELECT ein_lookup_hash h FROM deals WHERE workspace_id=$1 AND ein_lookup_hash IS NOT NULL AND NOT id=ANY($2::text[])
    UNION SELECT ein_lookup_hash FROM mca_merchants WHERE workspace_id=$1 AND ein_lookup_hash IS NOT NULL AND id NOT IN (SELECT merchant_id FROM deals WHERE workspace_id=$1 AND merchant_id IS NOT NULL AND id=ANY($2::text[]))`, [ws, dealIds])).rows.map(r => r.h))
  const outsideDisplayIds = new Set((await db.query(`SELECT display_id FROM deals WHERE workspace_id=$1 AND NOT id=ANY($2::text[])`, [ws, dealIds])).rows.map(r => r.display_id))
  const sharedMerchants = new Set((await db.query(`SELECT merchant_id FROM deals WHERE workspace_id=$1 AND merchant_id IS NOT NULL GROUP BY merchant_id HAVING count(*) > 1`, [ws])).rows.map(r => r.merchant_id))
  const used = new Set<string>()
  return deals.map((deal, i) => {
    const profile = buildProfile(i, rows[i], used)
    assert.ok(profile.startDate && profile.monthlyRevenue && profile.requestedAmount, `CSV row ${i + 1} is missing details`)
    assert.ok(!outsideEinHashes.has(einLookupHash(ws, profile.ein)), `EIN for ${profile.dbaName} is already used by another record in this company`)
    const displayId = `MCA-${String(deal.id).slice(0, 8).toUpperCase()}`
    assert.ok(!outsideDisplayIds.has(displayId), `Display id ${displayId} is already used by another deal`)
    const merchantId = deal.merchant_id ?? detId(ws, `merchant:${deal.id}`)
    assert.ok(!sharedMerchants.has(merchantId), `Deal ${deal.id} links to a merchant shared with other deals; refusing to edit it`)
    const startDate = profile.startDate, monthlyRevenue = profile.monthlyRevenue, requestedAmount = profile.requestedAmount
    const missing = submissionMissingFields({
      legalName: profile.legalName, entityType: profile.entityType, address: profile.address, contactPhone: profile.contactPhone, startDate, industry: profile.industry,
      monthlyRevenue, requestedAmount, fundingPurpose: profile.fundingPurpose,
      owners: profile.owners.map((o, n) => ({ id: String(n), firstName: o.firstName, lastName: o.lastName, ownershipPercent: o.ownershipPercent, isPrimary: o.isPrimary })),
    } as Pick<DealRecord, "legalName" | "entityType" | "address" | "contactPhone" | "startDate" | "industry" | "monthlyRevenue" | "requestedAmount" | "fundingPurpose" | "owners">)
    const draftState = missing.length ? "partial" : "submission_ready"
    const owners = ownersFor(ws, `deal-owner:${deal.id}`, profile)
    const merchantOwners = ownersFor(ws, `merchant-owner:${merchantId}`, profile)
    const dealChanged = deal.display_id !== displayId || deal.legal_name !== profile.legalName || deal.dba_name !== profile.dbaName || deal.entity_type !== profile.entityType
      || deal.address_json !== JSON.stringify(profile.address) || deal.contact_name !== profile.contactName || deal.industry !== profile.industry || deal.funding_purpose !== profile.fundingPurpose
      || deal.missing_required_json !== JSON.stringify(missing) || deal.draft_state !== draftState || deal.merchant_id !== merchantId
      || deal.start_date !== startDate || Number(deal.monthly_revenue) !== monthlyRevenue || Number(deal.requested_amount) !== requestedAmount
      || dec(deal.ein_cipher, ws) !== profile.ein || deal.ein_lookup_hash !== einLookupHash(ws, profile.ein)
      || dec(deal.contact_email_cipher, ws) !== profile.contactEmail || dec(deal.contact_phone_cipher, ws) !== profile.contactPhone
    const ownersChanged = !sameOwners(ws, ownerRows.filter(o => o.deal_id === deal.id), owners)
    const m = merchants.get(merchantId)
    const merchantChanged = !m || m.legal_name !== profile.legalName || m.dba_name !== profile.dbaName || m.contact_name !== profile.contactName || m.address_json !== JSON.stringify(profile.address)
      || dec(m.ein_cipher, ws) !== profile.ein || m.ein_lookup_hash !== einLookupHash(ws, profile.ein) || dec(m.contact_email_cipher, ws) !== profile.contactEmail || dec(m.contact_phone_cipher, ws) !== profile.contactPhone
      || !sameOwners(ws, merchantOwnerRows.filter(o => o.merchant_id === merchantId), merchantOwners)
    return { deal, profile, displayId, merchantId, missing, draftState, owners, merchantOwners, dealChanged, ownersChanged, merchantChanged, startDate, monthlyRevenue, requestedAmount }
  })
}

async function insertOwners(db: Q, table: "deal_owners" | "mca_merchant_owners", parentColumn: "deal_id" | "merchant_id", ws: string, parentId: string, owners: OwnerRow[]) {
  await db.query(`DELETE FROM ${table} WHERE workspace_id=$1 AND ${parentColumn}=$2`, [ws, parentId])
  for (const o of owners) await db.query(`INSERT INTO ${table} (id, workspace_id, ${parentColumn}, first_name, last_name, ownership_percent, is_primary, email_cipher, phone_cipher)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [o.id, ws, parentId, o.first_name, o.last_name, o.ownership_percent, o.is_primary, encryptSensitive(o.email, ws), encryptSensitive(o.phone, ws)])
}

const pdfDeal = (p: Plan): PdfDeal => ({ profile: p.profile, monthlyRevenue: p.monthlyRevenue, requestedAmount: p.requestedAmount, startDate: p.startDate, createdAt: p.deal.created_at, displayId: p.displayId })

async function documentJobs(db: Q, ws: string, plans: Plan[]) {
  const existing = new Map((await db.query(`SELECT id, idempotency_key, processing_state, checksum, storage_key FROM mca_documents WHERE workspace_id=$1 AND deal_id=ANY($2::text[]) AND idempotency_key LIKE $3`, [ws, plans.map(p => p.deal.id), `${VERSION}:%`])).rows.map(r => [r.idempotency_key, r]))
  const jobs: Array<{ plan: Plan; key: string; category: "statement" | "application"; build: () => Promise<{ bytes: Uint8Array; filename: string }>; current?: Row }> = []
  for (const plan of plans) {
    for (const category of ["statement", "application"] as const) {
      const key = `${VERSION}:${plan.deal.id}:${category}`
      jobs.push({ plan, key, category, current: existing.get(key), build: () => category === "statement" ? bankStatementPdf(pdfDeal(plan)) : signedApplicationPdf(pdfDeal(plan)) })
    }
  }
  return jobs
}

/** Read-only: exactly which deals would change and how. */
export async function dryRun(ws: string) {
  const db = getDatabase()
  const plans = await plan(db, ws)
  const jobs = await documentJobs(db, ws, plans)
  let docsReady = 0, docsMissing = 0, docsStale = 0
  for (const j of jobs) {
    if (!j.current) { docsMissing++; continue }
    const ready = ["clean", "ready"].includes(j.current.processing_state) && j.current.checksum === sha256((await j.build()).bytes)
    if (ready) docsReady++; else docsStale++
  }
  const otherDeals = (await db.query(`SELECT count(*)::int n FROM deals WHERE workspace_id=$1 AND (idempotency_key IS NULL OR idempotency_key NOT LIKE $2)`, [ws, `${SEED_BATCH}:deal:%`])).rows[0].n
  return {
    workspace: ws, targetDeals: plans.length, otherDealsLeftAlone: otherDeals,
    planned: { dealUpdates: plans.filter(p => p.dealChanged).length, ownerSets: plans.filter(p => p.ownersChanged).length, merchantUpserts: plans.filter(p => p.merchantChanged).length, incomplete: plans.filter(p => p.missing.length).length },
    documents: { ready: docsReady, missing: docsMissing, stale: docsStale },
    deals: plans.map(p => ({ dealId: p.deal.id, seedKey: p.deal.idempotency_key, from: p.deal.legal_name, to: p.profile.legalName, displayId: p.displayId, entityType: p.profile.entityType, ein: p.profile.ein,
      owners: p.profile.owners.map(o => `${o.firstName} ${o.lastName} (${o.ownershipPercent}%)`), merchant: p.deal.merchant_id ? "update existing" : "create", changes: { deal: p.dealChanged, owners: p.ownersChanged, merchant: p.merchantChanged } })),
  }
}

const BACKUP_TABLES = ["mca_merchants", "deals", "deal_owners", "mca_merchant_owners", "mca_offers", "mca_manual_submissions", "mca_offer_selections", "mca_advance_status_history", "mca_documents", "deal_notes"] as const
type Backup = { meta: { workspaceId: string; seedBatch: string; exportedAt: string; dealIds: string[] }; tables: Record<(typeof BACKUP_TABLES)[number], Row[]> }
/** Responses and requests must stay under Vercel's 4.5 MB body limit; base64 adds a third. */
const MAX_FILE_BYTES = 3_000_000

async function backupRows(db: Q, ws: string, dealIds: string[]): Promise<Backup["tables"]> {
  const merchantIds = (await db.query(`SELECT DISTINCT merchant_id FROM deals WHERE workspace_id=$1 AND id=ANY($2::text[]) AND merchant_id IS NOT NULL`, [ws, dealIds])).rows.map(r => r.merchant_id)
  const rows = async (sql: string, ids: string[]) => (await db.query(`SELECT to_jsonb(x) j FROM ${sql}`, [ws, ids])).rows.map(r => r.j)
  return {
    mca_merchants: await rows(`mca_merchants x WHERE workspace_id=$1 AND id=ANY($2::text[])`, merchantIds),
    deals: await rows(`deals x WHERE workspace_id=$1 AND id=ANY($2::text[])`, dealIds),
    deal_owners: await rows(`deal_owners x WHERE workspace_id=$1 AND deal_id=ANY($2::text[])`, dealIds),
    mca_merchant_owners: await rows(`mca_merchant_owners x WHERE workspace_id=$1 AND merchant_id=ANY($2::text[])`, merchantIds),
    mca_offers: await rows(`mca_offers x WHERE workspace_id=$1 AND deal_id=ANY($2::text[])`, dealIds),
    mca_manual_submissions: await rows(`mca_manual_submissions x WHERE workspace_id=$1 AND deal_id=ANY($2::text[])`, dealIds),
    mca_offer_selections: await rows(`mca_offer_selections x WHERE workspace_id=$1 AND deal_id=ANY($2::text[])`, dealIds),
    mca_advance_status_history: await rows(`mca_advance_status_history x WHERE workspace_id=$1 AND advance_id IN (SELECT id FROM mca_advances WHERE workspace_id=$1 AND deal_id=ANY($2::text[]))`, dealIds),
    mca_documents: await rows(`mca_documents x WHERE workspace_id=$1 AND deal_id=ANY($2::text[])`, dealIds),
    deal_notes: await rows(`deal_notes x WHERE workspace_id=$1 AND deal_id=ANY($2::text[])`, dealIds),
  }
}

/** Read-only: raw rows (ciphertext as stored) of everything the job can change. Document bytes are fetched one at a time with backupFile. */
export async function backup(ws: string): Promise<Backup> {
  const db = getDatabase()
  const dealIds = (await targetDeals(db, ws)).map(d => d.id)
  return { meta: { workspaceId: ws, seedBatch: SEED_BATCH, exportedAt: new Date().toISOString(), dealIds }, tables: await backupRows(db, ws, dealIds) }
}

/** Read-only: the stored bytes of one document on the target deals. */
export async function backupFile(ws: string, documentId: string) {
  const db = getDatabase()
  const dealIds = (await targetDeals(db, ws)).map(d => d.id)
  const doc = (await db.query(`SELECT id, deal_id, storage_key, checksum FROM mca_documents WHERE workspace_id=$1 AND id=$2 AND deal_id=ANY($3::text[])`, [ws, documentId, dealIds])).rows[0]
  assert.ok(doc, "Document is not on one of the seeded deals")
  const { documentStorage } = await import("../documents/storage")
  const bytes = await documentStorage().get(doc.storage_key)
  assert.ok(bytes.byteLength <= MAX_FILE_BYTES, "Document is too large to export through this endpoint")
  return { documentId: doc.id, storageKey: doc.storage_key, checksumMatches: sha256(bytes) === doc.checksum, base64: Buffer.from(bytes).toString("base64") }
}

/** Writes deal, owner, merchant and funder-name changes in one transaction. Idempotent. */
export async function applyData(ws: string) {
  assertWritesAllowed()
  return withTransaction(async db => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${VERSION}:${ws}`])
    const plans = await plan(db, ws)
    const now = new Date().toISOString(), counts = { deals: 0, dealOwnerSets: 0, merchants: 0, offers: 0, submissions: 0, submissionReasons: 0, selectionReasons: 0, statusReasons: 0 }
    const dealIds = plans.map(p => p.deal.id)
    const enc = (v: string) => encryptSensitive(v, ws)
    for (const p of plans) {
      if (p.merchantChanged) {
        await db.query(`INSERT INTO mca_merchants (id, workspace_id, legal_name, dba_name, ein_cipher, ein_lookup_hash, contact_name, contact_email_cipher, contact_phone_cipher, address_json, created_at, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
          ON CONFLICT (id) DO UPDATE SET legal_name=EXCLUDED.legal_name, dba_name=EXCLUDED.dba_name, ein_cipher=EXCLUDED.ein_cipher, ein_lookup_hash=EXCLUDED.ein_lookup_hash,
            contact_name=EXCLUDED.contact_name, contact_email_cipher=EXCLUDED.contact_email_cipher, contact_phone_cipher=EXCLUDED.contact_phone_cipher, address_json=EXCLUDED.address_json, updated_at=EXCLUDED.updated_at
          WHERE mca_merchants.workspace_id=EXCLUDED.workspace_id`,
          [p.merchantId, ws, p.profile.legalName, p.profile.dbaName, enc(p.profile.ein), einLookupHash(ws, p.profile.ein), p.profile.contactName, enc(p.profile.contactEmail), enc(p.profile.contactPhone), JSON.stringify(p.profile.address), now])
        await insertOwners(db, "mca_merchant_owners", "merchant_id", ws, p.merchantId, p.merchantOwners)
        counts.merchants++
      }
      if (p.dealChanged) {
        const result = await db.query(`UPDATE deals SET display_id=$3, legal_name=$4, dba_name=$5, entity_type=$6, address_json=$7, contact_name=$8, contact_email_cipher=$9, contact_phone_cipher=$10,
          ein_cipher=$11, ein_lookup_hash=$12, industry=$13, funding_purpose=$14, missing_required_json=$15, draft_state=$16, merchant_id=$17, start_date=$18, monthly_revenue=$19, requested_amount=$20,
          version=version+1, updated_at=$21 WHERE workspace_id=$1 AND id=$2 AND version=$22 AND idempotency_key LIKE $23`,
          [ws, p.deal.id, p.displayId, p.profile.legalName, p.profile.dbaName, p.profile.entityType, JSON.stringify(p.profile.address), p.profile.contactName, enc(p.profile.contactEmail), enc(p.profile.contactPhone),
            enc(p.profile.ein), einLookupHash(ws, p.profile.ein), p.profile.industry, p.profile.fundingPurpose, JSON.stringify(p.missing), p.draftState, p.merchantId, p.startDate, p.monthlyRevenue, p.requestedAmount,
            now, p.deal.version, `${SEED_BATCH}:deal:%`])
        assert.equal(result.rowCount, 1, `Deal ${p.deal.id} changed concurrently`)
        counts.deals++
      }
      if (p.ownersChanged) { await insertOwners(db, "deal_owners", "deal_id", ws, p.deal.id, p.owners); counts.dealOwnerSets++ }
    }
    const unknown = (await db.query(`SELECT DISTINCT funder_name FROM (SELECT funder_name FROM mca_offers WHERE workspace_id=$1 AND deal_id=ANY($2::text[]) UNION SELECT funder_name FROM mca_manual_submissions WHERE workspace_id=$1 AND deal_id=ANY($2::text[])) f
      WHERE funder_name ~* '^test\\M' AND NOT funder_name=ANY($3::text[])`, [ws, dealIds, Object.keys(FUNDER_NAMES)])).rows
    assert.equal(unknown.length, 0, `Unmapped TEST funder names: ${unknown.map(r => r.funder_name).join(", ")}`)
    for (const [from, to] of Object.entries(FUNDER_NAMES)) {
      counts.offers += (await db.query(`UPDATE mca_offers SET funder_name=$4, updated_at=$5 WHERE workspace_id=$1 AND deal_id=ANY($2::text[]) AND funder_name=$3`, [ws, dealIds, from, to, now])).rowCount
      counts.submissions += (await db.query(`UPDATE mca_manual_submissions SET funder_name=$4, updated_at=$5 WHERE workspace_id=$1 AND deal_id=ANY($2::text[]) AND funder_name=$3`, [ws, dealIds, from, to, now])).rowCount
    }
    counts.submissionReasons = (await db.query(`UPDATE mca_manual_submissions SET reason=$3 WHERE workspace_id=$1 AND deal_id=ANY($2::text[]) AND reason LIKE 'TEST ONLY %'`, [ws, dealIds, "Historical submission (imported record; not sent through Fundlane)"])).rowCount
    counts.selectionReasons = (await db.query(`UPDATE mca_offer_selections SET reason='Historical selection' WHERE workspace_id=$1 AND deal_id=ANY($2::text[]) AND reason='TEST historical selection'`, [ws, dealIds])).rowCount
    counts.statusReasons = (await db.query(`UPDATE mca_advance_status_history SET reason=regexp_replace(reason, '^TEST ([0-9]+)% repaid$', '\\1% repaid (historical)')
      WHERE workspace_id=$1 AND reason ~ '^TEST [0-9]+% repaid$' AND advance_id IN (SELECT id FROM mca_advances WHERE workspace_id=$1 AND deal_id=ANY($2::text[]))`, [ws, dealIds])).rowCount
    if (Object.values(counts).some(Boolean)) await db.query(`INSERT INTO audit_events (id, workspace_id, actor_user_id, source, action, resource_type, resource_id, metadata, correlation_id, created_at)
      VALUES ($1,$2,NULL,'system','demo.humanize.applied','demo_batch',$3,$4,$5,$6)`, [randomUUID(), ws, SEED_BATCH, JSON.stringify({ version: VERSION, counts }), VERSION, now])
    return counts
  })
}

/** Uploads up to `limit` missing or stale sample PDFs through the app's document service. Call repeatedly until `remaining` is 0. */
export async function applyDocuments(ws: string, limit: number, budgetMs: number) {
  assertWritesAllowed()
  const started = Date.now()
  const db = getDatabase()
  const plans = await plan(db, ws)
  assert.ok(plans.every(p => !p.dealChanged && !p.ownersChanged && !p.merchantChanged), "Run apply-data first; the PDFs show the deal data")
  const jobs = await documentJobs(db, ws, plans)
  const work: Array<{ job: (typeof jobs)[number]; pdf: { bytes: Uint8Array; filename: string } }> = []
  for (const job of jobs) {
    const pdf = await job.build()
    if (job.current && ["clean", "ready"].includes(job.current.processing_state) && job.current.checksum === sha256(pdf.bytes)) continue
    work.push({ job, pdf })
  }
  const actor = (await db.query(`SELECT u.id user_id, m.id membership_id, m.role FROM memberships m JOIN users u ON u.id=m.user_id
    WHERE m.workspace_id=$1 AND m.status='active' AND m.role IN ('super_admin','admin') ORDER BY m.created_at, m.id LIMIT 1`, [ws])).rows[0]
  assert.ok(actor, "No active admin in the company to attribute the uploads to")
  const dealActor = { workspaceId: ws, userId: actor.user_id, membershipId: actor.membership_id, role: actor.role, managedMembershipIds: [], activeMembershipIds: [actor.membership_id], source: "system" as const, correlationId: `${VERSION}:${randomUUID()}` }
  const { storeDocument } = await import("../documents/service")
  const { storageClient, quarantineBucket } = await import("../documents/storage")
  const result: Record<string, number> = { replaced: 0, failed: 0 }
  let done = 0
  for (const { job, pdf } of work.slice(0, limit)) {
    if (Date.now() - started > budgetMs) break
    try {
      if (job.current) {
        // Stale generated PDF: remove its row and object, then upload the new one under the same idempotency key.
        const refs = (await db.query(`SELECT count(*)::int n FROM mca_outgoing_derivatives WHERE original_document_id=$1`, [job.current.id])).rows[0].n
        assert.equal(refs, 0, `Document ${job.current.id} has outgoing derivatives; not replacing it`)
        const del = await db.query(`DELETE FROM mca_documents WHERE workspace_id=$1 AND id=$2 AND deal_id=$3 AND idempotency_key=$4 AND source='demo_seed' AND source_reference=$5`, [ws, job.current.id, job.plan.deal.id, job.key, VERSION])
        assert.equal(del.rowCount, 1, `Could not remove stale document ${job.current.id}`)
        for (const bucket of [process.env.MCA_SUPABASE_DOCUMENT_BUCKET ?? "fundlane-documents", quarantineBucket()]) await storageClient().storage.from(bucket).remove([job.current.storage_key])
        result.replaced++
      }
      const doc = await storeDocument(dealActor, { dealId: job.plan.deal.id, idempotencyKey: job.key, filename: pdf.filename, mimeType: "application/pdf", bytes: pdf.bytes, category: job.category, source: "demo_seed", sourceReference: VERSION })
      result[doc.processingState] = (result[doc.processingState] ?? 0) + 1
    } catch (error) {
      result.failed++
      console.error(JSON.stringify({ event: "demo_humanize_document_failed", deal: job.plan.displayId, category: job.category, error: error instanceof Error ? error.message : String(error) }))
    }
    done++
  }
  return { ...result, attempted: done, remaining: work.length - done }
}

/** Read-only checks after applying: the data matches the CSV, documents exist, and no TEST text is left on the target deals. */
export async function verify(ws: string, sampleNames: string[]) {
  const db = getDatabase()
  const plans = await plan(db, ws)
  const dealIds = plans.map(p => p.deal.id)
  const one = async (sql: string) => (await db.query(sql, [ws, dealIds])).rows[0].n as number
  const testText = {
    deals: await one(`SELECT count(*)::int n FROM deals WHERE workspace_id=$1 AND id=ANY($2::text[]) AND concat_ws(' ', legal_name, dba_name, contact_name, industry, funding_purpose, display_id) ~* '\\mtest\\M'`),
    owners: await one(`SELECT count(*)::int n FROM deal_owners WHERE workspace_id=$1 AND deal_id=ANY($2::text[]) AND concat_ws(' ', first_name, last_name) ~* '\\mtest\\M'`),
    merchants: await one(`SELECT count(*)::int n FROM mca_merchants WHERE workspace_id=$1 AND id IN (SELECT merchant_id FROM deals WHERE workspace_id=$1 AND id=ANY($2::text[])) AND concat_ws(' ', legal_name, dba_name, contact_name) ~* '\\mtest\\M'`),
    offers: await one(`SELECT count(*)::int n FROM mca_offers WHERE workspace_id=$1 AND deal_id=ANY($2::text[]) AND funder_name ~* '\\mtest\\M'`),
    submissions: await one(`SELECT count(*)::int n FROM mca_manual_submissions WHERE workspace_id=$1 AND deal_id=ANY($2::text[]) AND concat_ws(' ', funder_name, reason) ~* '\\mtest\\M'`),
    selections: await one(`SELECT count(*)::int n FROM mca_offer_selections WHERE workspace_id=$1 AND deal_id=ANY($2::text[]) AND reason ~* '\\mtest\\M'`),
    statusHistory: await one(`SELECT count(*)::int n FROM mca_advance_status_history WHERE workspace_id=$1 AND reason ~* '\\mtest\\M' AND advance_id IN (SELECT id FROM mca_advances WHERE workspace_id=$1 AND deal_id=ANY($2::text[]))`),
    documents: await one(`SELECT count(*)::int n FROM mca_documents WHERE workspace_id=$1 AND deal_id=ANY($2::text[]) AND original_filename ~* '\\mtest\\M'`),
  }
  const docStates = Object.fromEntries((await db.query(`SELECT processing_state s, count(*)::int n FROM mca_documents WHERE workspace_id=$1 AND deal_id=ANY($2::text[]) GROUP BY 1`, [ws, dealIds])).rows.map(r => [r.s, r.n]))
  const samples = []
  for (const name of sampleNames) {
    const p = plans.find(x => x.profile.dbaName === name)
    if (!p) { samples.push({ name, found: false }); continue }
    const owners = (await db.query(`SELECT first_name, last_name, ownership_percent, email_cipher, phone_cipher FROM deal_owners WHERE workspace_id=$1 AND deal_id=$2 ORDER BY is_primary DESC, ownership_percent DESC`, [ws, p.deal.id])).rows
    const docs = (await db.query(`SELECT id, original_filename, processing_state, checksum, storage_key FROM mca_documents WHERE workspace_id=$1 AND deal_id=$2 ORDER BY category`, [ws, p.deal.id])).rows
    samples.push({ name, dealId: p.deal.id, displayId: p.deal.display_id, legalName: p.deal.legal_name, entityType: p.deal.entity_type, ein: dec(p.deal.ein_cipher, ws), phone: dec(p.deal.contact_phone_cipher, ws),
      owners: owners.map(o => ({ name: `${o.first_name} ${o.last_name}`, percent: Number(o.ownership_percent), email: dec(o.email_cipher, ws), phone: dec(o.phone_cipher, ws) })),
      documents: docs.map(d => ({ id: d.id, filename: d.original_filename, state: d.processing_state })) })
  }
  // Read one stored PDF back through the app's storage and compare its checksum.
  const doc = (await db.query(`SELECT storage_key, checksum, original_filename FROM mca_documents WHERE workspace_id=$1 AND deal_id=ANY($2::text[]) AND processing_state IN ('clean','ready') ORDER BY created_at LIMIT 1`, [ws, dealIds])).rows[0]
  let storageReadBack: Record<string, unknown> = { available: false }
  if (doc) {
    const { documentStorage } = await import("../documents/storage")
    const bytes = await documentStorage().get(doc.storage_key)
    storageReadBack = { available: true, filename: doc.original_filename, bytes: bytes.byteLength, checksumMatches: sha256(bytes) === doc.checksum, pdfHeader: Buffer.from(bytes.subarray(0, 5)).toString() === "%PDF-" }
  }
  return { targetDeals: plans.length, pending: { deals: plans.filter(p => p.dealChanged).length, owners: plans.filter(p => p.ownersChanged).length, merchants: plans.filter(p => p.merchantChanged).length },
    submissionReady: plans.filter(p => p.deal.draft_state === "submission_ready").length, testText, docStates, samples, storageReadBack }
}

/** Rejects a backup unless every row belongs to this company's seeded deals (or their merchants/advances). */
async function assertBackupScope(db: Q, ws: string, data: Backup, deals: Row[]) {
  assert.equal(data?.meta?.workspaceId, ws, "Backup is for a different company")
  const dealIds = deals.map(d => d.id), seedKey = new Map(deals.map(d => [d.id, d.idempotency_key]))
  assert.deepEqual([...data.meta.dealIds].sort(), [...dealIds].sort(), "Backup deals do not match this company's seeded deals")
  const t = data.tables
  for (const table of BACKUP_TABLES) {
    assert.ok(Array.isArray(t?.[table]), `Backup is missing ${table}`)
    for (const row of t[table]) assert.equal(row.workspace_id, ws, `Backup ${table} row ${row.id} is from another company`)
  }
  assert.deepEqual(t.deals.map(r => String(r.id)).sort(), [...dealIds].sort(), "Backup deal rows must be exactly the seeded deals")
  for (const r of t.deals) assert.equal(r.idempotency_key, seedKey.get(r.id), `Backup deal ${r.id} has the wrong seed key`)
  const inDeals = new Set(dealIds)
  for (const table of ["deal_owners", "mca_offers", "mca_manual_submissions", "mca_offer_selections", "mca_documents", "deal_notes"] as const)
    for (const r of t[table]) assert.ok(inDeals.has(r.deal_id), `Backup ${table} row ${r.id} is not on a seeded deal`)
  const merchantIds = new Set(t.deals.map(r => r.merchant_id).filter(Boolean))
  for (const r of t.mca_merchants) assert.ok(merchantIds.has(r.id), `Backup merchant ${r.id} is not linked to a seeded deal in the backup`)
  for (const r of t.mca_merchant_owners) assert.ok(merchantIds.has(r.merchant_id), `Backup merchant owner ${r.id} is not on a backed-up merchant`)
  const advances = new Set((await db.query(`SELECT id FROM mca_advances WHERE workspace_id=$1 AND deal_id=ANY($2::text[])`, [ws, dealIds])).rows.map(r => r.id))
  for (const r of t.mca_advance_status_history) assert.ok(advances.has(r.advance_id), `Backup status history ${r.id} is not on a seeded deal's advance`)
  for (const r of t.mca_documents) assert.equal(r.storage_key, `${ws}/${r.deal_id}/${r.id}`, `Backup document ${r.id} has an unexpected storage key`)
}

/**
 * Puts every backed-up row back exactly (raw ciphertext) and removes owners/merchants/documents the job added.
 * The whole backup is validated first; any row outside the seeded deals rejects the restore. Files go back with restoreFiles.
 */
export async function restore(ws: string, data: Backup) {
  assertWritesAllowed()
  const removedKeys: string[] = []
  const counts = await withTransaction(async db => {
    const deals = await targetDeals(db, ws)
    await assertBackupScope(db, ws, data, deals)
    const dealIds = deals.map(d => d.id)
    const ids = (t: (typeof BACKUP_TABLES)[number]) => data.tables[t].map(r => String(r.id))
    const merchantsBefore = (await db.query(`SELECT DISTINCT merchant_id FROM deals WHERE workspace_id=$1 AND id=ANY($2::text[]) AND merchant_id IS NOT NULL`, [ws, dealIds])).rows.map(r => r.merchant_id)
    const out: Record<string, number> = {}
    const docs = (await db.query(`DELETE FROM mca_documents WHERE workspace_id=$1 AND deal_id=ANY($2::text[]) AND source='demo_seed' AND source_reference=$3 AND NOT id=ANY($4::text[]) RETURNING storage_key`, [ws, dealIds, VERSION, ids("mca_documents")])).rows
    removedKeys.push(...docs.map(r => r.storage_key)); out.documentsRemoved = docs.length
    out.dealOwnersRemoved = (await db.query(`DELETE FROM deal_owners WHERE workspace_id=$1 AND deal_id=ANY($2::text[]) AND NOT id=ANY($3::text[])`, [ws, dealIds, ids("deal_owners")])).rowCount
    out.merchantOwnersRemoved = (await db.query(`DELETE FROM mca_merchant_owners WHERE workspace_id=$1 AND merchant_id=ANY($2::text[]) AND NOT id=ANY($3::text[])`, [ws, [...new Set([...merchantsBefore, ...ids("mca_merchants")])], ids("mca_merchant_owners")])).rowCount
    for (const table of BACKUP_TABLES) {
      const rows = data.tables[table]
      if (!rows.length) continue
      const cols = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND is_generated='NEVER' ORDER BY ordinal_position`, [table])).rows.map(r => `"${r.column_name}"`)
      const set = cols.filter(c => c !== '"id"').map(c => `${c}=EXCLUDED.${c}`).join(", ")
      out[table] = (await db.query(`INSERT INTO ${table} (${cols.join(",")}) SELECT ${cols.join(",")} FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb)
        ON CONFLICT (id) DO UPDATE SET ${set} WHERE ${table}.workspace_id=$2`, [JSON.stringify(rows), ws])).rowCount
    }
    out.merchantsRemoved = (await db.query(`DELETE FROM mca_merchants m WHERE workspace_id=$1 AND id=ANY($2::text[]) AND NOT id=ANY($3::text[]) AND NOT EXISTS (SELECT 1 FROM deals d WHERE d.merchant_id=m.id)`, [ws, merchantsBefore, ids("mca_merchants")])).rowCount
    await db.query(`INSERT INTO audit_events (id, workspace_id, actor_user_id, source, action, resource_type, resource_id, metadata, correlation_id, created_at)
      VALUES ($1,$2,NULL,'system','demo.humanize.restored','demo_batch',$3,$4,$5,$6)`, [randomUUID(), ws, SEED_BATCH, JSON.stringify({ version: VERSION, exportedAt: data.meta.exportedAt, out }), VERSION, new Date().toISOString()])
    return out
  })
  const { storageClient, quarantineBucket } = await import("../documents/storage")
  const bucket = process.env.MCA_SUPABASE_DOCUMENT_BUCKET ?? "fundlane-documents"
  for (const key of removedKeys) for (const b of [bucket, quarantineBucket()]) await storageClient().storage.from(b).remove([key])
  return { ...counts, storageObjectsRemoved: removedKeys.length }
}

/** After restore: puts backed-up document bytes back for document rows on the seeded deals whose object is missing. */
export async function restoreFiles(ws: string, files: Array<{ storageKey: string; base64: string }>) {
  assertWritesAllowed()
  const db = getDatabase()
  const dealIds = (await targetDeals(db, ws)).map(d => d.id)
  const { storageClient, quarantineBucket } = await import("../documents/storage")
  const bucket = process.env.MCA_SUPABASE_DOCUMENT_BUCKET ?? "fundlane-documents"
  let restored = 0, present = 0
  for (const file of files) {
    const doc = (await db.query(`SELECT id, deal_id, processing_state, checksum FROM mca_documents WHERE workspace_id=$1 AND storage_key=$2 AND deal_id=ANY($3::text[])`, [ws, file.storageKey, dealIds])).rows[0]
    assert.ok(doc && file.storageKey === `${ws}/${doc.deal_id}/${doc.id}`, `No document row on a seeded deal for ${file.storageKey}`)
    const bytes = Buffer.from(file.base64, "base64")
    assert.equal(sha256(bytes), doc.checksum, `Bytes for ${file.storageKey} do not match the document checksum`)
    const target = ["clean", "ready"].includes(doc.processing_state) ? bucket : quarantineBucket()
    const { error } = await storageClient().storage.from(target).upload(file.storageKey, bytes, { upsert: false, contentType: "application/octet-stream" })
    if (error) present++; else restored++
  }
  return { restored, alreadyPresentOrFailed: present }
}

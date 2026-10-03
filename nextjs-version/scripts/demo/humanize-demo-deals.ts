import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import pg from "pg"
import { postgresConnection } from "../../src/lib/mca/db-connection"
import { decryptSensitive, encryptSensitive } from "../../src/lib/mca/crypto"
import { einLookupHash } from "../../src/lib/mca/merchants/lookup-hash"
import { submissionMissingFields } from "../../src/lib/mca/deals/validation"
import type { DealRecord } from "../../src/lib/mca/deals/schema"
import { FUNDER_NAMES, buildProfile, matchedIndustryRule, parseBusinessesCsv, type DealProfile } from "./humanize-demo-profiles"
import { bankStatementPdf, signedApplicationPdf, type PdfDeal } from "./humanize-demo-pdfs"

/**
 * Turns the placeholder "TEST … 0NN" deals seeded by seed-ben.ts into realistic sample businesses.
 * Dry run by default; --apply writes. Idempotent: re-running with the same CSV changes nothing.
 * See scripts/demo/README.md for usage.
 */
export const SEED_BATCH = "ben-demo-20260916-v1"
const PROD_REF = "drubsfvhlggmtyiigwxy"
const VERSION = "humanize-demo-v1"
type Row = Record<string, any>
type Options = { workspace: string; csv: string; apply: boolean; documents: boolean; allowProd: boolean; onlyCsvRows?: boolean; replaceStaleDocuments?: boolean; actorEmail?: string; pdfOut?: string; out?: string }

const detId = (workspace: string, key: string) => {
  const hex = createHash("sha256").update(`${VERSION}:${workspace}:${key}`).digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
// Ciphertext that the current MCA_DATA_ENCRYPTION_KEY cannot open (e.g. written with another
// environment's key). Only tolerated with --reencrypt-unreadable; those values are then rewritten.
let allowUnreadable = false
let unreadableCount = 0
const dec = (value: unknown, ws: string) => {
  if (typeof value !== "string" || !value) return undefined
  try { return decryptSensitive(value, ws) } catch (error) {
    if (!allowUnreadable) throw new Error("Existing encrypted values cannot be decrypted with this MCA_DATA_ENCRYPTION_KEY. Check the key; pass --reencrypt-unreadable only if you mean to re-encrypt the demo deals with it.", { cause: error })
    unreadableCount += 1
    return undefined
  }
}
const SUBMISSION_REASON = "Historical submission (imported record; not sent through Fundlane)"

type OwnerRow = { id: string; first_name: string; last_name: string; ownership_percent: number; is_primary: number; email: string; phone: string }
type Plan = {
  deal: Row; profile: DealProfile; displayId: string; merchantId: string; missing: string[]; draftState: string
  owners: OwnerRow[]; merchantOwners: OwnerRow[]; dealChanged: boolean; ownersChanged: boolean; merchantChanged: boolean
  startDate?: string; monthlyRevenue?: number; requestedAmount?: number
}

function ownersFor(ws: string, prefix: string, profile: DealProfile): OwnerRow[] {
  return profile.owners.map((o, n) => ({ id: detId(ws, `${prefix}:${n}`), first_name: o.firstName, last_name: o.lastName, ownership_percent: o.ownershipPercent, is_primary: o.isPrimary ? 1 : 0, email: o.email, phone: o.phone }))
}
function sameOwners(ws: string, current: Row[], desired: OwnerRow[]) {
  const norm = (rows: Row[], decrypt: boolean) => JSON.stringify(rows.map(r => [r.id, r.first_name, r.last_name, Number(r.ownership_percent), Number(r.is_primary), decrypt ? dec(r.email_cipher, ws) : r.email, decrypt ? dec(r.phone_cipher, ws) : r.phone]).sort())
  return norm(current, true) === norm(desired, false)
}

export async function planHumanize(client: pg.Client, workspace: string, businesses: ReturnType<typeof parseBusinessesCsv>, onlyCsvRows = false): Promise<Plan[]> {
  const allDeals = (await client.query(`SELECT * FROM deals WHERE workspace_id=$1 AND idempotency_key LIKE $2 ORDER BY split_part(idempotency_key, ':', 3)::int`, [workspace, `${SEED_BATCH}:deal:%`])).rows
  assert.ok(allDeals.length > 0, `No ${SEED_BATCH} demo deals in workspace ${workspace}`)
  // --only-csv-rows: a shorter CSV updates the first N demo deals and leaves the rest exactly as they are (data and documents).
  if (!(onlyCsvRows && businesses.length < allDeals.length)) assert.equal(businesses.length, allDeals.length, `CSV has ${businesses.length} businesses but the workspace has ${allDeals.length} demo deals; they must match (or pass --only-csv-rows to update just the first ${businesses.length})`)
  const deals = allDeals.slice(0, businesses.length)
  const dealIds = deals.map(d => d.id)
  const ownerRows = (await client.query(`SELECT * FROM deal_owners WHERE workspace_id=$1 AND deal_id=ANY($2::text[]) ORDER BY id`, [workspace, dealIds])).rows
  const merchants = new Map((await client.query(`SELECT * FROM mca_merchants WHERE workspace_id=$1 AND id IN (SELECT merchant_id FROM deals WHERE workspace_id=$1 AND id=ANY($2::text[]))`, [workspace, dealIds])).rows.map(m => [m.id, m]))
  const merchantOwnerRows = (await client.query(`SELECT * FROM mca_merchant_owners WHERE workspace_id=$1 AND merchant_id=ANY($2::text[]) ORDER BY id`, [workspace, [...merchants.keys()]])).rows
  // EINs / display ids already used by records outside this batch must not be reused.
  const outsideEinHashes = new Set((await client.query(`SELECT ein_lookup_hash h FROM deals WHERE workspace_id=$1 AND ein_lookup_hash IS NOT NULL AND NOT id=ANY($2::text[])
    UNION SELECT ein_lookup_hash FROM mca_merchants WHERE workspace_id=$1 AND ein_lookup_hash IS NOT NULL AND id NOT IN (SELECT merchant_id FROM deals WHERE workspace_id=$1 AND merchant_id IS NOT NULL AND id=ANY($2::text[]))`, [workspace, dealIds])).rows.map(r => r.h))
  const outsideDisplayIds = new Set((await client.query(`SELECT display_id FROM deals WHERE workspace_id=$1 AND NOT id=ANY($2::text[])`, [workspace, dealIds])).rows.map(r => r.display_id))
  const sharedMerchants = (await client.query(`SELECT merchant_id FROM deals WHERE workspace_id=$1 AND merchant_id IS NOT NULL GROUP BY merchant_id HAVING count(*) > 1`, [workspace])).rows.map(r => r.merchant_id)
  const used = new Set<string>()
  return deals.map((deal, i) => {
    let profile = buildProfile(i, businesses[i], used)
    if (businesses[i].details) assert.ok(!outsideEinHashes.has(einLookupHash(workspace, profile.ein)), `CSV EIN for ${profile.dbaName} is already used by another record in this workspace`)
    else while (outsideEinHashes.has(einLookupHash(workspace, profile.ein))) profile = buildProfile(i, businesses[i], used)
    const startDate = profile.startDate ?? deal.start_date ?? undefined
    const monthlyRevenue = profile.monthlyRevenue ?? (deal.monthly_revenue === null ? undefined : Number(deal.monthly_revenue))
    const requestedAmount = profile.requestedAmount ?? (deal.requested_amount === null ? undefined : Number(deal.requested_amount))
    // The app's own format for new deals (deals/service.ts createDeal).
    const displayId = `MCA-${String(deal.id).slice(0, 8).toUpperCase()}`
    assert.ok(!outsideDisplayIds.has(displayId), `Display id ${displayId} is already used by another deal`)
    const merchantId = deal.merchant_id ?? detId(workspace, `merchant:${deal.id}`)
    assert.ok(!sharedMerchants.includes(merchantId), `Deal ${deal.id} links to a merchant shared with other deals; refusing to edit it`)
    const missing = submissionMissingFields({
      legalName: profile.legalName, entityType: profile.entityType, address: profile.address, contactPhone: profile.contactPhone,
      startDate, industry: profile.industry, monthlyRevenue, requestedAmount, fundingPurpose: profile.fundingPurpose,
      owners: profile.owners.map((o, n) => ({ id: String(n), firstName: o.firstName, lastName: o.lastName, ownershipPercent: o.ownershipPercent, isPrimary: o.isPrimary })),
    } as Pick<DealRecord, "legalName" | "entityType" | "address" | "contactPhone" | "startDate" | "industry" | "monthlyRevenue" | "requestedAmount" | "fundingPurpose" | "owners">)
    const draftState = missing.length ? "partial" : "submission_ready"
    const owners = ownersFor(workspace, `deal-owner:${deal.id}`, profile)
    const merchantOwners = ownersFor(workspace, `merchant-owner:${merchantId}`, profile)
    const ws = workspace
    const dealChanged = deal.display_id !== displayId || deal.legal_name !== profile.legalName || deal.dba_name !== profile.dbaName || deal.entity_type !== profile.entityType
      || deal.address_json !== JSON.stringify(profile.address) || deal.contact_name !== profile.contactName || deal.industry !== profile.industry || deal.funding_purpose !== profile.fundingPurpose
      || deal.missing_required_json !== JSON.stringify(missing) || deal.draft_state !== draftState || deal.merchant_id !== merchantId
      || (deal.start_date ?? undefined) !== startDate || (deal.monthly_revenue === null ? undefined : Number(deal.monthly_revenue)) !== monthlyRevenue
      || (deal.requested_amount === null ? undefined : Number(deal.requested_amount)) !== requestedAmount
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

async function insertOwners(client: pg.Client, table: "deal_owners" | "mca_merchant_owners", parentColumn: "deal_id" | "merchant_id", ws: string, parentId: string, owners: OwnerRow[]) {
  await client.query(`DELETE FROM ${table} WHERE workspace_id=$1 AND ${parentColumn}=$2`, [ws, parentId])
  for (const o of owners) await client.query(`INSERT INTO ${table} (id, workspace_id, ${parentColumn}, first_name, last_name, ownership_percent, is_primary, email_cipher, phone_cipher)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [o.id, ws, parentId, o.first_name, o.last_name, o.ownership_percent, o.is_primary, encryptSensitive(o.email, ws), encryptSensitive(o.phone, ws)])
}

async function applyPlan(client: pg.Client, ws: string, plans: Plan[]) {
  const now = new Date().toISOString(), counts = { deals: 0, dealOwnerSets: 0, merchants: 0, offers: 0, submissions: 0, submissionReasons: 0, selectionReasons: 0, statusReasons: 0 }
  const dealIds = plans.map(p => p.deal.id)
  for (const p of plans) {
    const enc = (v: string) => encryptSensitive(v, ws)
    if (p.merchantChanged) {
      await client.query(`INSERT INTO mca_merchants (id, workspace_id, legal_name, dba_name, ein_cipher, ein_lookup_hash, contact_name, contact_email_cipher, contact_phone_cipher, address_json, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
        ON CONFLICT (id) DO UPDATE SET legal_name=EXCLUDED.legal_name, dba_name=EXCLUDED.dba_name, ein_cipher=EXCLUDED.ein_cipher, ein_lookup_hash=EXCLUDED.ein_lookup_hash,
          contact_name=EXCLUDED.contact_name, contact_email_cipher=EXCLUDED.contact_email_cipher, contact_phone_cipher=EXCLUDED.contact_phone_cipher, address_json=EXCLUDED.address_json, updated_at=EXCLUDED.updated_at
        WHERE mca_merchants.workspace_id=EXCLUDED.workspace_id`,
        [p.merchantId, ws, p.profile.legalName, p.profile.dbaName, enc(p.profile.ein), einLookupHash(ws, p.profile.ein), p.profile.contactName, enc(p.profile.contactEmail), enc(p.profile.contactPhone), JSON.stringify(p.profile.address), now])
      await insertOwners(client, "mca_merchant_owners", "merchant_id", ws, p.merchantId, p.merchantOwners)
      counts.merchants++
    }
    if (p.dealChanged) {
      const result = await client.query(`UPDATE deals SET display_id=$3, legal_name=$4, dba_name=$5, entity_type=$6, address_json=$7, contact_name=$8, contact_email_cipher=$9, contact_phone_cipher=$10,
        ein_cipher=$11, ein_lookup_hash=$12, industry=$13, funding_purpose=$14, missing_required_json=$15, draft_state=$16, merchant_id=$17, version=version+1, updated_at=$18,
        start_date=$20, monthly_revenue=$21, requested_amount=$22
        WHERE workspace_id=$1 AND id=$2 AND version=$19`, [ws, p.deal.id, p.displayId, p.profile.legalName, p.profile.dbaName, p.profile.entityType, JSON.stringify(p.profile.address), p.profile.contactName,
        enc(p.profile.contactEmail), enc(p.profile.contactPhone), enc(p.profile.ein), einLookupHash(ws, p.profile.ein), p.profile.industry, p.profile.fundingPurpose, JSON.stringify(p.missing), p.draftState, p.merchantId, now, p.deal.version,
        p.startDate ?? null, p.monthlyRevenue ?? null, p.requestedAmount ?? null])
      assert.equal(result.rowCount, 1, `Deal ${p.deal.id} changed concurrently`)
      counts.deals++
    }
    if (p.ownersChanged) { await insertOwners(client, "deal_owners", "deal_id", ws, p.deal.id, p.owners); counts.dealOwnerSets++ }
  }
  const unknown = (await client.query(`SELECT DISTINCT funder_name FROM (SELECT funder_name FROM mca_offers WHERE workspace_id=$1 AND deal_id=ANY($2::text[]) UNION SELECT funder_name FROM mca_manual_submissions WHERE workspace_id=$1 AND deal_id=ANY($2::text[])) f
    WHERE funder_name ~* '^test\\M' AND NOT funder_name=ANY($3::text[])`, [ws, dealIds, Object.keys(FUNDER_NAMES)])).rows
  assert.equal(unknown.length, 0, `Unmapped TEST funder names: ${unknown.map(r => r.funder_name).join(", ")}`)
  for (const [from, to] of Object.entries(FUNDER_NAMES)) {
    counts.offers += (await client.query(`UPDATE mca_offers SET funder_name=$4, updated_at=$5 WHERE workspace_id=$1 AND deal_id=ANY($2::text[]) AND funder_name=$3`, [ws, dealIds, from, to, now])).rowCount ?? 0
    counts.submissions += (await client.query(`UPDATE mca_manual_submissions SET funder_name=$4, updated_at=$5 WHERE workspace_id=$1 AND deal_id=ANY($2::text[]) AND funder_name=$3`, [ws, dealIds, from, to, now])).rowCount ?? 0
  }
  counts.submissionReasons = (await client.query(`UPDATE mca_manual_submissions SET reason=$3 WHERE workspace_id=$1 AND deal_id=ANY($2::text[]) AND reason LIKE 'TEST ONLY %'`, [ws, dealIds, SUBMISSION_REASON])).rowCount ?? 0
  counts.selectionReasons = (await client.query(`UPDATE mca_offer_selections SET reason='Historical selection' WHERE workspace_id=$1 AND deal_id=ANY($2::text[]) AND reason='TEST historical selection'`, [ws, dealIds])).rowCount ?? 0
  counts.statusReasons = (await client.query(`UPDATE mca_advance_status_history SET reason=regexp_replace(reason, '^TEST ([0-9]+)% repaid$', '\\1% repaid (historical)')
    WHERE workspace_id=$1 AND reason ~ '^TEST [0-9]+% repaid$' AND advance_id IN (SELECT id FROM mca_advances WHERE workspace_id=$1 AND deal_id=ANY($2::text[]))`, [ws, dealIds])).rowCount ?? 0
  return counts
}

async function resolveActor(client: pg.Client, ws: string, email?: string) {
  const rows = (await client.query(`SELECT u.id user_id, u.email, m.id membership_id, m.role FROM memberships m JOIN users u ON u.id=m.user_id
    WHERE m.workspace_id=$1 AND m.status='active' AND m.role IN ('super_admin','admin') ${email ? "AND lower(u.email)=lower($2)" : ""} ORDER BY m.role DESC, m.created_at, m.id LIMIT 1`, email ? [ws, email] : [ws])).rows
  assert.ok(rows[0], "No active admin in the workspace to attribute document uploads to")
  return rows[0] as { user_id: string; email: string; membership_id: string; role: "admin" | "super_admin" }
}

function pdfDeal(p: Plan): PdfDeal {
  return { profile: p.profile, monthlyRevenue: p.monthlyRevenue ?? 50000, requestedAmount: p.requestedAmount ?? 50000, startDate: p.startDate ?? null, createdAt: p.deal.created_at, displayId: p.displayId }
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

async function uploadDocuments(client: pg.Client, ws: string, plans: Plan[], options: Options) {
  if (options.pdfOut) await mkdir(options.pdfOut, { recursive: true })
  const existing = new Map((await client.query(`SELECT id, idempotency_key, processing_state, checksum, storage_key FROM mca_documents WHERE workspace_id=$1 AND idempotency_key LIKE $2`, [ws, `${VERSION}:%`])).rows.map(r => [r.idempotency_key, r]))
  type Job = { plan: Plan; key: string; category: "statement" | "application"; pdf: { bytes: Uint8Array; filename: string }; stale?: Row }
  const jobs: Job[] = []
  for (const plan of plans) {
    jobs.push({ plan, key: `${VERSION}:${plan.deal.id}:statement`, category: "statement", pdf: await bankStatementPdf(pdfDeal(plan)) })
    jobs.push({ plan, key: `${VERSION}:${plan.deal.id}:application`, category: "application", pdf: await signedApplicationPdf(pdfDeal(plan)) })
  }
  // A ready document whose bytes differ from what the deal data now produces is stale (e.g. owners or EIN changed since it was generated).
  const pending: Job[] = [], stale: Job[] = []
  let alreadyReady = 0
  for (const j of jobs) {
    const cur = existing.get(j.key)
    if (cur && ["clean", "ready"].includes(cur.processing_state) && cur.checksum === sha256(j.pdf.bytes)) alreadyReady++
    else if (cur) stale.push({ ...j, stale: cur })
    else pending.push(j)
  }
  const result: Record<string, number> = { alreadyReady, missing: pending.length, stale: stale.length }
  if (options.pdfOut) for (const j of jobs.slice(0, 10)) await writeFile(join(options.pdfOut, `${j.plan.displayId}-${j.pdf.filename}`), j.pdf.bytes)
  if (!options.apply) return { ...result, wouldUpload: pending.length + (options.replaceStaleDocuments ? stale.length : 0), wouldReplace: options.replaceStaleDocuments ? stale.length : 0 }
  if (stale.length && !options.replaceStaleDocuments) console.error(JSON.stringify({ event: "stale_documents_kept", count: stale.length, hint: "pass --replace-stale-documents to regenerate them" }))
  if (process.env.MCA_DOCUMENT_STORAGE_PROVIDER !== "supabase") throw new Error("Set MCA_DOCUMENT_STORAGE_PROVIDER=supabase (plus SUPABASE_URL/SUPABASE_SECRET_KEY) so documents use the app's real storage path")
  const { documentScanner } = await import("../../src/lib/mca/documents/scanner")
  if (documentScanner().name === "unconfigured") throw new Error("Configure MCA_DOCUMENT_SCANNER (e.g. clamdscan) so uploads are scanned and promoted like in the app")
  const { storeDocument } = await import("../../src/lib/mca/documents/service")
  const { storageClient, quarantineBucket } = await import("../../src/lib/mca/documents/storage")
  const actor = await resolveActor(client, ws, options.actorEmail)
  const dealActor = { workspaceId: ws, userId: actor.user_id, membershipId: actor.membership_id, role: actor.role, managedMembershipIds: [], activeMembershipIds: [actor.membership_id], source: "system" as const, correlationId: `${VERSION}:${randomUUID()}` }
  const work = [...pending, ...(options.replaceStaleDocuments ? stale : [])]
  if (options.replaceStaleDocuments && stale.length) {
    const ids = stale.map(j => j.stale!.id)
    const refs = (await client.query(`SELECT count(*)::int n FROM mca_outgoing_derivatives WHERE original_document_id=ANY($1::text[])`, [ids])).rows[0].n
    assert.equal(refs, 0, "Some stale demo documents have outgoing derivatives (they were sent somewhere); refusing to replace them")
  }
  let next = 0
  const worker = async () => {
    while (next < work.length) {
      const job = work[next++]
      try {
        if (job.stale) {
          // Replace = remove the generated row and its stored object, then upload the new PDF under the same idempotency key.
          const del = await client.query(`DELETE FROM mca_documents WHERE workspace_id=$1 AND id=$2 AND idempotency_key=$3 AND source='demo_seed' AND source_reference=$4`, [ws, job.stale.id, job.key, VERSION])
          assert.equal(del.rowCount, 1, `Could not remove stale document ${job.stale.id}`)
          const storage = storageClient()
          for (const bucket of [process.env.MCA_SUPABASE_DOCUMENT_BUCKET ?? "fundlane-documents", quarantineBucket()]) await storage.storage.from(bucket).remove([job.stale.storage_key])
          result.replaced = (result.replaced ?? 0) + 1
        }
        const doc = await storeDocument(dealActor, { dealId: job.plan.deal.id, idempotencyKey: job.key, filename: job.pdf.filename, mimeType: "application/pdf", bytes: job.pdf.bytes, category: job.category, source: "demo_seed", sourceReference: VERSION })
        result[doc.processingState] = (result[doc.processingState] ?? 0) + 1
      } catch (error) {
        result.failed = (result.failed ?? 0) + 1
        console.error(JSON.stringify({ event: "document_upload_failed", deal: job.plan.displayId, category: job.category, error: error instanceof Error ? error.message : String(error) }))
      }
    }
  }
  await Promise.all(Array.from({ length: Number(process.env.HUMANIZE_UPLOAD_CONCURRENCY ?? 2) }, worker))
  if (result.replaced) await client.query(`INSERT INTO audit_events (id, workspace_id, actor_user_id, source, action, resource_type, resource_id, metadata, correlation_id, created_at)
    VALUES ($1,$2,NULL,'system','demo.humanize.documents_replaced','demo_batch',$3,$4,$5,$6)`, [randomUUID(), ws, SEED_BATCH, JSON.stringify({ version: VERSION, replaced: result.replaced }), VERSION, new Date().toISOString()])
  return result
}

export async function humanize(client: pg.Client, options: Options) {
  const businesses = parseBusinessesCsv(await readFile(options.csv, "utf8"))
  const workspace = (await client.query("SELECT id, name FROM workspaces WHERE id=$1", [options.workspace])).rows[0]
  assert.ok(workspace, `Workspace ${options.workspace} not found`)
  await client.query(options.apply ? "BEGIN ISOLATION LEVEL REPEATABLE READ" : "BEGIN READ ONLY")
  let plans: Plan[], counts: Record<string, number> | undefined
  try {
    if (options.apply) await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${VERSION}:${options.workspace}`])
    plans = await planHumanize(client, options.workspace, businesses, options.onlyCsvRows)
    if (options.apply) { counts = await applyPlan(client, options.workspace, plans); await client.query(`INSERT INTO audit_events (id, workspace_id, actor_user_id, source, action, resource_type, resource_id, metadata, correlation_id, created_at)
      VALUES ($1,$2,NULL,'system','demo.humanize.applied','demo_batch',$3,$4,$5,$6)`, [randomUUID(), options.workspace, SEED_BATCH, JSON.stringify({ version: VERSION, counts }), VERSION, new Date().toISOString()]) }
    await client.query(options.apply && counts && Object.values(counts).some(Boolean) ? "COMMIT" : "ROLLBACK")
  } catch (error) { await client.query("ROLLBACK"); throw error }
  // Documents need the deal data in place first (the PDFs show it).
  const documents = options.documents ? await uploadDocuments(client, options.workspace, options.apply ? await planHumanize(client, options.workspace, businesses, options.onlyCsvRows) : plans, options) : undefined
  return {
    mode: options.apply ? "apply" : "dry-run", workspace, deals: plans.length,
    planned: { dealUpdates: plans.filter(p => p.dealChanged).length, ownerSets: plans.filter(p => p.ownersChanged).length, merchantUpserts: plans.filter(p => p.merchantChanged).length, secondOwners: plans.filter(p => p.owners.length > 1).length, incomplete: plans.filter(p => p.missing.length).length },
    applied: counts, documents, unmatchedIndustry: plans.filter((p, i) => !businesses[i].details && !matchedIndustryRule(p.profile.dbaName)).map(p => p.profile.dbaName),
    csvDriven: businesses.some(b => b.details), untouchedDemoDeals: options.onlyCsvRows ? Math.max(0, (await client.query(`SELECT count(*)::int n FROM deals WHERE workspace_id=$1 AND idempotency_key LIKE $2`, [options.workspace, `${SEED_BATCH}:deal:%`])).rows[0].n - plans.length) : 0,
    plans,
  }
}

function arg(name: string) { return process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) }

async function main() {
  const options: Options = { workspace: arg("workspace") ?? "", csv: arg("csv") ?? "", apply: process.argv.includes("--apply"), documents: process.argv.includes("--documents"), allowProd: process.argv.includes("--allow-prod"), actorEmail: arg("actor-email"), pdfOut: arg("pdf-out"), out: arg("out"), onlyCsvRows: process.argv.includes("--only-csv-rows"), replaceStaleDocuments: process.argv.includes("--replace-stale-documents") }
  assert.ok(options.workspace && options.csv, "Usage: humanize-demo-deals.ts --workspace=<id> --csv=<businesses.csv> [--documents] [--replace-stale-documents] [--only-csv-rows] [--apply] [--pdf-out=dir] [--out=plan.json] [--reencrypt-unreadable]")
  allowUnreadable = process.argv.includes("--reencrypt-unreadable")
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL required")
  const ref = /([a-z]{20})/.exec(new URL(process.env.DATABASE_URL).username + " " + new URL(process.env.DATABASE_URL).hostname)?.[1] ?? "unknown"
  if ((ref === PROD_REF || process.env.DATABASE_URL.includes(PROD_REF)) && options.apply && !options.allowProd) throw new Error("DATABASE_URL is PRODUCTION. Re-run with --allow-prod only after the staging result has been approved.")
  if (options.documents && process.env.SUPABASE_URL && !process.env.SUPABASE_URL.includes(ref) && ref !== "unknown") throw new Error("SUPABASE_URL and DATABASE_URL point at different projects")
  const client = new pg.Client({ ...postgresConnection(process.env.DATABASE_URL), connectionTimeoutMillis: 15000 })
  await client.connect()
  try {
    const result = await humanize(client, options)
    const sample = result.plans.slice(0, 5).map(p => ({ displayId: p.displayId, legalName: p.profile.legalName, dba: p.profile.dbaName, owner: p.profile.contactName, owners: p.profile.owners.map(o => `${o.firstName} ${o.lastName} ${o.ownershipPercent}%`), phone: p.profile.contactPhone, email: p.profile.contactEmail, ein: p.profile.ein, entityType: p.profile.entityType, industry: p.profile.industry, purpose: p.profile.fundingPurpose, city: `${p.profile.address.city}, ${p.profile.address.state}`, startDate: p.startDate, monthlyRevenue: p.monthlyRevenue, requestedAmount: p.requestedAmount, ownerContacts: p.profile.owners.map(o => `${o.email} ${o.phone}`) }))
    if (options.out) await writeFile(resolve(options.out), JSON.stringify({ ...result, plans: result.plans.map(p => ({ dealId: p.deal.id, from: p.deal.legal_name, displayId: p.displayId, merchantId: p.merchantId, draftState: p.draftState, profile: p.profile })) }, null, 2) + "\n", { mode: 0o600 })
    console.log(JSON.stringify({ projectRef: ref, ...result, plans: undefined, unreadableCiphersReencrypted: unreadableCount, sample }, null, 2))
  } finally { await client.end() }
  process.exit(process.exitCode ?? 0) // the app's DB pool (used for documents) keeps the event loop alive
}
if (process.argv[1] && resolve(process.argv[1]).endsWith("scripts/demo/humanize-demo-deals.ts")) main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exit(1) })

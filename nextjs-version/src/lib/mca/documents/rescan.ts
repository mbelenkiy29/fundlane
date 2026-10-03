import "server-only"

import { createHash } from "node:crypto"
import { getDatabase, nowIso, recordAuditEvent, withImmediateTransaction } from "../db"
import { AppError } from "../errors"
import type { DealActor } from "../deals/schema"
import { isDocumentReady, NOT_SCANNED_PROVIDER, wasScanBypassed } from "./contracts"
import { findDocumentWithScanSnapshot, markDocumentNotScannedIfUnchanged, updateDocumentScanIfUnchanged, type DocumentRecord, type DocumentScanSnapshot } from "./repository"
import { documentScanner, scanBypassEnabled, SCAN_BYPASS_NOTE } from "./scanner"
import { documentStorage } from "./storage"

export interface RescanOptions {
  /** Default false: preview only, nothing is written. */
  apply?: boolean
  /** Explicit document IDs (e.g. the list of files released under the bypass). */
  ids?: string[]
  /** Also find files whose `document.ready` audit row says no malware scan ran. */
  includeAudit?: boolean
  /** Instead of scanning, add the "not scanned" marker to listed files that lack it. Requires `ids`. */
  backfillMarker?: boolean
  /** Required with `apply`: must equal `databaseIdentity(DATABASE_URL)` ("user@host/database", never the password). */
  confirmDatabase?: string
}

export interface RescanResult {
  mode: "rescan" | "backfill_marker"
  apply: boolean
  database: string
  /** The target is the production database (see isProductionDatabase). */
  productionDatabase: boolean
  scanner: string
  scannerReady: boolean
  candidates: number
  /** IDs from the list that are not documents in this workspace. */
  notFound: string[]
  /** Files that are not available (pending, failed or quarantined); never touched. */
  notReady: { id: string; state: string }[]
  /** Files a real scanner already cleared; skipped so reruns are no-ops. */
  alreadyScanned: number
  rescannedClean: number
  quarantined: string[]
  markerBackfilled: number
  /** Files left exactly as they were because the scan or the stored bytes could not be checked. */
  failed: { id: string; code: string }[]
  /**
   * Files whose scan columns changed between the read and the write (e.g. a concurrent scan or quarantine).
   * Nothing is written and no audit row is added; not a failure.
   */
  changedConcurrently: string[]
}

/**
 * "user@host/database" of a Postgres URL, so an operator can confirm the exact target. The username is included because
 * Supabase pooler URLs share one host and database across projects; the project ref is only in the username
 * (`mca_app.<ref>`, `postgres.<ref>`). The password and port are never included.
 */
export function databaseIdentity(url = process.env.DATABASE_URL): string {
  if (!url) return ""
  try {
    const parsed = new URL(url)
    const user = decodeURIComponent(parsed.username)
    return `${user ? `${user}@` : ""}${parsed.hostname}/${decodeURIComponent(parsed.pathname.replace(/^\/+/, ""))}`
  } catch { return "" }
}

/** Supabase project ref of the production database. */
export const PRODUCTION_PROJECT_REF = "drubsfvhlggmtyiigwxy"

/**
 * True when the URL's host or username contains the production project ref, e.g. the pooler user
 * `postgres.<ref>` or the direct host `db.<ref>.supabase.co`. Only host and username are inspected; nothing is returned or logged.
 */
export function isProductionDatabase(url = process.env.DATABASE_URL): boolean {
  if (!url) return false
  const ref = PRODUCTION_PROJECT_REF
  try {
    const parsed = new URL(url)
    return parsed.hostname.toLowerCase().includes(ref) || decodeURIComponent(parsed.username).toLowerCase().includes(ref)
  } catch {
    // Unparseable URL: err on the side of warning.
    return url.toLowerCase().includes(ref)
  }
}

/** Loud banner for operators; contains no part of the connection string. */
export function productionDatabaseWarning(apply: boolean): string {
  const bar = "!".repeat(78)
  return [bar, `!!! PRODUCTION DATABASE (Supabase project ${PRODUCTION_PROJECT_REF}) !!!`,
    apply ? "!!! --apply WILL CHANGE PRODUCTION DOCUMENTS. Infrastructure only, with a fresh backup taken first. !!!"
      : "!!! Preview only (nothing is written), but this is PRODUCTION. Any --apply goes through Infrastructure. !!!", bar].join("\n")
}

function assertCanWrite(options: RescanOptions, database: string) {
  if (!database) throw new AppError(503, "rescan_database_unknown", "DATABASE_URL is not set or cannot be parsed; refusing to write.")
  if (options.confirmDatabase !== database) {
    throw new AppError(412, "rescan_database_unconfirmed", `Refusing to write: pass --confirm-database=${database} to confirm the target database.`)
  }
}

/** A real scanner is required: the bypass scanner and an unconfigured scanner can never clear a file. */
function realScanner() {
  const scanner = documentScanner()
  const ready = !scanBypassEnabled() && scanner.name !== NOT_SCANNED_PROVIDER && scanner.name !== "unconfigured"
  return { scanner, ready }
}

function realScanPerformed(record: DocumentRecord): boolean {
  return !wasScanBypassed(record.scanProvider, record.scanEvidence) && record.scanEvidence?.malwareScanPerformed === true
}

const BATCH = 100

async function candidateIds(workspaceId: string, options: RescanOptions): Promise<string[]> {
  const ids = new Set<string>()
  if (options.ids?.length) for (const id of options.ids) ids.add(id)
  if (options.backfillMarker) return [...ids].sort()
  let cursor = ""
  while (true) {
    const rows = await getDatabase().prepare<{ id: string }>(`SELECT id FROM mca_documents
      WHERE workspace_id = ? AND id > ? AND scan_provider = ? ORDER BY id LIMIT ${BATCH}`).all(workspaceId, cursor, NOT_SCANNED_PROVIDER)
    if (!rows.length) break
    for (const row of rows) { ids.add(row.id); cursor = row.id }
  }
  if (options.includeAudit) {
    cursor = ""
    while (true) {
      const rows = await getDatabase().prepare<{ id: string }>(`SELECT DISTINCT resource_id AS id FROM audit_events
        WHERE workspace_id = ? AND resource_type = 'document' AND action = 'document.ready'
          AND metadata LIKE '%"malwareScanPerformed":false%' AND resource_id > ?
        ORDER BY resource_id LIMIT ${BATCH}`).all(workspaceId, cursor)
      if (!rows.length) break
      for (const row of rows) { ids.add(row.id); cursor = row.id }
    }
  }
  return [...ids].sort()
}

/**
 * Rescans files that the scan bypass let through, with a real scanner. Explicit maintenance only:
 * tenant-scoped, preview by default, and idempotent (files a real scanner already cleared are skipped).
 * Clean: the real provider and evidence replace the "not scanned" marker, plus a `document.rescanned` audit row.
 * Infected: the file becomes `quarantined` (downloads and submissions stop), plus an audit row.
 * Scanner error, unreadable or changed bytes: the file is left exactly as it was and reported in `failed`.
 */
export async function rescanBypassedDocuments(actor: DealActor, options: RescanOptions = {}): Promise<RescanResult> {
  if (actor.source !== "system" || actor.role !== "admin") {
    throw new AppError(403, "rescan_forbidden", "Document rescans require a system administrator.")
  }
  if (options.backfillMarker && !options.ids?.length) {
    throw new AppError(422, "rescan_ids_required", "The marker backfill only takes an explicit ID list.")
  }
  const apply = options.apply === true
  const database = databaseIdentity()
  const { scanner, ready } = realScanner()
  if (apply) assertCanWrite(options, database)
  if (apply && !options.backfillMarker && !ready) {
    throw new AppError(503, "rescan_scanner_unavailable", "Refusing to rescan: turn MCA_DOCUMENT_SCAN_BYPASS off and configure a real MCA_DOCUMENT_SCANNER first.")
  }
  const result: RescanResult = {
    mode: options.backfillMarker ? "backfill_marker" : "rescan", apply, database, productionDatabase: isProductionDatabase(), scanner: scanner.name, scannerReady: ready,
    candidates: 0, notFound: [], notReady: [], alreadyScanned: 0, rescannedClean: 0, quarantined: [], markerBackfilled: 0, failed: [],
    changedConcurrently: [],
  }
  for (const id of await candidateIds(actor.workspaceId, options)) {
    const found = await findDocumentWithScanSnapshot(actor.workspaceId, id)
    if (!found) { result.notFound.push(id); continue }
    const { record, seen } = found
    if (!isDocumentReady(record.processingState)) { result.notReady.push({ id, state: record.processingState }); continue }
    if (realScanPerformed(record)) { result.alreadyScanned++; continue }
    if (options.backfillMarker && wasScanBypassed(record.scanProvider, record.scanEvidence)) { result.alreadyScanned++; continue }
    result.candidates++
    if (!apply) continue
    if (options.backfillMarker) {
      // The label and its audit row are written together, and only if the row is unchanged since it was read.
      const written = await withImmediateTransaction(async (executor) => {
        if (!await markDocumentNotScannedIfUnchanged(executor, actor.workspaceId, id, seen,
          { ...record.scanEvidence, scanBypassed: true, malwareScanPerformed: false, note: SCAN_BYPASS_NOTE, markerBackfilled: true }, nowIso())) return false
        await recordAuditEvent({ context: actor, action: "document.scan_marker_backfilled", resourceType: "document", resourceId: id,
          metadata: { previousProvider: record.scanProvider ?? null, malwareScanPerformed: false }, correlationId: actor.correlationId, executor })
        return true
      })
      if (written) result.markerBackfilled++
      else result.changedConcurrently.push(id)
      continue
    }
    try {
      await rescanOne(actor, record, seen, result)
    } catch (error) {
      result.failed.push({ id, code: error instanceof AppError ? error.code : "rescan_failed" })
    }
  }
  return result
}

async function rescanOne(actor: DealActor, record: DocumentRecord, seen: DocumentScanSnapshot, result: RescanResult) {
  let bytes: Uint8Array
  try { bytes = await documentStorage().get(record.storageKey) }
  catch { result.failed.push({ id: record.id, code: "document_storage_unavailable" }); return }
  if (bytes.byteLength !== record.byteLength || createHash("sha256").update(bytes).digest("hex") !== record.checksum) {
    result.failed.push({ id: record.id, code: "document_integrity_failed" }); return
  }
  const { scanner, ready } = realScanner()
  if (!ready) { result.failed.push({ id: record.id, code: "scanner_unavailable" }); return }
  const scan = await scanner.scan(bytes, record.originalFilename)
  if ((scan.status !== "clean" && scan.status !== "infected") || scan.evidence.scanBypassed === true || scan.provider === NOT_SCANNED_PROVIDER) {
    result.failed.push({ id: record.id, code: `scan_${scan.status}` }); return
  }
  const state = scan.status === "clean" ? record.processingState : "quarantined"
  // Compare-and-set: write only if every scan column still equals what was read before the scan, and write the
  // audit row in the same transaction. A concurrent scan or quarantine wins; this file is then reported, not overwritten.
  const written = await withImmediateTransaction(async (executor) => {
    if (!await updateDocumentScanIfUnchanged(executor, actor.workspaceId, record.id, seen, { state, provider: scan.provider,
      evidence: { checksumVerified: true, ...scan.evidence, malwareScanPerformed: true, rescannedAfterBypass: true, previousProvider: record.scanProvider ?? null },
      attemptedAt: nowIso() })) return false
    await recordAuditEvent({ context: actor, action: "document.rescanned", resourceType: "document", resourceId: record.id,
      metadata: { state, provider: scan.provider, malwareScanPerformed: true, previousProvider: record.scanProvider ?? null }, correlationId: actor.correlationId, executor })
    return true
  })
  if (!written) result.changedConcurrently.push(record.id)
  else if (scan.status === "clean") result.rescannedClean++
  else result.quarantined.push(record.id)
}

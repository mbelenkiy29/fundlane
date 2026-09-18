import { CloudmersiveScanner } from "../../../src/lib/mca/documents/cloudmersive"
import { requireWorkerCredential } from "../../../src/lib/mca/jobs/edge-auth"
import { apiError, AppError } from "../../../src/lib/mca/errors"
import { encryptSensitive, decryptSensitive } from "../../../src/lib/mca/crypto"
import { getDatabase, withTransaction } from "../../../src/lib/mca/db"
import { parseSpreadsheet } from "../../../src/lib/mca/imports/parser"
import { runNextBackgroundJob } from "../../../src/lib/mca/jobs/worker"
import { runMessagingWorkerOnce } from "../../../src/lib/mca/email-conversations/worker"

// These references intentionally validate the complete worker module graph on cold start.
const moduleGraph = [runNextBackgroundJob, runMessagingWorkerOnce]

export default async function handle(request: Request): Promise<Response> {
  try {
    requireWorkerCredential(request, process.env.MCA_EDGE_FEASIBILITY_TOKEN)
    const expiresAt = Date.parse(process.env.MCA_EDGE_FEASIBILITY_EXPIRES_AT ?? "")
    if (!Number.isFinite(expiresAt) || !process.env.MCA_EDGE_FEASIBILITY_PROJECT_REF || new URL(process.env.SUPABASE_URL ?? "http://invalid").hostname !== `${process.env.MCA_EDGE_FEASIBILITY_PROJECT_REF}.supabase.co` || Date.now() >= expiresAt) {
      throw new AppError(403, "probe_disabled", "This temporary feasibility probe is disabled.")
    }
    const scenario = new URL(request.url).searchParams.get("case") ?? "dependencies"
    const started = performance.now()
    let result: unknown
    switch (scenario) {
      case "scanner": {
        const fixture = new URL(request.url).searchParams.get("fixture") ?? "clean"
        if (!["clean", "eicar", "maximum"].includes(fixture)) throw new AppError(400, "invalid_fixture", "Unknown synthetic scanner fixture.")
        const bytes = fixture === "maximum" ? Buffer.alloc(25 * 1024 * 1024, 65) : Buffer.from(fixture === "eicar"
          ? 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*' : "Fundlane synthetic clean test")
        result = await new CloudmersiveScanner().scan(bytes, "synthetic-test.txt"); break
      }
      case "dependencies": result = { loadedWorkers: moduleGraph.length, databaseConfigured: Boolean(process.env.DATABASE_URL), encryptionConfigured: Boolean(process.env.MCA_DATA_ENCRYPTION_KEY), adminConfigured: Boolean(process.env.SUPABASE_SECRET_KEY) }; break
      case "crypto": {
        const plaintext = "synthetic-fundlane-fixture"
        const encrypted = encryptSensitive(plaintext, "synthetic-workspace")
        if (decryptSensitive(encrypted, "synthetic-workspace") !== plaintext) throw new Error("Encryption parity failed")
        let rejected = false
        try { decryptSensitive(encrypted, "other-workspace") } catch { rejected = true }
        if (!rejected) throw new Error("Workspace AAD was not enforced")
        result = { roundTrip: true, workspaceIsolation: true }; break
      }
      case "database": {
        result = await withTransaction(async db => {
          const row = await db.queryOne<{ transaction: string }>("SELECT txid_current()::text AS transaction")
          const nested = await getDatabase().queryOne<{ transaction: string }>("SELECT txid_current()::text AS transaction")
          if (row?.transaction !== nested?.transaction) throw new Error("Transaction context was not preserved")
          return { transactionContext: true }
        }); break
      }
      case "spreadsheet": {
        const filename = request.headers.get("x-fixture-filename") ?? "fixture.csv"
        if (!/^fixture\.(csv|tsv|xlsx|xls)$/.test(filename)) throw new AppError(400, "invalid_fixture", "Use a synthetic spreadsheet fixture.")
        const max = 25 * 1024 * 1024
        const reader = request.body?.getReader()
        if (!reader) throw new AppError(400, "fixture_required", "Supply a synthetic fixture.")
        const parts: Uint8Array[] = []; let length = 0
        try {
          while (true) {
            const chunk = await reader.read(); if (chunk.done) break
            length += chunk.value.byteLength
            if (length > max) { await reader.cancel(); throw new AppError(413, "fixture_too_large", "Fixture exceeds the existing upload limit.") }
            parts.push(chunk.value)
          }
        } finally { reader.releaseLock() }
        const bytes = Buffer.concat(parts)
        const parsed = parseSpreadsheet({ filename, bytes })
        result = { bytes: length, rows: parsed.rows.length, columns: parsed.headers.length }; break
      }
      default: throw new AppError(400, "unknown_scenario", "Unknown feasibility scenario.")
    }
    return Response.json({ scenario, wallMs: performance.now() - started, result }, { headers: { "cache-control": "no-store" } })
  } catch (error) {
    if (error instanceof AppError) return apiError(error)
    // Only authenticated, synthetic probe failures reach here; never return provider bodies or settings.
    let message = error instanceof Error ? error.message : "Unknown runtime failure"
    for (const value of Object.values(process.env)) if (value && value.length >= 8) message = message.split(value).join("[redacted]")
    message = message.replace(/(?:postgres(?:ql)?|https?):\/\/[^\s]+/g, "[redacted URL]")
    return Response.json({ code: "probe_failed", message: message.slice(0, 300) }, { status: 500 })
  }
}

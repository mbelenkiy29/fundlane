import { createHash, timingSafeEqual } from "node:crypto"
import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import { applyData, applyDocuments, backup, backupFile, dryRun, restore, restoreFiles, verify } from "@/lib/mca/demo-humanize/service"

/**
 * ONE-TIME maintenance endpoint (remove after use): replaces the 120 seeded "TEST" sample deals of
 * Sentinel Tech Solutions with the client's sample businesses, using this deployment's own encryption key and storage.
 * Hard-scoped to one company; the service only touches deals whose idempotency_key is in the seed batch.
 */
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

const WORKSPACE_ID = "c880cbaf-f18d-4050-beab-840220624406"
/** sha256 of a random one-time bearer token held by the operator (the token itself is never committed). */
const TOKEN_SHA256 = "08820e0101ab9a5f0f1929be8e312a256c1a67ba8117341a6002ad3f57694ad3"
const EXPIRES_AT = Date.parse("2026-10-10T00:00:00Z")
const SAMPLE_DEALS = ["Maple Ridge Auto Repair", "Bluewater Seafood Grill", "Whitebridge Hardwood Floors"]
const MODES = ["dry-run", "backup", "backup-file", "apply-data", "apply-documents", "verify", "restore", "restore-files"] as const
const WRITE_MODES: readonly string[] = ["apply-data", "apply-documents", "restore", "restore-files"]

function authorize(request: Request) {
  if (Date.now() > EXPIRES_AT) throw new AppError(410, "expired", "This one-time endpoint has expired.")
  const header = request.headers.get("authorization") ?? ""
  const token = header.startsWith("Bearer ") ? header.slice(7) : ""
  const digest = createHash("sha256").update(token).digest()
  const tokenOk = token.length >= 32 && timingSafeEqual(digest, Buffer.from(TOKEN_SHA256, "hex"))
  if (!tokenOk) throw new AppError(401, "unauthorized", "Invalid credentials.")
}

export async function POST(request: Request) {
  try {
    authorize(request)
    const body = await request.json().catch(() => ({})) as { mode?: string; confirm?: string; limit?: number; backup?: unknown; documentId?: string; files?: unknown }
    const mode = MODES.find(m => m === body.mode)
    if (!mode) throw new AppError(422, "invalid_mode", `mode must be one of: ${MODES.join(", ")}`)
    // Writes need the company id echoed back, so a mistyped mode can never write.
    // Writes only in the production deployment (the service enforces this too).
    if (WRITE_MODES.includes(mode) && process.env.VERCEL_ENV !== "production") throw new AppError(403, "production_only", "Write modes run only in the production deployment.")
    if (WRITE_MODES.includes(mode) && body.confirm !== WORKSPACE_ID) throw new AppError(422, "confirm_required", "Write modes require confirm=<company id>.")
    const result = mode === "dry-run" ? await dryRun(WORKSPACE_ID)
      : mode === "backup" ? await backup(WORKSPACE_ID)
      : mode === "backup-file" ? await backupFile(WORKSPACE_ID, String(body.documentId ?? ""))
      : mode === "apply-data" ? await applyData(WORKSPACE_ID)
      : mode === "apply-documents" ? await applyDocuments(WORKSPACE_ID, Math.min(Math.max(Number(body.limit) || 20, 1), 60), 240_000)
      : mode === "verify" ? await verify(WORKSPACE_ID, SAMPLE_DEALS)
      : mode === "restore" ? await restore(WORKSPACE_ID, body.backup as Parameters<typeof restore>[1])
      : await restoreFiles(WORKSPACE_ID, Array.isArray(body.files) ? body.files as Parameters<typeof restoreFiles>[1] : [])
    console.info(JSON.stringify({ event: "demo_humanize", mode, workspaceId: WORKSPACE_ID }))
    return NextResponse.json({ mode, result }, { headers: { "cache-control": "no-store" } })
  } catch (error) {
    if (error instanceof Error && error.name === "AssertionError") return NextResponse.json({ error: { code: "precondition_failed", message: error.message } }, { status: 409, headers: { "cache-control": "no-store" } })
    return apiError(error)
  }
}

import { NextResponse } from "next/server"
import { consumeRequestRateLimit } from "@/lib/mca/auth"
import { apiError, AppError } from "@/lib/mca/errors"
import { commitFunderImport, requireFunderImportActor } from "@/lib/mca/funders/import"
import type { FunderImportDraft } from "@/lib/mca/funders/contracts"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function POST(request: Request) {
  try {
    const actor = await requireFunderImportActor(request)
    await consumeRequestRateLimit(`funder-import-commit:${actor.workspaceId}:${actor.membershipId}`, 10)
    let body: { idempotencyKey?: string; rows?: Array<{ key: string; included?: boolean; draft: FunderImportDraft }> } | unknown
    try {
      body = await request.json()
    } catch {
      throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
    }
    const payload = body as { idempotencyKey?: string; rows?: Array<{ key: string; included?: boolean; draft: FunderImportDraft }> }
    return NextResponse.json(await commitFunderImport(actor, {
      idempotencyKey: payload.idempotencyKey ?? "",
      rows: payload.rows ?? [],
    }), { headers: noStore, status: 201 })
  } catch (error) {
    return apiError(error)
  }
}

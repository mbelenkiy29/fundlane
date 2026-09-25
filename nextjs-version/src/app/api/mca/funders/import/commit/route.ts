import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import { commitFunderImport, requireFunderImportActor } from "@/lib/mca/funders/import"
import type { FunderImportDraft } from "@/lib/mca/funders/contracts"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function POST(request: Request) {
  try {
    const actor = await requireFunderImportActor(request)
    let body: { idempotencyKey?: string; rows?: Array<{ key: string; included?: boolean; draft: FunderImportDraft }> }
    try {
      body = await request.json() as { idempotencyKey?: string; rows?: Array<{ key: string; included?: boolean; draft: FunderImportDraft }> }
    } catch {
      throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
    }
    return NextResponse.json(await commitFunderImport(actor, {
      idempotencyKey: body.idempotencyKey ?? "",
      rows: body.rows ?? [],
    }), { headers: noStore, status: 201 })
  } catch (error) {
    return apiError(error)
  }
}

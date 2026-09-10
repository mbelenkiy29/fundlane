import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import {
  listAdapterConnections,
  requireAdapterAdmin,
  requireAdapterRead,
  upsertAdapterCredential,
  type UpsertAdapterCredentialInput,
} from "@/lib/mca/submissions/adapters/credentials"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function GET(request: Request) {
  try {
    const actor = await requireAdapterRead(request)
    return NextResponse.json(await listAdapterConnections(actor), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireAdapterAdmin(request)
    let input: UpsertAdapterCredentialInput
    try {
      input = await request.json() as UpsertAdapterCredentialInput
    } catch {
      throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
    }
    const saved = await upsertAdapterCredential(actor, input)
    return NextResponse.json(saved, { status: 201, headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

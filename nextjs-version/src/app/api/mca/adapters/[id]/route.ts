import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import {
  deactivateAdapterCredential,
  getAdapterCredential,
  requireAdapterAdmin,
  requireAdapterRead,
  updateAdapterCredential,
  type UpsertAdapterCredentialInput,
} from "@/lib/mca/submissions/adapters/credentials"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

interface RouteContext { params: Promise<{ id: string }> }

export async function GET(request: Request, context: RouteContext) {
  try {
    const actor = await requireAdapterRead(request)
    return NextResponse.json(await getAdapterCredential(actor, (await context.params).id), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const actor = await requireAdapterAdmin(request)
    let input: Partial<UpsertAdapterCredentialInput>
    try {
      input = await request.json() as Partial<UpsertAdapterCredentialInput>
    } catch {
      throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
    }
    return NextResponse.json(await updateAdapterCredential(actor, (await context.params).id, input), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const actor = await requireAdapterAdmin(request)
    return NextResponse.json(await deactivateAdapterCredential(actor, (await context.params).id), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

import { NextResponse } from "next/server"
import { assertTrustedMutation, requireWorkspaceAccess } from "@/lib/mca/auth"
import { actorForDeals } from "@/lib/mca/deals/service"
import { apiError, AppError } from "@/lib/mca/errors"
import { createFunder, listFunders, type CreateFunderInput } from "@/lib/mca/funders/directory"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function GET(request: Request) {
  try {
    const actor = await actorForDeals(await requireWorkspaceAccess(request, { scopes: ["deals:read"] }))
    const includeInactive = new URL(request.url).searchParams.get("includeInactive") === "true"
    return NextResponse.json({ funders: await listFunders(actor, { includeInactive }) }, { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    const actor = await actorForDeals(await requireWorkspaceAccess(request, { sessionOnly: true, roles: ["admin", "super_admin"] }))
    let input: CreateFunderInput
    try {
      input = await request.json() as CreateFunderInput
    } catch {
      throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
    }
    const result = await createFunder(actor, input)
    return NextResponse.json(result.funder, {
      status: result.created ? 201 : 200,
      headers: { ...noStore, "x-idempotent-replay": result.created ? "false" : "true" },
    })
  } catch (error) {
    return apiError(error)
  }
}

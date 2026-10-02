import { NextResponse } from "next/server"
import { requireSuperAdmin } from "@/lib/mca/platform-auth"
import { apiError, AppError } from "@/lib/mca/errors"
import { enrollmentQueueQuerySchema } from "@/lib/mca/onboarding/operator-contracts"
import { listEnrollmentOperations } from "@/lib/mca/onboarding/operator"

export async function GET(request: Request) {
  try {
    const actor = await requireSuperAdmin(request)
    const query = enrollmentQueueQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams))
    if (!query.success) throw new AppError(422, "invalid_query", "Invalid enrollment filters.")
    return NextResponse.json(await listEnrollmentOperations(actor, query.data), { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) {
    const response = apiError(error)
    response.headers.set("Cache-Control", "private, no-store")
    return response
  }
}

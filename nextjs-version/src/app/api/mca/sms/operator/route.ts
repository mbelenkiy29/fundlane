import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
const json = (data: unknown) =>
  NextResponse.json(data, { headers: { "cache-control": "no-store" } })
import { requireWorkspaceAccess, assertTrustedMutation } from "@/lib/mca/auth"
import {
  reviewQueue,
  reviewCompany,
  reviewSchema,
} from "@/lib/mca/sms/onboarding"
export async function GET(request: Request) {
  try {
    return json(
      await reviewQueue(
        await requireWorkspaceAccess(request, { sessionOnly: true })
      )
    )
  } catch (e) {
    return apiError(e)
  }
}
export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    return json(
      await reviewCompany(
        await requireWorkspaceAccess(request, { sessionOnly: true }),
        await readJson(request, reviewSchema)
      )
    )
  } catch (e) {
    return apiError(e)
  }
}

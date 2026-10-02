import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { requireBusinessActor } from "@/lib/mca/onboarding/business-profile"
import { getOnboardingReadiness } from "@/lib/mca/onboarding/readiness"
export const runtime = "nodejs"
export async function GET(request: Request) { try { return NextResponse.json(await getOnboardingReadiness(await requireBusinessActor(request)), { headers: { "cache-control": "no-store" } }) } catch (e) { return apiError(e) } }

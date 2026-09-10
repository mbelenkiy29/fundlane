import { NextResponse } from "next/server"
import { z } from "zod"
import { assertTrustedMutation, requireWorkspaceAccess } from "@/lib/mca/auth"
import { actorForDeals } from "@/lib/mca/deals/service"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { getRenewalPolicy, saveRenewalPolicy } from "@/lib/mca/renewals/service"

const schema = z.object({ paidInThresholdBasisPoints: z.number().int().min(0).max(10_000), minimumDaysSinceFunding: z.number().int().nonnegative().safe() }).strict()
async function actor(request: Request) { return actorForDeals(await requireWorkspaceAccess(request, { sessionOnly: true, roles: ["admin", "super_admin"] })) }
export async function GET(request: Request) { try { return NextResponse.json({ policy: await getRenewalPolicy(await actor(request)) }) } catch (error) { return apiError(error) } }
export async function PUT(request: Request) {
  try { assertTrustedMutation(request); return NextResponse.json(await saveRenewalPolicy(await actor(request), await readJson(request, schema))) }
  catch (error) { return apiError(error) }
}


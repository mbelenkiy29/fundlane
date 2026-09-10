import { z } from "zod"
import { NextResponse } from "next/server"
import { assertTrustedMutation, requireWorkspaceAccess } from "@/lib/mca/auth"
import { actorForDeals } from "@/lib/mca/deals/service"
import { apiError } from "@/lib/mca/errors"
import { replayEmailIntake } from "@/lib/mca/intake/email"
import { recordAuditEvent } from "@/lib/mca/db"
import { appOrigin, readJson } from "@/lib/mca/http"
import { replayIntake } from "@/lib/mca/intake/service"

export const runtime = "nodejs"
interface Context { params: Promise<{ intakeId: string }> }

export async function POST(request: Request, context: Context) {
  try {
    assertTrustedMutation(request)
    const auth = await requireWorkspaceAccess(request, { scopes: ["intake:write"] })
    const body = await readJson(request, z.object({ reviewedApplication: z.object({ legalName: z.string().trim().min(1).max(200), contactEmail: z.email().optional(), contactPhone: z.string().trim().max(40).optional() }).strict().optional() }).strict())
    if (body.reviewedApplication) {
      const intakeId = (await context.params).intakeId
      const result = await replayEmailIntake(await actorForDeals(auth), intakeId, { appOrigin: appOrigin(request), reviewedApplication: body.reviewedApplication })
      await recordAuditEvent({ context: auth, action: "intake.email_reviewed", resourceType: "intake", resourceId: intakeId, metadata: { result: "state" in result ? result.state : "review" } })
      return NextResponse.json(result)
    }
    return NextResponse.json(await replayIntake(await actorForDeals(auth), (await context.params).intakeId, appOrigin(request)))
  } catch (error) { return apiError(error) }
}

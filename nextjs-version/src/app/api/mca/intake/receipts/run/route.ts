import { NextResponse } from "next/server"
import { assertTrustedMutation, requireMembershipAccess } from "@/lib/mca/auth"
import { apiError } from "@/lib/mca/errors"
import { deliverPendingReceipts } from "@/lib/mca/intake/email"
import { intakeWorkerScope } from "@/lib/mca/intake/worker-auth"
import { getDatabase } from "@/lib/mca/db"
import { privateEmailDeliveryEnabled, privateEmailUiEnabled } from "@/lib/mca/intake/email-readiness"

export const runtime = "nodejs"
export async function GET(request: Request) {
  try {
    const actor = await requireMembershipAccess(request, ["admin", "super_admin"])
    if (!privateEmailUiEnabled()) return NextResponse.json({ receipts: [], deliveryEnabled: false }, { headers: { "cache-control": "private, no-store" } })
    const receipts = await getDatabase().prepare<{ id: string; intakeId: string; state: string; attempts: number; error: string | null }>(
      `SELECT id,intake_id AS "intakeId",state,attempt_count AS attempts,last_error AS error
       FROM intake_receipts WHERE workspace_id=? AND state='failed' ORDER BY updated_at DESC LIMIT 100`,
    ).all(actor.workspaceId)
    return NextResponse.json({ receipts, deliveryEnabled: privateEmailDeliveryEnabled() }, { headers: { "cache-control": "private, no-store" } })
  } catch (error) { return apiError(error) }
}
export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    const scope = await intakeWorkerScope(request)
    return NextResponse.json({ receipts: await deliverPendingReceipts({ workspaceId: scope.workspaceId }) })
  } catch (error) { return apiError(error) }
}

import { NextResponse } from "next/server"
import { assertTrustedMutation } from "@/lib/mca/auth"
import { apiError } from "@/lib/mca/errors"
import { deliverPendingReceipts } from "@/lib/mca/intake/email"
import { intakeWorkerScope } from "@/lib/mca/intake/worker-auth"

export const runtime = "nodejs"
export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    const scope = await intakeWorkerScope(request)
    return NextResponse.json({ receipts: await deliverPendingReceipts({ workspaceId: scope.workspaceId }) })
  } catch (error) { return apiError(error) }
}

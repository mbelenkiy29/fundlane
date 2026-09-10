import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { requireSmsActor } from "@/lib/mca/sms/http"
const json = (data: unknown) =>
  NextResponse.json(data, { headers: { "cache-control": "no-store" } })
import {
  requestProvisioning,
  provisionSchema,
  runProvisioning,
  refreshCompany,
} from "@/lib/mca/sms/provisioning"
import { consumeRequestRateLimit } from "@/lib/mca/auth"
export async function POST(request: Request) {
  try {
    const actor = await requireSmsActor(request, {
      mode: "write",
      admin: true,
      settings: true,
    })
    await consumeRequestRateLimit(`sms-provision:${actor.workspaceId}`, 5)
    const op = await requestProvisioning(
      actor,
      await readJson(request, provisionSchema)
    )
    return json(op)
  } catch (e) {
    return apiError(e)
  }
}
export async function PATCH(request: Request) {
  try {
    const actor = await requireSmsActor(request, {
      mode: "write",
      admin: true,
      settings: true,
    })
    await consumeRequestRateLimit(`sms-refresh:${actor.workspaceId}`, 5)
    const { getDatabase } = await import("@/lib/mca/db")
    const ops = await getDatabase()
      .prepare<{
        id: string
      }>("SELECT id FROM sms_operations WHERE workspace_id=? AND state IN ('queued','running') ORDER BY created_at LIMIT 1")
      .all(actor.workspaceId)
    for (const op of ops) await runProvisioning(op.id)
    await refreshCompany(actor.workspaceId)
    return json({ refreshed: true })
  } catch (e) {
    return apiError(e)
  }
}

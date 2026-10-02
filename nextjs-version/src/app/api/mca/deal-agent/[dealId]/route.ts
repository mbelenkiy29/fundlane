import { NextResponse } from "next/server"
import { z } from "zod"
import { requireClosingActor } from "@/lib/mca/closing/http"
import { decideDealAgentAction, listDealAgent } from "@/lib/mca/deal-agent/actions"
import { dealAgentEnabled } from "@/lib/mca/deal-agent/run"
import { apiError, AppError } from "@/lib/mca/errors"
import { appOrigin, readJson } from "@/lib/mca/http"

export const runtime = "nodejs"

const decisionSchema = z.object({
  actionId: z.string().min(1).max(128),
  decision: z.enum(["review", "approve", "dismiss"]),
  senderId: z.string().max(128).optional(),
  note: z.string().trim().max(500).optional(),
}).strict()

export async function GET(request: Request, { params }: { params: Promise<{ dealId: string }> }) {
  try {
    const actor = await requireClosingActor(request, "read")
    const body = await dealAgentEnabled(actor.workspaceId) ? await listDealAgent(actor, (await params).dealId) : { enabled: false }
    return NextResponse.json(body, { headers: { "cache-control": "no-store" } })
  } catch (error) { return apiError(error) }
}

export async function POST(request: Request, { params }: { params: Promise<{ dealId: string }> }) {
  try {
    // Session only: approvals run the manual send paths as this broker.
    const actor = await requireClosingActor(request, "write", true)
    if (!(await dealAgentEnabled(actor.workspaceId))) throw new AppError(404, "deal_agent_disabled", "Deal Agent is not enabled for this company.")
    const body = await readJson(request, decisionSchema)
    return NextResponse.json(await decideDealAgentAction(actor, { ...body, dealId: (await params).dealId, origin: appOrigin(request) }), { headers: { "cache-control": "no-store" } })
  } catch (error) { return apiError(error) }
}

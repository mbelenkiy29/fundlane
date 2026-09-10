import { NextResponse } from "next/server"
import { consumeRequestRateLimit, clientRateKey } from "@/lib/mca/auth"
import { apiError, AppError } from "@/lib/mca/errors"
import { requireSenderUse, testSend } from "@/lib/mca/senders/service"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

interface RouteContext { params: Promise<{ id: string }> }

export async function POST(request: Request, context: RouteContext) {
  try {
    const actor = await requireSenderUse(request)
    const senderId = (await context.params).id
    await consumeRequestRateLimit(clientRateKey(request, `sender-test:${actor.workspaceId}:${senderId}`), 10)
    let input: { to?: string } = {}
    const contentType = request.headers.get("content-type") ?? ""
    if (contentType.includes("application/json")) {
      try {
        input = await request.json() as { to?: string }
      } catch {
        throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
      }
    }
    return NextResponse.json(await testSend(actor, senderId, input), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

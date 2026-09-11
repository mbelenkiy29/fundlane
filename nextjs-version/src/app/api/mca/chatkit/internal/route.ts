import { NextResponse } from "next/server"
import { ZodError } from "zod"
import { boundedBody, requireAssistant, requireAssistantConfigured, verifyDelegation } from "@/lib/mca/assistant/security"
import { delegatedContext } from "@/lib/mca/assistant/chatkit-context"
import { storeOperation, storeRequest } from "@/lib/mca/assistant/store"
import { runTool, toolRequest } from "@/lib/mca/assistant/tools"
import { apiError, AppError } from "@/lib/mca/errors"
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export async function POST(request: Request) {
  try {
    requireAssistantConfigured()
    const claims = verifyDelegation(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "")
    requireAssistant(claims)
    const c = await delegatedContext(claims)
    const input = JSON.parse(await boundedBody(request, 512_000))
    const result = input.kind === "tool" ? await runTool(c, toolRequest.parse(input.input))
      : input.kind === "store" ? await storeOperation(c, storeRequest.parse(input.input))
      : (() => { throw new AppError(400, "invalid_operation", "Unsupported assistant operation.") })()
    return NextResponse.json({ result }, { headers: { "cache-control": "no-store" } })
  } catch (error) {
    return apiError(error instanceof ZodError || error instanceof SyntaxError ? new AppError(400, "invalid_request", "Invalid assistant request.") : error)
  }
}

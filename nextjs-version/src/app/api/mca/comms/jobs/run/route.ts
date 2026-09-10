import { NextResponse } from "next/server"
import { z } from "zod"
import { assertTrustedMutation, requireWorkspaceAccess } from "@/lib/mca/auth"
import "@/lib/mca/comms/digest"
import "@/lib/mca/comms/followups"
import "@/lib/mca/comms/webhooks"
import { runCommsJobs } from "@/lib/mca/comms/jobs"
import { actorForDeals } from "@/lib/mca/deals/service"
import { apiError, AppError } from "@/lib/mca/errors"
import { nowIso } from "@/lib/mca/db"

export const runtime = "nodejs"

const schema = z.object({
  nowIso: z.string().min(1).optional(),
  kinds: z.array(z.enum(["followup", "digest", "webhook_outbox"])).optional(),
}).strict()

export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    const context = await requireWorkspaceAccess(request, {
      sessionOnly: true,
      roles: ["admin", "super_admin"],
      scopes: ["deals:write"],
    })
    const raw = await request.text()
    let body: z.infer<typeof schema> = {}
    if (raw.trim()) {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
      }
      const parsedBody = schema.safeParse(parsed)
      if (!parsedBody.success) {
        const fieldErrors: Record<string, string[]> = {}
        for (const issue of parsedBody.error.issues) {
          const key = issue.path.join(".") || "request"
          ;(fieldErrors[key] ??= []).push(issue.message)
        }
        throw new AppError(400, "validation_failed", "Review the highlighted fields.", fieldErrors)
      }
      body = parsedBody.data
    }
    const actor = await actorForDeals(context)
    return NextResponse.json(await runCommsJobs({
      actor,
      nowIso: body.nowIso ?? nowIso(),
      kinds: body.kinds,
    }), { headers: { "cache-control": "no-store" } })
  } catch (error) {
    return apiError(error)
  }
}

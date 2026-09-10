import { NextResponse } from "next/server"
import { z } from "zod"
import { assertTrustedMutation } from "@/lib/mca/auth"
import { apiError, AppError } from "@/lib/mca/errors"
import { requirePaymentActor } from "@/lib/mca/accounting/access"
import { runDistributionSchedules } from "@/lib/mca/accounting/schedules"

export const runtime = "nodejs"

const schema = z.object({
  nowIso: z.string().min(1).optional(),
  scheduleId: z.string().min(1).optional(),
}).strict()

export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    const actor = await requirePaymentActor(request, "write")
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
    return NextResponse.json(await runDistributionSchedules(actor, body), { headers: { "cache-control": "no-store" } })
  } catch (error) {
    return apiError(error)
  }
}

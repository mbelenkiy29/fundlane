import { NextResponse } from "next/server"
import { z } from "zod"
import { consumeRequestRateLimit, clientRateKey } from "@/lib/mca/auth"
import {
  listFunderReminders,
  requireReminderActor,
  sendFunderReminder,
} from "@/lib/mca/comms/reminders"
import { apiError, AppError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

const sendSchema = z.object({
  jobId: z.string().min(1).max(80),
  reminderId: z.string().min(1).max(80).optional(),
  body: z.string().max(20_000).optional(),
}).strict()

export async function GET(request: Request) {
  try {
    const actor = await requireReminderActor(request, "read")
    const dealId = new URL(request.url).searchParams.get("dealId")
    if (!dealId) throw new AppError(422, "validation_failed", "Review the highlighted fields.", { dealId: ["Choose a deal."] })
    return NextResponse.json(await listFunderReminders(actor, dealId), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireReminderActor(request, "write")
    const input = await readJson(request, sendSchema)
    await consumeRequestRateLimit(clientRateKey(request, `funder-reminder:${actor.workspaceId}:${input.jobId}`), 20)
    return NextResponse.json(await sendFunderReminder(actor, input), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

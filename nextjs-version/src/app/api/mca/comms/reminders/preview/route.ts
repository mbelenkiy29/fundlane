import { NextResponse } from "next/server"
import { z } from "zod"
import { previewFunderReminder, requireReminderActor } from "@/lib/mca/comms/reminders"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

const schema = z.object({
  jobId: z.string().min(1).max(80),
}).strict()

export async function POST(request: Request) {
  try {
    const actor = await requireReminderActor(request, "read")
    const input = await readJson(request, schema)
    return NextResponse.json(await previewFunderReminder(actor, input), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

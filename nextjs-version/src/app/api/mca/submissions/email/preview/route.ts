import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import {
  previewSubmissionEmails,
  requireEmailPreviewActor,
  type PreviewSubmissionEmailsInput,
} from "@/lib/mca/submissions/email-templates"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function POST(request: Request) {
  try {
    const actor = await requireEmailPreviewActor(request)
    let input: PreviewSubmissionEmailsInput
    try {
      input = await request.json() as PreviewSubmissionEmailsInput
    } catch {
      throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
    }
    return NextResponse.json(await previewSubmissionEmails(actor, input), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

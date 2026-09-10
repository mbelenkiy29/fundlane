import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import {
  listSubmissionEmailTemplates,
  requireEmailTemplateAdmin,
  upsertSubmissionEmailTemplate,
  type UpsertSubmissionEmailTemplateInput,
} from "@/lib/mca/submissions/email-templates"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function GET(request: Request) {
  try {
    const actor = await requireEmailTemplateAdmin(request, "read")
    return NextResponse.json(await listSubmissionEmailTemplates(actor), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function PUT(request: Request) {
  try {
    const actor = await requireEmailTemplateAdmin(request, "write")
    let input: UpsertSubmissionEmailTemplateInput
    try {
      input = await request.json() as UpsertSubmissionEmailTemplateInput
    } catch {
      throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
    }
    return NextResponse.json(await upsertSubmissionEmailTemplate(actor, input), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

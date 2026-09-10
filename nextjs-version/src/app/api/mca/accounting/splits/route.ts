import { NextResponse } from "next/server"
import { z } from "zod"
import { assertTrustedMutation } from "@/lib/mca/auth"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { requirePaymentActor } from "@/lib/mca/accounting/access"
import { listSplitTemplates, saveSplitTemplate } from "@/lib/mca/accounting/service"

const allocation = z.object({ recipientMembershipId: z.string().min(1), percentageBasisPoints: z.number().int().positive().max(10_000) }).strict()
const schema = z.object({ templateId: z.string().min(1).optional(), name: z.string().trim().min(1).max(120), allocations: z.array(allocation).min(1).max(100) }).strict()
export async function GET(request: Request) {
  try { const actor = await requirePaymentActor(request, "read"); return NextResponse.json({ templates: await listSplitTemplates(actor) }) }
  catch (error) { return apiError(error) }
}
export async function POST(request: Request) {
  try { assertTrustedMutation(request); const actor = await requirePaymentActor(request, "write"); return NextResponse.json(await saveSplitTemplate(actor, await readJson(request, schema)), { status: 201 }) }
  catch (error) { return apiError(error) }
}


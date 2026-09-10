import { NextResponse } from "next/server"
import { z } from "zod"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { requireSmsActor } from "@/lib/mca/sms/http"
import { updateSmsAccount } from "@/lib/mca/sms/service"

const schema = z.object({ memberIds: z.array(z.string().min(1)).min(1).optional(), isDefault: z.boolean().optional(), state: z.enum(["active", "revoked"]).optional() }).strict().refine((value) => Object.keys(value).length > 0, "Provide an SMS account change.")
interface RouteContext { params: Promise<{ id: string }> }
export async function PATCH(request: Request, context: RouteContext) {
  try { return NextResponse.json(await updateSmsAccount(await requireSmsActor(request, { mode: "write", admin: true, settings: true }), (await context.params).id, await readJson(request, schema)), { headers: { "cache-control": "no-store" } }) }
  catch (error) { return apiError(error) }
}


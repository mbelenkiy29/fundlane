import { NextResponse } from "next/server"
import { z } from "zod"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { requireSmsActor } from "@/lib/mca/sms/http"
import { createSmsAccount, listSmsAccounts } from "@/lib/mca/sms/service"

const createSchema = z.object({
  label: z.string().min(1).max(100), senderKind: z.enum(["phone_number", "messaging_service"]), senderIdentity: z.string().min(1).max(80),
  credentialRef: z.string().min(1).max(40), memberIds: z.array(z.string().min(1)).min(1), isDefault: z.boolean().optional(),
}).strict()
const noStore = { "cache-control": "no-store" }

export async function GET(request: Request) {
  try { return NextResponse.json(await listSmsAccounts(await requireSmsActor(request, { mode: "read", settings: true })), { headers: noStore }) }
  catch (error) { return apiError(error) }
}

export async function POST(request: Request) {
  try { return NextResponse.json(await createSmsAccount(await requireSmsActor(request, { mode: "write", admin: true, settings: true }), await readJson(request, createSchema)), { status: 201, headers: noStore }) }
  catch (error) { return apiError(error) }
}


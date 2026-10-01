import { NextResponse } from "next/server"
import { z } from "zod"
import { requireSuperAdmin } from "@/lib/mca/platform-auth"
import { assertTrustedMutation, consumeRequestRateLimit } from "@/lib/mca/auth"
import { assertStrictPlatformMutation } from "@/lib/mca/platform-audit"
import { completePlatformStepUp } from "@/lib/mca/platform-step-up"
import { readJson } from "@/lib/mca/http"
import { apiError } from "@/lib/mca/errors"
export async function POST(request: Request) {
  try {
    const actor = await requireSuperAdmin(request)
    assertStrictPlatformMutation(request)
    assertTrustedMutation(request)
    await consumeRequestRateLimit(`platform-step-up:${actor.userId}`, 5)
    const { code } = await readJson(request,z.object({code:z.string().min(1).max(32)}).strict())
    await completePlatformStepUp(actor,code,request)
    return NextResponse.json({verified:true},{headers:{"Cache-Control":"no-store"}})
  } catch (error) { return apiError(error) }
}

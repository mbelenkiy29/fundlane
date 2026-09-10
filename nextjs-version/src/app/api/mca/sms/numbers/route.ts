import { NextResponse } from "next/server"
import { z } from "zod"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { requireSmsActor } from "@/lib/mca/sms/http"
const json = (data: unknown) =>
  NextResponse.json(data, { headers: { "cache-control": "no-store" } })
import { numberSearch, assignNumber } from "@/lib/mca/sms/provisioning"
import { consumeRequestRateLimit } from "@/lib/mca/auth"
export async function GET(request: Request) {
  try {
    const actor = await requireSmsActor(request, {
      mode: "read",
      admin: true,
      settings: true,
    })
    await consumeRequestRateLimit(`sms-search:${actor.workspaceId}`, 10)
    return json(
      await numberSearch(
        actor,
        new URL(request.url).searchParams.get("areaCode") ?? ""
      )
    )
  } catch (e) {
    return apiError(e)
  }
}
export async function PATCH(request: Request) {
  try {
    const actor = await requireSmsActor(request, {
        mode: "write",
        admin: true,
        settings: true,
      }),
      input = await readJson(
        request,
        z
          .object({
            numberId: z.string().min(1),
            membershipId: z.string().min(1),
          })
          .strict()
      )
    return json(await assignNumber(actor, input.numberId, input.membershipId))
  } catch (e) {
    return apiError(e)
  }
}

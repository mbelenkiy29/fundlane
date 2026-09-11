import { NextResponse } from "next/server"
import { assertTrustedMutation, consumeRequestRateLimit } from "@/lib/mca/auth"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { authorize } from "@/lib/mca/assistant/operations"
import {
  readMemories,
  changeMemory,
  memoryCommand
} from "@/lib/mca/assistant/memory"
const headers = { "cache-control": "no-store" }
export async function GET(request: Request) {
  try {
    return NextResponse.json(await readMemories(await authorize(request)), {
      headers
    })
  } catch (e) {
    return apiError(e)
  }
}
export async function PATCH(request: Request) {
  try {
    assertTrustedMutation(request)
    const actor = await authorize(request)
    await consumeRequestRateLimit(
      `assistant:memory:${actor.workspaceId}:${actor.userId}`,
      30
    )
    return NextResponse.json(
      await changeMemory(actor, await readJson(request, memoryCommand)),
      { headers }
    )
  } catch (e) {
    return apiError(e)
  }
}

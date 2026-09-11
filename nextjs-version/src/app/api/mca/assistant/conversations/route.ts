import { NextResponse } from "next/server"
import { z } from "zod"
import { assertTrustedMutation } from "@/lib/mca/auth"
import { apiError, AppError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { authorize } from "@/lib/mca/assistant/operations"
import { assistantAvailable } from "@/lib/mca/assistant/agent"
import {
  conversationView,
  openConversation,
  listAssistantConversations
} from "@/lib/mca/assistant/repository"

export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    if (!assistantAvailable())
      throw new AppError(
        404,
        "assistant_disabled",
        "The deal assistant is not enabled."
      )
    const { dealId } = await readJson(
      request,
      z
        .object({ dealId: z.string().min(1).max(128).nullable().optional() })
        .strict()
    )
    const actor = await authorize(request, dealId)
    return NextResponse.json(
      await conversationView(await openConversation(actor, dealId ?? null)),
      { headers: { "cache-control": "no-store" } }
    )
  } catch (error) {
    return apiError(error)
  }
}

export async function GET(request: Request) {
  try {
    const actor = await authorize(request)
    const url = new URL(request.url)
    const query = z
      .string()
      .max(200)
      .parse(url.searchParams.get("q") ?? "")
    const before = z.iso
      .datetime()
      .optional()
      .parse(url.searchParams.get("before") ?? undefined)
    return NextResponse.json(
      await listAssistantConversations(actor, { query, before }),
      { headers: { "cache-control": "no-store" } }
    )
  } catch (error) {
    return apiError(error)
  }
}

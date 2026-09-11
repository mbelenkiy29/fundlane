import { NextResponse } from "next/server"
import { z } from "zod"
import { assertTrustedMutation } from "@/lib/mca/auth"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { authorize } from "@/lib/mca/assistant/operations"
import {
  ownedConversation,
  conversationView
} from "@/lib/mca/assistant/repository"
import {
  renameConversation,
  deleteConversation
} from "@/lib/mca/assistant/experience"
type Context = { params: Promise<{ id: string }> }
export async function GET(request: Request, context: Context) {
  try {
    const c = await ownedConversation(
      await authorize(request),
      (await context.params).id
    )
    return NextResponse.json(await conversationView(c), {
      headers: { "cache-control": "no-store" }
    })
  } catch (e) {
    return apiError(e)
  }
}
export async function PATCH(request: Request, context: Context) {
  try {
    assertTrustedMutation(request)
    const c = await ownedConversation(
      await authorize(request),
      (await context.params).id
    )
    const { title } = await readJson(
      request,
      z.object({ title: z.string().trim().min(1).max(100) }).strict()
    )
    await renameConversation(c, title)
    return NextResponse.json({ title })
  } catch (e) {
    return apiError(e)
  }
}
export async function DELETE(request: Request, context: Context) {
  try {
    assertTrustedMutation(request)
    const c = await ownedConversation(
      await authorize(request),
      (await context.params).id
    )
    await deleteConversation(c)
    return NextResponse.json({ deleted: true })
  } catch (e) {
    return apiError(e)
  }
}

import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { ingestAdapterWebhook, parseWebhookJson, requestHeaderMap } from "@/lib/mca/submissions/webhooks"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

interface RouteContext { params: Promise<{ slug: string }> }

export async function POST(request: Request, context: RouteContext) {
  try {
    const slug = (await context.params).slug
    const rawBody = await request.text()
    const body = parseWebhookJson(rawBody)
    return NextResponse.json(await ingestAdapterWebhook({
      slug,
      headers: requestHeaderMap(request),
      body,
      rawBody,
    }), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

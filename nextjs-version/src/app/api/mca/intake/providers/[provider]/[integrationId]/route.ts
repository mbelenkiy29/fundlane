import { NextResponse } from "next/server"
import { clientRateKey, consumeRequestRateLimit } from "@/lib/mca/auth"
import { apiError } from "@/lib/mca/errors"
import { ingestProviderDelivery, readProviderBody } from "@/lib/mca/intake/ingress"

export const runtime = "nodejs"
interface Context { params: Promise<{ provider: string; integrationId: string }> }

export async function POST(request: Request, context: Context) {
  try {
    const params = await context.params
    await consumeRequestRateLimit(clientRateKey(request, `intake:${params.integrationId}`), 120)
    const result = await ingestProviderDelivery({ provider: params.provider, integrationId: params.integrationId, request, rawBody: await readProviderBody(request) })
    return NextResponse.json(result, { status: result.created ? 201 : 200 })
  } catch (error) { return apiError(error) }
}

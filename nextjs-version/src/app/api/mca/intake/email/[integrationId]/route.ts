import { NextResponse } from "next/server"
import { clientRateKey, consumeRequestRateLimit } from "@/lib/mca/auth"
import { apiError } from "@/lib/mca/errors"
import { appOrigin } from "@/lib/mca/http"
import { ingestEmailDelivery, readInboundEmailBody } from "@/lib/mca/intake/email"

export const runtime = "nodejs"
interface Context { params: Promise<{ integrationId: string }> }

export async function POST(request: Request, context: Context) {
  try {
    const { integrationId } = await context.params
    consumeRequestRateLimit(clientRateKey(request, `email-intake:${integrationId}`), 120)
    const result = await ingestEmailDelivery({ integrationId, request, rawBody: await readInboundEmailBody(request), appOrigin: appOrigin(request) })
    return NextResponse.json(result)
  } catch (error) { return apiError(error) }
}

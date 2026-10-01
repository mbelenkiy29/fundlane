import { apiError } from "@/lib/mca/errors"
import { processTwilioOptOut } from "@/lib/mca/sms/service"

interface RouteContext { params: Promise<{ accountId: string }> }
export async function POST(request: Request, context: RouteContext) {
  try {
    const raw = await request.text(), params = new URLSearchParams(raw)
    await processTwilioOptOut((await context.params).accountId, params, request.headers.get("x-twilio-signature"), request.url)
    return new Response('<?xml version="1.0" encoding="UTF-8"?><Response/>', { status: 200, headers: { "content-type": "text/xml; charset=utf-8" } })
  } catch (error) { return apiError(error) }
}

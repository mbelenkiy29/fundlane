import { apiError } from "@/lib/mca/errors"
import { processTwilioStatus } from "@/lib/mca/sms/service"

interface RouteContext { params: Promise<{ accountId: string }> }
export async function POST(request: Request, context: RouteContext) {
  try {
    const raw = await request.text(), params = new URLSearchParams(raw)
    const result = await processTwilioStatus((await context.params).accountId, params, request.headers.get("x-twilio-signature"), request.url)
    return Response.json(result)
  } catch (error) { return apiError(error) }
}


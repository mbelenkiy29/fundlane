import { NextRequest, NextResponse } from "next/server"
import { verifyWebhook } from "@clerk/nextjs/webhooks"
import { processClerkWebhook } from "@/lib/mca/clerk-webhooks"
export async function POST(request: NextRequest) {
  if (!process.env.CLERK_WEBHOOK_SIGNING_SECRET)
    return NextResponse.json(
      { error: "Webhook is not configured." },
      { status: 503 }
    )
  let event
  try {
    event = await verifyWebhook(request)
  } catch {
    return NextResponse.json(
      { error: "Invalid webhook signature." },
      { status: 400 }
    )
  }
  const id = request.headers.get("svix-id")
  if (!id)
    return NextResponse.json({ error: "Missing event ID." }, { status: 400 })
  try {
    await processClerkWebhook(id, event)
    return NextResponse.json({ received: true })
  } catch {
    return NextResponse.json(
      { error: "Reconciliation failed; retry delivery." },
      { status: 503 }
    )
  }
}

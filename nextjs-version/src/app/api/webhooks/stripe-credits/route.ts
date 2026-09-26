import { NextResponse, after } from "next/server"
import {
  creditStripe,
  processCreditPaymentEvent,
} from "@/lib/mca/assistant/purchases"
import { maintainCreditAlerts } from "@/lib/mca/assistant/alerts"
import { webhookVerificationTime } from "@/lib/mca/maintenance/replay-clock"
export const runtime = "nodejs"
export async function POST(request: Request) {
  if (!process.env.STRIPE_WEBHOOK_SECRET || !process.env.STRIPE_SECRET_KEY)
    return NextResponse.json(
      { error: "Webhook not configured" },
      { status: 503 }
    )
  const signature = request.headers.get("stripe-signature")
  if (!signature)
    return NextResponse.json({ error: "Signature required" }, { status: 400 })
  const stripe = creditStripe()
  let event
  try {
    event = stripe.webhooks.constructEvent(
      await request.text(),
      signature,
      process.env.STRIPE_WEBHOOK_SECRET,
      undefined,
      undefined,
      webhookVerificationTime()
    )
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 })
  }
  try {
    await processCreditPaymentEvent(event, stripe)
    try {
      after(() => maintainCreditAlerts().catch(() => {}))
    } catch {
      // Alert maintenance also runs in the worker; never retry an acknowledged payment for scheduling failure.
    }
    return NextResponse.json({ received: true })
  } catch {
    return NextResponse.json(
      { error: "Payment reconciliation pending" },
      { status: 503 }
    )
  }
}

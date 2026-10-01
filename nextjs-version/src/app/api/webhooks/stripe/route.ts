import { after, NextResponse } from "next/server"
import { processStripeBillingEvent, runImmediateBillingReconcile, verifyStripeBillingEvent } from "@/lib/mca/billing"
import { captureEnrollmentStripeEvent, reconcileEnrollment } from "@/lib/mca/onboarding/reconcile"
import { apiError, AppError } from "@/lib/mca/errors"
export const runtime = "nodejs"
export async function POST(request: Request) {
  try {
    // Verification must receive the original request text, before JSON parsing.
    const body = await request.text()
    if (Buffer.byteLength(body) > 1024 * 1024) throw new AppError(413, "webhook_too_large", "Webhook payload is too large.")
    const event = verifyStripeBillingEvent(body, request.headers.get("stripe-signature"))
    const enrollment = await captureEnrollmentStripeEvent(event)
    if (enrollment.handled) {
      if (enrollment.enrollmentId) after(async () => {
        let timer:ReturnType<typeof setTimeout>|undefined
        try { await Promise.race([reconcileEnrollment(enrollment.enrollmentId!).catch(() => undefined), new Promise<void>(resolve => { timer=setTimeout(resolve,5000) })]) } finally { if(timer)clearTimeout(timer) }
      })
      return NextResponse.json({received:true,queued:true})
    }
    const result = await processStripeBillingEvent(event)
    if ("queued" in result && result.queued) {
      const { workspaceId, jobId } = result
      after(() => runImmediateBillingReconcile(workspaceId, jobId))
    }
    return NextResponse.json({ received: true, ...result })
  } catch (error) { return apiError(error) }
}

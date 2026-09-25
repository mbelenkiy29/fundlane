import "server-only"

import { newId } from "../db"
import { assertCompanyOperational } from "../company-access"
import { deliverSandboxSubmission, isSandboxSubmissionJob } from "../sandbox/deliver"
import { submitViaAdapter } from "./adapters/framework"
import type { DeliverResult, OutgoingDocument, SubmissionJob } from "./contracts"
import { sendSubmissionEmail } from "./email-templates"
import { createPortalTask } from "./portal"
import { deliverWebhook } from "./webhook"

export async function deliverSubmission(job: SubmissionJob, packaged: OutgoingDocument[] = []): Promise<DeliverResult> {
  await assertCompanyOperational(job.workspaceId)
  if (isSandboxSubmissionJob(job)) {
    return deliverSandboxSubmission(job)
  }
  await (await import("../outbound-approval")).assertOutboundDispatch(job.workspaceId, job.createdAt)
  switch (job.routeKind) {
    case "email":
      return sendSubmissionEmail(job, packaged)
    case "api": {
      const result = await submitViaAdapter(job)
      return {
        ok: result.ok,
        state: result.ok ? "sent" : "failed",
        correlationId: result.correlationId,
        externalRef: result.externalRef,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
      }
    }
    case "manual_portal":
      return createPortalTask(job)
    case "custom_webhook":
      return deliverWebhook(job)
    default:
      return {
        ok: false,
        state: "failed",
        correlationId: newId(),
        errorCode: "provider_unavailable",
        errorMessage: `Unsupported route kind ${job.routeKind as string}.`,
      }
  }
}

import "server-only"

import { after } from "next/server"
import { nowIso } from "../db"
import type { DealActor } from "../deals/schema"
import type { OfferRecord } from "../offers/contracts"
import type { PublishWorkflowWebhookInput, PublishWorkflowWebhookResult } from "./webhooks"

function scheduleOutbox(actor: DealActor): void {
  const run = async () => {
    try {
      const { processWebhookOutbox } = await import("./webhooks")
      await processWebhookOutbox({ actor, nowIso: nowIso() })
    } catch (error) {
      console.error(JSON.stringify({
        event: "workflow_webhook_outbox_kick_failed",
        workspaceId: actor.workspaceId,
        code: error instanceof Error ? error.message : "processing_failed",
      }))
    }
  }
  if (process.env.NODE_ENV === "test") return
  try {
    after(() => { void run() })
  } catch {
    void run()
  }
}

export async function emitWorkflowWebhook(
  actor: DealActor,
  input: PublishWorkflowWebhookInput,
): Promise<PublishWorkflowWebhookResult | undefined> {
  try {
    const { publishWorkflowWebhook } = await import("./webhooks")
    const result = await publishWorkflowWebhook(actor, input)
    if (result.enqueued > 0) scheduleOutbox(actor)
    return result
  } catch (error) {
    console.error(JSON.stringify({
      event: "workflow_webhook_publish_failed",
      workspaceId: actor.workspaceId,
      eventType: input.eventType,
      dealId: input.dealId,
      code: error instanceof Error ? error.message : "publish_failed",
    }))
    return undefined
  }
}

export async function emitOfferCreatedWebhook(actor: DealActor, offer: OfferRecord): Promise<void> {
  const revision = offer.revisions.find((item) => item.id === offer.currentRevisionId) ?? offer.revisions.at(-1)
  if (!revision) return
  await emitWorkflowWebhook(actor, {
    eventType: "offer.created",
    dealId: offer.dealId,
    offer: {
      offerId: offer.id,
      revisionId: revision.id,
      revisionNumber: revision.revisionNumber,
      funderName: offer.funderName,
      source: offer.source,
      amountCents: revision.amountCents,
    },
  })
}

export async function emitDealStatusUpdatedWebhook(
  actor: DealActor,
  input: { dealId: string; fromStatus: string; toStatus: string },
): Promise<void> {
  if (input.fromStatus === input.toStatus) return
  await emitWorkflowWebhook(actor, {
    eventType: "deal.transitioned",
    dealId: input.dealId,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
  })
}

export async function emitDealAssignedWebhook(actor: DealActor, dealId: string): Promise<void> {
  await emitWorkflowWebhook(actor, { eventType: "deal.assigned", dealId })
}

export async function emitSubmissionCreatedWebhook(
  actor: DealActor,
  job: { id: string; dealId: string; funderId: string; displayFunderName: string; routeKind: string; state: string },
): Promise<void> {
  await emitWorkflowWebhook(actor, {
    eventType: "submission.created",
    dealId: job.dealId,
    submission: {
      jobId: job.id,
      funderId: job.funderId,
      funderName: job.displayFunderName,
      routeKind: job.routeKind,
      state: job.state,
    },
  })
}

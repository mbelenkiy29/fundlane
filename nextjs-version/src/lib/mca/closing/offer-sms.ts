import "server-only"

import type { DealActor } from "../deals/schema"
import { AppError } from "../errors"
import type { SmsDeliveryResult } from "../sms/contracts"
import { deliverClosingSms } from "../sms/service"
import type { TwilioSmsTransport } from "../sms/twilio"
import type { ClosingTransport, ClosingTransportRequest, ClosingTransportResult } from "./delivery"

export type DeliverClosingSmsFn = typeof deliverClosingSms

export function mapClosingSmsResult(
  request: ClosingTransportRequest,
  result: SmsDeliveryResult,
): ClosingTransportResult {
  if (result.state === "accepted" && result.externalId) {
    return { state: "sent" as const, correlationId: request.correlationId, externalId: result.externalId }
  }
  if (result.state === "failed") {
    return {
      state: "failed" as const,
      correlationId: request.correlationId,
      errorCode: result.errorCode ?? "sms_provider_rejected",
      errorMessage: result.errorMessage ?? "The text message provider rejected the message.",
    }
  }
  return {
    state: "blocked" as const,
    correlationId: request.correlationId,
    errorCode: "provider_outcome_unknown",
    errorMessage: "The text message provider outcome could not be confirmed. Check provider activity before retrying.",
  }
}

export function createMerchantOfferSmsTransport(
  actor: DealActor,
  dealId: string,
  transport?: TwilioSmsTransport,
  deliverSms: DeliverClosingSmsFn = deliverClosingSms,
): ClosingTransport {
  const execute = async (
    request: ClosingTransportRequest,
    deliveryMode: "never_attempted" | "reconcile_only",
  ): Promise<ClosingTransportResult> => {
    try {
      const result = await deliverSms(actor, {
        dealId,
        recipient: request.recipient,
        body: request.body ?? "",
        senderAccountId: request.senderId,
        idempotencyKey: `closing:${request.correlationId}`,
        correlationId: request.correlationId,
        payloadHash: request.payloadHash,
        deliveryMode,
        // Preview already bound via bindMerchantSms (deal contact or audited admin override).
        matchDealContact: false,
      }, transport)
      return mapClosingSmsResult(request, result)
    } catch (error) {
      if (error instanceof AppError) {
        return { state: "failed" as const, correlationId: request.correlationId, errorCode: error.code, errorMessage: error.message }
      }
      throw error
    }
  }
  return {
    deliver: (request) => execute(request, "never_attempted"),
    reconcile: (request) => execute(request, "reconcile_only"),
  }
}

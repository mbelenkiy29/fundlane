import "server-only"

import { newId } from "../db"
import { AppError } from "../errors"
import type { SenderProvider, SenderPurpose, SenderTestSendResult } from "./contracts"
import { configuredPostmarkClosingTransport } from "../closing/delivery"

type SenderFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
let fetchOverride: SenderFetch | undefined

export function setSenderDeliveryFetchForTests(fetchImpl?: SenderFetch): void {
  fetchOverride = fetchImpl
}

function http(): SenderFetch {
  return fetchOverride ?? globalThis.fetch
}

export interface SenderTestMessage {
  workspaceId: string
  senderId: string
  provider: SenderProvider
  purpose: SenderPurpose
  fromName: string
  fromAddress: string
  recipient: string
}

export function redactedTestPayload(message: SenderTestMessage, correlationId: string) {
  return {
    template: "sender_test",
    senderId: message.senderId,
    provider: message.provider,
    purpose: message.purpose,
    fromName: message.fromName,
    fromAddress: message.fromAddress,
    recipient: message.recipient,
    correlationId,
  }
}

export async function deliverSenderTest(message: SenderTestMessage): Promise<SenderTestSendResult> {
  const correlationId = newId()
  if (process.env.MCA_CLOSING_EMAIL_PROVIDER === "postmark") {
    const transport = configuredPostmarkClosingTransport({
      workspaceId: message.workspaceId, kind: "offer_message", channel: "email", senderId: message.senderId,
      sender: { fromName: message.fromName, fromAddress: message.fromAddress }, recipient: message.recipient,
      subject: "Fundlane sender verification", body: `This message verifies the selected Fundlane sender connection.\n\nCorrelation ID: ${correlationId}`,
      correlationId, recordId: `sender-test:${message.senderId}`, attemptKey: correlationId, payloadHash: correlationId,
    }, http())
    const result = await transport.deliver({
      workspaceId: message.workspaceId, kind: "offer_message", channel: "email", senderId: message.senderId,
      sender: { fromName: message.fromName, fromAddress: message.fromAddress }, recipient: message.recipient,
      subject: "Fundlane sender verification", body: `This message verifies the selected Fundlane sender connection.\n\nCorrelation ID: ${correlationId}`,
      correlationId, recordId: `sender-test:${message.senderId}`, attemptKey: correlationId, payloadHash: correlationId,
    })
    return result.state === "sent" && result.externalId
      ? { delivery: "sent", correlationId, providerMessageId: result.externalId }
      : { delivery: "failed", correlationId, error: result.errorMessage ?? "Postmark did not verify this sender connection." }
  }
  const webhook = process.env.MCA_EMAIL_WEBHOOK_URL?.trim()
  if (!webhook) {
    if (process.env.NODE_ENV === "production") {
      throw new AppError(503, "email_delivery_unconfigured", "Email delivery is not configured for this deployment.")
    }
    return {
      delivery: "preview",
      correlationId,
      previewUrl: `mca://senders/${message.senderId}/test`,
    }
  }
  try {
    const response = await http()(webhook, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.MCA_EMAIL_WEBHOOK_TOKEN ? { authorization: `Bearer ${process.env.MCA_EMAIL_WEBHOOK_TOKEN}` } : {}),
        "x-correlation-id": correlationId,
      },
      body: JSON.stringify(redactedTestPayload(message, correlationId)),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      return { delivery: "failed", correlationId, error: "The email provider did not accept the test message." }
    }
    return { delivery: "sent", correlationId }
  } catch (error) {
    if (error instanceof AppError) throw error
    return { delivery: "failed", correlationId, error: "The email provider did not accept the test message." }
  }
}

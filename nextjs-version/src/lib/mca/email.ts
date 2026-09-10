import "server-only";

import { AppError } from "./errors";
import { newId } from "./db";

interface EmailMessage {
  recipient: string;
  template: "workspace_invitation" | "account_recovery" | "funder_analysis_review" | "company_email_verification";
  actionUrl: string;
  expiresAt: string;
}

export function assertEmailDeliveryConfigured(): void {
  if (process.env.NODE_ENV === "production" && !process.env.MCA_EMAIL_WEBHOOK_URL) {
    throw new AppError(503, "email_delivery_unconfigured", "Email delivery is not configured for this deployment.");
  }
}

export async function deliverEmail(message: EmailMessage): Promise<{
  delivery: "sent" | "preview";
  correlationId: string;
  previewUrl?: string;
}> {
  const correlationId = newId();
  const webhook = process.env.MCA_EMAIL_WEBHOOK_URL;
  if (!webhook) {
    if (process.env.NODE_ENV === "production") {
      throw new AppError(503, "email_delivery_unconfigured", "Email delivery is not configured for this deployment.");
    }
    return { delivery: "preview", correlationId, previewUrl: message.actionUrl };
  }
  const response = await fetch(webhook, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(process.env.MCA_EMAIL_WEBHOOK_TOKEN ? { authorization: `Bearer ${process.env.MCA_EMAIL_WEBHOOK_TOKEN}` } : {}),
      "x-correlation-id": correlationId,
    },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new AppError(502, "email_delivery_failed", "The email provider did not accept the message.");
  return { delivery: "sent", correlationId };
}

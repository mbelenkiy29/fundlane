import { resendSystemEmailEnabled, systemEmailCredentials } from "../system-email"

export function privateEmailIntakeEnabled(): boolean {
  return process.env.MCA_PRIVATE_EMAIL_INTAKE_ENABLED === "true"
}

export function privateEmailDeliveryEnabled(): boolean {
  return process.env.MCA_PRIVATE_EMAIL_DELIVERY_ENABLED === "true"
}

export function privateEmailUiEnabled(): boolean {
  return privateEmailIntakeEnabled() || privateEmailDeliveryEnabled()
}

export function receiptWebhookConfigured(): boolean {
  return Boolean(process.env.MCA_INTAKE_RECEIPT_WEBHOOK_URL?.trim() && process.env.MCA_INTAKE_RECEIPT_WEBHOOK_TOKEN?.trim())
}

export function emailSenderVerified(): boolean {
  return process.env.MCA_EMAIL_SENDER_VERIFIED === "true"
}

export function emailIntakeReadiness(input: {
  enabled: boolean; inboundAddress?: string; admissionSecretHash?: string; senderRules?: string[]
  emailGateway?: string; providerEvidenceHash?: string; fromAddress?: string; credentialConfigured?: boolean
}): string[] {
  const missing: string[] = []
  if (!privateEmailIntakeEnabled()) missing.push("Private email intake flag is off")
  if (!input.enabled) missing.push("Integration is disabled")
  if (!input.inboundAddress) missing.push("Inbound address is missing")
  if (!input.admissionSecretHash) missing.push("Inbound webhook secret is missing")
  if (!input.senderRules?.length) missing.push("Allowed sender rules are missing")
  if (["usesend", "postmark"].includes(input.emailGateway ?? "") && !input.providerEvidenceHash) missing.push("Provider setup is unverified")
  if (!privateEmailDeliveryEnabled()) missing.push("Receipt delivery flag is off")
  const resendReady = resendSystemEmailEnabled() && Boolean(systemEmailCredentials())
  if (resendSystemEmailEnabled() && !resendReady) missing.push("Verified receipt sender is missing")
  if (input.emailGateway === "usesend" && !resendSystemEmailEnabled() && (!input.fromAddress || !input.credentialConfigured)) missing.push("Verified receipt sender is missing")
  if (input.emailGateway !== "usesend" && !resendSystemEmailEnabled() && !emailSenderVerified()) missing.push("Outbound sender verification is unconfirmed")
  if (input.emailGateway !== "usesend" && !resendSystemEmailEnabled() && !process.env.MCA_INTAKE_RECEIPT_WEBHOOK_URL?.trim()) missing.push("Receipt delivery receiver is missing")
  if (input.emailGateway !== "usesend" && !resendSystemEmailEnabled() && !process.env.MCA_INTAKE_RECEIPT_WEBHOOK_TOKEN?.trim()) missing.push("Receipt delivery receiver token is missing")
  return missing
}

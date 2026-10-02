import "server-only";
import { AppError } from "../errors";
import { hmacScopedToken } from "../crypto";
import type { EmailContent } from "../operations/email-transport";
import { sendTransactionalWebhook } from "../operations/email-transport";
import { requestFrozenSystemEmail, systemEmailConfiguration, systemEmailCredentials, systemEmailReplyTo, type FrozenSystemEmailConfiguration } from "../system-email";

export type FrozenOnboardingEmailConfiguration = FrozenSystemEmailConfiguration | { provider: "webhook"; from: string | null; replyTo: string | null; endpoint: string; keyIdentity: string };
export type OnboardingEmailDispatchOutcome = { state: "accepted" | "retry" | "failed" | "uncertain" | "suppressed"; providerMessageId?: string; errorCode?: string; evidence?: "provider_response" };

export function onboardingEmailConfiguration(): FrozenOnboardingEmailConfiguration {
  const webhook = process.env.MCA_EMAIL_WEBHOOK_URL?.trim();
  if (!webhook) return systemEmailConfiguration();
  const token = process.env.MCA_EMAIL_WEBHOOK_TOKEN?.trim();
  if (!token) throw new AppError(503, "onboarding_email_unconfigured", "Configure authenticated service email delivery.");
  let url: URL;
  try { url = new URL(webhook); } catch { throw new AppError(503, "onboarding_email_endpoint_invalid", "Configure a secure service email endpoint."); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new AppError(503, "onboarding_email_endpoint_invalid", "Configure a secure service email endpoint.");
  return { provider: "webhook", from: systemEmailCredentials()?.from ?? null, replyTo: systemEmailReplyTo() ?? null, endpoint: url.href, keyIdentity: hmacScopedToken("onboarding-webhook-email-key", "platform", token) };
}

/** Opaque transport configuration identity, not a provider-verified account identifier. */
export const onboardingEmailProviderIdentity = (configuration: FrozenOnboardingEmailConfiguration): string => hmacScopedToken("onboarding-email-provider-configuration", "platform", JSON.stringify(configuration));

export async function dispatchOnboardingEmail(input: { content: EmailContent; recipient: string; purpose: string; deliveryKey: string; configuration: FrozenOnboardingEmailConfiguration; deadlineMs: number; beforeSend: () => Promise<void> }): Promise<OnboardingEmailDispatchOutcome> {
  let started = false;
  const fetcher: typeof fetch = async (url, init) => {
    await input.beforeSend();
    if (input.deadlineMs - Date.now() < 1000) throw new AppError(503, "onboarding_email_deadline", "The email execution deadline has elapsed.");
    let current: FrozenOnboardingEmailConfiguration;
    try { current = onboardingEmailConfiguration(); } catch { throw new AppError(503, "onboarding_email_provider_unavailable", "The frozen email provider is unavailable."); }
    if (JSON.stringify(current) !== JSON.stringify(input.configuration)) throw new AppError(409, "onboarding_email_provider_changed", "Review the changed email provider configuration.");
    started = true;
    return fetch(url, { ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(Math.max(1, Math.floor(input.deadlineMs - Date.now())))]) });
  };
  try {
    let result: { status: number; emailId?: string };
    if (input.configuration.provider === "webhook") {
      const response = await sendTransactionalWebhook(input.configuration.endpoint, process.env.MCA_EMAIL_WEBHOOK_TOKEN?.trim(), { recipient: input.recipient, template: input.purpose, ...input.content, from: input.configuration.from, replyTo: input.configuration.replyTo }, input.deliveryKey, fetcher, 15000);
      const body = await response.json().catch(() => undefined);
      result = { status: response.status, emailId: typeof body?.emailId === "string" ? body.emailId : typeof body?.id === "string" ? body.id : undefined };
    } else result = await requestFrozenSystemEmail({ ...input.content, to: input.recipient, idempotencyKey: input.deliveryKey, fetchImpl: fetcher }, input.configuration);
    if (result.status >= 200 && result.status < 300 && result.emailId?.trim() && result.emailId.length <= 512 && !/[\r\n]/.test(result.emailId)) return { state: "accepted", providerMessageId: result.emailId, evidence: "provider_response" };
    if (result.status === 429) return { state: "retry", errorCode: "onboarding_email_rate_limited", evidence: "provider_response" };
    if ([400, 401, 403, 404, 422].includes(result.status)) return { state: "failed", errorCode: "onboarding_email_rejected", evidence: "provider_response" };
    return { state: "uncertain", errorCode: "onboarding_email_acceptance_unknown", evidence: "provider_response" };
  } catch (error) {
    if (!started && error instanceof AppError) return { state: error.code === "onboarding_email_suppressed" || error.code === "onboarding_email_superseded" ? "suppressed" : "failed", errorCode: error.code };
    return { state: "uncertain", errorCode: "onboarding_email_acceptance_unknown" };
  }
}

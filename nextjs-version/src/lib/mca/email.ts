import { sendTransactionalWebhook } from "./operations/email-transport";
import "server-only";

import { AppError } from "./errors";
import { newId } from "./db";
import { sendUsesendEmail } from "./intake/usesend";

interface EmailMessage {
  recipient: string;
  template: "workspace_invitation" | "account_recovery" | "funder_analysis_review" | "company_email_verification" | "ai_credit_alert" | "application_invitation" | "application_invitation_reminder" | "operations_alert";
  actionUrl: string;
  expiresAt: string;
  data?: Record<string, unknown>;
}

export function assertEmailDeliveryConfigured(): void {
  if (process.env.NODE_ENV === "production" && !process.env.MCA_EMAIL_WEBHOOK_URL) {
    throw new AppError(503, "email_delivery_unconfigured", "Email delivery is not configured for this deployment.");
  }
}

export async function deliverEmail(message: EmailMessage, options?: {correlationId?: string; workspaceId?: string; approvedAt?: string}): Promise<{
  delivery: "sent" | "preview";
  correlationId: string;
  previewUrl?: string;
}> {
  if (options?.workspaceId) await (await import("./company-access")).assertCompanyOperational(options.workspaceId);
  if (options?.workspaceId) await (await import("./outbound-approval")).assertOutboundDispatch(options.workspaceId, options.approvedAt ?? new Date().toISOString());
  const correlationId = options?.correlationId ?? newId();
  const webhook = process.env.MCA_EMAIL_WEBHOOK_URL;
  if (!webhook) {
    if (process.env.NODE_ENV === "production") {
      throw new AppError(503, "email_delivery_unconfigured", "Email delivery is not configured for this deployment.");
    }
    return { delivery: "preview", correlationId, previewUrl: message.actionUrl };
  }
  const response = await sendTransactionalWebhook(webhook, process.env.MCA_EMAIL_WEBHOOK_TOKEN, message, correlationId);
  if (!response.ok) throw new AppError(502, response.status >= 500 ? "email_delivery_uncertain" : "email_delivery_failed", "The email provider did not accept the message.");
  return { delivery: "sent", correlationId };
}

export interface BillingEmailMessage {
  recipient: string; actionUrl: string; expiresAt: string; data: Record<string, unknown>;
  transport: "webhook" | "usesend"; from?: string; retryUntil?: string;
  content?: { subject:string; text:string; html:string };
}
/** Billing recovery is allowed while paused. Only this explicit helper has the UseSend fallback. */
export async function deliverBillingEmail(message: BillingEmailMessage, correlationId: string): Promise<void> {
  if (message.transport === "webhook") {
    if (!process.env.MCA_EMAIL_WEBHOOK_URL) throw new AppError(503,"billing_email_unconfigured","The original billing webhook transport is unavailable.")
    const result = await deliverEmail({ ...message, template:"operations_alert" },{correlationId})
    if (result.delivery !== "sent") throw new AppError(503,"billing_email_unconfigured","Billing email requires a real delivery transport.")
    return
  }
  const key = process.env.MCA_USESEND_API_KEY?.trim()
  if (message.retryUntil && Date.parse(message.retryUntil) <= Date.now()) throw new AppError(503,"billing_delivery_review_required","UseSend's deduplication window has ended. Check provider delivery before reissuing this notification.")
  const from = message.from
  if (!key || !from) throw new AppError(503,"billing_email_unconfigured","Configure MCA_USESEND_API_KEY and MCA_USESEND_FROM for billing notifications.")
  const url = new URL(message.actionUrl)
  if (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && url.protocol === "http:" && ["localhost","127.0.0.1"].includes(url.hostname))) throw new AppError(503,"billing_origin_invalid","Billing recovery links require HTTPS.")
  await sendUsesendEmail({apiKey:key,from,to:message.recipient,...(message.content??renderBillingEmailContent(message)),idempotencyKey:correlationId})
}

/** Freeze this output in the outbox so a deployment cannot change a retry's provider body. */
export function renderBillingEmailContent(message: Pick<BillingEmailMessage,"data"|"actionUrl">) {
  const subjects: Record<string,string> = {
    renewal_payment_failed:"Action needed: Fundlane renewal payment", billing_paused:"Your Fundlane company access is paused",
    billing_recovered:"Fundlane billing payment received", trial_ending:"Your Fundlane trial ends soon", trial_ended:"Your Fundlane trial has ended", trial_paused:"Add a payment method to resume Fundlane",
    payment_action_required:"Action needed: authenticate your Fundlane payment", payment_failed:"Action needed: update your Fundlane payment method",
  }
  const kind = String(message.data.kind)
  const subject = subjects[kind]
  if (!subject) throw new AppError(422,"billing_notification_unknown","Unknown billing notification kind.")
  const descriptions: Record<string,string> = {
    renewal_payment_failed:"Your company renewal payment has not completed. Update your payment method and pay all outstanding invoices before your grace period ends to keep company access. Monthly fees continue during suspension until the subscription’s effective cancellation date. Open Plans & Billing to review outstanding invoices, pay or cancel. All applicable overdue invoices, including missed months, must be verified paid before otherwise-eligible access resumes; returning from payment is not confirmation.",
    billing_paused:"Company operations are paused because a renewal remains unpaid. Monthly fees continue during suspension until the subscription’s effective cancellation date. Outstanding invoices, including missed months, remain due even after cancellation. Plans & Billing remains available to review outstanding invoices, pay or cancel. All applicable overdue invoices must be verified paid before otherwise-eligible access resumes; returning from payment is not confirmation. Separate administrative suspensions remain in effect.",
    billing_recovered:"All applicable overdue invoices have been verified paid. Billing suspension has been cleared. Any separate administrative suspension remains in effect. Payment does not restart a canceled subscription.",
    trial_ending:message.data.stripeTrial ? "Your Stripe trial ends soon. Your selected plan will be billed after the trial unless you cancel before it ends. Open the Stripe billing portal to update your card or cancel." : "Your trial is ending soon. Choose your paid seat quantity in Plans & Billing to continue. Checkout starts your paid subscription immediately.",
    trial_ended:"Your trial has ended and company operations are paused. Your data remains available for recovery. Choose your paid subscription in Plans & Billing.",
    trial_paused:"Your subscription is paused because there was no usable payment method at trial end. Add a payment method in the Stripe billing portal to resume your subscription and company access. You can also cancel there.",
    payment_action_required:"Your invoice needs payment authentication. Complete the payment on Stripe's hosted invoice page. Seats and access update after Stripe confirms payment.",
    payment_failed:"Your invoice payment failed. Open Plans & Billing, then Payment settings & invoices to update your card in the Billing Portal. Seats and access update after Stripe confirms payment.",
  }
  const deadline = message.data.graceEndsAt ?? message.data.trialEndsAt
  const deadlineLabel = message.data.trialEndsAt ? "Trial ends" : "Deadline"
  const preview = kind === "trial_ending" && message.data.stripeTrial && Number.isSafeInteger(message.data.amount) && Number.isSafeInteger(message.data.quantity) && typeof message.data.currency === "string"
    ? `Upcoming charge: ${new Intl.NumberFormat("en-US",{style:"currency",currency:message.data.currency.toUpperCase()}).format(Number(message.data.amount)/100)} for ${message.data.quantity} seats (Stripe invoice preview).` : null
  const invoiceUrl = kind === "payment_action_required" && typeof message.data.invoiceUrl === "string" && /^https:\/\//.test(message.data.invoiceUrl) ? message.data.invoiceUrl : null
  const portal = kind === "trial_paused" || (kind === "trial_ending" && message.data.stripeTrial)
  const text = [descriptions[kind], typeof deadline === "string" ? `${deadlineLabel}: ${deadline}` : "", preview, invoiceUrl ? `Complete payment: ${invoiceUrl}` : "", `${portal ? "Stripe billing portal" : "Plans & Billing"}: ${message.actionUrl}`].filter(Boolean).join("\n\n")
  const escape = (value:string) => value.replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[char]!)
  return {subject,text,html:`<p>${escape(descriptions[kind])}</p>${typeof deadline==="string"?`<p>${deadlineLabel}: ${escape(deadline)}</p>`:""}${preview?`<p>${escape(preview)}</p>`:""}${invoiceUrl?`<p><a href="${escape(invoiceUrl)}">Complete payment</a></p>`:""}<p><a href="${escape(message.actionUrl)}">${portal?"Open Stripe billing portal":"Open Plans &amp; Billing"}</a></p>`}
}

import { z } from "zod";
import type { EmailContent } from "../operations/email-transport";
import type { OnboardingEmailPurpose } from "./contracts";

const inputSchema = z.object({
  purpose: z.enum(["business_information_requested", "getting_started"]),
  enrollmentId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/),
  generation: z.number().int().positive(),
  trialEndsAt: z.iso.datetime({ offset: true }),
  origin: z.string().url(),
}).strict();
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/** These locators carry no authentication or claim authority; GET only resumes verification. */
export function renderOnboardingEmail(input: { purpose: OnboardingEmailPurpose; enrollmentId: string; generation: number; trialEndsAt: string; origin: string }): EmailContent {
  const value = inputSchema.parse(input), origin = new URL(value.origin);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("Configure a secure onboarding application origin.");
  const business = value.purpose === "business_information_requested";
  const action = new URL("/enrollment", origin);
  action.searchParams.set("enrollment", value.enrollmentId);
  action.searchParams.set("destination", business ? "business" : "crm");
  action.searchParams.set("generation", String(value.generation));
  const subject = business ? "Complete your Fundlane business details" : "Get started with Fundlane";
  const paragraphs = business ? [
    "Confirm or correct the business name supplied at Checkout and add your EIN in Fundlane’s secure form.",
    "Do not reply with your EIN. Phone and SMS require additional registration and approval; saving these details does not verify your business.",
  ] : [
    "Your Fundlane trial is active. These getting-started steps are optional and do not block CRM access.",
    "1. Connect an email sender that you are authorized to use.",
    "2. Explicitly send a test to your own address you control, then check your inbox and confirm that it was received. Provider acceptance alone does not prove receipt.",
    "3. Choose the default sender for the purpose you intend to use.",
    "4. Review the sender, permissions, and submission prerequisites in the in-app getting-started checklist. Explicitly initiate a safe synthetic submission using synthetic deal data and a sandbox funder; do not send to a live funder as a test.",
    `Your original trial ends at ${value.trialEndsAt}. Open Plans & Billing in Fundlane to manage billing or cancel before the automatic paid subscription begins.`,
  ];
  paragraphs.push("Sign in and verify your identity to continue. Opening this link does not create a company, submit details, or send a test.");
  const cta = business ? "Add business details" : "Open Fundlane";
  return { subject, text: [...paragraphs, `${cta}: ${action.href}`].join("\n\n"), html: `${paragraphs.map(p => `<p>${escapeHtml(p)}</p>`).join("")}<p><a href="${escapeHtml(action.href)}">${cta}</a></p>` };
}

import { z } from "zod";
import type { EmailContent } from "../operations/email-transport";
import type { OnboardingEmailPurpose } from "./contracts";

const inputSchema = z.object({
  purpose: z.enum(["business_information_requested", "getting_started"]),
  enrollmentId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/),
  generation: z.number().int().positive(),
  trialEndsAt: z.iso.datetime({ offset: true }),
  origin: z.string().url(),
  invite: z.object({ challengeId: z.uuid(), token: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/) }).strict().optional(),
}).strict();
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/** Locators carry no authority. Only a freeze-time new-owner invite carries a single-use, hashed-at-rest credential. */
export function renderOnboardingEmail(input: { purpose: OnboardingEmailPurpose; enrollmentId: string; generation: number; trialEndsAt: string; origin: string; invite?: { challengeId: string; token: string } }): EmailContent {
  const value = inputSchema.parse(input), origin = new URL(value.origin);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("Configure a secure onboarding application origin.");
  const business = value.purpose === "business_information_requested", invite = value.invite;
  if (business && invite) throw new Error("Business details email carries no credential.");
  const action = new URL(invite ? "/api/enrollment/invite" : "/enrollment", origin);
  if (invite) {
    action.searchParams.set("challenge", invite.challengeId);
    action.searchParams.set("token", invite.token);
  } else {
    action.searchParams.set("enrollment", value.enrollmentId);
    action.searchParams.set("destination", business ? "business" : "crm");
    action.searchParams.set("generation", String(value.generation));
  }
  const subject = business ? "Complete your Fundlane business details" : invite ? "Set your Fundlane password" : "Get started with Fundlane";
  const trial = `Original trial end: ${value.trialEndsAt}. Open Plans & Billing in Fundlane to review your current subscription, charges, and cancellation options.`;
  const paragraphs = business ? [
    "Confirm or correct the business name supplied at Checkout and add your EIN in Fundlane’s secure form, along with the details needed to register business texting (A2P 10DLC): business type, address, website, authorized contact, use-case description, sample messages and how customers opt in.",
    "Do not reply with your EIN. Phone and SMS require additional registration and approval; saving these details does not verify your business.",
  ] : invite ? [
    "Welcome to Fundlane. Confirm your email and set a password to finish creating your account.",
    "This link works once and expires 24 hours after it was sent. If it expires, open Fundlane from Login or request a new email code on your purchase page.",
    trial,
  ] : [
    "Welcome to Fundlane. These getting-started steps are optional and do not block CRM access.",
    "1. Connect an email sender that you are authorized to use.",
    "2. Explicitly send a test to your own address you control, then check your inbox and confirm that it was received. Provider acceptance alone does not prove receipt.",
    "3. Choose the default sender for the purpose you intend to use.",
    "4. Review the sender, permissions, and submission prerequisites in the in-app getting-started checklist. Explicitly initiate a safe synthetic submission using synthetic deal data and a sandbox funder; do not send to a live funder as a test.",
    trial,
  ];
  paragraphs.push(invite ? "Opening this link does not create a company; your company is created when you enter the CRM after setting your password." : "Sign in and verify your identity to continue. Opening this link does not create a company, submit details, or send a test.");
  const cta = business ? "Add business details" : invite ? "Set your password" : "Open Fundlane";
  return { subject, text: [...paragraphs, `${cta}: ${action.href}`].join("\n\n"), html: `${paragraphs.map(p => `<p>${escapeHtml(p)}</p>`).join("")}<p><a href="${escapeHtml(action.href)}">${cta}</a></p>` };
}

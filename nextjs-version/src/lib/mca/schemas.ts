import { z } from "zod";
import { API_KEY_SCOPES, ROLES } from "./types";

const nullableUrl = z.union([z.url().refine((value) => value.startsWith("https://"), "Use an HTTPS URL."), z.null()]);
const nullableId = z.union([z.uuid(), z.null()]);
const phone = z.string().trim().min(7, "Enter a phone number with 7 to 32 characters.").max(32, "Enter a phone number with 7 to 32 characters.");
const strongPassword = z.string().min(12).max(256);

export const signInSchema = z.object({
  email: z.email(),
  password: z.string().min(1).max(256),
  workspaceId: z.uuid().optional(),
});

export const recoveryRequestSchema = z.object({ email: z.email() });
export const recoveryResetSchema = z.object({ token: z.string().min(20), password: strongPassword });

export const invitationSchema = z.object({
  email: z.email({ error: "Enter a valid email address." }),
  name: z.string().trim().min(1, "Enter the employee's full name.").max(120, "Use at most 120 characters."),
  phone: phone.nullable().optional(),
  role: z.enum(ROLES),
  managerMembershipId: nullableId.optional(),
  senderAssociation: z.string().trim().max(160, "Use at most 160 characters.").nullable().optional(),
});

export const invitationAcceptSchema = z.object({
  token: z.string().min(20),
  password: strongPassword,
  name: z.string().trim().min(1).max(120).optional(),
  phone: phone.nullable().optional(),
});

export const membershipPatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  phone: phone.nullable().optional(),
  role: z.enum(ROLES).optional(),
  managerMembershipId: nullableId.optional(),
  senderAssociation: z.string().trim().max(160).nullable().optional(),
}).refine((value) => Object.keys(value).length > 0, "Provide at least one change.");

const featureFlags = z.object({ reports: z.boolean(), payments: z.boolean(), integrations: z.boolean(), dealAgent: z.boolean() }).partial();
const pageVisibility = z.object({
  dashboard: z.boolean(), deals: z.boolean(), users: z.boolean(), reports: z.boolean(),
  payments: z.boolean(), workspace: z.boolean(), integrations: z.boolean(),
}).partial();
const actionVisibility = z.object({
  createDeal: z.boolean(), exportDeals: z.boolean(), inviteUsers: z.boolean(), manageApiKeys: z.boolean(),
  viewPaymentTable: z.boolean(), viewCompanyFinancials: z.boolean(),
}).partial();

export const workspacePatchSchema = z.object({
  brokerageName: z.string().trim().min(1).max(160).optional(),
  logoUrl: nullableUrl.optional(),
  timezone: z.string().min(1).max(80).refine((value) => {
    try { Intl.DateTimeFormat(undefined, { timeZone: value }); return true; } catch { return false; }
  }, "Choose a valid IANA timezone.").optional(),
  seatLimit: z.number().int().min(1).max(10_000).optional(),
  featureFlags: featureFlags.optional(),
  pageVisibility: pageVisibility.optional(),
  actionVisibility: actionVisibility.optional(),
  require2fa: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, "Provide at least one change.");

export const apiKeyCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1).max(API_KEY_SCOPES.length).transform((items) => [...new Set(items)]),
  expiresAt: z.iso.datetime().nullable().optional().refine((value) => !value || value > new Date().toISOString(), "Expiry must be in the future."),
  rateLimitPerMinute: z.number().int().min(1).max(10_000).optional(),
});

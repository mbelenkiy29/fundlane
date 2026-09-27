import { z } from "zod"
import type { DealWriteInput } from "../deals/schema"
import type { FunnelStepId, OptionalFields } from "./form-schema"

export const invitationInput = z.object({
  clientName: z.string().trim().min(1, "Enter the business name.").max(150, "Use at most 150 characters."),
  email: z.string().trim().email("Enter a valid email address.").max(254, "Use at most 254 characters."),
  integrationId: z.string().min(1).max(100),
  requestKey: z.uuid(),
}).strict()
export const sendInput = z.object({ requestKey: z.uuid() }).strict()
export const trackingInput = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), kind: z.enum(["opened", "started"]) }).strict()
export const sessionTokenInput = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict()
export const draftInput = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  step: z.string().min(1).max(40),
  answers: z.record(z.string(), z.unknown()).optional(),
}).strict()
export const formSettingsInput = z.object({
  accent: z.string().trim().max(32).optional(),
  welcomeTitle: z.string().trim().max(120).optional(),
  welcomeBody: z.string().trim().max(600).optional(),
  thankYouTitle: z.string().trim().max(120).optional(),
  optionalFields: z.object({
    dbaName: z.boolean().optional(),
    naicsCode: z.boolean().optional(),
    ficoScore: z.boolean().optional(),
    fundingPurpose: z.boolean().optional(),
    driversLicense: z.boolean().optional(),
    voidedCheck: z.boolean().optional(),
  }).optional(),
}).strict()

export interface InvitationDelivery {
  id: string
  createdAt: string
  acceptedAt: string | null
  delivery: "sent" | "preview" | null
  state: "queued" | "running" | "complete" | "failed"
  errorCode: string | null
}
export interface ApplicationInvitation {
  id: string
  membershipId: string
  employeeName: string
  clientName: string
  businessName: string
  email: string
  formName: string
  provider: string
  createdAt: string
  expiresAt: string
  copiedAt: string | null
  sentAt: string | null
  openedAt: string | null
  startedAt: string | null
  submittedAt: string | null
  revokedAt: string | null
  requestedAmountCents: number | null
  lastStep: string | null
  reminderCount: number
  active: boolean
  intakeId: string | null
  intakeError: string | null
  dealId: string | null
  deliveries: InvitationDelivery[]
}

export interface InvitationFileView {
  id: string
  category: "statement" | "application" | "driver_license" | "voided_check"
  filename: string
  processingState: string
  byteLength: number
  createdAt: string
}

export interface FormBranding {
  accent: string | null
  welcomeTitle: string
  welcomeBody: string
  thankYouTitle: string
  optionalFields: OptionalFields
}

export interface ApplicationSession {
  provider: string
  formId: string
  clientName: string
  employeeName: string
  contactEmail: string
  submitted: boolean
  expiresAt: string
  step: FunnelStepId
  answers: DealWriteInput
  files: InvitationFileView[]
  requiredStatementMonths: number
  branding: FormBranding
}
export const OUTREACH_METRICS = ["created", "emailed", "opened", "started", "received", "incomplete", "submitted", "approved", "funded"] as const
export type OutreachMetric = typeof OUTREACH_METRICS[number]
export interface OutreachRow {
  membershipId: string | null
  name: string
  counts: Record<OutreachMetric, number>
  fundedAmountCents: number | null
  unknownFundedAmountCount: number
  conversions: { emailedToOpened: number | null; openedToReceived: number | null; receivedToFunded: number | null }
}
export interface OutreachReport {
  period: { from: string; to: string; timezone: string; asOf: string }
  employees: { id: string; name: string }[]
  totals: OutreachRow
  reps: OutreachRow[]
  invitations: (ApplicationInvitation & { stages: OutreachMetric[]; fundedAmountCents: number | null })[]
  financialsVisible: boolean
}

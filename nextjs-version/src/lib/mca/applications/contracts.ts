import { z } from "zod"

export const invitationInput = z.object({
  clientName: z.string().trim().min(1).max(150),
  email: z.string().trim().email().max(254),
  integrationId: z.string().min(1).max(100),
  requestKey: z.uuid(),
}).strict()
export const sendInput = z.object({ requestKey: z.uuid() }).strict()
export const trackingInput = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), kind: z.enum(["opened", "started"]) }).strict()

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
  email: string
  formName: string
  createdAt: string
  expiresAt: string
  copiedAt: string | null
  sentAt: string | null
  openedAt: string | null
  startedAt: string | null
  submittedAt: string | null
  revokedAt: string | null
  active: boolean
  intakeId: string | null
  intakeError: string | null
  dealId: string | null
  deliveries: InvitationDelivery[]
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

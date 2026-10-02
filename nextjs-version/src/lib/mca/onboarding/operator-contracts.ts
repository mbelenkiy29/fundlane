import { z } from "zod"
import type { Page } from "../platform-contracts"
import type { EnrollmentRecord, OnboardingEmailPurpose, OnboardingEmailState } from "./contracts"

export const enrollmentQueueStates = ["pending", "claimed", "due", "stalled", "compensation", "operator_required", "mail_uncertain", "mail_failed"] as const
export const enrollmentQueueQuerySchema = z.object({
  enrollmentId: z.uuid().optional(),
  state: z.enum(enrollmentQueueStates).optional(),
  cursor: z.string().min(1).max(2000).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict()
export type EnrollmentQueueQuery = z.infer<typeof enrollmentQueueQuerySchema>
export type EnrollmentRepairState = "attached" | "operator_required" | "lease_active" | "scheduled" | "due" | "stalled"
export interface EnrollmentOperationsRow {
  enrollmentId: string
  revision: number
  createdAt: string
  updatedAt: string
  workspaceId: string | null
  checkoutState: EnrollmentRecord["checkoutState"]
  billingState: EnrollmentRecord["billingState"]
  claimState: EnrollmentRecord["claimState"]
  finalizationState: EnrollmentRecord["finalizationState"]
  recoveryState: EnrollmentRecord["recoveryState"]
  trialEndsAt: string | null
  activatedAt: string | null
  verifiedAt: string | null
  nextReconcileAt: string
  leaseUntil: string | null
  repairState: EnrollmentRepairState
  hasRepairError: boolean
  emails: Array<{ purpose: OnboardingEmailPurpose; state: OnboardingEmailState; attempts: number; hasError: boolean; nextAttemptAt: string }>
}
export type EnrollmentOperationsPage = Page<EnrollmentOperationsRow> & {
  snapshotAt: string
  runtime: { enabled: boolean; creationEnabled: boolean; emailEnabled: boolean }
}

/** Exact sanitized projection of the protected enrollment detail route. */
export type EnrollmentOperatorAction = "verify_target" | "approve_identity" | "record_email_evidence" | "reissue_emails"
export interface EnrollmentOperatorEmail {
  id: string
  purpose: OnboardingEmailPurpose
  generation: number
  state: OnboardingEmailState
  attempts: number
  createdAt: string
  updatedAt: string
  ageSeconds: number
  nextAttemptAt: string
  errorCode: string | null
  provider: "usesend" | "resend" | "webhook" | null
  providerConfigurationId: string | null
  providerIdentityVerified: false
  providerMessageId: string | null
  supersededByGeneration: number | null
  canRecordEvidence: boolean
  receipts: Array<{ id: string; state: string; providerMessageId: string | null; evidenceType: string; occurredAt: string; observedAt: string }>
}
export interface EnrollmentOperatorTarget {
  id: string
  state: string
  provider_user_id: string | null
  verified_at: string | null
}
export interface EnrollmentOperatorDetail {
  enrollmentId: string
  revision: number
  claimState: string
  recoveryState: string
  emailGeneration: number
  billingState: string
  trialEndsAt: string | null
  providerAccountId: string
  checkoutSessionId: string | null
  subscriptionId: string | null
  livemode: boolean
  runtime: { runtimeEnabled: boolean; creationEnabled: boolean; emailDispatchEnabled: boolean }
  availableActions: EnrollmentOperatorAction[]
  targetVerification: EnrollmentOperatorTarget[]
  emails: EnrollmentOperatorEmail[]
}

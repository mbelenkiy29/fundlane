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

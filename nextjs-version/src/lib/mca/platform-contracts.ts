import { z } from "zod"
export type Page<T> = { items: T[]; nextCursor: string | null }
export const ownerQueueQuerySchema = z.object({
  workspaceId: z.string().trim().min(1).max(200).optional(),
  state: z.enum(["draft", "pending", "approved", "rejected", "not_started"]).optional(),
  cursor: z.string().min(1).max(2000).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
export type OwnerQueueQuery = z.infer<typeof ownerQueueQuerySchema>
export type CompanyOperationsRow = {
  workspaceId: string; name: string; ownerEmail: string | null; occupiedSeats: number; purchasedSeats: number
  subscriptionStatus: string; accessState: string; smsReviewState: string; providerState: string
  blockedReasons: string[]; observedAt: string | null
}
export type RegistrationSummary = { id: string; kind: string; attempt: number; state: string }
export type SmsReviewItem = {
  workspaceId: string; companyName: string; submissionId: string | null; version: number | null
  latestOperation: { id: string; kind: string; state: string } | null
  reviewState: string; submittedAt: string | null; registrationSummary: RegistrationSummary[]; blockedReasons: string[]
}
export type ProviderObservation = {
  kind: "customer_profile" | "trust_product" | "brand" | "campaign"; attempt: number; providerSid: string | null
  state: "not_started" | "pending" | "approved" | "rejected" | "unknown"
  providerStatus: string | null; observedAt: string; errorCodes: string[]
}

export interface SmsCreditBalance {
  balanceSegments: number
  reservedSegments: number
  availableSegments: number
  updatedAt: string
}

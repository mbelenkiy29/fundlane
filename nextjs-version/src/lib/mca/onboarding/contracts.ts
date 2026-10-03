import type { BILLING_CATALOG } from "../billing-catalog";

/** Server-selected catalog snapshot. Never accept this contract from request JSON. */
export interface EnrollmentOffer {
  version: 1;
  accountId: string;
  basePriceId: string;
  seatPriceId: string;
  currency: "usd";
  baseAmount: typeof BILLING_CATALOG.base.unitAmountCents;
  quantity: 1;
  trialDays: 14;
  livemode: boolean;
  promotionCodes: boolean;
  automaticTax: boolean;
}

/** Internal, provider-verified result. It is not an HTTP request DTO. */
export interface EnrollmentActivation {
  sessionId: string;
  customerId: string;
  subscriptionId: string;
  email: string;
  businessName: string;
  trialStartedAt: string;
  trialEndsAt: string;
  verifiedAt: string;
  billingStatus: string;
  livemode: boolean;
}

export type EnrollmentCheckoutState = "created" | "creating" | "open" | "complete" | "expired" | "uncertain";
export type EnrollmentBillingState = "pending" | "trialing" | "active" | "paused" | "incomplete" | "incomplete_expired" | "past_due" | "unpaid" | "canceled" | "blocked";
export type EnrollmentClaimState = "unclaimed" | "claiming" | "claimed" | "blocked";
export type EnrollmentFinalizationState = "pending" | "complete" | "blocked";
export type EnrollmentRecoveryState = "none" | "pending" | "canceling" | "canceled" | "uncertain" | "operator_required";
export type OnboardingEmailPurpose = "business_information_requested" | "getting_started";
export type OnboardingEmailState = "queued" | "sending" | "retry" | "accepted" | "delivered" | "failed" | "uncertain" | "suppressed";

/** Private server view; public status must explicitly project permitted fields. */
export interface EnrollmentRecord {
  id: string;
  resumeSecretHash: string;
  offer: EnrollmentOffer;
  providerAccountId: string;
  initiatingProviderUserId: string | null;
  claimedProviderUserId: string | null;
  userId: string | null;
  workspaceId: string | null;
  checkoutState: EnrollmentCheckoutState;
  billingState: EnrollmentBillingState;
  claimState: EnrollmentClaimState;
  finalizationState: EnrollmentFinalizationState;
  recoveryState: EnrollmentRecoveryState;
  checkoutSessionId: string | null;
  customerId: string | null;
  subscriptionId: string | null;
  contactCipher: string | null;
  providerSnapshotCipher: string | null;
  emailHash: string | null;
  emailDomainHash: string | null;
  activationEmailHash: string | null;
  activationEmailDomainHash: string | null;
  trialStartedAt: string | null;
  trialEndsAt: string | null;
  activatedAt: string | null;
  verifiedAt: string | null;
  revision: number;
  activationVersion: number;
  checkoutGeneration: number;
  resumeGeneration: number;
  emailGeneration: number;
  checkoutRequestKey: string;
  checkoutRequestedAt: string | null;
  checkoutExpiresAt: string | null;
  claimToken: string | null;
  leaseUntil: string | null;
  nextReconcileAt: string;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnrollmentContact { email: string; businessName: string }

/** No EIN, Auth token, or provider portal capability belongs in this stored payload. A new-owner invite token is minted only at freeze time and exists solely in the encrypted frozen content. */
export interface OnboardingEmailPayload {
  version: 1;
  enrollmentId: string;
  generation: number;
  purpose: OnboardingEmailPurpose;
  email: string;
  trialEndsAt: string;
}

import "server-only"

import type { RenderedSubmissionEmail } from "./email-templates"
import type { DealActor } from "../deals/schema"
import type { FunderRoute, FunderRouteKind } from "../funders/contracts"

export const JOB_STATES = [
  "preflight_failed",
  "queued",
  "sending",
  "sent",
  "failed",
  "skipped",
  "pending_portal",
  "blocked_duplicate",
  "declined",
  "funded",
] as const
export type JobState = (typeof JOB_STATES)[number]

export const ATTEMPT_STATES = ["queued", "sending", "sent", "failed", "skipped"] as const
export type AttemptState = (typeof ATTEMPT_STATES)[number]

export const DERIVATIVE_STAGES = ["stamp", "watermark", "compress"] as const
export type DerivativeStage = (typeof DERIVATIVE_STAGES)[number]

export const OFFER_SOURCES = ["api", "email", "link", "manual"] as const
export type OfferSource = (typeof OFFER_SOURCES)[number]

export const REPLY_STATES = ["pending_review", "matched", "ignored", "processed"] as const
export type ReplyState = (typeof REPLY_STATES)[number]

export const ADAPTER_ENVIRONMENTS = ["development", "production"] as const
export type AdapterEnvironment = (typeof ADAPTER_ENVIRONMENTS)[number]

export interface DuplicateDecision {
  allowed: boolean
  code?: "retry_too_soon" | "recent_duplicate" | "privileged_retry"
  eligibleAt?: string
  reason?: string
}

export interface QueueSubmissionsInput {
  actor: DealActor
  dealId: string
  funderIds: string[]
  analysisRunId?: string
  confirmationKey: string
  expectedDealVersion?: number
  autoSubmitDecisionId?: string
  /** Route approved by the auto-submit worker; checked again when the job is inserted. */
  expectedAutoApiRoute?: FunderRoute
  approvedPackages?: Record<string, ApprovedSubmissionPackage>
  deferDelivery?: boolean
  privilegedRetry?: boolean
  privilegedReason?: string
}

export interface QueuedJobSummary {
  jobId: string
  funderId: string
  state: JobState
  reason?: string
  eligibleAt?: string
}

export interface QueueSubmissionsResult {
  ok: true
  jobs: QueuedJobSummary[]
}

export interface ApprovedSubmissionPackage {
  route: FunderRoute
  originalVersions: SubmissionJob["documentVersions"]
  filenames: Record<string, string>
  documents: OutgoingDocument[]
  email?: RenderedSubmissionEmail
}

export interface SubmissionJob {
  id: string
  workspaceId: string
  dealId: string
  funderId: string
  displayFunderName: string
  routeKind: FunderRouteKind
  route: FunderRoute
  state: JobState
  confirmationKey: string
  attemptKey: string
  analysisRunId?: string
  autoSubmitDecisionId?: string
  dealVersion: number
  documentVersions: Array<{ documentId: string; checksum: string; category: string }>
  packageDocumentIds: string[]
  approvedPackage?: ApprovedSubmissionPackage
  preflightErrors: Array<{ field: string; message: string }>
  merchantIdentityKey: string
  packageFingerprint: string
  reason?: string
  createdAt: string
  updatedAt: string
}

export interface SubmissionAttempt {
  id: string
  jobId: string
  attemptKey: string
  transport: FunderRouteKind
  state: AttemptState
  correlationId: string
  externalRef?: string
  errorCode?: string
  errorMessage?: string
  createdAt: string
}

export interface OutgoingDocument {
  documentId: string
  originalDocumentId: string
  checksum: string
  byteLength: number
  stage: DerivativeStage | "original"
}

export interface PackageResult {
  documents: OutgoingDocument[]
  originalChecksums: Record<string, string>
}

export interface DeliverResult {
  ok: boolean
  state: JobState
  correlationId: string
  externalRef?: string
  errorCode?: string
  errorMessage?: string
}

export interface AdapterCapabilities {
  submit: true
  statusPoll: boolean
  webhooks: boolean
  offers: boolean
}

export interface AdapterSubmitResult {
  ok: boolean
  correlationId: string
  externalRef?: string
  rawStatus?: string
  errorCode?: string
  errorMessage?: string
  fields?: Record<string, string>
}

export interface AdapterStatusResult {
  rawStatus: string
  normalized?: "submitted" | "pending" | "approved" | "declined" | "funded" | "unknown"
  terms?: {
    amount?: number
    rate?: number
    term?: number
    frequency?: string
    commission?: number
    offerLink?: string
  }
  correlationId: string
  eventId?: string
  unknown: boolean
}

export interface FunderAdapter {
  slug: string
  readiness?: "live" | "sandbox" | "unavailable"
  validate(input: unknown): { ok: true } | { ok: false; fields: Record<string, string> }
  submit(job: SubmissionJob): Promise<AdapterSubmitResult>
  getStatus?(job: SubmissionJob): Promise<AdapterStatusResult>
  parseWebhook?(headers: Record<string, string>, body: unknown): Promise<AdapterStatusResult>
  capabilities: AdapterCapabilities
}

/** Contract for adapters built against a verified provider specification. */
export interface FunderSubmissionAdapter<Config, Application, Payload> extends FunderAdapter {
  validateConfig(config: Config): { ok: true } | { ok: false; fields: Record<string, string> }
  mapSubmission(job: SubmissionJob, application: Application): Payload
  normalizeStatus(rawStatus: string): AdapterStatusResult["normalized"]
}

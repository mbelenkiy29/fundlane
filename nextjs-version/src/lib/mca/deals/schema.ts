import type { ApiKeyScope, Role } from "../types"

export const DEAL_STATUSES = [
  "lead",
  "new_application",
  "missing_documents",
  "ready_to_submit",
  "submitted",
  "resubmitting",
  "offer",
  "repricing",
  "contract",
  "funded",
  "renewed",
  "closed",
  "default",
  "missed_payments",
] as const

export type DealStatus = (typeof DEAL_STATUSES)[number]

export const DEAL_STATUS_LABELS: Record<DealStatus, string> = {
  lead: "Lead",
  new_application: "New application",
  missing_documents: "Missing documents",
  ready_to_submit: "Ready to submit",
  submitted: "Submitted",
  resubmitting: "Resubmitting",
  offer: "Offer",
  repricing: "Repricing",
  contract: "Contract",
  funded: "Funded",
  renewed: "Renewed",
  closed: "Closed",
  default: "Default",
  missed_payments: "Missed payments",
}

export const ENTITY_TYPES = [
  "llc",
  "corporation",
  "s_corporation",
  "partnership",
  "sole_proprietor",
  "nonprofit",
  "other",
] as const

export type EntityType = (typeof ENTITY_TYPES)[number]
export type AssignmentKind = "originator" | "closer"
export type DealSource = "manual" | "import" | "application_scan" | "api" | "system"
export type DraftState = "partial" | "submission_ready"

export interface DealActor {
  apiKeyId?: string
  sessionId?: string | null
  scopes?: readonly ApiKeyScope[]
  workspaceId: string
  userId: string | null
  membershipId: string | null
  role: Role | null
  managedMembershipIds: readonly string[]
  activeMembershipIds: readonly string[]
  source: "user" | "api_key" | "system"
  correlationId: string
}

export interface FieldSource {
  source: DealSource
  actorUserId: string | null
  capturedAt: string
  correlationId?: string
}

export interface DealAddress {
  line1?: string
  line2?: string
  city?: string
  state?: string
  postalCode?: string
  country?: string
}

export interface DealOwnerInput {
  id?: string
  firstName?: string
  lastName?: string
  ownershipPercent?: number
  isPrimary?: boolean
  dateOfBirth?: string
  identityLast4?: string
  email?: string
  phone?: string
}

export interface DealOwner extends Omit<DealOwnerInput, "id"> {
  id: string
}

export interface ProtectedDealOwner {
  id: string
  firstName?: string
  lastName?: string
  ownershipPercent?: number
  isPrimary?: boolean
  dateOfBirth?: string
  identityLast4?: string
  email?: string
  phone?: string
}

export interface DealAssignment {
  id: string
  membershipId: string
  kind: AssignmentKind
  isPrimary: boolean
  assignedAt: string
  assignedByUserId: string | null
}

export interface DealNote {
  id: string
  body: string
  actorUserId: string | null
  createdAt: string
}

export interface DealActivity {
  id: string
  action: "created" | "updated" | "assigned" | "note_added" | "status_changed"
  actorUserId: string | null
  source: DealSource
  summary: string
  fromStatus?: DealStatus
  toStatus?: DealStatus
  createdAt: string
  version: number
  correlationId: string
}

export interface DealSubmissionSummary {
  id: string
  funderName: string
  status: "draft" | "queued" | "sent" | "errored" | "declined" | "approved"
}

export interface DealOfferSummary {
  id: string
  submissionId: string
  status: "received" | "presented" | "accepted" | "declined" | "expired"
}

export interface DealRecord {
  id: string
  workspaceId: string
  merchantId?: string
  displayId: string
  legalName?: string
  dbaName?: string
  ein?: string
  entityType?: EntityType
  address?: DealAddress
  contactName?: string
  contactEmail?: string
  contactPhone?: string
  startDate?: string
  industry?: string
  naicsCode?: string
  monthlyRevenue?: number
  ficoScore?: number
  fundingPurpose?: string
  requestedAmount?: number
  status: DealStatus
  pipelineVersion: 1
  draftState: DraftState
  missingRequiredFields: string[]
  owners: DealOwner[]
  assignments: DealAssignment[]
  notes: DealNote[]
  activity: DealActivity[]
  submissions: DealSubmissionSummary[]
  offers: DealOfferSummary[]
  fieldSources: Record<string, FieldSource>
  idempotencyKey?: string
  version: number
  createdAt: string
  updatedAt: string
}

export interface DealListItem {
  id: string
  displayId: string
  legalName: string
  dbaName?: string
  status: DealStatus
  pipelineVersion: 1
  requestedAmount?: number
  monthlyRevenue?: number
  draftState: DraftState
  missingRequiredFields: string[]
  assignments: DealAssignment[]
  funderNames: string[]
  version: number
  createdAt: string
  updatedAt: string
}

export interface DealDetail extends Omit<DealRecord, "owners"> {
  owners: ProtectedDealOwner[]
}

export interface DealWriteInput {
  legalName?: string
  dbaName?: string
  ein?: string
  entityType?: EntityType
  address?: DealAddress
  contactName?: string
  contactEmail?: string
  contactPhone?: string
  startDate?: string
  industry?: string
  naicsCode?: string
  monthlyRevenue?: number
  ficoScore?: number
  fundingPurpose?: string
  requestedAmount?: number
  owners?: DealOwnerInput[]
  assignments?: Array<{ membershipId: string; kind: AssignmentKind; isPrimary?: boolean }>
  fieldSource?: DealSource
}

export interface CreateDealInput extends DealWriteInput {
  idempotencyKey: string
  forceDuplicate?: boolean
  attachMerchantId?: string
}

export interface UpdateDealInput extends DealWriteInput {
  expectedVersion: number
}

export interface TransitionDealInput {
  expectedVersion: number
  status: DealStatus
  reason?: string
  source?: DealSource
}

export interface DealFilters {
  search?: string
  statuses?: DealStatus[]
  assignee?: string
  createdFrom?: string
  createdTo?: string
  funder?: string
}

export interface DealListResponse {
  deals: DealListItem[]
  counts: Partial<Record<DealStatus, number>>
  total: number
  filters: DealFilters
}

export interface DealConflict {
  code: "version_conflict"
  message: string
  current: DealDetail
  expectedVersion: number
  attemptedFields: string[]
}

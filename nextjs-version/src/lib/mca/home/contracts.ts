import type { AssignmentKind, DealStatus, DraftState } from "../deals/schema"
import type { HomeOutreachId, HomeSuggestedAction } from "./outreach"

export type { HomeOutreachId, HomeSuggestedAction }

export const HOME_ACTION_REASONS = [
  "submit",
  "resubmit",
  "pitch",
  "merchant_follow_up",
  "funder_follow_up",
  "contract",
  "missing_doc",
  "signature",
  "repricing",
  "funding",
  "renewal",
] as const
export type HomeActionReasonCode = (typeof HOME_ACTION_REASONS)[number]

export const HOME_ACTION_CATEGORIES = ["own_action", "overdue_waiting", "renewal"] as const
export type HomeActionCategory = (typeof HOME_ACTION_CATEGORIES)[number]

export const HOME_SLA_HOURS = {
  merchant_follow_up: 48,
  funder_follow_up: 72,
  contract: 48,
  missing_doc: 48,
  signature: 48,
  repricing: 48,
} as const

export const HOME_CATEGORY_RANK: Record<HomeActionCategory, number> = {
  own_action: 0,
  overdue_waiting: 1,
  renewal: 2,
}

export const HOME_REASON_RANK: Record<HomeActionReasonCode, number> = {
  funding: 0,
  signature: 1,
  missing_doc: 2,
  contract: 3,
  resubmit: 4,
  submit: 5,
  pitch: 6,
  repricing: 7,
  funder_follow_up: 8,
  merchant_follow_up: 9,
  renewal: 10,
}

export const HOME_REASON_LABELS: Record<HomeActionReasonCode, Record<HomeActionCategory, string>> = {
  submit: { own_action: "Submit to funders", overdue_waiting: "Submit to funders", renewal: "Submit to funders" },
  resubmit: { own_action: "Resubmit or close out", overdue_waiting: "Resubmit or close out", renewal: "Resubmit or close out" },
  pitch: { own_action: "Pitch offer", overdue_waiting: "Pitch offer", renewal: "Pitch offer" },
  merchant_follow_up: {
    own_action: "Follow up merchant on offer",
    overdue_waiting: "Follow up merchant on offer",
    renewal: "Follow up merchant on offer",
  },
  funder_follow_up: { own_action: "Nudge ignored funders", overdue_waiting: "Nudge ignored funders", renewal: "Nudge ignored funders" },
  contract: { own_action: "Request contracts", overdue_waiting: "Chase funder for contracts", renewal: "Request contracts" },
  missing_doc: { own_action: "Collect missing docs", overdue_waiting: "Chase missing docs", renewal: "Collect missing docs" },
  signature: { own_action: "Chase signature", overdue_waiting: "Chase signature", renewal: "Chase signature" },
  repricing: { own_action: "Follow up repricing", overdue_waiting: "Follow up repricing", renewal: "Follow up repricing" },
  funding: { own_action: "Finalize funding", overdue_waiting: "Finalize funding", renewal: "Finalize funding" },
  renewal: { own_action: "Renewal follow-up", overdue_waiting: "Renewal follow-up", renewal: "Renewal follow-up" },
}

export const HOME_COPY = {
  title: "Needs Action",
  description: "Deals where the next move is yours, a wait has gone past normal turnaround, or a past funding is up for renewal. The queue is derived from live deal state — there is no separate task list to mark done.",
  loading: "Loading needs-action queue…",
  empty: "You are all caught up. If a deal is on Home, there is a reason.",
  validation: "Review the highlighted filters.",
  failed: "The needs-action queue could not be loaded.",
  retry: "Retry",
  panelLoading: "Loading deal…",
  panelEmpty: "No remaining actions on this deal.",
  panelFailed: "This deal panel could not be loaded.",
  caughtUp: "Caught up",
  action: "Action",
  actionSince: "Action since",
  fullDeal: "Full Deal",
  updateStatus: "Update Status",
  submit: "Submit",
  pitched: "Pitched",
  addNote: "Add note",
  notePlaceholder: "Internal note",
  contacts: "Contacts",
  offers: "Offers",
  submissions: "Submissions",
  notes: "Notes",
  advances: "Advances",
  workflow: "Workflow",
  ownAction: "Your move",
  overdueWaiting: "Waiting past turnaround",
  renewal: "Renewal",
} as const

export interface HomeActionReason {
  id: string
  code: HomeActionReasonCode
  category: HomeActionCategory
  label: string
  since: string
  sourceIds: string[]
  detail?: string
}

export interface HomeQueueItem {
  dealId: string
  displayId: string
  legalName: string
  status: DealStatus
  version: number
  reasons: HomeActionReason[]
  primaryReason: HomeActionReason
  category: HomeActionCategory
  actionSince: string
  updatedAt: string
  notification: string
  contacts: HomePanelContact
  suggestedActions: HomeSuggestedAction[]
  missingStatementMonths?: number
}

export interface HomeQueueCounts {
  own_action: number
  overdue_waiting: number
  renewal: number
  total: number
}

export interface HomeQueueResult {
  refreshedAt: string
  now: string
  slaHours: typeof HOME_SLA_HOURS
  items: HomeQueueItem[]
  counts: HomeQueueCounts
}

export interface HomePanelContact {
  name?: string
  email?: string
  phone?: string
}

export interface HomePanelOffer {
  id: string
  funderName: string
  revisionId: string
  amountCents?: number
  selected: boolean
  pitched: boolean
  pitchedAt?: string
  state: string
}

export interface HomePanelSubmission {
  id: string
  jobId?: string
  funderName: string
  status: string
  routeKind?: string
  jobState?: string
  sentAt?: string
  hasResponse: boolean
  overdue: boolean
}

export interface HomePanelNote {
  id: string
  body: string
  actorUserId: string | null
  createdAt: string
}

export interface HomePanelStipulation {
  id: string
  label: string
  status: string
  documentCategory: string
  createdAt: string
  dueDate?: string
}

export interface HomePanelContract {
  id: string
  state: string
  funderName: string
  offerRevisionId: string
  acceptedAt?: string
  contractRequestedAt?: string
  contractSentAt?: string
  signedAt?: string
  repricingRequestedAt?: string
}

export interface HomePanelAdvance {
  id: string
  funderName: string
  fundedAt: string
  principalCents: number
  renewalEligible: boolean
  renewalActionId?: string
}

export interface HomeWorkflowAction {
  id: "full_deal" | "update_status" | "submit" | "pitched" | "request_contract" | "funded" | "remind_funder" | "add_note"
  label: string
  enabled: boolean
  href?: string
  offerId?: string
  revisionId?: string
}

export interface HomePanelAssignment {
  membershipId: string
  kind: AssignmentKind
  isPrimary: boolean
}

export interface HomeDealPanel {
  dealId: string
  displayId: string
  legalName: string
  status: DealStatus
  version: number
  draftState: DraftState
  reasons: HomeActionReason[]
  contacts: HomePanelContact
  assignments: HomePanelAssignment[]
  allowedStatuses: DealStatus[]
  offers: HomePanelOffer[]
  submissions: HomePanelSubmission[]
  notes: HomePanelNote[]
  stipulations: HomePanelStipulation[]
  contracts: HomePanelContract[]
  advances: HomePanelAdvance[]
  workflowActions: HomeWorkflowAction[]
  refreshedAt: string
  now: string
}

export interface HomeQueueQuery {
  nowIso: string
  category?: HomeActionCategory
}

export interface HomeOfferFact {
  id: string
  dealId: string
  funderName: string
  submissionId?: string
  currentRevisionId: string
  currentRevisionState: string
  currentAmountCents?: number
  selected: boolean
  createdAt: string
  pitchedAt?: string
}

export interface HomeSubmissionFact {
  id: string
  dealId: string
  jobId?: string
  funderName: string
  status: string
  routeKind?: string
  jobState?: string
  sentAt?: string
  hasResponse: boolean
}

export interface HomeStipulationFact {
  id: string
  dealId: string
  status: string
  label: string
  documentCategory: string
  createdAt: string
  dueDate?: string
  receivedAt?: string
}

export interface HomeContractFact {
  id: string
  dealId: string
  offerId: string
  offerRevisionId: string
  funderName: string
  state: string
  acceptedAt?: string
  contractRequestedAt?: string
  contractSentAt?: string
  signedAt?: string
  finalReviewAt?: string
  repricingRequestedAt?: string
}

export interface HomeFundingFact {
  dealId: string
  offerRevisionId: string
  state: string
  fundedAt: string
}

export interface HomeRenewalFact {
  id: string
  dealId: string
  sourceAdvanceId: string
  state: string
  eligibleAt: string
  funderName?: string
  principalCents?: number
}

export interface HomeAdvanceFact {
  id: string
  dealId: string
  funderName: string
  fundedAt: string
  principalCents: number
  status: string
}

export interface HomeNoteFact {
  id: string
  dealId: string
  body: string
  actorUserId: string | null
  createdAt: string
}

export interface HomeDealFacts {
  dealId: string
  displayId: string
  legalName: string
  status: DealStatus
  draftState: DraftState
  version: number
  createdAt: string
  updatedAt: string
  statusChangedAt: string
  contactName?: string
  contactEmail?: string
  contactPhone?: string
  assignments: HomePanelAssignment[]
  offers: HomeOfferFact[]
  submissions: HomeSubmissionFact[]
  stipulations: HomeStipulationFact[]
  contracts: HomeContractFact[]
  fundingEvents: HomeFundingFact[]
  renewals: HomeRenewalFact[]
  advances: HomeAdvanceFact[]
  notes: HomeNoteFact[]
  completenessReady?: boolean
  missingStatementMonths?: number
}

export function isHomeActionReason(value: string): value is HomeActionReasonCode {
  return (HOME_ACTION_REASONS as readonly string[]).includes(value)
}

export function isHomeActionCategory(value: string): value is HomeActionCategory {
  return (HOME_ACTION_CATEGORIES as readonly string[]).includes(value)
}

export function formatActionSince(since: string, nowIso: string): string {
  const elapsed = Date.parse(nowIso) - Date.parse(since)
  if (!Number.isFinite(elapsed) || elapsed < 0) return "0h"
  const hours = Math.floor(elapsed / 3_600_000)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

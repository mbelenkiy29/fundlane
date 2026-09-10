import type { DealStatus } from "../deals/schema"
import {
  HOME_CATEGORY_RANK,
  HOME_REASON_LABELS,
  HOME_REASON_RANK,
  HOME_SLA_HOURS,
  type HomeActionCategory,
  type HomeActionReason,
  type HomeActionReasonCode,
  type HomeAdvanceFact,
  type HomeContractFact,
  type HomeDealFacts,
  type HomeDealPanel,
  type HomeOfferFact,
  type HomeQueueItem,
  type HomeStipulationFact,
  type HomeSubmissionFact,
  type HomeWorkflowAction,
} from "./contracts"
import { allowedTransitions } from "../deals/pipeline"

const TERMINAL_STATUSES = new Set<DealStatus>(["closed", "default"])
const FUNDED_LIKE = new Set<DealStatus>(["funded", "renewed", "missed_payments"])
const OPEN_STIPS = new Set(["open", "received"])
const ACTIVE_RENEWALS = new Set(["eligible", "contacted", "documents_requested"])
const RESPONSE_STATUSES = new Set(["approved", "declined"])
const FAILED_SUBMISSIONS = new Set(["declined", "errored", "failed"])
const SENT_JOB_STATES = new Set(["sent", "sending", "pending_portal"])
const ACTIVE_OFFER_STATES = new Set(["active", "superseded"])

function overdue(since: string | undefined, hours: number, nowIso: string): boolean {
  if (!since) return false
  const elapsed = Date.parse(nowIso) - Date.parse(since)
  return Number.isFinite(elapsed) && elapsed >= hours * 3_600_000
}

function earliest(values: Array<string | undefined>): string | undefined {
  const usable = values.filter((value): value is string => Boolean(value) && Number.isFinite(Date.parse(value ?? "")))
  if (!usable.length) return undefined
  return usable.reduce((min, value) => (value < min ? value : min))
}

function reason(
  dealId: string,
  code: HomeActionReasonCode,
  category: HomeActionCategory,
  since: string,
  sourceIds: string[],
  detail?: string,
): HomeActionReason {
  return {
    id: `${dealId}:${code}`,
    code,
    category,
    label: HOME_REASON_LABELS[code][category],
    since,
    sourceIds: [...new Set(sourceIds.filter(Boolean))],
    detail,
  }
}

function sortReasons(reasons: HomeActionReason[]): HomeActionReason[] {
  return [...reasons].sort((left, right) => {
    const category = HOME_CATEGORY_RANK[left.category] - HOME_CATEGORY_RANK[right.category]
    if (category) return category
    const rank = HOME_REASON_RANK[left.code] - HOME_REASON_RANK[right.code]
    if (rank) return rank
    if (left.since !== right.since) return left.since < right.since ? -1 : 1
    return left.id < right.id ? -1 : 1
  })
}

function activeOffers(offers: HomeOfferFact[]): HomeOfferFact[] {
  return offers.filter((offer) => ACTIVE_OFFER_STATES.has(offer.currentRevisionState) && offer.currentRevisionId)
}

function unansweredSubmissions(submissions: HomeSubmissionFact[]): HomeSubmissionFact[] {
  return submissions.filter((item) => {
    if (item.hasResponse || RESPONSE_STATUSES.has(item.status)) return false
    const sent = item.jobState ? SENT_JOB_STATES.has(item.jobState) : item.status === "sent" || item.status === "queued"
    return sent
  })
}

function failedWithoutApproval(submissions: HomeSubmissionFact[]): boolean {
  if (!submissions.length) return false
  if (submissions.some((item) => item.status === "approved")) return false
  if (unansweredSubmissions(submissions).length) return false
  return submissions.some((item) => FAILED_SUBMISSIONS.has(item.status) || item.jobState === "failed")
}

function blockingContract(contracts: HomeContractFact[]): HomeContractFact | undefined {
  return contracts.find((item) => ["accepted", "contract_requested", "contract_sent", "signed", "final_review", "repricing_requested"].includes(item.state))
}

function committedFunding(facts: HomeDealFacts): boolean {
  return facts.fundingEvents.some((item) => item.state === "committed")
}

function openStipulations(stips: HomeStipulationFact[]): HomeStipulationFact[] {
  return stips.filter((item) => OPEN_STIPS.has(item.status))
}

function stipOverdue(item: HomeStipulationFact, nowIso: string): boolean {
  if (item.dueDate && Date.parse(item.dueDate) <= Date.parse(nowIso)) return true
  return overdue(item.createdAt, HOME_SLA_HOURS.missing_doc, nowIso)
}

export function deriveHomeReasons(facts: HomeDealFacts, nowIso: string): HomeActionReason[] {
  const reasons: HomeActionReason[] = []
  const renewalSources = facts.renewals.filter((item) => ACTIVE_RENEWALS.has(item.state))
  if (renewalSources.length) {
    reasons.push(reason(
      facts.dealId,
      "renewal",
      "renewal",
      earliest(renewalSources.map((item) => item.eligibleAt)) ?? facts.createdAt,
      renewalSources.map((item) => item.id),
      renewalSources[0]?.funderName,
    ))
  }

  if (TERMINAL_STATUSES.has(facts.status)) return sortReasons(reasons)

  const stips = openStipulations(facts.stipulations)
  if (stips.length) {
    const late = stips.filter((item) => stipOverdue(item, nowIso))
    const use = late.length ? late : stips
    reasons.push(reason(
      facts.dealId,
      "missing_doc",
      late.length ? "overdue_waiting" : "own_action",
      earliest(use.map((item) => item.dueDate && Date.parse(item.dueDate) <= Date.parse(nowIso) ? item.dueDate : item.createdAt)) ?? facts.statusChangedAt,
      use.map((item) => item.id),
      use[0]?.label,
    ))
  } else if (facts.status === "missing_documents") {
    reasons.push(reason(facts.dealId, "missing_doc", "own_action", facts.statusChangedAt, [facts.dealId]))
  }

  if (FUNDED_LIKE.has(facts.status)) return sortReasons(reasons)

  if (facts.status === "ready_to_submit" || (facts.status === "new_application" && facts.draftState === "submission_ready")) {
    reasons.push(reason(facts.dealId, "submit", "own_action", facts.statusChangedAt, [facts.dealId]))
  }

  const offers = activeOffers(facts.offers)
  const accepted = blockingContract(facts.contracts)
  const funded = committedFunding(facts)

  if (facts.status === "resubmitting" || (failedWithoutApproval(facts.submissions) && !offers.length && !accepted)) {
    const failed = facts.submissions.filter((item) => FAILED_SUBMISSIONS.has(item.status) || item.jobState === "failed")
    reasons.push(reason(
      facts.dealId,
      "resubmit",
      "own_action",
      earliest(failed.map((item) => item.sentAt)) ?? facts.statusChangedAt,
      failed.map((item) => item.jobId ?? item.id),
    ))
  }

  const unanswered = unansweredSubmissions(facts.submissions)
  const overdueFunders = unanswered.filter((item) => overdue(item.sentAt, HOME_SLA_HOURS.funder_follow_up, nowIso))
  if (overdueFunders.length) {
    reasons.push(reason(
      facts.dealId,
      "funder_follow_up",
      "overdue_waiting",
      earliest(overdueFunders.map((item) => item.sentAt)) ?? facts.statusChangedAt,
      overdueFunders.map((item) => item.jobId ?? item.id),
      overdueFunders[0]?.funderName,
    ))
  }

  const unpitched = offers.filter((offer) => !offer.pitchedAt)
  const mayPitch = !accepted && !funded && ["lead", "new_application", "missing_documents", "ready_to_submit", "submitted", "resubmitting", "offer", "repricing"].includes(facts.status)
  if (mayPitch && unpitched.length) {
    reasons.push(reason(
      facts.dealId,
      "pitch",
      "own_action",
      earliest(unpitched.map((item) => item.createdAt)) ?? facts.statusChangedAt,
      unpitched.map((item) => item.id),
      unpitched[0]?.funderName,
    ))
  }

  const pitched = offers.filter((offer) => offer.pitchedAt)
  if (!accepted && !funded && pitched.length) {
    const oldestPitch = earliest(pitched.map((item) => item.pitchedAt))
    if (oldestPitch && overdue(oldestPitch, HOME_SLA_HOURS.merchant_follow_up, nowIso)) {
      reasons.push(reason(
        facts.dealId,
        "merchant_follow_up",
        "overdue_waiting",
        oldestPitch,
        pitched.map((item) => item.id),
        pitched[0]?.funderName,
      ))
    }
  }

  for (const workflow of facts.contracts) {
    if (workflow.state === "accepted") {
      reasons.push(reason(facts.dealId, "contract", "own_action", workflow.acceptedAt ?? facts.statusChangedAt, [workflow.id], workflow.funderName))
    } else if (workflow.state === "contract_requested" && overdue(workflow.contractRequestedAt, HOME_SLA_HOURS.contract, nowIso)) {
      reasons.push(reason(facts.dealId, "contract", "overdue_waiting", workflow.contractRequestedAt ?? facts.statusChangedAt, [workflow.id], workflow.funderName))
    } else if (workflow.state === "contract_sent" && !workflow.signedAt && overdue(workflow.contractSentAt, HOME_SLA_HOURS.signature, nowIso)) {
      reasons.push(reason(facts.dealId, "signature", "overdue_waiting", workflow.contractSentAt ?? facts.statusChangedAt, [workflow.id], workflow.funderName))
    } else if (workflow.state === "repricing_requested" && overdue(workflow.repricingRequestedAt, HOME_SLA_HOURS.repricing, nowIso)) {
      reasons.push(reason(facts.dealId, "repricing", "overdue_waiting", workflow.repricingRequestedAt ?? facts.statusChangedAt, [workflow.id], workflow.funderName))
    } else if ((workflow.state === "signed" || workflow.state === "final_review") && !facts.fundingEvents.some((item) => item.offerRevisionId === workflow.offerRevisionId && item.state === "committed")) {
      reasons.push(reason(facts.dealId, "funding", "own_action", workflow.signedAt ?? workflow.finalReviewAt ?? facts.statusChangedAt, [workflow.id], workflow.funderName))
    }
  }

  if (facts.status === "contract" && !facts.contracts.length && !funded) {
    reasons.push(reason(facts.dealId, "contract", "own_action", facts.statusChangedAt, [facts.dealId]))
  }

  if (facts.status === "repricing" && !facts.contracts.some((item) => item.state === "repricing_requested")) {
    reasons.push(reason(facts.dealId, "repricing", "own_action", facts.statusChangedAt, [facts.dealId]))
  }

  return sortReasons(dedupeReasons(reasons))
}

function dedupeReasons(reasons: HomeActionReason[]): HomeActionReason[] {
  const byCode = new Map<HomeActionReasonCode, HomeActionReason>()
  for (const item of sortReasons(reasons)) {
    const existing = byCode.get(item.code)
    if (!existing) {
      byCode.set(item.code, item)
      continue
    }
    byCode.set(item.code, {
      ...existing,
      category: HOME_CATEGORY_RANK[item.category] < HOME_CATEGORY_RANK[existing.category] ? item.category : existing.category,
      since: item.since < existing.since ? item.since : existing.since,
      sourceIds: [...new Set([...existing.sourceIds, ...item.sourceIds])],
      label: HOME_REASON_LABELS[item.code][
        HOME_CATEGORY_RANK[item.category] < HOME_CATEGORY_RANK[existing.category] ? item.category : existing.category
      ],
    })
  }
  return [...byCode.values()]
}

export function toHomeQueueItem(facts: HomeDealFacts, reasons: HomeActionReason[]): HomeQueueItem | undefined {
  if (!reasons.length) return undefined
  const primary = reasons[0]
  return {
    dealId: facts.dealId,
    displayId: facts.displayId,
    legalName: facts.legalName,
    status: facts.status,
    version: facts.version,
    reasons,
    primaryReason: primary,
    category: primary.category,
    actionSince: primary.since,
    updatedAt: facts.updatedAt,
  }
}

export function sortHomeQueueItems(items: HomeQueueItem[]): HomeQueueItem[] {
  return [...items].sort((left, right) => {
    const category = HOME_CATEGORY_RANK[left.category] - HOME_CATEGORY_RANK[right.category]
    if (category) return category
    const rank = HOME_REASON_RANK[left.primaryReason.code] - HOME_REASON_RANK[right.primaryReason.code]
    if (rank) return rank
    if (left.actionSince !== right.actionSince) return left.actionSince < right.actionSince ? -1 : 1
    return left.dealId < right.dealId ? -1 : 1
  })
}

function workflowActions(facts: HomeDealFacts, reasons: HomeActionReason[]): HomeWorkflowAction[] {
  const codes = new Set(reasons.map((item) => item.code))
  const pitchOffer = facts.offers.find((item) => !item.pitchedAt && ACTIVE_OFFER_STATES.has(item.currentRevisionState))
    ?? facts.offers.find((item) => item.selected)
  const fundingContract = facts.contracts.find((item) => item.state === "signed" || item.state === "final_review")
  const accepted = facts.contracts.find((item) => item.state === "accepted")
  const overdueJob = facts.submissions.find((item) => !item.hasResponse && (SENT_JOB_STATES.has(item.jobState ?? "") || item.status === "sent"))
  return [
    { id: "full_deal", label: "Full Deal", enabled: true, href: `/deals?deal=${encodeURIComponent(facts.dealId)}` },
    { id: "update_status", label: "Update Status", enabled: allowedTransitions(facts.status).length > 0 },
    { id: "submit", label: "Submit", enabled: codes.has("submit") || codes.has("resubmit") },
    {
      id: "pitched",
      label: "Pitched",
      enabled: codes.has("pitch") && Boolean(pitchOffer),
      offerId: pitchOffer?.id,
      revisionId: pitchOffer?.currentRevisionId,
    },
    {
      id: "request_contract",
      label: "Request Contract",
      enabled: codes.has("contract") && reasons.some((item) => item.code === "contract" && item.category === "own_action"),
      offerId: accepted?.offerId ?? pitchOffer?.id,
      revisionId: accepted?.offerRevisionId ?? pitchOffer?.currentRevisionId,
    },
    {
      id: "funded",
      label: "Funded",
      enabled: codes.has("funding"),
      offerId: fundingContract?.offerId ?? facts.offers.find((item) => item.selected)?.id,
      revisionId: fundingContract?.offerRevisionId ?? facts.offers.find((item) => item.selected)?.currentRevisionId,
    },
    { id: "remind_funder", label: "Remind Funder", enabled: codes.has("funder_follow_up") && Boolean(overdueJob) },
    { id: "add_note", label: "Add note", enabled: true },
  ]
}

function advanceRenewal(facts: HomeDealFacts, advance: HomeAdvanceFact) {
  const match = facts.renewals.find((item) => item.sourceAdvanceId === advance.id && ACTIVE_RENEWALS.has(item.state))
  return {
    id: advance.id,
    funderName: advance.funderName,
    fundedAt: advance.fundedAt,
    principalCents: advance.principalCents,
    renewalEligible: Boolean(match),
    renewalActionId: match?.id,
  }
}

export function toHomeDealPanel(facts: HomeDealFacts, reasons: HomeActionReason[], nowIso: string): HomeDealPanel {
  return {
    dealId: facts.dealId,
    displayId: facts.displayId,
    legalName: facts.legalName,
    status: facts.status,
    version: facts.version,
    draftState: facts.draftState,
    reasons,
    contacts: { name: facts.contactName, email: facts.contactEmail, phone: facts.contactPhone },
    assignments: facts.assignments,
    allowedStatuses: [...allowedTransitions(facts.status)],
    offers: facts.offers.map((offer) => ({
      id: offer.id,
      funderName: offer.funderName,
      revisionId: offer.currentRevisionId,
      amountCents: offer.currentAmountCents,
      selected: offer.selected,
      pitched: Boolean(offer.pitchedAt),
      pitchedAt: offer.pitchedAt,
      state: offer.currentRevisionState,
    })),
    submissions: facts.submissions.map((item) => ({
      id: item.id,
      jobId: item.jobId,
      funderName: item.funderName,
      status: item.status,
      routeKind: item.routeKind,
      jobState: item.jobState,
      sentAt: item.sentAt,
      hasResponse: item.hasResponse,
      overdue: !item.hasResponse && overdue(item.sentAt, HOME_SLA_HOURS.funder_follow_up, nowIso),
    })),
    notes: facts.notes.map((note) => ({ id: note.id, body: note.body, actorUserId: note.actorUserId, createdAt: note.createdAt })),
    stipulations: facts.stipulations.map((item) => ({
      id: item.id,
      label: item.label,
      status: item.status,
      documentCategory: item.documentCategory,
      createdAt: item.createdAt,
      dueDate: item.dueDate,
    })),
    contracts: facts.contracts.map((item) => ({
      id: item.id,
      state: item.state,
      funderName: item.funderName,
      offerRevisionId: item.offerRevisionId,
      acceptedAt: item.acceptedAt,
      contractRequestedAt: item.contractRequestedAt,
      contractSentAt: item.contractSentAt,
      signedAt: item.signedAt,
      repricingRequestedAt: item.repricingRequestedAt,
    })),
    advances: facts.advances.map((item) => advanceRenewal(facts, item)),
    workflowActions: workflowActions(facts, reasons),
    refreshedAt: nowIso,
    now: nowIso,
  }
}

export function countHomeCategories(items: HomeQueueItem[]) {
  const counts = { own_action: 0, overdue_waiting: 0, renewal: 0, total: items.length }
  for (const item of items) counts[item.category] += 1
  return counts
}

import "server-only"

import { decryptSensitive } from "../crypto"
import { getDatabase, parseJson } from "../db"
import type { AssignmentKind, DealStatus, DraftState } from "../deals/schema"
import type {
  HomeAdvanceFact,
  HomeContractFact,
  HomeDealFacts,
  HomeFundingFact,
  HomeNoteFact,
  HomeOfferFact,
  HomePanelAssignment,
  HomeRenewalFact,
  HomeStipulationFact,
  HomeSubmissionFact,
} from "./contracts"

type Row = Record<string, string | number | null>

function text(row: Row, key: string): string {
  const value = row[key]
  return value == null ? "" : String(value)
}

function optional(row: Row, key: string): string | undefined {
  const value = row[key]
  return value == null || value === "" ? undefined : String(value)
}

function decrypt(value: unknown, workspaceId: string): string | undefined {
  return typeof value === "string" && value ? decryptSensitive(value, workspaceId) : undefined
}

function countMissingStatementMonths(value: unknown): number {
  const findings = Array.isArray(value) ? value as Array<{ code?: string }> : parseJson<Array<{ code?: string }>>(value, [])
  return findings.filter((item) => typeof item?.code === "string" && item.code.startsWith("missing_statement_")).length
}

function group<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const id = key(item)
    const list = map.get(id)
    if (list) list.push(item)
    else map.set(id, [item])
  }
  return map
}

export interface HomeWorkspaceSnapshot {
  facts: Map<string, HomeDealFacts>
}

export async function loadHomeWorkspace(workspaceId: string): Promise<HomeWorkspaceSnapshot> {
  const database = getDatabase()
  const [
    dealRows,
    assignmentRows,
    activityRows,
    offerRows,
    selectionRows,
    pitchRows,
    jobRows,
    submissionRows,
    replyRows,
    stipRows,
    contractRows,
    fundingRows,
    renewalRows,
    advanceRows,
    noteRows,
    completenessRows,
  ] = await Promise.all([
    database.prepare<Row>(`SELECT id, display_id, legal_name, dba_name, status, draft_state, version, created_at, updated_at,
      contact_name, contact_email_cipher, contact_phone_cipher
      FROM deals WHERE workspace_id=?`).all(workspaceId),
    database.prepare<Row>("SELECT id, deal_id, membership_id, kind, is_primary, assigned_at FROM deal_assignments WHERE workspace_id=?").all(workspaceId),
    database.prepare<Row>("SELECT deal_id, created_at, to_status FROM deal_activity WHERE workspace_id=? AND action='status_changed'").all(workspaceId),
    database.prepare<Row>(`SELECT o.id, o.deal_id, o.funder_name, o.submission_id, o.current_revision_id, o.created_at,
      r.state, r.amount_cents
      FROM mca_offers o
      LEFT JOIN mca_offer_revisions r ON r.workspace_id=o.workspace_id AND r.id=o.current_revision_id
      WHERE o.workspace_id=?`).all(workspaceId),
    database.prepare<Row>("SELECT deal_id, offer_id, offer_revision_id FROM mca_offer_selections WHERE workspace_id=? AND active=1").all(workspaceId),
    database.prepare<Row>("SELECT deal_id, offer_id, offer_revision_id, pitched_at FROM mca_pitch_events WHERE workspace_id=?").all(workspaceId),
    database.prepare<Row>("SELECT id, deal_id, display_funder_name, route_kind, state, created_at, updated_at FROM mca_submission_jobs WHERE workspace_id=?").all(workspaceId),
    database.prepare<Row>("SELECT id, deal_id, funder_name, status, funder_id, job_id, route_kind FROM deal_submissions WHERE workspace_id=?").all(workspaceId),
    database.prepare<Row>(`SELECT DISTINCT matched_job_id FROM mca_funder_replies
      WHERE workspace_id=? AND matched_job_id IS NOT NULL AND state IN ('matched','processed','pending_review')`).all(workspaceId),
    database.prepare<Row>("SELECT id, deal_id, status, label, document_category, created_at, due_date, received_at FROM mca_closing_stipulations WHERE workspace_id=?").all(workspaceId),
    database.prepare<Row>(`SELECT id, deal_id, offer_id, offer_revision_id, funder_name, state, accepted_at, contract_requested_at,
      contract_sent_at, signed_at, final_review_at, repricing_requested_at
      FROM mca_contract_workflows WHERE workspace_id=?`).all(workspaceId),
    database.prepare<Row>("SELECT deal_id, offer_revision_id, state, funded_at FROM mca_funding_events WHERE workspace_id=?").all(workspaceId),
    database.prepare<Row>(`SELECT a.id, a.source_advance_id, a.state, a.eligible_at, adv.deal_id, o.funder_name, adv.principal_cents
      FROM mca_renewal_actions a
      JOIN mca_advances adv ON adv.workspace_id=a.workspace_id AND adv.id=a.source_advance_id
      JOIN mca_offers o ON o.workspace_id=adv.workspace_id AND o.id=adv.offer_id
      WHERE a.workspace_id=?`).all(workspaceId),
    database.prepare<Row>(`SELECT a.id, a.deal_id, o.funder_name, a.funded_at, a.principal_cents, a.status
      FROM mca_advances a
      JOIN mca_offers o ON o.workspace_id=a.workspace_id AND o.id=a.offer_id
      WHERE a.workspace_id=?`).all(workspaceId),
    database.prepare<Row>("SELECT id, deal_id, body, actor_user_id, created_at FROM deal_notes WHERE workspace_id=? ORDER BY created_at, id").all(workspaceId),
    database.prepare<Row>(`SELECT DISTINCT ON (deal_id) deal_id, findings_json, ready
      FROM mca_completeness_results
      WHERE workspace_id = ?
      ORDER BY deal_id, version DESC`).all(workspaceId),
  ])

  const assignmentsByDeal = group(assignmentRows, (row) => text(row, "deal_id"))
  const activityByDeal = group(activityRows, (row) => text(row, "deal_id"))
  const selected = new Set(selectionRows.map((row) => `${text(row, "offer_id")}:${text(row, "offer_revision_id")}`))
  const pitches = new Map<string, string>()
  for (const row of pitchRows) {
    const key = `${text(row, "offer_id")}:${text(row, "offer_revision_id")}`
    const at = text(row, "pitched_at")
    const existing = pitches.get(key)
    if (!existing || at < existing) pitches.set(key, at)
  }
  const replyJobs = new Set(replyRows.map((row) => text(row, "matched_job_id")))
  const offersByDeal = group(offerRows, (row) => text(row, "deal_id"))
  const jobsByDeal = group(jobRows, (row) => text(row, "deal_id"))
  const submissionsByDeal = group(submissionRows, (row) => text(row, "deal_id"))
  const stipsByDeal = group(stipRows, (row) => text(row, "deal_id"))
  const contractsByDeal = group(contractRows, (row) => text(row, "deal_id"))
  const fundingByDeal = group(fundingRows, (row) => text(row, "deal_id"))
  const renewalsByDeal = group(renewalRows, (row) => text(row, "deal_id"))
  const advancesByDeal = group(advanceRows, (row) => text(row, "deal_id"))
  const notesByDeal = group(noteRows, (row) => text(row, "deal_id"))
  const completenessByDeal = new Map<string, { completenessReady: boolean; missingStatementMonths: number }>()
  for (const row of completenessRows) {
    completenessByDeal.set(text(row, "deal_id"), {
      completenessReady: Number(row.ready) === 1,
      missingStatementMonths: countMissingStatementMonths(row.findings_json),
    })
  }
  const offerBySubmission = new Map<string, string>()
  for (const row of offerRows) {
    const submissionId = optional(row, "submission_id")
    if (submissionId) offerBySubmission.set(submissionId, text(row, "id"))
  }

  const facts = new Map<string, HomeDealFacts>()
  for (const row of dealRows) {
    const dealId = text(row, "id")
    const assignments: HomePanelAssignment[] = (assignmentsByDeal.get(dealId) ?? []).map((item) => ({
      membershipId: text(item, "membership_id"),
      kind: text(item, "kind") as AssignmentKind,
      isPrimary: Boolean(item.is_primary),
    }))
    const statusChanges = activityByDeal.get(dealId) ?? []
    const latestChange = statusChanges.reduce<string | undefined>((max, item) => {
      const at = text(item, "created_at")
      return !max || at > max ? at : max
    }, undefined)
    const offers: HomeOfferFact[] = (offersByDeal.get(dealId) ?? []).map((item) => {
      const revisionId = text(item, "current_revision_id")
      const pitchKey = `${text(item, "id")}:${revisionId}`
      return {
        id: text(item, "id"),
        dealId,
        funderName: text(item, "funder_name"),
        submissionId: optional(item, "submission_id"),
        currentRevisionId: revisionId,
        currentRevisionState: text(item, "state") || "active",
        currentAmountCents: item.amount_cents == null ? undefined : Number(item.amount_cents),
        selected: selected.has(pitchKey),
        createdAt: text(item, "created_at"),
        pitchedAt: pitches.get(pitchKey),
      }
    })
    const jobs = jobsByDeal.get(dealId) ?? []
    const cache = submissionsByDeal.get(dealId) ?? []
    const jobById = new Map(jobs.map((item) => [text(item, "id"), item]))
    const submissions: HomeSubmissionFact[] = []
    const seenJobs = new Set<string>()
    for (const item of cache) {
      const jobId = optional(item, "job_id")
      const job = jobId ? jobById.get(jobId) : undefined
      if (jobId) seenJobs.add(jobId)
      const hasOffer = jobId ? offerBySubmission.has(jobId) : false
      submissions.push({
        id: text(item, "id"),
        dealId,
        jobId,
        funderName: text(item, "funder_name"),
        status: text(item, "status"),
        routeKind: optional(item, "route_kind") ?? (job ? optional(job, "route_kind") : undefined),
        jobState: job ? text(job, "state") : undefined,
        sentAt: job ? text(job, "updated_at") : undefined,
        hasResponse: Boolean(jobId && (replyJobs.has(jobId) || hasOffer)) || ["approved", "declined"].includes(text(item, "status")),
      })
    }
    for (const job of jobs) {
      const jobId = text(job, "id")
      if (seenJobs.has(jobId)) continue
      submissions.push({
        id: jobId,
        dealId,
        jobId,
        funderName: text(job, "display_funder_name"),
        status: text(job, "state") === "failed" ? "errored" : text(job, "state") === "sent" ? "sent" : "queued",
        routeKind: optional(job, "route_kind"),
        jobState: text(job, "state"),
        sentAt: text(job, "updated_at"),
        hasResponse: replyJobs.has(jobId) || offerBySubmission.has(jobId),
      })
    }
    const stipulations: HomeStipulationFact[] = (stipsByDeal.get(dealId) ?? []).map((item) => ({
      id: text(item, "id"),
      dealId,
      status: text(item, "status"),
      label: text(item, "label"),
      documentCategory: text(item, "document_category"),
      createdAt: text(item, "created_at"),
      dueDate: optional(item, "due_date"),
      receivedAt: optional(item, "received_at"),
    }))
    const contracts: HomeContractFact[] = (contractsByDeal.get(dealId) ?? []).map((item) => ({
      id: text(item, "id"),
      dealId,
      offerId: text(item, "offer_id"),
      offerRevisionId: text(item, "offer_revision_id"),
      funderName: text(item, "funder_name"),
      state: text(item, "state"),
      acceptedAt: optional(item, "accepted_at"),
      contractRequestedAt: optional(item, "contract_requested_at"),
      contractSentAt: optional(item, "contract_sent_at"),
      signedAt: optional(item, "signed_at"),
      finalReviewAt: optional(item, "final_review_at"),
      repricingRequestedAt: optional(item, "repricing_requested_at"),
    }))
    const fundingEvents: HomeFundingFact[] = (fundingByDeal.get(dealId) ?? []).map((item) => ({
      dealId,
      offerRevisionId: text(item, "offer_revision_id"),
      state: text(item, "state"),
      fundedAt: text(item, "funded_at"),
    }))
    const renewals: HomeRenewalFact[] = (renewalsByDeal.get(dealId) ?? []).map((item) => ({
      id: text(item, "id"),
      dealId,
      sourceAdvanceId: text(item, "source_advance_id"),
      state: text(item, "state"),
      eligibleAt: text(item, "eligible_at"),
      funderName: optional(item, "funder_name"),
      principalCents: item.principal_cents == null ? undefined : Number(item.principal_cents),
    }))
    const advances: HomeAdvanceFact[] = (advancesByDeal.get(dealId) ?? []).map((item) => ({
      id: text(item, "id"),
      dealId,
      funderName: text(item, "funder_name"),
      fundedAt: text(item, "funded_at"),
      principalCents: Number(item.principal_cents ?? 0),
      status: text(item, "status"),
    }))
    const notes: HomeNoteFact[] = (notesByDeal.get(dealId) ?? []).map((item) => ({
      id: text(item, "id"),
      dealId,
      body: text(item, "body"),
      actorUserId: optional(item, "actor_user_id") ?? null,
      createdAt: text(item, "created_at"),
    }))
    facts.set(dealId, {
      dealId,
      displayId: text(row, "display_id"),
      legalName: text(row, "legal_name") || text(row, "dba_name") || "Untitled draft",
      status: text(row, "status") as DealStatus,
      draftState: text(row, "draft_state") as DraftState,
      version: Number(row.version ?? 1),
      createdAt: text(row, "created_at"),
      updatedAt: text(row, "updated_at"),
      statusChangedAt: latestChange ?? text(row, "created_at"),
      contactName: optional(row, "contact_name"),
      contactEmail: decrypt(row.contact_email_cipher, workspaceId),
      contactPhone: decrypt(row.contact_phone_cipher, workspaceId),
      assignments,
      offers,
      submissions,
      stipulations,
      contracts,
      fundingEvents,
      renewals,
      advances,
      notes,
      completenessReady: completenessByDeal.get(dealId)?.completenessReady,
      missingStatementMonths: completenessByDeal.get(dealId)?.missingStatementMonths,
    })
  }
  return { facts }
}

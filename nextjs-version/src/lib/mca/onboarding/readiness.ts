import "server-only"
import type { DealActor } from "../deals/schema"
import { getBusinessBasics } from "./business-profile"
import { listSenders } from "../senders/service"
import { getCompanyAccess } from "../company-access"
import { getDatabase } from "../db"
import { SANDBOX_FUNDER_IDEMPOTENCY_KEY } from "../sandbox/labels"
import { findFunderByIdempotencyKey } from "../funders/directory-repository"
import { activeRoute } from "../submissions/jobs"
import { preflightDestination } from "../submissions/preflight"
import { listDocumentRecords } from "../documents/repository"
import { readCurrentCompleteness } from "../underwriting/completeness"
import { listPositionRecords } from "../underwriting/statement-repository"

export interface OnboardingReadiness {
  businessDetails: "missing" | "supplied" | "registered"
  sender: "missing" | "configured" | "preview" | "accepted" | "received"
  defaultSender: boolean
  safeSubmission: "unavailable" | "ready" | "accepted"
  trialEndsAt: string | null
}
/** Facts only. This reader never creates a deal/funder, sends a test, submits documents or changes CRM access. */
export async function getOnboardingReadiness(actor: DealActor): Promise<OnboardingReadiness> {
  const basics = await getBusinessBasics(actor)
  const senders = (await listSenders(actor)).senders.filter(s => !["expired", "revoked"].includes(s.state) && s.hasCredential)
  const chosen = senders.find(s => s.purpose === "submission" && s.isDefault) ?? senders.find(s => s.purpose === "submission") ?? senders[0]
  const evidence = chosen?.testEvidence?.state
  const safeSubmission = await getSafeSubmissionReadiness(actor.workspaceId)
  return {
    businessDetails: basics.registered && basics.einPresent ? "registered" : basics.einPresent ? "supplied" : "missing",
    sender: !chosen ? "missing" : evidence === "received" || evidence === "accepted" || evidence === "preview" ? evidence : "configured",
    defaultSender: senders.some(s => s.purpose === "submission" && s.isDefault && s.state === "verified"),
    safeSubmission,
    trialEndsAt: (await getCompanyAccess(actor.workspaceId)).trialEndsAt,
  }
}

/** Server-internal prerequisite facts. Actual submission still uses all normal preflight, document and approval checks. */
export async function getSafeSubmissionReadiness(workspaceId: string): Promise<OnboardingReadiness["safeSubmission"]> {
  const row = await getDatabase().prepare<{ accepted: boolean }>(`SELECT
    EXISTS(SELECT 1 FROM mca_submission_jobs j JOIN deals d ON d.workspace_id=j.workspace_id AND d.id=j.deal_id
      JOIN mca_funders f ON f.workspace_id=j.workspace_id AND f.id=j.funder_id
      WHERE j.workspace_id=? AND j.state='sent' AND j.route_kind='api' AND j.route_json::jsonb->>'destination'='fundlane-sandbox'
      AND f.idempotency_key=? AND (d.legal_name ILIKE '[SANDBOX]%' OR d.legal_name ILIKE '[SYNTHETIC]%')) accepted`)
    .get(workspaceId, SANDBOX_FUNDER_IDEMPOTENCY_KEY)
  if (row?.accepted) return "accepted"
  const funder = await findFunderByIdempotencyKey(workspaceId, SANDBOX_FUNDER_IDEMPOTENCY_KEY)
  const route = funder && activeRoute(funder.routes)
  if (!funder?.active || route?.kind !== "api" || route.destination !== "fundlane-sandbox") return "unavailable"
  const deals = await getDatabase().prepare<{ id: string }>("SELECT id FROM deals WHERE workspace_id=? AND draft_state='submission_ready' AND (legal_name ILIKE '[SANDBOX]%' OR legal_name ILIKE '[SYNTHETIC]%')").all(workspaceId)
  for (const deal of deals) {
    const [completeness, positions, documents] = await Promise.all([
      readCurrentCompleteness(workspaceId, deal.id), listPositionRecords(workspaceId, deal.id), listDocumentRecords(workspaceId, deal.id, true),
    ])
    if (completeness.findings.length || positions.some(position => position.status === "proposed")) continue
    if (!preflightDestination({ funder, documents, sender: {} }).errors.length) return "ready"
  }
  return "unavailable"
}

import "server-only"
import type { DealActor } from "../deals/schema"
import { getBusinessBasics } from "./business-profile"
import { listSenders } from "../senders/service"
import { getCompanyAccess } from "../company-access"
import { getDatabase } from "../db"
import { SANDBOX_FUNDER_IDEMPOTENCY_KEY } from "../sandbox/labels"

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
  const row = await getDatabase().prepare<{ ready: boolean; accepted: boolean }>(`SELECT
    EXISTS(SELECT 1 FROM deals d JOIN mca_funders f ON f.workspace_id=d.workspace_id
      CROSS JOIN LATERAL jsonb_array_elements(f.routes::jsonb) r
      WHERE d.workspace_id=? AND d.draft_state='submission_ready' AND (d.legal_name ILIKE '[SANDBOX]%' OR d.legal_name ILIKE '[SYNTHETIC]%')
      AND f.idempotency_key=? AND f.active=1 AND r->>'active'='true' AND r->>'kind'='api' AND r->>'destination'='fundlane-sandbox'
      AND EXISTS(SELECT 1 FROM mca_documents doc WHERE doc.workspace_id=d.workspace_id AND doc.deal_id=d.id AND doc.processing_state IN ('ready','clean')
        AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(r->'documentExceptions','[]'::jsonb)) excluded WHERE excluded=doc.category))) ready,
    EXISTS(SELECT 1 FROM mca_submission_jobs j JOIN deals d ON d.workspace_id=j.workspace_id AND d.id=j.deal_id
      JOIN mca_funders f ON f.workspace_id=j.workspace_id AND f.id=j.funder_id
      WHERE j.workspace_id=? AND j.state='sent' AND j.route_kind='api' AND j.route_json::jsonb->>'destination'='fundlane-sandbox'
      AND f.idempotency_key=? AND (d.legal_name ILIKE '[SANDBOX]%' OR d.legal_name ILIKE '[SYNTHETIC]%')) accepted`)
    .get(workspaceId, SANDBOX_FUNDER_IDEMPOTENCY_KEY, workspaceId, SANDBOX_FUNDER_IDEMPOTENCY_KEY)
  return row?.accepted ? "accepted" : row?.ready ? "ready" : "unavailable"
}

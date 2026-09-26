import "server-only"

import { getDatabase, nowIso } from "../db"
import type { AuthContext } from "../types"
import type { Role } from "../types"
import { buildWorkspaceSetup, type WorkspaceSetup } from "./contracts"
import { deriveReadiness, type ReadinessFacts } from "./readiness"
import { SANDBOX_FUNDER_IDEMPOTENCY_KEY } from "../sandbox/labels"
import { getCompanyAccess } from "../company-access"

interface SetupRow {
  name: string
  setup_checklist_dismissed_at: string | null
  funders: number
  deals: number
  members: number
  invitations: number
  verified_senders: number
  intake_enabled: number
  datamerch: number
}

export function setupReadinessEnabled(): boolean { return process.env.MCA_SETUP_READINESS_ENABLED === "true" }

export async function getWorkspaceSetup(workspaceId: string, role: Role | null = null): Promise<WorkspaceSetup> {
  const row = await getDatabase().prepare<SetupRow>(`
    SELECT
      w.name,
      w.setup_checklist_dismissed_at,
      (SELECT count(*)::int FROM mca_funders f WHERE f.workspace_id = w.id) funders,
      (SELECT count(*)::int FROM deals d WHERE d.workspace_id = w.id) deals,
      (SELECT count(*)::int FROM memberships m WHERE m.workspace_id = w.id AND m.status IN ('pending','active')) members,
      (SELECT count(*)::int FROM invitations i WHERE i.workspace_id = w.id AND i.status = 'pending') invitations,
      (SELECT count(*)::int FROM mca_email_senders s WHERE s.workspace_id = w.id AND s.state = 'verified') verified_senders,
      (SELECT count(*)::int FROM intake_integrations ii WHERE ii.workspace_id = w.id AND ii.enabled = 1) intake_enabled,
      (SELECT count(*)::int FROM mca_datamerch_config dm WHERE dm.workspace_id = w.id AND dm.enabled = 1 AND dm.credential_cipher IS NOT NULL) datamerch
    FROM workspaces w
    WHERE w.id = ?
  `).get(workspaceId)
  if (!row) throw new Error("Workspace not found.")
  const setup = buildWorkspaceSetup({
    brokerageName: row.name,
    dismissedAt: row.setup_checklist_dismissed_at,
    funderCount: row.funders,
    dealCount: row.deals,
    memberCount: row.members,
    pendingInvitationCount: row.invitations,
    verifiedSenderCount: row.verified_senders,
    enabledIntakeCount: row.intake_enabled,
    connectedDatamerchCount: row.datamerch,
  })
  if (setupReadinessEnabled() && role) {
    setup.readiness = deriveReadiness(await getReadinessFacts(workspaceId), role)
    setup.canDownloadDiagnostics = role === "admin" || role === "super_admin"
  }
  return setup
}

export async function getReadinessFacts(workspaceId: string): Promise<ReadinessFacts> {
  const now = nowIso()
  const row = await getDatabase().prepare<{
    company_named: boolean; team_members: number; pending_invitations: number; enabled_forms: number; broken_forms: number; created_intakes: number;
    failed_intakes: number; ready_documents: number; failed_documents: number; verified_senders: number; broken_senders: number;
    active_funders: number; sandbox_funders: number; billing_status: string | null; billing_exempt: boolean; synthetic_deals: number;
    sandbox_sent_jobs: number; sandbox_failed_jobs: number; automatic_processing_forms: number;
  }>(`
    SELECT
      length(trim(w.name)) >= 2 company_named,
      (SELECT count(*)::int FROM memberships m WHERE m.workspace_id=w.id AND m.status='active') team_members,
      (SELECT count(*)::int FROM invitations i WHERE i.workspace_id=w.id AND i.status='pending') pending_invitations,
      (SELECT count(*)::int FROM intake_integrations i WHERE i.workspace_id=w.id AND i.enabled=1 AND i.approval_state='approved' AND (i.credential_expires_at IS NULL OR i.credential_expires_at > ?)) enabled_forms,
      (SELECT count(*)::int FROM intake_integrations i WHERE i.workspace_id=w.id AND i.enabled=1 AND (i.approval_state <> 'approved' OR (i.credential_expires_at IS NOT NULL AND i.credential_expires_at <= ?))) broken_forms,
      (SELECT count(*)::int FROM intake_integrations i WHERE i.workspace_id=w.id AND i.enabled=1 AND i.approval_state='approved' AND (i.credential_expires_at IS NULL OR i.credential_expires_at > ?) AND i.automatic_processing=1
        AND i.provider IN ('jotform','highlevel','zoho','custom','fundlane','native','fillout','docuseal')) automatic_processing_forms,
      (SELECT count(*)::int FROM intake_events e JOIN deals d ON d.id=e.deal_id AND d.workspace_id=e.workspace_id WHERE e.workspace_id=w.id AND e.state IN ('created','file_pending') AND (d.legal_name ILIKE '[SANDBOX]%' OR d.legal_name ILIKE '[SYNTHETIC]%')) created_intakes,
      (SELECT count(*)::int FROM intake_events e WHERE e.workspace_id=w.id AND e.state='error') failed_intakes,
      (SELECT count(*)::int FROM mca_documents d JOIN deals deal ON deal.id=d.deal_id AND deal.workspace_id=d.workspace_id WHERE d.workspace_id=w.id AND d.processing_state IN ('ready','clean') AND (deal.legal_name ILIKE '[SANDBOX]%' OR deal.legal_name ILIKE '[SYNTHETIC]%')) ready_documents,
      (SELECT count(*)::int FROM mca_documents d WHERE d.workspace_id=w.id AND d.processing_state IN ('upload_failed','scan_failed')) failed_documents,
      (SELECT count(*)::int FROM mca_email_senders s WHERE s.workspace_id=w.id AND s.state='verified') verified_senders,
      (SELECT count(*)::int FROM mca_email_senders s WHERE s.workspace_id=w.id AND s.state IN ('expired','revoked')) broken_senders,
      (SELECT count(*)::int FROM mca_funders f WHERE f.workspace_id=w.id AND f.active=1 AND f.idempotency_key <> ?) active_funders,
      (SELECT count(*)::int FROM mca_funders f WHERE f.workspace_id=w.id AND f.active=1 AND f.idempotency_key = ?) sandbox_funders,
      (SELECT status FROM workspace_billing_entitlements b WHERE b.workspace_id=w.id) billing_status,
      COALESCE((SELECT legacy_exempt=1 FROM company_subscription_state c WHERE c.workspace_id=w.id), false) billing_exempt,
      (SELECT count(*)::int FROM deals d WHERE d.workspace_id=w.id AND (d.legal_name ILIKE '[SANDBOX]%' OR d.legal_name ILIKE '[SYNTHETIC]%')) synthetic_deals,
      (SELECT count(*)::int FROM mca_submission_jobs j JOIN mca_funders f ON f.id=j.funder_id AND f.workspace_id=j.workspace_id JOIN deals d ON d.id=j.deal_id AND d.workspace_id=j.workspace_id
        WHERE j.workspace_id=w.id AND f.idempotency_key=? AND j.state='sent' AND (d.legal_name ILIKE '[SANDBOX]%' OR d.legal_name ILIKE '[SYNTHETIC]%')) sandbox_sent_jobs,
      (SELECT count(*)::int FROM mca_submission_jobs j JOIN mca_funders f ON f.id=j.funder_id AND f.workspace_id=j.workspace_id JOIN deals d ON d.id=j.deal_id AND d.workspace_id=j.workspace_id
        WHERE j.workspace_id=w.id AND f.idempotency_key=? AND j.state IN ('failed','preflight_failed') AND (d.legal_name ILIKE '[SANDBOX]%' OR d.legal_name ILIKE '[SYNTHETIC]%')) sandbox_failed_jobs
    FROM workspaces w WHERE w.id=?
  `).get(now, now, now, SANDBOX_FUNDER_IDEMPOTENCY_KEY, SANDBOX_FUNDER_IDEMPOTENCY_KEY, SANDBOX_FUNDER_IDEMPOTENCY_KEY, SANDBOX_FUNDER_IDEMPOTENCY_KEY, workspaceId)
  if (!row) throw new Error("Workspace not found.")
  const billingAccessAllowed = (await getCompanyAccess(workspaceId)).allowed
  return {
    companyNamed: row.company_named, teamMembers: row.team_members, pendingInvitations: row.pending_invitations,
    enabledForms: row.enabled_forms, brokenForms: row.broken_forms, createdIntakes: row.created_intakes, failedIntakes: row.failed_intakes,
    readyDocuments: row.ready_documents, failedDocuments: row.failed_documents, verifiedSenders: row.verified_senders,
    brokenSenders: row.broken_senders, activeFunders: row.active_funders, sandboxFunders: row.sandbox_funders,
    billingStatus: row.billing_status, billingExempt: row.billing_exempt, billingAccessAllowed, syntheticDeals: row.synthetic_deals, sandboxSentJobs: row.sandbox_sent_jobs,
    sandboxFailedJobs: row.sandbox_failed_jobs,
    processingAvailable: row.automatic_processing_forms > 0,
  }
}

export async function dismissWorkspaceSetup(context: AuthContext): Promise<WorkspaceSetup> {
  const dismissedAt = nowIso()
  await getDatabase()
    .prepare("UPDATE workspaces SET setup_checklist_dismissed_at = COALESCE(setup_checklist_dismissed_at, ?) WHERE id = ?")
    .run(dismissedAt, context.workspaceId)
  return getWorkspaceSetup(context.workspaceId)
}

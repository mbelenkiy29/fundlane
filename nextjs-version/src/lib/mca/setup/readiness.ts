import type { Role } from "../types"

export type ReadinessPhase = "needs_setup" | "configured" | "tested" | "live_ready"
export type ReadinessId = "company_team" | "form_intake" | "documents" | "sender" | "pilot_funder" | "billing" | "synthetic_deal"

export interface ReadinessItem {
  id: ReadinessId
  title: string
  phase: ReadinessPhase
  detail: string
  action: string
  href: string
  helpHref: string
}

export interface ReadinessFacts {
  companyNamed: boolean
  teamMembers: number
  pendingInvitations: number
  enabledForms: number
  brokenForms: number
  createdIntakes: number
  failedIntakes: number
  readyDocuments: number
  failedDocuments: number
  verifiedSenders: number
  brokenSenders: number
  activeFunders: number
  sandboxFunders: number
  billingStatus: string | null
  billingExempt: boolean
  billingAccessAllowed: boolean
  syntheticDeals: number
  sandboxSentJobs: number
  sandboxFailedJobs: number
  processingAvailable: boolean
}

const help = (slug: string) => `/help/${slug}`

/** Phases describe observed workspace state. A configured provider is never inferred to be live from local test data. */
export function deriveReadiness(f: ReadinessFacts, role: Role | null): ReadinessItem[] {
  const admin = role === "admin" || role === "super_admin"
  const items: ReadinessItem[] = [
    { id: "company_team", title: "Company and team", phase: f.companyNamed && f.teamMembers > 1 ? "live_ready" : "needs_setup",
      detail: f.pendingInvitations && f.teamMembers < 2 ? "An invitation is pending acceptance." : "Name the company and invite a teammate.",
      action: "Manage team", href: "/settings/team", helpHref: help("set-up-your-company") },
    { id: "form_intake", title: "Form and intake", phase: !f.enabledForms ? "needs_setup" : f.brokenForms ? "configured" : f.createdIntakes ? "tested" : "configured",
      detail: f.brokenForms ? "A form connection needs reapproval or its credential expired. Reconnect it in Connections, then retry intake." : f.failedIntakes ? "An intake failed. Open Application Intake to inspect and retry it." : f.enabledForms ? "Submit a synthetic application through the enabled form." : "Enable a form in Connections.",
      action: f.brokenForms ? "Reconnect form" : f.enabledForms ? "Open Application Intake" : "Configure form", href: f.brokenForms || !f.enabledForms ? "/settings/connections" : "/intake", helpHref: help("invite-a-client-to-apply") },
    { id: "documents", title: "Document processing", phase: !f.processingAvailable ? "needs_setup" : f.readyDocuments ? "tested" : "configured",
      detail: !f.processingAvailable ? "Enable automatic processing on an intake form, then verify the worker with a synthetic statement." : f.failedDocuments ? "A document failed processing. Review its state and retry from the application." : "Automatic processing is enabled for a form. Verify the worker with a synthetic statement and confirm it reaches ready.",
      action: "Review documents", href: "/intake", helpHref: help("review-applications-and-documents") },
    { id: "sender", title: "Email sender", phase: f.verifiedSenders ? "configured" : "needs_setup",
      detail: f.brokenSenders ? "A sender connection expired or was revoked. Reconnect it in Connections." : f.verifiedSenders ? "Verified sender saved. Confirm delivery with a synthetic recipient before live use." : "Connect and verify a sender in Connections.",
      action: "Open sender connections", href: "/settings/connections", helpHref: help("invite-a-client-to-apply") },
    { id: "pilot_funder", title: "Pilot funder", phase: f.activeFunders ? "configured" : "needs_setup",
      detail: f.activeFunders ? "An active real funder is saved. Verify its route before live submission." : "Add an active pilot funder and verify its route.",
      action: "Manage funders", href: "/funders", helpHref: help("track-submissions-and-offers") },
    { id: "billing", title: "Billing", phase: f.billingAccessAllowed && (f.billingExempt || f.billingStatus === "active") ? "live_ready" : f.billingAccessAllowed && f.billingStatus === "trialing" ? "configured" : "needs_setup",
      detail: !f.billingAccessAllowed && (f.billingExempt || f.billingStatus === "active" || f.billingStatus === "trialing") ? "Billing access is paused or expired. Open billing to review the account." : f.billingExempt ? "This workspace has an existing billing exemption." : f.billingStatus === "past_due" ? "Payment is past due. Open billing to update the payment method." : f.billingStatus ? "Review the current plan and payment state." : "Complete billing setup.",
      action: "Open billing", href: "/settings/billing", helpHref: help("set-up-your-company") },
    { id: "synthetic_deal", title: "Synthetic test deal", phase: f.sandboxSentJobs ? "tested" : f.syntheticDeals && f.sandboxFunders ? "configured" : "needs_setup",
      detail: f.sandboxFailedJobs ? "The sandbox submission failed. Open Submissions to inspect its state and retry." : f.sandboxSentJobs ? "A sandbox submission completed. This does not prove live lender delivery." : "Create a synthetic deal, enable the sandbox funder, then submit to it without contacting a real lender.",
      action: f.syntheticDeals ? "Open submissions" : "Create test deal", href: f.syntheticDeals ? "/submissions" : "/pipeline?create=1", helpHref: help("track-submissions-and-offers") },
  ]
  return admin ? items : items.filter((item) => item.id === "form_intake" || item.id === "documents" || item.id === "synthetic_deal")
}

export interface DiagnosticBundle {
  generatedAt: string
  workspaceId: string
  readiness: Array<{ id: ReadinessId; phase: ReadinessPhase }>
  requests: Array<{ kind: "intake" | "submission"; requestId: string; state: string }>
}

const safeId = (value: string) => /^[a-zA-Z0-9_-]{1,80}$/.test(value) ? value : "redacted"
const intakeStates = new Set(["received", "validated", "created", "file_pending", "error"])
const submissionStates = new Set(["preflight_failed", "queued", "sending", "sent", "failed", "skipped", "pending_portal", "blocked_duplicate", "declined", "funded"])

/** Explicit allowlist: no provider payloads, error text, credentials, names, bank fields or document contents. */
export function makeDiagnosticBundle(input: {
  workspaceId: string
  generatedAt: string
  items: ReadinessItem[]
  requests: Array<{ kind: "intake" | "submission"; id: string; state: string }>
}): DiagnosticBundle {
  return {
    generatedAt: input.generatedAt,
    workspaceId: safeId(input.workspaceId),
    readiness: input.items.map(({ id, phase }) => ({ id, phase })),
    requests: input.requests.slice(0, 20).map(({ kind, id, state }) => ({
      kind, requestId: safeId(id), state: (kind === "intake" ? intakeStates : submissionStates).has(state) ? state : "unknown",
    })),
  }
}

import { pathToFileURL } from "node:url"
import type { PoolClient } from "pg"

const PRODUCTION_PROJECT_REF = "drubsfvhlggmtyiigwxy"
const CHECKPOINT_PROVIDER_MESSAGE_ID = "mca:mailbox-checkpoint:v1"
const DISCLAIMER = "Offline synthetic evidence is not live provider acceptance."

export type PilotEvidenceStatus = "present" | "missing" | "not_applicable"

export interface PilotEvidenceRow {
  label: "Reviewed submission and preflight" | "Explicit approval and job" | "Attempt correlation" |
    "Relay or provider receipt" | "Unknown outcome reconciliation" | "Reply provider message" |
    "Reviewed reply outcome" | "Deal activity"
  status: PilotEvidenceStatus
  references: Record<string, string>
  note: string
}

export interface PilotEvidenceMatrix {
  workspaceId: string
  dealId: string
  jobId: string
  funderId: string
  providerReadiness: "sandbox verified" | "untested"
  disclaimer: typeof DISCLAIMER
  rows: PilotEvidenceRow[]
}

export interface ReadOnlyQueryExecutor {
  query<T extends object>(text: string, values: readonly unknown[]): Promise<{ rows: T[] }>
}

interface JobEvidence {
  workspace_id: string
  deal_id: string
  job_id: string
  funder_id: string
  route_kind: string
  job_state: string
  created_at: string
  preflight_ready: boolean
  explicitly_approved: boolean
  sandbox_adapter: boolean
}

interface AttemptEvidence {
  attempt_id: string
  attempt_state: string
  correlation_id: string
  external_ref: string | null
  error_code: string | null
  created_at: string
  sent_at: string | null
  reconciled: boolean
  reconciled_at: string | null
}

interface ReplyEvidence {
  reply_id: string
  provider_message_id: string
  reply_state: string
  matched_deal_id: string | null
  matched_job_id: string | null
  created_at: string
  updated_at: string
  checkpoint_at: string | null
}

interface ActivityEvidence {
  activity_id: string
  action: string
  source: string
  from_status: string | null
  to_status: string | null
  created_at: string
}

export interface CollectedPilotEvidence {
  job: JobEvidence
  attempt?: AttemptEvidence
  reply?: ReplyEvidence
  activity?: ActivityEvidence
}

export function assertPilotEvidenceGuards(input: {
  env: Readonly<Record<string, string | undefined>>
  argv: readonly string[]
}): { databaseUrl: string; workspaceId: string; jobId: string } {
  const { env, argv } = input
  if (env.MCA_FUNDER_PILOT_EVIDENCE_ENABLED !== "true") {
    throw new Error("Set MCA_FUNDER_PILOT_EVIDENCE_ENABLED=true to generate offline pilot evidence.")
  }
  if (!env.MCA_FUNDER_PILOT_EVIDENCE_DATABASE_URL) throw new Error("Missing MCA_FUNDER_PILOT_EVIDENCE_DATABASE_URL.")
  if (!env.MCA_FUNDER_PILOT_EVIDENCE_WORKSPACE_ID) throw new Error("Missing MCA_FUNDER_PILOT_EVIDENCE_WORKSPACE_ID.")
  const args = argv[0] === "--" ? argv.slice(1) : argv
  if (args.length !== 2 || args[0] !== "--job-id" || !args[1]?.trim()) {
    throw new Error("Pass exactly one --job-id <synthetic-job-id>.")
  }

  let url: URL
  try {
    url = new URL(env.MCA_FUNDER_PILOT_EVIDENCE_DATABASE_URL)
  } catch {
    throw new Error("Missing MCA_FUNDER_PILOT_EVIDENCE_DATABASE_URL.")
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error("Missing MCA_FUNDER_PILOT_EVIDENCE_DATABASE_URL.")
  if (env.MCA_FUNDER_PILOT_EVIDENCE_DATABASE_URL.toLowerCase().includes(PRODUCTION_PROJECT_REF)) {
    throw new Error("Refusing to inspect the production Supabase project.")
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname)
  if (!loopback && env.MCA_FUNDER_PILOT_EVIDENCE_DATABASE_DISPOSABLE !== "true") {
    throw new Error("Pilot evidence may run only against loopback PostgreSQL unless MCA_FUNDER_PILOT_EVIDENCE_DATABASE_DISPOSABLE=true.")
  }
  return {
    databaseUrl: env.MCA_FUNDER_PILOT_EVIDENCE_DATABASE_URL,
    workspaceId: env.MCA_FUNDER_PILOT_EVIDENCE_WORKSPACE_ID,
    jobId: args[1].trim(),
  }
}

export async function collectPilotEvidence(
  executor: ReadOnlyQueryExecutor,
  input: { workspaceId: string; jobId: string },
): Promise<CollectedPilotEvidence> {
  const parameters = [input.workspaceId, input.jobId] as const
  const jobResult = await executor.query<JobEvidence>(`
    SELECT j.workspace_id, j.deal_id, j.id AS job_id, j.funder_id, j.route_kind,
      j.state AS job_state, j.created_at,
      jsonb_array_length(j.preflight_errors_json::jsonb) = 0 AS preflight_ready,
      EXISTS (
        SELECT 1 FROM mca_review_approvals approval
        WHERE approval.workspace_id = $1 AND approval.run_id = j.analysis_run_id
          AND approval.selected_funder_ids::jsonb ? j.funder_id
      ) AS explicitly_approved,
      EXISTS (
        SELECT 1 FROM jsonb_array_elements(mf.routes::jsonb) route
        WHERE route->>'kind' = 'api' AND route->>'destination' = 'sandbox'
          AND COALESCE((route->>'active')::boolean, false)
      ) AS sandbox_adapter
    FROM mca_submission_jobs j
    INNER JOIN mca_funders mf ON mf.workspace_id = j.workspace_id AND mf.id = j.funder_id
    WHERE j.workspace_id = $1 AND j.id = $2
    LIMIT 1`, parameters)
  const job = jobResult.rows[0]
  if (!job) throw new Error("The selected submission job was not found in the selected workspace.")

  const attemptResult = await executor.query<AttemptEvidence>(`
    SELECT a.id AS attempt_id, a.state AS attempt_state, a.correlation_id,
      CASE WHEN j.route_kind = 'email' THEN a.external_ref::jsonb->>'messageId' ELSE a.external_ref END AS external_ref,
      a.error_code, a.created_at, a.sent_at,
      EXISTS (
        SELECT 1 FROM audit_events audit
        WHERE audit.workspace_id = $1 AND audit.resource_id = j.id
          AND audit.action = 'submission.email_delivery_reconciled'
      ) AS reconciled,
      (SELECT audit.created_at FROM audit_events audit
        WHERE audit.workspace_id = $1 AND audit.resource_id = j.id
          AND audit.action = 'submission.email_delivery_reconciled'
        ORDER BY audit.created_at DESC, audit.id DESC LIMIT 1) AS reconciled_at
    FROM mca_submission_jobs j
    INNER JOIN mca_submission_attempts a ON a.workspace_id = j.workspace_id AND a.job_id = j.id
    WHERE j.workspace_id = $1 AND j.id = $2
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT 1`, parameters)

  const replyResult = await executor.query<ReplyEvidence>(`
    SELECT reply.id AS reply_id, reply.provider_message_id, reply.state AS reply_state,
      reply.matched_deal_id, reply.matched_job_id, reply.created_at, reply.updated_at,
      (SELECT checkpoint.match_evidence::jsonb->>'lastRunAt'
        FROM mca_funder_replies checkpoint
        WHERE checkpoint.workspace_id = $1 AND checkpoint.sender_id = reply.sender_id
          AND checkpoint.provider_message_id = '${CHECKPOINT_PROVIDER_MESSAGE_ID}'
        ORDER BY checkpoint.updated_at DESC, checkpoint.id DESC LIMIT 1) AS checkpoint_at
    FROM mca_submission_jobs j
    INNER JOIN mca_funder_replies reply ON reply.workspace_id = j.workspace_id
      AND reply.matched_job_id = j.id AND reply.matched_deal_id = j.deal_id
      AND reply.provider_message_id <> '${CHECKPOINT_PROVIDER_MESSAGE_ID}'
    WHERE j.workspace_id = $1 AND j.id = $2
    ORDER BY reply.created_at DESC, reply.id DESC
    LIMIT 1`, parameters)

  const activityResult = await executor.query<ActivityEvidence>(`
    SELECT activity.id AS activity_id, activity.action, activity.source,
      activity.from_status, activity.to_status, activity.created_at
    FROM mca_submission_jobs j
    INNER JOIN deal_activity activity ON activity.workspace_id = j.workspace_id AND activity.deal_id = j.deal_id
    WHERE j.workspace_id = $1 AND j.id = $2
    ORDER BY activity.created_at DESC, activity.id DESC
    LIMIT 1`, parameters)

  return { job, attempt: attemptResult.rows[0], reply: replyResult.rows[0], activity: activityResult.rows[0] }
}

function refs(values: Record<string, string | null | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => Boolean(entry[1])))
}

export function buildPilotEvidenceMatrix(evidence: CollectedPilotEvidence): PilotEvidenceMatrix {
  const { job, attempt, reply, activity } = evidence
  const uncertain = attempt?.error_code === "delivery_uncertain" || attempt?.attempt_state === "sending"
  const receiptPresent = Boolean(attempt?.external_ref && !uncertain)
  return {
    workspaceId: job.workspace_id,
    dealId: job.deal_id,
    jobId: job.job_id,
    funderId: job.funder_id,
    providerReadiness: job.route_kind === "api" && job.sandbox_adapter ? "sandbox verified" : "untested",
    disclaimer: DISCLAIMER,
    rows: [
      { label: "Reviewed submission and preflight", status: job.preflight_ready && job.explicitly_approved ? "present" : "missing", references: refs({ jobId: job.job_id, state: job.job_state, createdAt: job.created_at }), note: job.preflight_ready && job.explicitly_approved ? "The stored submission has no preflight errors." : "Preflight readiness is absent; this does not establish non-delivery." },
      { label: "Explicit approval and job", status: job.explicitly_approved ? "present" : "missing", references: refs({ jobId: job.job_id, dealId: job.deal_id, funderId: job.funder_id }), note: job.explicitly_approved ? "The selected job is linked to stored explicit approval." : "Stored explicit approval was not found for the selected job." },
      { label: "Attempt correlation", status: attempt?.correlation_id ? "present" : "missing", references: refs({ attemptId: attempt?.attempt_id, correlationId: attempt?.correlation_id, state: attempt?.attempt_state, createdAt: attempt?.created_at, sentAt: attempt?.sent_at }), note: attempt?.correlation_id ? "The newest stored attempt has a correlation identifier." : "No attempt correlation is stored; absence is not proof of non-delivery." },
      { label: "Relay or provider receipt", status: receiptPresent ? "present" : "missing", references: refs({ externalReference: receiptPresent ? attempt?.external_ref : undefined }), note: receiptPresent ? "A stored opaque receipt or external reference is present." : "No definitive stored receipt is present; absence is not proof of non-delivery." },
      { label: "Unknown outcome reconciliation", status: uncertain ? (attempt?.reconciled ? "present" : "missing") : "not_applicable", references: refs({ correlationId: attempt?.correlation_id, reconciledAt: attempt?.reconciled_at }), note: uncertain ? (attempt?.reconciled ? "The uncertain attempt has stored reconciliation evidence." : "The uncertain attempt has no stored reconciliation evidence and must not be treated as not sent.") : "The newest attempt is not stored as an unknown outcome." },
      { label: "Reply provider message", status: reply?.provider_message_id ? "present" : "missing", references: refs({ replyId: reply?.reply_id, providerMessageId: reply?.provider_message_id, checkpointAt: reply?.checkpoint_at, createdAt: reply?.created_at }), note: reply ? "A deterministically selected stored provider reply is linked to the job." : "No linked stored provider reply was found." },
      { label: "Reviewed reply outcome", status: reply && ["matched", "ignored", "processed"].includes(reply.reply_state) ? "present" : "missing", references: refs({ replyId: reply?.reply_id, state: reply?.reply_state, matchedJobId: reply?.matched_job_id, matchedDealId: reply?.matched_deal_id, updatedAt: reply?.updated_at }), note: reply && ["matched", "ignored", "processed"].includes(reply.reply_state) ? "The stored reply has a reviewed outcome." : "A reviewed reply outcome is not stored." },
      { label: "Deal activity", status: activity ? "present" : "missing", references: refs({ activityId: activity?.activity_id, action: activity?.action, source: activity?.source, fromStatus: activity?.from_status, toStatus: activity?.to_status, createdAt: activity?.created_at }), note: activity ? "The newest stored deal activity is included as an opaque reference." : "No deal activity is stored for the selected deal." },
    ],
  }
}

function safeOpaque(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 128)
}

function safeTimestamp(value: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new Error("Pilot evidence contains an unsafe timestamp.")
  return new Date(timestamp).toISOString()
}

const TIMESTAMP_KEYS = new Set(["createdAt", "sentAt", "reconciledAt", "checkpointAt", "updatedAt"])
const REFERENCE_KEYS = new Set(["jobId", "dealId", "funderId", "attemptId", "correlationId", "externalReference", "providerMessageId", "replyId", "activityId", "matchedJobId", "matchedDealId", "state", "action", "source", "fromStatus", "toStatus", ...TIMESTAMP_KEYS])
const ROW_LABELS = new Set([
  "Reviewed submission and preflight", "Explicit approval and job", "Attempt correlation", "Relay or provider receipt",
  "Unknown outcome reconciliation", "Reply provider message", "Reviewed reply outcome", "Deal activity",
])
const FIXED_NOTES = new Set([
  "The stored submission has no preflight errors.", "Preflight readiness is absent; this does not establish non-delivery.",
  "The selected job is linked to stored explicit approval.", "Stored explicit approval was not found for the selected job.",
  "The newest stored attempt has a correlation identifier.", "No attempt correlation is stored; absence is not proof of non-delivery.",
  "A stored opaque receipt or external reference is present.", "No definitive stored receipt is present; absence is not proof of non-delivery.",
  "The uncertain attempt has stored reconciliation evidence.", "The uncertain attempt has no stored reconciliation evidence and must not be treated as not sent.",
  "The newest attempt is not stored as an unknown outcome.", "A deterministically selected stored provider reply is linked to the job.",
  "No linked stored provider reply was found.", "The stored reply has a reviewed outcome.", "A reviewed reply outcome is not stored.",
  "The newest stored deal activity is included as an opaque reference.", "No deal activity is stored for the selected deal.",
])

export function sanitizePilotEvidence(matrix: PilotEvidenceMatrix): PilotEvidenceMatrix {
  if (matrix.rows.length !== 8 || new Set(matrix.rows.map(row => row.label)).size !== ROW_LABELS.size || matrix.rows.some(row => !ROW_LABELS.has(row.label) || !FIXED_NOTES.has(row.note))) {
    throw new Error("Pilot evidence contains unsafe output.")
  }
  return {
    workspaceId: safeOpaque(matrix.workspaceId),
    dealId: safeOpaque(matrix.dealId),
    jobId: safeOpaque(matrix.jobId),
    funderId: safeOpaque(matrix.funderId),
    providerReadiness: matrix.providerReadiness === "sandbox verified" ? "sandbox verified" : "untested",
    disclaimer: DISCLAIMER,
    rows: matrix.rows.map((row) => ({
      label: row.label,
      status: ["present", "missing", "not_applicable"].includes(row.status) ? row.status : "missing",
      references: Object.fromEntries(Object.entries(row.references)
        .filter(([key]) => REFERENCE_KEYS.has(key))
        .map(([key, value]) => [key, TIMESTAMP_KEYS.has(key) ? safeTimestamp(value) : safeOpaque(value)])),
      note: row.note,
    })),
  }
}

export async function main(argv = process.argv.slice(2), env = process.env): Promise<void> {
  const guarded = assertPilotEvidenceGuards({ env, argv })
  const { Pool } = await import("pg")
  const pool = new Pool({ connectionString: guarded.databaseUrl, max: 1 })
  let client: PoolClient | undefined
  try {
    client = await pool.connect()
    await client.query("BEGIN READ ONLY")
    const collected = await collectPilotEvidence(client, guarded)
    const sanitized = sanitizePilotEvidence(buildPilotEvidenceMatrix(collected))
    await client.query("COMMIT")
    process.stdout.write(`${JSON.stringify(sanitized, null, 2)}\n`)
  } catch (error) {
    await client?.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client?.release()
    await pool.end()
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : "Pilot evidence generation failed."}\n`)
  process.exitCode = 1
})

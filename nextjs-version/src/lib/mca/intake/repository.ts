import "server-only"

import { decryptSensitive, encryptSensitive } from "../crypto"
import { getDatabase, newId, nowIso, parseJson, withImmediateTransaction, type DbExecutor } from "../db"
import type { DealStatus, DealWriteInput } from "../deals/schema"
import type { IntakeResult, NormalizedIntakeInput } from "./contracts"

export function intakeDatabase(): DbExecutor { return getDatabase() }

export interface IntakeEventRecord extends IntakeResult {
  workspaceId: string
  provider: string
  eventId: string
  payloadChecksum: string
  application: DealWriteInput
  emailSource?: string
  emailSourceChecksum?: string
  sourceReference?: string
  initialStatus?: DealStatus
  integrationId?: string
  eventNamespace?: string
  errorCode?: string
  errorMessage?: string
  createdAt: string
  updatedAt: string
}

type Row = Record<string, string | number | null>

function eventFromRow(row: Row): IntakeEventRecord {
  const workspaceId = String(row.workspace_id)
  return {
    intakeId: String(row.id),
    workspaceId,
    provider: String(row.provider),
    eventId: String(row.provider_event_id),
    payloadChecksum: String(row.payload_checksum),
    application: JSON.parse(decryptSensitive(String(row.application_cipher), workspaceId)) as DealWriteInput,
    emailSource: row.email_source_cipher ? decryptSensitive(String(row.email_source_cipher), workspaceId) : undefined,
    emailSourceChecksum: row.email_source_checksum ? String(row.email_source_checksum) : undefined,
    sourceReference: row.source_reference ? String(row.source_reference) : undefined,
    initialStatus: row.initial_status ? row.initial_status as DealStatus : undefined,
    eventNamespace: row.event_namespace ? String(row.event_namespace) : undefined,
    integrationId: row.integration_id ? String(row.integration_id) : undefined,
    dealId: row.deal_id ? String(row.deal_id) : null,
    created: Boolean(row.deal_id),
    state: row.state as IntakeResult["state"],
    warnings: parseJson<string[]>(row.warnings_json, []),
    errorCode: row.error_code ? String(row.error_code) : undefined,
    errorMessage: row.error_message ? String(row.error_message) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

export async function reserveIntake(
  workspaceId: string,
  input: NormalizedIntakeInput,
  payloadChecksum: string,
  integrationId?: string,
): Promise<{ record: IntakeEventRecord; inserted: boolean }> {
  return withImmediateTransaction(async (database) => {
    // Before namespaces existed there was at most one event per provider ID. Keep generic client retries valid.
    if (!integrationId) {
      const legacy = await database.prepare("SELECT * FROM intake_events WHERE workspace_id=? AND provider=? AND provider_event_id=? AND legacy_identity=1 FOR UPDATE").get(workspaceId, input.provider, input.eventId) as Row | undefined
      if (legacy) return { record: eventFromRow(legacy), inserted: false }
    }
    const id = newId()
    const timestamp = nowIso()
    const inserted = await database.prepare<{ id: string }>(`INSERT INTO intake_events
      (id, workspace_id, provider, provider_event_id, payload_checksum, application_cipher,
       source_reference, initial_status, state, integration_id, event_namespace, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?, ?, ?)
      ON CONFLICT (workspace_id, event_namespace, provider, provider_event_id) DO NOTHING
      RETURNING id`).get(
      id,
      workspaceId,
      input.provider,
      input.eventId,
      payloadChecksum,
      encryptSensitive(JSON.stringify(input.application), workspaceId),
      input.sourceReference ?? null,
      input.initialStatus ?? null,
      integrationId ?? null,
      integrationId ?? "",
      timestamp,
      timestamp,
    )
    const row = await database.prepare(`SELECT * FROM intake_events
      WHERE workspace_id = ? AND event_namespace = ? AND provider = ? AND provider_event_id = ? FOR UPDATE`).get(
      workspaceId, integrationId ?? "", input.provider, input.eventId,
    ) as Row
    return { record: eventFromRow(row), inserted: Boolean(inserted) }
  })
}

export async function updateIntake(input: {
  workspaceId: string
  intakeId: string
  state: IntakeResult["state"]
  dealId?: string | null
  warnings?: string[]
  errorCode?: string | null
  errorMessage?: string | null
}): Promise<IntakeEventRecord> {
  const database = intakeDatabase()
  await database.prepare(`UPDATE intake_events SET state = ?, deal_id = COALESCE(?, deal_id),
    warnings_json = COALESCE(?, warnings_json), error_code = ?, error_message = ?, updated_at = ?
    WHERE id = ? AND workspace_id = ?`).run(
    input.state,
    input.dealId ?? null,
    input.warnings ? JSON.stringify(input.warnings) : null,
    input.errorCode ?? null,
    input.errorMessage ?? null,
    nowIso(),
    input.intakeId,
    input.workspaceId,
  )
  const row = await database.prepare("SELECT * FROM intake_events WHERE id = ? AND workspace_id = ?")
    .get(input.intakeId, input.workspaceId) as Row | undefined
  if (!row) throw new Error("Intake record disappeared while it was being updated.")
  return eventFromRow(row)
}

export async function findIntake(workspaceId: string, intakeId: string): Promise<IntakeEventRecord | undefined> {
  const row = await intakeDatabase().prepare("SELECT * FROM intake_events WHERE id = ? AND workspace_id = ?")
    .get(intakeId, workspaceId) as Row | undefined
  return row ? eventFromRow(row) : undefined
}

export async function associateIntakeIntegration(workspaceId: string, intakeId: string, integrationId: string): Promise<void> {
  await intakeDatabase().prepare(`UPDATE intake_events SET integration_id = ?, updated_at = ?
    WHERE id = ? AND workspace_id = ?`).run(integrationId, nowIso(), intakeId, workspaceId)
}

export async function listIntakes(workspaceId: string, limit = 50): Promise<IntakeEventRecord[]> {
  return (await intakeDatabase().prepare(`SELECT * FROM intake_events WHERE workspace_id = ?
    ORDER BY updated_at DESC LIMIT ?`).all(workspaceId, Math.max(1, Math.min(limit, 200))) as Row[]).map(eventFromRow)
}

export interface AttachmentJob {
  id: string
  workspaceId: string
  intakeId: string
  attachmentId: string
  sourceUrl?: string
  filename: string
  mimeType: string
  category: string
  state: "pending" | "fetching" | "stored" | "retryable" | "failed"
  attemptCount: number
  nextAttemptAt?: string
  documentId?: string
  lastError?: string
  leaseToken?: string
  leaseExpiresAt?: string
}

function attachmentFromRow(row: Row): AttachmentJob {
  const workspaceId = String(row.workspace_id)
  return {
    id: String(row.id), workspaceId, intakeId: String(row.intake_id), attachmentId: String(row.attachment_id),
    sourceUrl: row.source_url_cipher ? decryptSensitive(String(row.source_url_cipher), workspaceId) : undefined,
    filename: String(row.filename), mimeType: String(row.mime_type), category: String(row.category),
    state: row.state as AttachmentJob["state"], attemptCount: Number(row.attempt_count),
    nextAttemptAt: row.next_attempt_at ? String(row.next_attempt_at) : undefined,
    documentId: row.document_id ? String(row.document_id) : undefined,
    lastError: row.last_error ? String(row.last_error) : undefined,
    leaseToken: row.lease_token ? String(row.lease_token) : undefined,
    leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : undefined,
  }
}

export async function upsertAttachmentJob(input: Omit<AttachmentJob, "id" | "state" | "attemptCount">): Promise<AttachmentJob> {
  return withImmediateTransaction(async (database) => {
    await database.prepare("SELECT id FROM intake_events WHERE id = ? AND workspace_id = ? FOR UPDATE").get(input.intakeId, input.workspaceId)
    const existing = await database.prepare("SELECT * FROM intake_attachment_jobs WHERE intake_id = ? AND attachment_id = ?")
      .get(input.intakeId, input.attachmentId) as Row | undefined
    if (existing) return attachmentFromRow(existing)
    const id = newId()
    const timestamp = nowIso()
    await database.prepare(`INSERT INTO intake_attachment_jobs
      (id, workspace_id, intake_id, attachment_id, source_url_cipher, filename, mime_type, category,
       state, attempt_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`).run(
      id, input.workspaceId, input.intakeId, input.attachmentId,
      input.sourceUrl ? encryptSensitive(input.sourceUrl, input.workspaceId) : null,
      input.filename, input.mimeType, input.category, timestamp, timestamp,
    )
    return attachmentFromRow(await database.prepare("SELECT * FROM intake_attachment_jobs WHERE id = ?").get(id) as Row)
  })
}

export async function updateAttachmentJob(
  workspaceId: string,
  jobId: string,
  patch: Partial<Pick<AttachmentJob, "state" | "nextAttemptAt" | "documentId" | "lastError">> & { incrementAttempt?: boolean },
): Promise<AttachmentJob> {
  const database = intakeDatabase()
  await database.prepare(`UPDATE intake_attachment_jobs SET
    state = COALESCE(?, state), next_attempt_at = ?, document_id = COALESCE(?, document_id),
    last_error = ?, attempt_count = attempt_count + ?,
    lease_token = CASE WHEN CAST(? AS text) IS NOT NULL AND CAST(? AS text) <> 'fetching' THEN NULL ELSE lease_token END,
    lease_expires_at = CASE WHEN CAST(? AS text) IS NOT NULL AND CAST(? AS text) <> 'fetching' THEN NULL ELSE lease_expires_at END,
    updated_at = ?
    WHERE id = ? AND workspace_id = ?`).run(
    patch.state ?? null, patch.nextAttemptAt ?? null, patch.documentId ?? null, patch.lastError ?? null,
    patch.incrementAttempt ? 1 : 0,
    patch.state ?? null, patch.state ?? null, patch.state ?? null, patch.state ?? null,
    nowIso(), jobId, workspaceId,
  )
  const row = await database.prepare("SELECT * FROM intake_attachment_jobs WHERE id = ? AND workspace_id = ?")
    .get(jobId, workspaceId) as Row | undefined
  if (!row) throw new Error("Attachment job not found.")
  return attachmentFromRow(row)
}

export async function claimAttachmentJob(workspaceId: string, jobId: string, leaseMs = 60_000): Promise<{ job: AttachmentJob; acquired: boolean }> {
  return withImmediateTransaction(async (database) => {
    const now = nowIso()
    const current = await database.prepare("SELECT * FROM intake_attachment_jobs WHERE id=? AND workspace_id=? FOR UPDATE")
      .get(jobId, workspaceId) as Row | undefined
    if (!current) throw new Error("Attachment job not found.")
    const state = String(current.state)
    const due = !current.next_attempt_at || String(current.next_attempt_at) <= now
    const leaseExpired = !current.lease_expires_at || String(current.lease_expires_at) <= now
    if (!((state === "pending" || state === "retryable") && due) && !(state === "fetching" && leaseExpired)) {
      return { job: attachmentFromRow(current), acquired: false }
    }
    const token = newId()
    const expiresAt = new Date(Date.now() + Math.max(1, leaseMs)).toISOString()
    await database.prepare(`UPDATE intake_attachment_jobs SET state='fetching', attempt_count=attempt_count+1,
      next_attempt_at=NULL, lease_token=?, lease_expires_at=?, updated_at=? WHERE id=? AND workspace_id=?`).run(
      token, expiresAt, now, jobId, workspaceId,
    )
    return {
      job: attachmentFromRow(await database.prepare("SELECT * FROM intake_attachment_jobs WHERE id=? AND workspace_id=?").get(jobId, workspaceId) as Row),
      acquired: true,
    }
  })
}

export async function completeAttachmentJob(
  workspaceId: string,
  jobId: string,
  leaseToken: string,
  patch: Pick<AttachmentJob, "state"> & Partial<Pick<AttachmentJob, "nextAttemptAt" | "documentId" | "lastError">>,
): Promise<{ job: AttachmentJob; completed: boolean }> {
  const database = intakeDatabase()
  const result = await database.prepare(`UPDATE intake_attachment_jobs SET state=?, next_attempt_at=?,
    document_id=COALESCE(?, document_id), last_error=?, lease_token=NULL, lease_expires_at=NULL, updated_at=?
    WHERE id=? AND workspace_id=? AND lease_token=?`).run(
    patch.state, patch.nextAttemptAt ?? null, patch.documentId ?? null, patch.lastError ?? null,
    nowIso(), jobId, workspaceId, leaseToken,
  )
  const row = await database.prepare("SELECT * FROM intake_attachment_jobs WHERE id=? AND workspace_id=?")
    .get(jobId, workspaceId) as Row | undefined
  if (!row) throw new Error("Attachment job not found.")
  return { job: attachmentFromRow(row), completed: result.changes === 1 }
}

export async function listAttachmentJobs(workspaceId: string, intakeId?: string): Promise<AttachmentJob[]> {
  const database = intakeDatabase()
  const rows = intakeId
    ? await database.prepare("SELECT * FROM intake_attachment_jobs WHERE workspace_id = ? AND intake_id = ? ORDER BY created_at").all(workspaceId, intakeId)
    : await database.prepare("SELECT * FROM intake_attachment_jobs WHERE workspace_id = ? ORDER BY updated_at DESC").all(workspaceId)
  return (rows as Row[]).map(attachmentFromRow)
}

export async function dueAttachmentJobs(limit = 25, workspaceId?: string): Promise<AttachmentJob[]> {
  const now = nowIso()
  const database = intakeDatabase()
  const rows = workspaceId
    ? await database.prepare(`SELECT * FROM intake_attachment_jobs WHERE workspace_id = ?
        AND (((state IN ('pending','retryable')) AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
          OR (state='fetching' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)))
        ORDER BY updated_at LIMIT ?`).all(workspaceId, now, now, Math.max(1, Math.min(limit, 100)))
    : await database.prepare(`SELECT * FROM intake_attachment_jobs
        WHERE (((state IN ('pending','retryable')) AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
          OR (state='fetching' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)))
        ORDER BY updated_at LIMIT ?`).all(now, now, Math.max(1, Math.min(limit, 100)))
  return (rows as Row[]).map(attachmentFromRow)
}

export interface IntegrationRecord {
  id: string
  workspaceId: string
  provider: string
  displayName: string
  formId?: string
  templateId?: string
  locationId?: string
  admissionSecretHash?: string
  signingSecret?: string
  credential?: string
  credentialConfigured: boolean
  credentialExpiresAt?: string
  credentialVersion: number
  mapping: Record<string, string>
  allowedHosts: string[]
  senderRules: string[]
  assignmentPool: string[]
  initialStatus: DealStatus
  inboundAddress?: string
  enabled: boolean
  automaticProcessing?: boolean
  automaticSince?: string
  approvalState: "approved" | "pending_customer_contract"
  contractKey?: string
  attachmentMethod?: string
  emailGateway?: "usesend" | "postmark" | "custom"
  providerServerId?: string
  providerEvidenceHash?: string
  createdAt: string
  updatedAt: string
}

function integrationFromRow(row: Row, revealCredential = false): IntegrationRecord {
  const workspaceId = String(row.workspace_id)
  return {
    id: String(row.id), workspaceId, provider: String(row.provider), displayName: String(row.display_name),
    formId: row.form_id ? String(row.form_id) : undefined,
    templateId: row.template_id ? String(row.template_id) : undefined,
    locationId: row.location_id ? String(row.location_id) : undefined,
    admissionSecretHash: row.admission_secret_hash ? String(row.admission_secret_hash) : undefined,
    signingSecret: revealCredential && row.signing_secret_cipher ? decryptSensitive(String(row.signing_secret_cipher), workspaceId) : undefined,
    credential: revealCredential && row.credential_cipher ? decryptSensitive(String(row.credential_cipher), workspaceId) : undefined,
    credentialConfigured: Boolean(row.credential_cipher),
    credentialExpiresAt: row.credential_expires_at ? String(row.credential_expires_at) : undefined,
    credentialVersion: Number(row.credential_version), mapping: parseJson(row.mapping_json, {}),
    allowedHosts: parseJson(row.allowed_hosts_json, []), senderRules: parseJson(row.sender_rules_json, []),
    assignmentPool: parseJson(row.assignment_pool_json, []), initialStatus: row.initial_status as DealStatus,
    inboundAddress: row.inbound_address ? String(row.inbound_address) : undefined,
    automaticProcessing: Boolean(row.automatic_processing), automaticSince: row.automatic_since ? String(row.automatic_since) : undefined,
    enabled: Boolean(row.enabled), approvalState: row.approval_state as IntegrationRecord["approvalState"],
    contractKey: row.contract_key ? String(row.contract_key) : undefined,
    attachmentMethod: row.attachment_method ? String(row.attachment_method) : undefined,
    emailGateway: row.email_gateway ? String(row.email_gateway) as IntegrationRecord["emailGateway"] : undefined,
    providerServerId: row.provider_server_id ? String(row.provider_server_id) : undefined,
    providerEvidenceHash: row.provider_evidence_hash ? String(row.provider_evidence_hash) : undefined,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  }
}

export async function saveIntegration(input: Omit<IntegrationRecord, "createdAt" | "updatedAt" | "credentialVersion" | "credentialConfigured"> & {
  credential?: string
  signingSecret?: string
  credentialExpiresAt?: string
  credentialVersion?: number
}): Promise<IntegrationRecord> {
  const database = intakeDatabase()
  const timestamp = nowIso()
  const previous = await database.prepare("SELECT * FROM intake_integrations WHERE id = ? AND workspace_id = ?")
    .get(input.id, input.workspaceId) as Row | undefined
  if (previous) {
    await database.prepare(`UPDATE intake_integrations SET display_name=?, form_id=?, template_id=?, location_id=?,
      admission_secret_hash=?, signing_secret_cipher=COALESCE(?, signing_secret_cipher), credential_cipher=COALESCE(?, credential_cipher), credential_expires_at=?,
      credential_version=?, mapping_json=?, allowed_hosts_json=?, sender_rules_json=?, assignment_pool_json=?,
      initial_status=?, inbound_address=?, enabled=?, approval_state=?, contract_key=?, attachment_method=?,
      email_gateway=?, provider_server_id=?, provider_evidence_hash=?, updated_at=? WHERE id=? AND workspace_id=?`).run(
      input.displayName, input.formId ?? null, input.templateId ?? null, input.locationId ?? null,
      input.admissionSecretHash ?? null,
      input.signingSecret ? encryptSensitive(input.signingSecret, input.workspaceId) : null,
      input.credential ? encryptSensitive(input.credential, input.workspaceId) : null,
      input.credentialExpiresAt ?? null, input.credentialVersion ?? Number(previous.credential_version),
      JSON.stringify(input.mapping), JSON.stringify(input.allowedHosts), JSON.stringify(input.senderRules),
      JSON.stringify(input.assignmentPool), input.initialStatus, input.inboundAddress ?? null,
      input.enabled ? 1 : 0, input.approvalState, input.contractKey ?? null, input.attachmentMethod ?? null,
      input.emailGateway ?? null, input.providerServerId ?? null, input.providerEvidenceHash ?? null,
      timestamp, input.id, input.workspaceId,
    )
  } else {
    await database.prepare(`INSERT INTO intake_integrations
      (id, workspace_id, provider, display_name, form_id, template_id, location_id, admission_secret_hash, signing_secret_cipher,
       credential_cipher, credential_expires_at, credential_version, mapping_json, allowed_hosts_json,
       sender_rules_json, assignment_pool_json, initial_status, inbound_address, enabled, approval_state,
       contract_key, attachment_method, email_gateway, provider_server_id, provider_evidence_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.id, input.workspaceId, input.provider, input.displayName, input.formId ?? null, input.templateId ?? null,
      input.locationId ?? null, input.admissionSecretHash ?? null,
      input.signingSecret ? encryptSensitive(input.signingSecret, input.workspaceId) : null,
      input.credential ? encryptSensitive(input.credential, input.workspaceId) : null,
      input.credentialExpiresAt ?? null, input.credentialVersion ?? 1, JSON.stringify(input.mapping),
      JSON.stringify(input.allowedHosts), JSON.stringify(input.senderRules), JSON.stringify(input.assignmentPool),
      input.initialStatus, input.inboundAddress ?? null, input.enabled ? 1 : 0, input.approvalState,
      input.contractKey ?? null, input.attachmentMethod ?? null, input.emailGateway ?? null,
      input.providerServerId ?? null, input.providerEvidenceHash ?? null, timestamp, timestamp,
    )
  }
  await database.prepare("UPDATE intake_integrations SET automatic_processing=?, automatic_since=? WHERE id=? AND workspace_id=?").run(
    input.automaticProcessing ? 1 : 0, input.automaticSince ?? null, input.id, input.workspaceId,
  )
  return (await getIntegration(input.workspaceId, input.id, false))!
}

export async function getIntegration(workspaceId: string, id: string, revealCredential = false): Promise<IntegrationRecord | undefined> {
  const row = await intakeDatabase().prepare("SELECT * FROM intake_integrations WHERE id = ? AND workspace_id = ?")
    .get(id, workspaceId) as Row | undefined
  return row ? integrationFromRow(row, revealCredential) : undefined
}

export async function findIntegrationByPublicId(id: string, revealCredential = false): Promise<IntegrationRecord | undefined> {
  const row = await intakeDatabase().prepare("SELECT * FROM intake_integrations WHERE id = ? AND enabled = 1")
    .get(id) as Row | undefined
  return row ? integrationFromRow(row, revealCredential) : undefined
}

export async function listIntegrations(workspaceId: string): Promise<IntegrationRecord[]> {
  return (await intakeDatabase().prepare("SELECT * FROM intake_integrations WHERE workspace_id = ? ORDER BY provider, display_name")
    .all(workspaceId) as Row[]).map((row) => integrationFromRow(row))
}

export async function findIntegrationByBinding(provider: string, binding: { formId?: string; templateId?: string; locationId?: string; inboundAddress?: string }, revealCredential = false): Promise<IntegrationRecord | undefined> {
  const pair = binding.formId ? ["form_id", binding.formId]
    : binding.templateId ? ["template_id", binding.templateId]
      : binding.locationId ? ["location_id", binding.locationId]
        : binding.inboundAddress ? ["inbound_address", binding.inboundAddress]
          : undefined
  if (!pair) return undefined
  const [column, value] = pair
  const row = await intakeDatabase().prepare(`SELECT * FROM intake_integrations WHERE provider = ? AND ${column} = ? AND enabled = 1`)
    .get(provider, value) as Row | undefined
  return row ? integrationFromRow(row, revealCredential) : undefined
}

export async function putAttributionToken(input: { workspaceId: string; integrationId: string; membershipId: string; tokenHash: string }): Promise<void> {
  const database = intakeDatabase()
  await database.prepare(`INSERT INTO intake_attribution_tokens
    (id, workspace_id, integration_id, membership_id, token_hash, created_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(integration_id, membership_id) DO UPDATE SET token_hash=excluded.token_hash, created_at=excluded.created_at, revoked_at=NULL`).run(
    newId(), input.workspaceId, input.integrationId, input.membershipId, input.tokenHash, nowIso(),
  )
}

export async function resolveAttributionToken(tokenHash: string): Promise<{ workspaceId: string; integrationId: string; membershipId: string; formId: string } | undefined> {
  const row = await intakeDatabase().prepare(`SELECT t.workspace_id, t.integration_id, t.membership_id, i.form_id
    FROM intake_attribution_tokens t
    JOIN intake_integrations i ON i.id=t.integration_id AND i.workspace_id=t.workspace_id AND i.enabled=1
    JOIN memberships m ON m.id=t.membership_id AND m.workspace_id=t.workspace_id AND m.status='active'
    WHERE t.token_hash=? AND t.revoked_at IS NULL AND i.provider='jotform'`).get(tokenHash) as Row | undefined
  return row && row.form_id ? {
    workspaceId: String(row.workspace_id), integrationId: String(row.integration_id),
    membershipId: String(row.membership_id), formId: String(row.form_id),
  } : undefined
}

export async function resolveNativeAttributionToken(tokenHash: string): Promise<{ workspaceId: string; integrationId: string; membershipId: string } | undefined> {
  const row = await intakeDatabase().prepare(`SELECT t.workspace_id, t.integration_id, t.membership_id
    FROM intake_attribution_tokens t
    JOIN intake_integrations i ON i.id=t.integration_id AND i.workspace_id=t.workspace_id AND i.enabled=1
    JOIN memberships m ON m.id=t.membership_id AND m.workspace_id=t.workspace_id AND m.status='active'
    WHERE t.token_hash=? AND t.revoked_at IS NULL AND i.provider='native'`).get(tokenHash) as Row | undefined
  return row ? {
    workspaceId: String(row.workspace_id),
    integrationId: String(row.integration_id),
    membershipId: String(row.membership_id),
  } : undefined
}

export async function findNativeApplyIntegration(workspaceId: string): Promise<IntegrationRecord | undefined> {
  const row = await intakeDatabase().prepare(
    "SELECT * FROM intake_integrations WHERE workspace_id=? AND provider='native' AND form_id='apply' AND enabled=1"
  ).get(workspaceId) as Row | undefined
  return row ? integrationFromRow(row, false) : undefined
}

export interface ReceiptRecord {
  id: string
  workspaceId: string
  intakeId: string
  recipient: string
  dealLink?: string
  addDocumentLink?: string
  warnings: string[]
  state: "pending" | "sent" | "failed"
  attemptCount: number
  providerMessageId?: string
  lastError?: string
  leaseToken?: string
  leaseExpiresAt?: string
}

function receiptFromRow(row: Row): ReceiptRecord {
  const workspaceId = String(row.workspace_id)
  return {
    id: String(row.id), workspaceId, intakeId: String(row.intake_id),
    recipient: decryptSensitive(String(row.recipient_cipher), workspaceId),
    dealLink: row.deal_link_cipher ? decryptSensitive(String(row.deal_link_cipher), workspaceId) : undefined,
    addDocumentLink: row.add_document_link_cipher ? decryptSensitive(String(row.add_document_link_cipher), workspaceId) : undefined,
    warnings: parseJson(row.warnings_json, []), state: row.state as ReceiptRecord["state"],
    attemptCount: Number(row.attempt_count), providerMessageId: row.provider_message_id ? String(row.provider_message_id) : undefined,
    lastError: row.last_error ? String(row.last_error) : undefined,
    leaseToken: row.lease_token ? String(row.lease_token) : undefined,
    leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : undefined,
  }
}

export async function enqueueReceipt(input: Omit<ReceiptRecord, "id" | "state" | "attemptCount">): Promise<ReceiptRecord> {
  return withImmediateTransaction(async (database) => {
    // AES-GCM is randomized, so event-level idempotency is enforced explicitly inside the write lock.
    await database.prepare("SELECT id FROM intake_events WHERE id = ? AND workspace_id = ? FOR UPDATE").get(input.intakeId, input.workspaceId)
    const prior = await database.prepare("SELECT * FROM intake_receipts WHERE intake_id = ? ORDER BY created_at LIMIT 1")
      .get(input.intakeId) as Row | undefined
    if (prior) return receiptFromRow(prior)
    const recipientCipher = encryptSensitive(input.recipient.toLowerCase(), input.workspaceId)
    const id = newId(); const timestamp = nowIso()
    await database.prepare(`INSERT INTO intake_receipts
      (id, workspace_id, intake_id, recipient_cipher, deal_link_cipher, add_document_link_cipher,
       warnings_json, state, attempt_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`).run(
        id, input.workspaceId, input.intakeId, recipientCipher,
        input.dealLink ? encryptSensitive(input.dealLink, input.workspaceId) : null,
        input.addDocumentLink ? encryptSensitive(input.addDocumentLink, input.workspaceId) : null,
        JSON.stringify(input.warnings), timestamp, timestamp,
      )
    return receiptFromRow(await database.prepare("SELECT * FROM intake_receipts WHERE id = ?").get(id) as Row)
  })
}

export async function listPendingReceipts(workspaceId?: string): Promise<ReceiptRecord[]> {
  const now = nowIso()
  const rows = workspaceId
    ? await intakeDatabase().prepare(`SELECT * FROM intake_receipts WHERE workspace_id=? AND state IN ('pending','failed')
        AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?) ORDER BY updated_at`).all(workspaceId, now)
    : await intakeDatabase().prepare(`SELECT * FROM intake_receipts WHERE state IN ('pending','failed')
        AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?) ORDER BY updated_at`).all(now)
  return (rows as Row[]).map(receiptFromRow)
}

export async function claimReceipt(workspaceId: string, id: string, leaseMs = 60_000): Promise<{ receipt: ReceiptRecord; acquired: boolean }> {
  return withImmediateTransaction(async (database) => {
    const current = await database.prepare("SELECT * FROM intake_receipts WHERE id=? AND workspace_id=? FOR UPDATE").get(id, workspaceId) as Row | undefined
    if (!current) throw new Error("Receipt not found.")
    const now = nowIso()
    const eligible = (current.state === "pending" || current.state === "failed")
      && (!current.lease_token || !current.lease_expires_at || String(current.lease_expires_at) <= now)
    if (!eligible) return { receipt: receiptFromRow(current), acquired: false }
    const token = newId()
    await database.prepare(`UPDATE intake_receipts SET attempt_count=attempt_count+1, lease_token=?, lease_expires_at=?, updated_at=?
      WHERE id=? AND workspace_id=?`).run(token, new Date(Date.now() + Math.max(1, leaseMs)).toISOString(), now, id, workspaceId)
    return { receipt: receiptFromRow(await database.prepare("SELECT * FROM intake_receipts WHERE id=? AND workspace_id=?").get(id, workspaceId) as Row), acquired: true }
  })
}

export async function completeReceipt(workspaceId: string, id: string, leaseToken: string, patch: { state: ReceiptRecord["state"]; providerMessageId?: string; lastError?: string }): Promise<{ receipt: ReceiptRecord; completed: boolean }> {
  const database = intakeDatabase()
  const result = await database.prepare(`UPDATE intake_receipts SET state=?, provider_message_id=?, last_error=?,
    lease_token=NULL, lease_expires_at=NULL, updated_at=? WHERE id=? AND workspace_id=? AND lease_token=?`).run(
    patch.state, patch.providerMessageId ?? null, patch.lastError ?? null, nowIso(), id, workspaceId, leaseToken,
  )
  const row = await database.prepare("SELECT * FROM intake_receipts WHERE id=? AND workspace_id=?").get(id, workspaceId) as Row | undefined
  if (!row) throw new Error("Receipt not found.")
  return { receipt: receiptFromRow(row), completed: result.changes === 1 }
}

// Called under the email intake row lock; the original source remains immutable.
export async function saveEmailSource(workspaceId: string, intakeId: string, source: string, checksum: string): Promise<void> {
  await intakeDatabase().prepare(`UPDATE intake_events SET email_source_cipher = ?, email_source_checksum = ?
    WHERE id = ? AND workspace_id = ? AND email_source_cipher IS NULL`).run(encryptSensitive(source, workspaceId), checksum, intakeId, workspaceId)
}

export async function saveEmailApplication(workspaceId: string, intakeId: string, input: NormalizedIntakeInput, checksum: string): Promise<void> {
  await intakeDatabase().prepare(`UPDATE intake_events SET application_cipher = ?, payload_checksum = ?, initial_status = ?
    WHERE id = ? AND workspace_id = ? AND deal_id IS NULL AND email_source_cipher IS NOT NULL`).run(
    encryptSensitive(JSON.stringify(input.application), workspaceId), checksum, input.initialStatus ?? null, intakeId, workspaceId)
}

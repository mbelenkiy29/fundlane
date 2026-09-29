import "server-only"

import { createHash } from "node:crypto"
import { getDatabase, nowIso } from "../db"
import { AppError } from "../errors"
import { verifyDocuSealCompletedWebhook } from "./docuseal-provider"
import { verifiedClosingFlowEnabled } from "./verified-flow"

interface Binding { submissionId: string; workflowId: string; offerRevisionId?: string }
interface Connection { workspaceId: string; webhookSecret: string; bindings: Binding[] }

export function contractDocuSealEnabled(): boolean {
  return verifiedClosingFlowEnabled() && process.env.MCA_CLOSING_DOCUSEAL_CONTRACT_ENABLED === "true"
}

function invalid(): never {
  throw new AppError(503, "docuseal_configuration_invalid", "DocuSeal contract connections are invalid.")
}

function required(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim() && value.length <= 300
}

export function parseContractDocuSealConnections(raw = process.env.MCA_DOCUSEAL_CONTRACT_CONNECTIONS_JSON ?? "[]"): Connection[] {
  let parsed: unknown
  try { parsed = JSON.parse(raw) as unknown } catch { return invalid() }
  if (!Array.isArray(parsed)) return invalid()
  const workspaces = new Set<string>()
  const submissions = new Set<string>()
  return parsed.map((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid()
    const entry = value as Record<string, unknown>
    if (!required(entry.workspaceId) || !required(entry.webhookSecret) || entry.webhookSecret.length < 32 || entry.webhookSecret.length > 500 || !Array.isArray(entry.bindings) || workspaces.has(entry.workspaceId)) return invalid()
    workspaces.add(entry.workspaceId)
    const bindings = entry.bindings.map((item: unknown) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return invalid()
      const binding = item as Record<string, unknown>
      if (!required(binding.submissionId) || !/^\d+$/.test(binding.submissionId) || !required(binding.workflowId) || submissions.has(binding.submissionId)) return invalid()
      submissions.add(binding.submissionId)
      if (binding.offerRevisionId === undefined) return { submissionId: binding.submissionId, workflowId: binding.workflowId }
      if (!required(binding.offerRevisionId)) return invalid()
      return { submissionId: binding.submissionId, workflowId: binding.workflowId, offerRevisionId: binding.offerRevisionId }
    })
    return { workspaceId: entry.workspaceId, webhookSecret: entry.webhookSecret, bindings }
  })
}

export async function recordContractDocuSealWebhook(workspaceId: string, rawBody: string, signature: string | null): Promise<{ state: "ignored" } | { state: "received"; replayed: boolean }> {
  const connection = parseContractDocuSealConnections().find((item) => item.workspaceId === workspaceId)
  if (!connection) throw new AppError(503, "docuseal_unconfigured", "DocuSeal contract callback is not configured for this workspace.")
  const completed = verifyDocuSealCompletedWebhook(rawBody, signature, connection.webhookSecret)
  const binding = connection.bindings.find((item) => item.submissionId === completed.submissionId)
  if (!binding) return { state: "ignored" }
  const database = getDatabase()
  const id = createHash("sha256").update(JSON.stringify(["docuseal_contract_receipt", workspaceId, completed.submissionId])).digest("hex")
  const assertReplay = async (): Promise<{ state: "received"; replayed: true } | null> => {
    const existing = await database.prepare<{ workspace_id: string; action: string; resource_id: string; metadata: string }>("SELECT workspace_id,action,resource_id,metadata FROM audit_events WHERE id=?").get(id)
    if (!existing) return null
    let prior: { workflowId?: unknown; submissionId?: unknown; offerRevisionId?: unknown } = {}
    try { prior = (JSON.parse(existing.metadata) as typeof prior | null) ?? {} } catch { /* conflict below */ }
    if (existing.workspace_id !== workspaceId || existing.action !== "contract.docuseal_completion_received" || existing.resource_id !== binding.workflowId || prior.workflowId !== binding.workflowId || prior.submissionId !== completed.submissionId || (binding.offerRevisionId !== undefined && prior.offerRevisionId !== binding.offerRevisionId)) {
      throw new AppError(409, "docuseal_contract_receipt_conflict", "DocuSeal contract receipt binding conflicts with the stored receipt.")
    }
    return { state: "received", replayed: true }
  }
  // A duplicate delivery of an already-recorded completion is acknowledged as a replay even if the
  // workflow has since moved past contract_sent, so DocuSeal stops retrying.
  const replay = await assertReplay()
  if (replay) return replay
  const workflow = await database.prepare<{ offer_revision_id: string }>("SELECT offer_revision_id FROM mca_contract_workflows WHERE workspace_id=? AND id=? AND state='contract_sent'").get(workspaceId, binding.workflowId)
  if (!workflow || (binding.offerRevisionId && workflow.offer_revision_id !== binding.offerRevisionId)) throw new AppError(409, "docuseal_contract_binding_invalid", "DocuSeal contract binding does not match a sent contract.")
  const metadata = { workflowId: binding.workflowId, submissionId: completed.submissionId, offerRevisionId: workflow.offer_revision_id, bodyHash: createHash("sha256").update(rawBody).digest("hex") }
  const inserted = await database.prepare(`INSERT INTO audit_events(id,workspace_id,actor_user_id,source,action,resource_type,resource_id,metadata,correlation_id,created_at)
    VALUES(?,?,NULL,'system','contract.docuseal_completion_received','mca_contract_workflow',?,?,?,?) ON CONFLICT(id) DO NOTHING RETURNING id`)
    .get(id, workspaceId, binding.workflowId, JSON.stringify(metadata), id, nowIso())
  if (inserted) return { state: "received", replayed: false }
  const raced = await assertReplay()
  if (raced) return raced
  throw new AppError(409, "docuseal_contract_receipt_conflict", "DocuSeal contract receipt binding conflicts with the stored receipt.")
}

import "server-only"

import { createHash } from "node:crypto"
import { createOpaqueToken, hashOpaqueToken } from "../crypto"
import { getDatabase, newId, nowIso, recordAuditEvent } from "../db"
import { AppError } from "../errors"
import { getMembership, listMemberships } from "../memberships"
import type { DealStatus } from "../deals/schema"
import type { MembershipContext } from "../types"
import {
  getIntegration,
  listIntegrations,
  putAttributionToken,
  saveIntegration,
  type IntegrationRecord,
} from "./repository"
import {
  listUsesendDomains,
  parseEmailAddress,
  requirePublicHttpsOrigin,
  verifiedUsesendDomain,
} from "./usesend"

export const INTAKE_PROVIDERS = ["jotform", "highlevel", "fillout", "custom", "zoho", "docuseal", "email"] as const
export type IntakeProvider = (typeof INTAKE_PROVIDERS)[number]
export const EMAIL_GATEWAYS = ["usesend", "postmark", "custom"] as const
export type EmailGateway = (typeof EMAIL_GATEWAYS)[number]
export const ZOHO_CONTRACT_KEY = "zoho_forms_json_drive_v1"
export const ZOHO_ATTACHMENT_METHOD = "google_drive_links_v1"

const zohoDefaultMapping: Record<string, string> = {
  legalName: "legalName", contactEmail: "contactEmail", contactPhone: "contactPhone", ein: "ein",
  "address.state": "state", monthlyRevenue: "monthlyRevenue",
  "owners.0.firstName": "ownerFirstName", "owners.0.lastName": "ownerLastName",
  "owners.0.ownershipPercent": "ownerOwnershipPercent",
}

export interface IntegrationInput {
  id?: string
  provider: IntakeProvider
  displayName: string
  formId?: string
  templateId?: string
  locationId?: string
  inboundAddress?: string
  admissionSecret?: string
  credential?: string
  credentialExpiresAt?: string
  mapping?: Record<string, string>
  allowedHosts?: string[]
  senderRules?: string[]
  assignmentPool?: string[]
  initialStatus?: DealStatus
  automaticProcessing?: boolean
  enabled?: boolean
  customerContractApproved?: boolean
  contractKey?: string
  emailGateway?: EmailGateway
}

export interface IntegrationStatus {
  id: string
  provider: string
  displayName: string
  binding: string | null
  automaticProcessing: boolean
  enabled: boolean
  credential: "configured" | "missing" | "expired"
  credentialVersion: number
  approvalState: IntegrationRecord["approvalState"]
  mapping: Record<string, string>
  allowedHosts: string[]
  senderRules: string[]
  assignmentPool: string[]
  initialStatus: DealStatus
  inboundAddress?: string
  contractKey?: string
  attachmentMethod?: string
  emailGateway?: EmailGateway
  providerServerId?: string
  lastDeliveryAt?: string
  readiness: "local_tested" | "live_unverified" | "live_configured"
  updatedAt: string
}

function assertAdmin(actor: MembershipContext): void {
  if (!actor.role || !["admin", "super_admin"].includes(actor.role)) {
    throw new AppError(403, "permission_denied", "Only workspace administrators can manage intake integrations.")
  }
}

function status(record: IntegrationRecord): IntegrationStatus {
  const binding = record.formId ?? record.templateId ?? record.locationId ?? null
  return {
    id: record.id, provider: record.provider, displayName: record.displayName, binding,
    enabled: record.enabled, automaticProcessing: Boolean(record.automaticProcessing),
    credential: !record.credentialConfigured ? "missing" : record.credentialExpiresAt && record.credentialExpiresAt <= new Date().toISOString() ? "expired" : "configured",
    credentialVersion: record.credentialVersion, approvalState: record.approvalState,
    mapping: record.mapping, allowedHosts: record.allowedHosts, senderRules: record.senderRules,
    assignmentPool: record.assignmentPool, initialStatus: record.initialStatus,
    inboundAddress: record.inboundAddress, updatedAt: record.updatedAt,
    contractKey: record.contractKey, attachmentMethod: record.attachmentMethod,
    emailGateway: record.emailGateway, providerServerId: record.providerServerId,
    readiness: record.provider === "email" && (record.emailGateway === "usesend" || record.emailGateway === "postmark")
      ? record.providerEvidenceHash ? "live_configured" : "live_unverified"
      : record.provider === "zoho" ? "live_unverified" : "local_tested",
  }
}

function cleanHosts(hosts: string[]): string[] {
  return [...new Set(hosts.map((host) => host.trim().toLowerCase()).filter((host) => /^[a-z0-9.-]+$/.test(host) && !host.startsWith(".") && !host.endsWith(".")))]
}

function validateInput(input: IntegrationInput): void {
  const errors: Record<string, string[]> = {}
  if (!INTAKE_PROVIDERS.includes(input.provider)) errors.provider = ["Choose a supported provider."]
  if (!input.displayName?.trim() || input.displayName.length > 120) errors.displayName = ["Enter a name of at most 120 characters."]
  if (["jotform", "fillout", "custom", "zoho"].includes(input.provider) && !input.formId?.trim()) errors.formId = ["Enter the configured form ID."]
  if (input.provider === "docuseal" && !input.templateId?.trim()) errors.templateId = ["Enter the DocuSeal template ID."]
  if (input.provider === "highlevel" && !input.locationId?.trim()) errors.locationId = ["Enter the HighLevel location ID."]
  if (input.provider === "email" && !input.inboundAddress?.match(/^[^@\s]+@[^@\s]+$/)) errors.inboundAddress = ["Configure the actual inbound route address."]
  if (input.emailGateway && input.provider !== "email") errors.emailGateway = ["Email gateway applies only to email intake."]
  if (input.provider === "email" && input.emailGateway !== undefined && !EMAIL_GATEWAYS.includes(input.emailGateway)) {
    errors.emailGateway = ["Choose the useSend, Postmark, or custom email gateway."]
  }
  if (input.credentialExpiresAt && Number.isNaN(Date.parse(input.credentialExpiresAt))) errors.credentialExpiresAt = ["Use an ISO credential expiry date."]
  for (const membershipId of input.assignmentPool ?? []) {
    if (!/^[0-9a-f-]{36}$/i.test(membershipId)) (errors.assignmentPool ??= []).push("Assignment pool contains an invalid member ID.")
  }
  if (Object.keys(errors).length) throw new AppError(422, "integration_validation_failed", "Review the integration settings.", errors)
}

export async function configureIntegration(actor: MembershipContext, input: IntegrationInput): Promise<{ status: IntegrationStatus; admissionSecret?: string }> {
  assertAdmin(actor); validateInput(input)
  const previous = input.id ? await getIntegration(actor.workspaceId, input.id) : undefined
  if (input.id && !previous) throw new AppError(404, "integration_not_found", "The intake integration was not found.")
  if (previous && previous.provider !== input.provider) throw new AppError(409, "provider_change_denied", "Create a new integration to change providers.")
  for (const membershipId of input.assignmentPool ?? previous?.assignmentPool ?? []) {
    const member = await getMembership(actor.workspaceId, membershipId)
    if (member.status !== "active") throw new AppError(422, "inactive_assignee", "Assignment pools may contain only active workspace members.")
  }
  if (input.automaticProcessing !== undefined && typeof input.automaticProcessing !== "boolean") throw new AppError(422, "integration_validation_failed", "Automatic processing must be enabled or disabled.")
  const automaticProcessing = input.automaticProcessing ?? previous?.automaticProcessing ?? false
  if ((automaticProcessing || (input.enabled === true && !previous?.enabled)) && !(input.assignmentPool ?? previous?.assignmentPool)?.length) throw new AppError(422, "assignment_required", "Select a fallback rep or team before enabling automatic processing.")
  const generatedSecret = input.admissionSecret ?? (!previous && input.provider !== "highlevel" ? createOpaqueToken() : undefined)
  const contractKey = input.provider === "zoho" ? input.contractKey ?? previous?.contractKey ?? ZOHO_CONTRACT_KEY : undefined
  const emailGateway = input.provider === "email" ? input.emailGateway ?? previous?.emailGateway ?? "usesend" : undefined
  const hmacSecret = generatedSecret && (input.provider === "docuseal" || emailGateway === "usesend") ? generatedSecret : undefined
  const record = await saveIntegration({
    id: previous?.id ?? newId(), workspaceId: actor.workspaceId, provider: input.provider,
    displayName: input.displayName.trim(), formId: input.formId?.trim(), templateId: input.templateId?.trim(),
    locationId: input.locationId?.trim(), inboundAddress: input.inboundAddress?.trim().toLowerCase(),
    admissionSecretHash: generatedSecret ? hashOpaqueToken(generatedSecret) : previous?.admissionSecretHash,
    signingSecret: hmacSecret,
    credential: input.credential, credentialExpiresAt: input.credentialExpiresAt ?? previous?.credentialExpiresAt,
    automaticProcessing, automaticSince: automaticProcessing ? previous?.automaticSince ?? nowIso() : previous?.automaticSince,
    credentialVersion: previous?.credentialVersion ?? 1,
    mapping: input.provider === "zoho" && (!input.mapping || Object.keys(input.mapping).length === 0)
      ? previous?.mapping && Object.keys(previous.mapping).length ? previous.mapping : zohoDefaultMapping
      : input.mapping ?? previous?.mapping ?? {},
    allowedHosts: input.provider === "zoho" ? ["www.googleapis.com"] : cleanHosts(input.allowedHosts ?? previous?.allowedHosts ?? []),
    senderRules: [...new Set((input.senderRules ?? previous?.senderRules ?? []).map((item) => item.trim().toLowerCase()).filter(Boolean))],
    assignmentPool: [...new Set(input.assignmentPool ?? previous?.assignmentPool ?? [])],
    initialStatus: input.initialStatus ?? previous?.initialStatus ?? "lead", enabled: input.enabled ?? previous?.enabled ?? true,
    approvalState: input.provider === "zoho" && contractKey !== ZOHO_CONTRACT_KEY ? "pending_customer_contract" : "approved",
    contractKey,
    attachmentMethod: input.provider === "zoho" ? ZOHO_ATTACHMENT_METHOD : undefined,
    emailGateway,
    providerServerId: previous?.providerServerId,
    providerEvidenceHash: previous?.providerEvidenceHash,
  })
  await recordAuditEvent({ context: actor, action: previous ? "intake.integration_updated" : "intake.integration_created", resourceType: "intake_integration", resourceId: record.id, metadata: { provider: record.provider, credentialVersion: record.credentialVersion } })
  return { status: status(record), ...(generatedSecret ? { admissionSecret: generatedSecret } : {}) }
}

export async function rotateIntegrationCredentials(actor: MembershipContext, id: string, input: { credential?: string; credentialExpiresAt?: string; admissionSecret?: string }): Promise<{ status: IntegrationStatus; admissionSecret?: string }> {
  assertAdmin(actor)
  const prior = await getIntegration(actor.workspaceId, id, true)
  if (!prior) throw new AppError(404, "integration_not_found", "The intake integration was not found.")
  if (!input.credential && !input.admissionSecret) throw new AppError(422, "rotation_value_missing", "Provide a new read credential or webhook secret.")
  const admissionSecret = input.admissionSecret ?? (prior.provider === "highlevel" ? undefined : createOpaqueToken())
  const next = await saveIntegration({
    ...prior,
    credential: input.credential,
    credentialExpiresAt: input.credentialExpiresAt ?? prior.credentialExpiresAt,
    credentialVersion: prior.credentialVersion + 1,
    admissionSecretHash: admissionSecret ? hashOpaqueToken(admissionSecret) : prior.admissionSecretHash,
    signingSecret: admissionSecret && (prior.provider === "docuseal" || prior.emailGateway === "usesend") ? admissionSecret : undefined,
  })
  await recordAuditEvent({ context: actor, action: "intake.credential_rotated", resourceType: "intake_integration", resourceId: id, metadata: { provider: prior.provider, credentialVersion: next.credentialVersion } })
  return { status: status(next), ...(admissionSecret ? { admissionSecret } : {}) }
}

export async function listIntegrationStatuses(actor: MembershipContext): Promise<IntegrationStatus[]> {
  assertAdmin(actor)
  const deliveries = await getDatabase().prepare<{ integration_id: string; received_at: string }>("SELECT integration_id,MAX(created_at) received_at FROM intake_events WHERE workspace_id=? AND deal_id IS NOT NULL GROUP BY integration_id").all(actor.workspaceId)
  return (await listIntegrations(actor.workspaceId)).map(record => ({ ...status(record), lastDeliveryAt: deliveries.find(d => d.integration_id === record.id)?.received_at }))
}

type PostmarkServer = { ID?: number; Name?: string; InboundHash?: string; InboundAddress?: string }

export interface ProvisionPostmarkInput {
  integrationId?: string
  accountToken: string
  serverId?: string
  createServer?: boolean
  serverName: string
  displayName: string
  publicOrigin: string
  senderRules?: string[]
  assignmentPool?: string[]
  initialStatus?: DealStatus
}

function postmarkOrigin(value: string): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new AppError(422, "postmark_origin_invalid", "Enter the public HTTPS application origin.") }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || /^(localhost|127\.|0\.|\[?::1\]?$)/i.test(url.hostname) || url.hostname.endsWith(".localhost")) {
    throw new AppError(422, "postmark_origin_invalid", "Postmark requires a deployed public HTTPS application origin.")
  }
  return url
}

async function postmarkRequest(fetchImpl: typeof fetch, token: string, path: string, init?: RequestInit): Promise<PostmarkServer> {
  const response = await fetchImpl(`https://api.postmarkapp.com${path}`, {
    ...init,
    headers: { "content-type": "application/json", accept: "application/json", "x-postmark-account-token": token, ...(init?.headers ?? {}) },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  })
  if (response.status === 401 || response.status === 403) throw new AppError(503, "postmark_account_rejected", "Postmark rejected the account token.")
  if (!response.ok) throw new AppError(502, "postmark_setup_failed", `Postmark server setup returned HTTP ${response.status}.`)
  const body = await response.json().catch(() => undefined)
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppError(502, "postmark_response_invalid", "Postmark returned an invalid server response.")
  return body as PostmarkServer
}

export async function provisionPostmarkIntegration(
  actor: MembershipContext,
  input: ProvisionPostmarkInput,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: IntegrationStatus; admissionSecret: string }> {
  assertAdmin(actor)
  const accountToken = input.accountToken?.trim()
  const serverName = input.serverName?.trim()
  if (!accountToken) throw new AppError(422, "postmark_account_token_required", "Enter a Postmark account token.")
  if (!serverName || serverName.length > 100) throw new AppError(422, "postmark_server_name_invalid", "Enter the exact Postmark server name, at most 100 characters.")
  if (!input.displayName?.trim() || input.displayName.length > 120) throw new AppError(422, "integration_validation_failed", "Enter a connection name of at most 120 characters.")
  const origin = postmarkOrigin(input.publicOrigin)
  for (const membershipId of input.assignmentPool ?? []) {
    const member = await getMembership(actor.workspaceId, membershipId)
    if (member.status !== "active") throw new AppError(422, "inactive_assignee", "Assignment pools may contain only active workspace members.")
  }
  const previous = input.integrationId ? await getIntegration(actor.workspaceId, input.integrationId) : undefined
  if (input.integrationId && (!previous || previous.provider !== "email" || previous.emailGateway !== "postmark")) {
    throw new AppError(404, "postmark_integration_not_found", "The Postmark intake integration was not found.")
  }
  const requestedServerId = input.serverId?.trim() || previous?.providerServerId
  let server: PostmarkServer
  if (requestedServerId) {
    if (!/^\d{1,20}$/.test(requestedServerId)) throw new AppError(422, "postmark_server_id_invalid", "Postmark server ID must be numeric.")
    server = await postmarkRequest(fetchImpl, accountToken, `/servers/${requestedServerId}`, { method: "GET" })
    if (server.Name !== serverName) throw new AppError(409, "postmark_server_mismatch", "The Postmark server name does not match the expected workspace server.")
  } else {
    if (!input.createServer) throw new AppError(422, "postmark_server_required", "Choose an existing Postmark server or explicitly create one.")
    server = await postmarkRequest(fetchImpl, accountToken, "/servers", { method: "POST", body: JSON.stringify({ Name: serverName }) })
  }
  const serverId = String(server.ID ?? requestedServerId ?? "")
  if (!/^\d{1,20}$/.test(serverId)) throw new AppError(502, "postmark_response_invalid", "Postmark did not return a valid server ID.")
  const inboundAddress = typeof server.InboundAddress === "string" && /^[^@\s]+@inbound\.postmarkapp\.com$/i.test(server.InboundAddress)
    ? server.InboundAddress.toLowerCase()
    : typeof server.InboundHash === "string" && /^[A-Za-z0-9]+$/.test(server.InboundHash)
      ? `${server.InboundHash}@inbound.postmarkapp.com`.toLowerCase() : undefined
  if (!inboundAddress) throw new AppError(502, "postmark_response_invalid", "Postmark did not return its provider-issued inbound address.")

  const integrationId = previous?.id ?? newId()
  const admissionSecret = createOpaqueToken()
  const hook = new URL(`/api/mca/intake/email/${integrationId}`, origin)
  hook.username = "mca"; hook.password = admissionSecret
  await postmarkRequest(fetchImpl, accountToken, `/servers/${serverId}`, {
    method: "PUT", body: JSON.stringify({ Name: serverName, InboundHookUrl: hook.toString() }),
  })
  const evidence = createHash("sha256").update(`${serverId}\0${serverName}\0${inboundAddress}`).digest("hex")
  const record = await saveIntegration({
    id: integrationId, workspaceId: actor.workspaceId, provider: "email", displayName: input.displayName.trim(),
    admissionSecretHash: hashOpaqueToken(admissionSecret), credentialVersion: (previous?.credentialVersion ?? 0) + 1,
    mapping: {}, allowedHosts: [], senderRules: [...new Set((input.senderRules ?? previous?.senderRules ?? []).map((item) => item.trim().toLowerCase()).filter(Boolean))],
    assignmentPool: [...new Set(input.assignmentPool ?? previous?.assignmentPool ?? [])], initialStatus: input.initialStatus ?? previous?.initialStatus ?? "lead",
    inboundAddress, enabled: true, approvalState: "approved", emailGateway: "postmark", providerServerId: serverId,
    providerEvidenceHash: evidence,
  })
  await recordAuditEvent({ context: actor, action: previous ? "intake.postmark_reconfigured" : "intake.postmark_provisioned", resourceType: "intake_integration", resourceId: record.id, metadata: { provider: "postmark", serverId, evidence }, correlationId: newId() })
  return { status: status(record), admissionSecret }
}

export interface ProvisionUsesendInput {
  integrationId?: string
  apiKey: string
  inboundAddress: string
  fromAddress: string
  displayName: string
  publicOrigin: string
  senderRules?: string[]
  assignmentPool?: string[]
  initialStatus?: DealStatus
}

export async function provisionUsesendIntegration(
  actor: MembershipContext,
  input: ProvisionUsesendInput,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: IntegrationStatus; admissionSecret: string; webhookUrl: string }> {
  assertAdmin(actor)
  const apiKey = input.apiKey?.trim()
  const inboundAddress = parseEmailAddress(input.inboundAddress)
  const fromAddress = parseEmailAddress(input.fromAddress) ? input.fromAddress.trim() : undefined
  if (!apiKey) throw new AppError(422, "usesend_api_key_required", "Enter a useSend API key.")
  if (!inboundAddress) throw new AppError(422, "usesend_inbound_address_invalid", "Enter the actual workspace intake address that will receive forwarded mail.")
  if (!fromAddress) throw new AppError(422, "usesend_from_invalid", "Enter a receipt From address on a verified useSend domain.")
  if (!input.displayName?.trim() || input.displayName.length > 120) throw new AppError(422, "integration_validation_failed", "Enter a connection name of at most 120 characters.")
  const origin = requirePublicHttpsOrigin(input.publicOrigin)
  for (const membershipId of input.assignmentPool ?? []) {
    const member = await getMembership(actor.workspaceId, membershipId)
    if (member.status !== "active") throw new AppError(422, "inactive_assignee", "Assignment pools may contain only active workspace members.")
  }
  const previous = input.integrationId ? await getIntegration(actor.workspaceId, input.integrationId) : undefined
  if (input.integrationId && (!previous || previous.provider !== "email" || previous.emailGateway !== "usesend")) {
    throw new AppError(404, "usesend_integration_not_found", "The useSend intake integration was not found.")
  }
  const domain = verifiedUsesendDomain(await listUsesendDomains(apiKey, fetchImpl), fromAddress)
  const integrationId = previous?.id ?? newId()
  const admissionSecret = createOpaqueToken()
  const webhookUrl = new URL(`/api/mca/intake/email/${integrationId}`, origin).toString()
  const evidence = createHash("sha256").update(`${domain.id}\0${domain.name}\0${inboundAddress}\0${parseEmailAddress(fromAddress)}`).digest("hex")
  const record = await saveIntegration({
    id: integrationId, workspaceId: actor.workspaceId, provider: "email", displayName: input.displayName.trim(),
    admissionSecretHash: hashOpaqueToken(admissionSecret), signingSecret: admissionSecret, credential: apiKey,
    credentialVersion: (previous?.credentialVersion ?? 0) + 1, mapping: { ...(previous?.mapping ?? {}), fromAddress },
    allowedHosts: [], senderRules: [...new Set((input.senderRules ?? previous?.senderRules ?? []).map((item) => item.trim().toLowerCase()).filter(Boolean))],
    assignmentPool: [...new Set(input.assignmentPool ?? previous?.assignmentPool ?? [])],
    initialStatus: input.initialStatus ?? previous?.initialStatus ?? "lead", inboundAddress, enabled: true,
    approvalState: "approved", emailGateway: "usesend", providerServerId: String(domain.id), providerEvidenceHash: evidence,
  })
  await recordAuditEvent({
    context: actor, action: previous ? "intake.usesend_reconfigured" : "intake.usesend_provisioned",
    resourceType: "intake_integration", resourceId: record.id,
    metadata: { provider: "usesend", domainId: domain.id, domainName: domain.name, evidence },
    correlationId: newId(),
  })
  return { status: status(record), admissionSecret, webhookUrl }
}

export async function createJotformRepLink(actor: MembershipContext, integrationId: string, membershipId: string, appOrigin: string): Promise<{ token: string; url: string; membershipId: string; formId: string }> {
  assertAdmin(actor)
  const integration = await getIntegration(actor.workspaceId, integrationId)
  if (!integration || integration.provider !== "jotform" || !integration.formId) throw new AppError(404, "jotform_integration_not_found", "Choose a configured Jotform integration.")
  const member = await getMembership(actor.workspaceId, membershipId)
  if (member.status !== "active") throw new AppError(422, "inactive_rep", "Create links only for active workspace members.")
  const token = createOpaqueToken()
  await putAttributionToken({ workspaceId: actor.workspaceId, integrationId, membershipId, tokenHash: hashOpaqueToken(token) })
  const url = new URL(`/apply/${encodeURIComponent(integration.formId)}`, appOrigin)
  url.searchParams.set("mca_rep", token)
  await recordAuditEvent({ context: actor, action: "intake.rep_link_rotated", resourceType: "intake_integration", resourceId: integrationId, metadata: { membershipId } })
  return { token, url: url.toString(), membershipId, formId: integration.formId }
}

export async function listEligibleRepLinks(actor: MembershipContext): Promise<Array<{ membershipId: string; name: string }>> {
  assertAdmin(actor)
  return (await listMemberships(actor.workspaceId)).filter((member) => member.status === "active").map((member) => ({ membershipId: member.id, name: member.name }))
}

import "server-only"

import { z } from "zod"
import { createHash } from "node:crypto"
import { encryptSensitive, decryptSensitive } from "../crypto"
import { backgroundJobView, enqueueBackgroundJob, inBackgroundWorker } from "../jobs/queue"
import { documentScanner } from "../documents/scanner"
import { usesSupabaseStorage } from "../documents/storage"
import { withImmediateTransaction } from "../db"
import { AppError } from "../errors"
import { actorForDeals } from "../deals/service"
import type { DealActor, DealWriteInput } from "../deals/schema"
import type { AuthContext } from "../types"
import type { ApplicationExtraction } from "../documents/contracts"
import { extractApplication } from "../documents/extraction"
import { verifyProviderAdmission } from "./providers"
import {
  findIntake,
  getIntegration,
  saveEmailSource,
  saveEmailApplication,
  upsertAttachmentJob,
  updateAttachmentJob,
  claimReceipt,
  completeReceipt,
  enqueueReceipt,
  findIntegrationByPublicId,
  listPendingReceipts,
  listAttachmentJobs,
  reserveIntake,
  updateIntake,
  type ReceiptRecord,
  type IntegrationRecord,
} from "./repository"
import { attachIntakeDocument, ingestApplication, intakePayloadChecksum, scheduleAttachment } from "./service"
import type { IntakeResult, NormalizedIntakeInput } from "./contracts"
import { receiptEmailContent, sendUsesendEmail, usesendInboundEmail } from "./usesend"

interface InboundAttachment {
  id?: string
  filename?: string
  mimeType?: string
  base64?: string
  url?: string
  disposition?: string
  contentId?: string
  declaredLength?: number
  strictBase64?: boolean
  category?: "statement" | "application" | "driver_license" | "voided_check" | "closing_document" | "other_stip"
}

interface InboundEmail {
  messageId?: string
  to?: string
  from?: string
  subject?: string
  text?: string
  forwardingConfirmation?: boolean
  forwardingConfirmationReview?: boolean
  application?: DealWriteInput
  attachments?: InboundAttachment[]
}

const inboundEmailSchema = z.object({
  messageId: z.string().max(200).optional(), to: z.string().optional(), from: z.string().optional(),
  subject: z.string().optional(), text: z.string().optional(), forwardingConfirmation: z.boolean().optional(),
  forwardingConfirmationReview: z.boolean().optional(), application: z.record(z.string(), z.unknown()).optional(),
  attachments: z.array(z.object({
    id: z.string().max(200).optional(), filename: z.string().max(500).optional(), mimeType: z.string().max(200).optional(),
    base64: z.string().optional(), url: z.url().optional(), disposition: z.string().optional(), contentId: z.string().optional(),
    declaredLength: z.number().int().nonnegative().optional(), strictBase64: z.boolean().optional(),
    category: z.enum(["statement", "application", "driver_license", "voided_check", "closing_document", "other_stip"]).optional(),
  })).max(100).optional(),
})

export async function readInboundEmailBody(request: Request, maxBytes = 35 * 1024 * 1024): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? 0)
  if (Number.isFinite(declared) && declared > maxBytes) throw new AppError(413, "email_payload_too_large", "Inbound email payload exceeds the request limit.")
  if (!request.body) return ""
  const reader = request.body.getReader()
  const decoder = new TextDecoder()
  let received = 0; let body = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > maxBytes) {
      await reader.cancel()
      throw new AppError(413, "email_payload_too_large", "Inbound email payload exceeds the request limit.")
    }
    body += decoder.decode(value, { stream: true })
  }
  return body + decoder.decode()
}

async function actorForEmail(workspaceId: string): Promise<DealActor> {
  const context: AuthContext = { authType: "api_key", userId: null, membershipId: null, workspaceId, role: null, scopes: ["intake:write"], sessionId: null }
  return { ...await actorForDeals(context), source: "system", role: "admin" }
}

function parseObject(rawBody: string): Record<string, unknown> {
  try {
    const value = JSON.parse(rawBody)
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error()
    return value as Record<string, unknown>
  } catch {
    throw new AppError(400, "email_payload_invalid", "Inbound email body must be valid JSON.")
  }
}

function postmarkEmail(payload: Record<string, unknown>): InboundEmail {
  const from = payload.FromFull && typeof payload.FromFull === "object" && !Array.isArray(payload.FromFull)
    ? (payload.FromFull as Record<string, unknown>).Email : undefined
  const headers = Array.isArray(payload.Headers) ? payload.Headers : []
  const originalMessageIdCandidate = headers.flatMap((header) => {
    if (!header || typeof header !== "object" || Array.isArray(header)) return []
    const item = header as Record<string, unknown>
    return typeof item.Name === "string" && item.Name.toLowerCase() === "message-id" && typeof item.Value === "string"
      ? [item.Value.trim()] : []
  }).find(Boolean)
  const originalMessageId = originalMessageIdCandidate && originalMessageIdCandidate.length <= 200
    && /^<[^<>\s@]+@[^<>\s@]+>$/.test(originalMessageIdCandidate) ? originalMessageIdCandidate : undefined
  const postmarkId = typeof payload.MessageID === "string" ? payload.MessageID.trim() : ""
  const subject = typeof payload.Subject === "string" ? payload.Subject : ""
  const textBody = typeof payload.TextBody === "string" ? payload.TextBody : ""
  const messageId = originalMessageId || postmarkId
  const attachments: InboundAttachment[] = (Array.isArray(payload.Attachments) ? payload.Attachments : []).map((entry, index) => {
    const item = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, unknown> : {}
    return {
      id: createHash("sha256").update(`${messageId}\0${index}`).digest("hex"),
      filename: typeof item.Name === "string" ? item.Name : undefined,
      mimeType: typeof item.ContentType === "string" ? item.ContentType : undefined,
      base64: typeof item.Content === "string" ? item.Content : undefined,
      contentId: typeof item.ContentID === "string" ? item.ContentID : undefined,
      declaredLength: typeof item.ContentLength === "number" ? item.ContentLength : undefined,
      strictBase64: true,
    }
  })
  return {
    messageId,
    to: typeof payload.OriginalRecipient === "string" ? payload.OriginalRecipient : undefined,
    from: typeof from === "string" ? from : undefined,
    subject,
    text: textBody,
    forwardingConfirmationReview: /forwarding confirmation|confirm forwarding/i.test(`${subject}\n${textBody}`),
    attachments,
  }
}

function senderAllowed(sender: string, rules: string[]): boolean {
  if (!rules.length) return true
  const normalized = sender.trim().toLowerCase()
  const domain = normalized.split("@")[1]
  return rules.some((rule) => rule === normalized || (rule.startsWith("@") && domain === rule.slice(1)) || rule === domain)
}

// Only explicit, unambiguous field labels are accepted; free prose stays in review.
function applicationFromText(text: string | undefined): DealWriteInput {
  if (!text) return {}
  const names = [...text.matchAll(/^(?:legal (?:business )?name|business name|company name)\s*:\s*(.+)$/gim)].map((match) => match[1].trim())
  if (new Set(names).size !== 1) return {}
  const field = (label: string) => new RegExp(`^(?:${label})\\s*:\\s*(.+)$`, "im").exec(text)?.[1].trim()
  const email = field("contact email|merchant email")
  const phone = field("contact phone|merchant phone")
  return { legalName: names[0], ...(email && /^[^@\s]+@[^@\s]+$/.test(email) ? { contactEmail: email } : {}), ...(phone ? { contactPhone: phone } : {}) }
}

function isSignatureGraphic(file: InboundAttachment): boolean {
  return Boolean((file.disposition === "inline" || file.contentId) && file.mimeType?.startsWith("image/"))
}

function decodeAttachment(file: InboundAttachment): Uint8Array | undefined {
  if (!file.base64) return undefined
  const encoded = file.strictBase64 ? file.base64 : file.base64.replace(/\s/g, "")
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0
  let valid = encoded.length > 0 && encoded.length % 4 === 0
  for (let index = 0; valid && index < encoded.length - padding; index += 1) {
    const code = encoded.charCodeAt(index)
    valid = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 43 || code === 47
  }
  for (let index = encoded.length - padding; valid && index < encoded.length; index += 1) valid = encoded[index] === "="
  if (!valid) {
    throw new AppError(422, "email_attachment_invalid", "An inbound attachment is not valid base64.")
  }
  const bytes = Buffer.from(encoded, "base64")
  if (!bytes.length || bytes.length > 25 * 1024 * 1024) throw new AppError(413, "email_attachment_too_large", "Inbound attachments must be at most 25 MiB.")
  if (file.strictBase64 && bytes.toString("base64") !== encoded) throw new AppError(422, "email_attachment_invalid", "An inbound attachment is not canonical base64.")
  if (file.declaredLength !== undefined && (!Number.isSafeInteger(file.declaredLength) || file.declaredLength < 0 || file.declaredLength !== bytes.length)) {
    throw new AppError(422, "email_attachment_size_mismatch", "An inbound attachment does not match its declared ContentLength.")
  }
  return bytes
}

export async function ingestEmailDelivery(input: {
  integrationId: string
  request: Request
  rawBody: string
  appOrigin: string
  extractor?: (actor: DealActor, file: { filename: string; mimeType: string; bytes: Uint8Array; sourceReference: string }) => Promise<ApplicationExtraction>
}): Promise<IntakeResult> {
  const { integration, email } = await admittedEmail(input)
  return processEmail(email, integration, input)
}

async function admittedEmail(input: Parameters<typeof ingestEmailDelivery>[0]) {
  const integration = await findIntegrationByPublicId(input.integrationId, true)
  if (!integration || integration.provider !== "email") throw new AppError(404, "integration_not_found", "The email intake route was not found.")
  verifyProviderAdmission(input.request, input.rawBody, integration)
  if (Buffer.byteLength(input.rawBody) > 35 * 1024 * 1024) throw new AppError(413, "email_payload_too_large", "Inbound email payloads must be at most 35 MiB.")
  const payload = parseObject(input.rawBody)
  const normalized = integration.emailGateway === "usesend"
    ? usesendInboundEmail(payload, integration.inboundAddress ?? "")
    : integration.emailGateway === "postmark" ? postmarkEmail(payload) : payload
  const parsed = inboundEmailSchema.safeParse(normalized)
  if (!parsed.success) throw new AppError(422, "email_payload_invalid", "Review the inbound email fields.", z.flattenError(parsed.error).fieldErrors)
  const email = parsed.data as InboundEmail
  return { integration, email }
}

export async function queueInboundEmail(input: Parameters<typeof ingestEmailDelivery>[0]) {
  const { integration, email } = await admittedEmail(input)
  if (!email.messageId?.trim()) throw new AppError(422, "email_message_id_missing", "Inbound email message identity is required.")
  const actor = await actorForEmail(integration.workspaceId)
  const normalized = JSON.stringify(email)
  return backgroundJobView(await enqueueBackgroundJob({ actor, kind: "email_intake", resourceId: input.integrationId,
    idempotencyKey: `${input.integrationId}:${createHash("sha256").update(email.messageId).digest("hex")}`,
    payload: { emailCipher: encryptSensitive(normalized, actor.workspaceId), appOrigin: input.appOrigin }, payloadHash: createHash("sha256").update(normalized).digest("hex") }))
}

export async function processQueuedEmail(actor: DealActor, integrationId: string, payload: { emailCipher: string; appOrigin: string }): Promise<IntakeResult> {
  const integration = await findIntegrationByPublicId(integrationId, true)
  if (!integration || !integration.enabled || integration.workspaceId !== actor.workspaceId || integration.provider !== "email") throw new AppError(403, "integration_disabled", "The original email integration is no longer available.")
  return processEmail(JSON.parse(decryptSensitive(payload.emailCipher, actor.workspaceId)) as InboundEmail, integration, { appOrigin: payload.appOrigin })
}

type EmailProcessingOptions = Pick<Parameters<typeof ingestEmailDelivery>[0], "appOrigin" | "extractor"> & { reviewedApplication?: DealWriteInput }

export async function replayEmailIntake(actor: DealActor, intakeId: string, options: EmailProcessingOptions): Promise<IntakeResult> {
  if (actor.role !== "admin" && actor.role !== "super_admin") throw new AppError(403, "permission_denied", "Only administrators can replay private email intake.")
  const record = await findIntake(actor.workspaceId, intakeId)
  if (!record?.emailSource || !record.integrationId) throw new AppError(409, "email_source_unavailable", "This older intake has no retained email. Redeliver the original email from your provider.")
  const integration = await getIntegration(actor.workspaceId, record.integrationId)
  if (!integration?.enabled) throw new AppError(409, "integration_disabled", "Enable the original email integration before retrying.")
  return processEmail(JSON.parse(record.emailSource) as InboundEmail, integration, options)
}

async function processEmail(email: InboundEmail, integration: IntegrationRecord, input: EmailProcessingOptions): Promise<IntakeResult> {
  const messageId = email.messageId?.trim()
  if (!messageId || messageId.length > 200) throw new AppError(422, "email_message_id_missing", "Inbound email message identity is required and must be at most 200 characters.")
  if (email.to?.trim().toLowerCase() !== integration.inboundAddress) throw new AppError(422, "email_route_mismatch", "Inbound email address does not match this configured route.")
  const sender = email.from?.trim().toLowerCase() ?? ""
  if (!/^[^@\s]+@[^@\s]+$/.test(sender)) throw new AppError(422, "email_sender_invalid", "A valid sender email is required.")
  const actor = await actorForEmail(integration.workspaceId)
  const genuine = (email.attachments ?? []).filter((file) => !isSignatureGraphic(file))
  const decoded = new Map<InboundAttachment, Uint8Array>()
  let aggregateBytes = 0
  for (const file of genuine) {
    const bytes = decodeAttachment(file)
    if (!bytes) continue
    aggregateBytes += bytes.length
    if (aggregateBytes > 25 * 1024 * 1024) throw new AppError(413, "email_attachments_too_large", "Decoded inbound attachments must total at most 25 MiB.")
    decoded.set(file, bytes)
  }
  if (usesSupabaseStorage()) {
    if (!inBackgroundWorker()) throw new AppError(503, "email_worker_required", "Email processing must run on the background worker.")
    for (const [file, bytes] of decoded) {
      const result = await documentScanner().scan(bytes, file.filename ?? "attachment")
      if (result.status === "infected") throw new AppError(422, "email_attachment_quarantined", "Security scanning rejected an email attachment.")
      if (result.status !== "clean") throw new AppError(503, "scanner_unavailable", "Email attachments must pass security scanning before processing.")
    }
  }
  return withImmediateTransaction(async () => {
    const initial: NormalizedIntakeInput = { schemaVersion: 1, provider: "email", eventId: messageId, application: {}, sourceReference: `email:message:${messageId}`, initialStatus: integration.initialStatus }
    const reserved = await reserveIntake(actor.workspaceId, initial, intakePayloadChecksum(initial), integration.id)
    const prior = reserved.record
    const source = JSON.stringify(email)
    const sourceChecksum = createHash("sha256").update(source).digest("hex")
    if (prior.integrationId && prior.integrationId !== integration.id) throw new AppError(409, "email_integration_conflict", "This message belongs to a different intake route.")
    if (prior.emailSourceChecksum && prior.emailSourceChecksum !== sourceChecksum) throw new AppError(409, "intake_event_conflict", "This email identity was already used for different content.")
    await saveEmailSource(actor.workspaceId, prior.intakeId, source, sourceChecksum)
    const recordError = async (code: string, message: string): Promise<IntakeResult> => {
      if (prior.dealId) return { intakeId: prior.intakeId, dealId: prior.dealId, created: false, state: prior.state, warnings: prior.warnings }
      const failed = await updateIntake({ workspaceId: actor.workspaceId, intakeId: prior.intakeId, state: "error", errorCode: code, errorMessage: message, warnings: ["Review the email intake and retry when the issue is resolved."] })
      return { intakeId: failed.intakeId, dealId: null, created: false, state: "error", warnings: failed.warnings }
    }
    if (!senderAllowed(sender, integration.senderRules)) return recordError("sender_not_allowed", "The sender is not permitted by this intake route.")
    if (email.forwardingConfirmationReview || email.forwardingConfirmation) return recordError("forwarding_confirmation_review", "A forwarding-confirmation message requires review in the source mailbox; MCA does not follow links automatically.")
  const applicationFile = genuine.find((file) => file.mimeType === "application/pdf" && (file.category === "application" || /application/i.test(file.filename ?? "")))
  let application: DealWriteInput = prior.dealId ? prior.application : input.reviewedApplication ?? email.application ?? applicationFromText(email.text)
  const warnings: string[] = [...prior.warnings.filter((warning) => !warning.startsWith("Review the email intake") && !warning.includes("could not be stored") && !warning.startsWith("Attachments pending:"))]
  if (applicationFile && !prior.dealId && !input.reviewedApplication) {
    const bytes = decoded.get(applicationFile)
    if (bytes) {
      try {
        const extraction = await (input.extractor ?? extractApplication)(actor, {
          filename: applicationFile.filename ?? "application.pdf",
          mimeType: "application/pdf",
          bytes,
          sourceReference: `email:${messageId}:${applicationFile.id ?? "application"}`,
        })
        application = { ...extraction.fields, ...application }
        warnings.push(...extraction.warnings)
        if (Object.values(extraction.evidence).some((evidence) => evidence.unknown || evidence.confidence < 0.8)) {
          return recordError("email_extraction_uncertain", "Extraction contains uncertain fields. Review the source application before retrying.")
        }
      } catch (error) {
        const code = error instanceof AppError ? error.code : "email_extraction_failed"
        const message = "Application extraction failed. Check the extraction provider configuration and retry."
        return recordError(code, message)
      }
    }
  }
  if (!Object.keys(application).length) return recordError("email_extraction_required", "No structured application or extractable application PDF was found.")

  if (input.reviewedApplication && !prior.dealId) { application.fieldSource = "manual"; warnings.push("Created from administrator review. Complete remaining application fields on the deal.") }
  const eligible = integration.assignmentPool.filter((id) => actor.activeMembershipIds.includes(id))
  if (eligible.length && !prior.dealId) {
    const index = createHash("sha256").update(messageId).digest().readUInt32BE(0) % eligible.length
    application = { ...application, assignments: [{ membershipId: eligible[index], kind: "originator", isPrimary: true }] }
  }
  const normalized: NormalizedIntakeInput = { ...initial, application, initialStatus: prior.dealId ? prior.initialStatus : integration.initialStatus }
  if (!prior.dealId) await saveEmailApplication(actor.workspaceId, prior.intakeId, normalized, intakePayloadChecksum(normalized))
  let result: IntakeResult
  try { result = await ingestApplication(actor, normalized) }
  catch (error) { return recordError(error instanceof AppError ? error.code : "email_application_invalid", "The extracted application could not be saved. Review its fields and retry.") }
  for (const [index, file] of genuine.entries()) {
    const attachmentId = file.id ?? createHash("sha256").update(`${messageId}\0${index}\0${file.filename ?? ""}`).digest("hex").slice(0, 24)
    const filename = file.filename ?? `attachment-${index + 1}`
    const mimeType = file.mimeType ?? "application/octet-stream"
    const category = file.category ?? (file === applicationFile ? "application" : /statement/i.test(filename) ? "statement" : /void.*check/i.test(filename) ? "voided_check" : /driver.*licen[cs]e/i.test(filename) ? "driver_license" : "other_stip")
    const bytes = decoded.get(file)
    if (bytes && result.dealId) {
      const job = await upsertAttachmentJob({ workspaceId: actor.workspaceId, intakeId: result.intakeId, attachmentId, filename, mimeType, category })
      try { await attachIntakeDocument(actor, { intakeId: result.intakeId, attachmentId, filename, mimeType, bytes, category }) }
      catch { await updateAttachmentJob(actor.workspaceId, job.id, { state: "failed", lastError: "Could not store attachment. Replay the email intake to retry." }); warnings.push("An attachment could not be stored. Replay the email intake to retry.") }
    } else if (file.url && result.dealId) {
      await scheduleAttachment({ actor, intakeId: result.intakeId, attachmentId, sourceUrl: file.url, filename, mimeType, category })
    }
  }
  warnings.push(...result.warnings.filter((warning) => !warning.includes("could not be stored") && !warning.startsWith("Attachments pending:")))
  if (result.dealId && sender) {
    await enqueueReceipt({
      workspaceId: actor.workspaceId, intakeId: result.intakeId, recipient: sender,
      dealLink: `${input.appOrigin.replace(/\/$/, "")}/deals?deal=${result.dealId}`,
      addDocumentLink: `${input.appOrigin.replace(/\/$/, "")}/deals?deal=${result.dealId}&addDocument=1`,
      warnings: [...result.warnings, ...warnings],
    })
  }
  const uniqueWarnings = [...new Set(warnings)]
  const pendingFiles = (await listAttachmentJobs(actor.workspaceId, result.intakeId)).some((job) => job.state !== "stored")
  const final = await updateIntake({ workspaceId: actor.workspaceId, intakeId: result.intakeId, state: pendingFiles ? "file_pending" : "created", warnings: uniqueWarnings })
  return { ...result, state: final.state, warnings: uniqueWarnings }
  })
}

async function usesendReceiptTransport(workspaceId: string, intakeId: string): Promise<{ apiKey: string; from: string } | undefined> {
  const intake = await findIntake(workspaceId, intakeId)
  const integration = intake?.integrationId ? await getIntegration(workspaceId, intake.integrationId, true) : undefined
  if (integration?.emailGateway === "usesend") {
    const apiKey = integration.credential?.trim() || process.env.MCA_USESEND_API_KEY?.trim()
    const from = integration.mapping.fromAddress?.trim() || process.env.MCA_USESEND_FROM?.trim()
    if (!apiKey || !from) throw new AppError(503, "usesend_receipt_unconfigured", "Configure a useSend API key and verified From address before sending intake receipts.")
    return { apiKey, from }
  }
  const envKey = process.env.MCA_USESEND_API_KEY?.trim()
  const envFrom = process.env.MCA_USESEND_FROM?.trim()
  if (envKey && envFrom && !process.env.MCA_INTAKE_RECEIPT_WEBHOOK_URL) return { apiKey: envKey, from: envFrom }
  return undefined
}

export async function deliverPendingReceipts(options: { workspaceId?: string; fetchImpl?: typeof fetch } = {}): Promise<ReceiptRecord[]> {
  const endpoint = process.env.MCA_INTAKE_RECEIPT_WEBHOOK_URL
  const results: ReceiptRecord[] = []
  let unconfigured = 0
  for (const receipt of await listPendingReceipts(options.workspaceId)) {
    const usesend = await usesendReceiptTransport(receipt.workspaceId, receipt.intakeId)
    if (!usesend && !endpoint) {
      unconfigured += 1
      continue
    }
    const claim = await claimReceipt(receipt.workspaceId, receipt.id)
    if (!claim.acquired || !claim.receipt.leaseToken) continue
    const claimed = claim.receipt
    const leaseToken = claimed.leaseToken!
    try {
      if (usesend) {
        const content = receiptEmailContent({ dealLink: claimed.dealLink, addDocumentLink: claimed.addDocumentLink, warnings: claimed.warnings })
        const sent = await sendUsesendEmail({
          apiKey: usesend.apiKey, from: usesend.from, to: claimed.recipient, subject: content.subject, text: content.text, html: content.html,
          idempotencyKey: `intake-receipt:${claimed.id}`, fetchImpl: options.fetchImpl,
        })
        results.push((await completeReceipt(claimed.workspaceId, claimed.id, leaseToken, { state: "sent", providerMessageId: sent.emailId })).receipt)
        continue
      }
      const response = await (options.fetchImpl ?? fetch)(endpoint!, {
        method: "POST", headers: { "content-type": "application/json", "idempotency-key": `intake-receipt:${claimed.id}`, ...(process.env.MCA_INTAKE_RECEIPT_WEBHOOK_TOKEN ? { authorization: `Bearer ${process.env.MCA_INTAKE_RECEIPT_WEBHOOK_TOKEN}` } : {}) },
        body: JSON.stringify({ template: "intake_receipt", recipient: claimed.recipient, dealLink: claimed.dealLink, addDocumentLink: claimed.addDocumentLink, warnings: claimed.warnings }),
        signal: AbortSignal.timeout(10_000), redirect: "error",
      })
      if (!response.ok) throw new Error(`Receipt provider returned HTTP ${response.status}.`)
      const body = await response.json().catch(() => ({})) as { id?: string }
      results.push((await completeReceipt(claimed.workspaceId, claimed.id, leaseToken, { state: "sent", providerMessageId: body.id })).receipt)
    } catch (error) {
      if (error instanceof AppError && error.code === "receipt_delivery_unconfigured") throw error
      if (error instanceof AppError && error.code === "usesend_receipt_unconfigured") throw error
      results.push((await completeReceipt(claimed.workspaceId, claimed.id, leaseToken, { state: "failed", lastError: error instanceof Error ? error.message.slice(0, 300) : "Receipt delivery failed." })).receipt)
    }
  }
  if (!results.length && unconfigured) throw new AppError(503, "receipt_delivery_unconfigured", "Configure useSend or MCA_INTAKE_RECEIPT_WEBHOOK_URL before sending intake receipts.")
  return results
}

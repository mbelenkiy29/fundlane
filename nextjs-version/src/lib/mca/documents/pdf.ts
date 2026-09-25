import "server-only"

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib"
import { AppError } from "../errors"
import { newId, nowIso, recordAuditEvent } from "../db"
import { getDealForDocument } from "../deals/service"
import type { DealActor, DealOwner, DealRecord } from "../deals/schema"
import type { DocumentSummary } from "./contracts"
import { getDocument, storeDocument } from "./service"
import {
  findPdfGenerationByKey,
  insertPdfAuthorization,
  insertPdfGeneration,
  latestPdfAuthorization,
  type PdfAuthorizationRecord,
} from "./repository"

export type ContactDisclosureMode = "real" | "omitted" | "redacted"

export interface GenerateApplicationPdfInput {
  dealId: string
  idempotencyKey: string
  contactMode: ContactDisclosureMode
  signedOnBehalf?: boolean
}

export interface GeneratedApplicationPdf {
  generationId: string
  document: DocumentSummary
  dealVersion: number
  contactMode: ContactDisclosureMode
  signedOnBehalf: boolean
  authorizationId?: string
  replayed: boolean
}

function display(value: string | undefined, mode?: ContactDisclosureMode): string {
  if (mode === "omitted") return "OMITTED BY REQUEST"
  if (mode === "redacted") return "REDACTED"
  return value?.trim() || "NOT PROVIDED"
}

function money(value?: number): string {
  return value === undefined ? "NOT PROVIDED" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value)
}

function ownerName(owner: DealOwner): string {
  return [owner.firstName, owner.lastName].filter(Boolean).join(" ") || "NOT PROVIDED"
}

function wrapText(value: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = value.replace(/\s+/g, " ").trim().split(" ")
  const lines: string[] = []
  let line = ""
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) { line = candidate; continue }
    if (line) lines.push(line)
    if (font.widthOfTextAtSize(word, size) <= maxWidth) { line = word; continue }
    let chunk = ""
    for (const character of word) {
      if (font.widthOfTextAtSize(chunk + character, size) > maxWidth && chunk) { lines.push(chunk); chunk = character } else chunk += character
    }
    line = chunk
  }
  if (line) lines.push(line)
  return lines.length ? lines : ["NOT PROVIDED"]
}

export async function renderApplicationPdf(
  deal: DealRecord,
  options: { contactMode: ContactDisclosureMode; signedOnBehalf: boolean; authorization?: PdfAuthorizationRecord },
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  let page!: PDFPage
  let y = 0
  const addPage = () => {
    page = pdf.addPage([612, 792])
    page.drawRectangle({ x: 0, y: 724, width: 612, height: 68, color: rgb(0.08, 0.16, 0.29) })
    page.drawText("MERCHANT FUNDING APPLICATION", { x: 48, y: 755, size: 18, font: bold, color: rgb(1, 1, 1) })
    page.drawText(`Deal ${deal.displayId} | Record version ${deal.version}`, { x: 48, y: 737, size: 9, font, color: rgb(0.83, 0.89, 0.98) })
    y = 692
  }
  const ensure = (height: number) => { if (y - height < 58) addPage() }
  const section = (label: string, aside?: string) => {
    ensure(34); y -= 4
    page.drawText(label, { x: 48, y, size: 11, font: bold, color: rgb(0.13, 0.34, 0.63) })
    if (aside) page.drawText(aside, { x: 440, y, size: 9, font: bold, color: rgb(0.13, 0.34, 0.63) })
    y -= 22
  }
  const field = (label: string, value: string) => {
    const lines = wrapText(value, font, 9, 378)
    const height = Math.max(22, lines.length * 12 + 10)
    ensure(height)
    page.drawText(label, { x: 48, y, size: 9, font: bold, color: rgb(0.17, 0.22, 0.31) })
    lines.forEach((line, index) => page.drawText(line, { x: 180, y: y - index * 12, size: 9, font, color: rgb(0.1, 0.12, 0.16) }))
    y -= height
    page.drawLine({ start: { x: 48, y: y + 4 }, end: { x: 564, y: y + 4 }, thickness: 0.35, color: rgb(0.83, 0.85, 0.89) })
  }

  addPage()
  section("BUSINESS")
  field("Legal name", display(deal.legalName)); field("DBA", display(deal.dbaName)); field("EIN", display(deal.ein))
  field("Entity type", display(deal.entityType?.replace(/_/g, " "))); field("Industry", display(deal.industry)); field("NAICS", display(deal.naicsCode))
  field("Business address", display([deal.address?.line1, deal.address?.line2, deal.address?.city, deal.address?.state, deal.address?.postalCode, deal.address?.country].filter(Boolean).join(", ")))
  field("Requested amount", money(deal.requestedAmount)); field("Monthly revenue", money(deal.monthlyRevenue)); field("Funding purpose", display(deal.fundingPurpose))

  section("CONTACT DISCLOSURE", options.contactMode.toUpperCase())
  field("Contact name", display(deal.contactName, options.contactMode)); field("Contact email", display(deal.contactEmail, options.contactMode)); field("Contact phone", display(deal.contactPhone, options.contactMode))

  section("OWNERS")
  for (const [index, owner] of deal.owners.entries()) {
    field(`Owner ${index + 1}`, `${ownerName(owner)}${owner.ownershipPercent === undefined ? "" : ` - ${owner.ownershipPercent}% ownership`}`)
    field("Owner contact", options.contactMode === "real" ? display([owner.email, owner.phone].filter(Boolean).join(" | ")) : display(undefined, options.contactMode))
  }
  if (!deal.owners.length) field("Owner", "NOT PROVIDED")

  section("ATTESTATION")
  ensure(70)
  if (options.signedOnBehalf && options.authorization) {
    page.drawText("Generated on behalf of the merchant under recorded authorization.", { x: 48, y, size: 9, font })
    y -= 16
    for (const line of wrapText(`Authorization reference: ${options.authorization.authorizationReference}`, font, 9, 516)) {
      page.drawText(line, { x: 48, y, size: 9, font }); y -= 12
    }
    page.drawText(`Recorded: ${options.authorization.recordedAt}`, { x: 48, y, size: 9, font })
  } else {
    page.drawText("Merchant signature: ____________________________________   Date: ______________", { x: 48, y, size: 9, font })
  }
  const pages = pdf.getPages()
  pages.forEach((current, index) => {
    current.drawText("Generated from the Fundlane record. Missing fields are labeled explicitly.", { x: 48, y: 34, size: 8, font, color: rgb(0.38, 0.42, 0.49) })
    current.drawText(`Page ${index + 1} of ${pages.length}`, { x: 504, y: 34, size: 8, font, color: rgb(0.38, 0.42, 0.49) })
  })

  // Metadata deliberately excludes merchant contact values in every disclosure mode.
  pdf.setTitle("Merchant Funding Application")
  pdf.setSubject(`MCA deal application ${deal.displayId}`)
  pdf.setAuthor("Fundlane")
  pdf.setCreator("Fundlane")
  pdf.setProducer("Fundlane")
  pdf.setKeywords(["merchant application", "MCA", options.contactMode])
  return new Uint8Array(await pdf.save({ useObjectStreams: false }))
}

export async function recordMerchantAuthorization(
  actor: DealActor,
  input: { dealId: string; merchantName: string; authorizationReference: string },
): Promise<PdfAuthorizationRecord> {
  const deal = await getDealForDocument(actor, input.dealId)
  const merchantName = input.merchantName.trim()
  const authorizationReference = input.authorizationReference.trim()
  if (!merchantName || !authorizationReference || authorizationReference.length > 200) {
    throw new AppError(422, "authorization_invalid", "Merchant name and an authorization reference are required.")
  }
  const record: PdfAuthorizationRecord = { id: newId(), workspaceId: actor.workspaceId, dealId: deal.id, authorizedBy: actor.userId, merchantName, authorizationReference, recordedAt: nowIso() }
  await insertPdfAuthorization(record)
  await recordAuditEvent({ context: actor, action: "application_pdf.authorization_recorded", resourceType: "deal", resourceId: deal.id, metadata: { authorizationId: record.id }, correlationId: actor.correlationId })
  return record
}

export async function generateApplicationPdf(actor: DealActor, input: GenerateApplicationPdfInput): Promise<GeneratedApplicationPdf> {
  if (!input.idempotencyKey?.trim() || input.idempotencyKey.length > 160) throw new AppError(422, "invalid_idempotency_key", "Provide a stable idempotency key.")
  if (!["real", "omitted", "redacted"].includes(input.contactMode)) throw new AppError(422, "contact_mode_invalid", "Choose real, omitted, or redacted contact disclosure.")
  const replay = await findPdfGenerationByKey(actor.workspaceId, input.idempotencyKey)
  if (replay) {
    if (replay.dealId !== input.dealId || replay.contactMode !== input.contactMode || replay.signedOnBehalf !== Boolean(input.signedOnBehalf)) throw new AppError(409, "idempotency_conflict", "That idempotency key was used for different PDF settings.")
    const document = await getDocument(actor, replay.documentId)
    return { generationId: replay.id, document, dealVersion: replay.dealVersion, contactMode: replay.contactMode, signedOnBehalf: replay.signedOnBehalf, authorizationId: replay.authorizationId, replayed: true }
  }
  const deal = await getDealForDocument(actor, input.dealId)
  const authorization = input.signedOnBehalf ? await latestPdfAuthorization(actor.workspaceId, deal.id) : undefined
  if (input.signedOnBehalf && !authorization) throw new AppError(422, "merchant_authorization_required", "Record current merchant authorization before generating a signed-on-behalf application.")
  const bytes = await renderApplicationPdf(deal, { contactMode: input.contactMode, signedOnBehalf: Boolean(input.signedOnBehalf), authorization })
  const document = await storeDocument(actor, {
    dealId: deal.id, idempotencyKey: `application-pdf:${input.idempotencyKey}`, filename: `${deal.displayId}-application-v${deal.version}.pdf`,
    mimeType: "application/pdf", bytes, category: "api_application", source: "application_pdf", sourceReference: input.idempotencyKey,
  })
  const generationId = newId()
  const createdAt = nowIso()
  await insertPdfGeneration({ id: generationId, workspaceId: actor.workspaceId, dealId: deal.id, idempotencyKey: input.idempotencyKey, documentId: document.id, dealVersion: deal.version, contactMode: input.contactMode, signedOnBehalf: Boolean(input.signedOnBehalf), authorizationId: authorization?.id, generatedBy: actor.userId, correlationId: actor.correlationId, createdAt })
  await recordAuditEvent({ context: actor, action: "application_pdf.generated", resourceType: "document", resourceId: document.id, metadata: { dealId: deal.id, dealVersion: deal.version, contactMode: input.contactMode, signedOnBehalf: Boolean(input.signedOnBehalf), authorizationId: authorization?.id }, correlationId: actor.correlationId })
  return { generationId, document, dealVersion: deal.version, contactMode: input.contactMode, signedOnBehalf: Boolean(input.signedOnBehalf), authorizationId: authorization?.id, replayed: false }
}

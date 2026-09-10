import "server-only"

import { z } from "zod"
import { AppError } from "../errors"
import type { DealActor, DealWriteInput } from "../deals/schema"
import type { ApplicationExtraction, ExtractionFileInput, FieldMappingSuggestion, StatementMetadataExtraction } from "./contracts"

export interface DocumentExtractionProvider {
  readonly name: string
  extractApplication(actor: DealActor, input: ExtractionFileInput): Promise<ApplicationExtraction>
  suggestFieldMapping(actor: DealActor, input: { headers: string[]; samples: string[][]; allowedFields: string[] }): Promise<FieldMappingSuggestion>
  extractStatementMetadata(actor: DealActor, input: ExtractionFileInput): Promise<StatementMetadataExtraction>
}

const nullableString = z.string().nullable()
const ownerSchema = z.object({
  firstName: nullableString, lastName: nullableString, ownershipPercent: z.number().nullable(), isPrimary: z.boolean().nullable(),
  dateOfBirth: nullableString, identityLast4: nullableString, email: nullableString, phone: nullableString,
}).strict()
const fieldsSchema = z.object({
  legalName: nullableString, dbaName: nullableString, ein: nullableString,
  entityType: z.enum(["llc", "corporation", "s_corporation", "partnership", "sole_proprietor", "nonprofit", "other"]).nullable(),
  address: z.object({ line1: nullableString, line2: nullableString, city: nullableString, state: nullableString, postalCode: nullableString, country: nullableString }).strict().nullable(),
  contactName: nullableString, contactEmail: nullableString, contactPhone: nullableString, startDate: nullableString,
  industry: nullableString, naicsCode: nullableString, monthlyRevenue: z.number().nullable(), ficoScore: z.number().nullable(),
  fundingPurpose: nullableString, requestedAmount: z.number().nullable(), owners: z.array(ownerSchema),
}).strict()
const evidenceItemSchema = z.object({ field: z.string(), confidence: z.number().min(0).max(1), page: z.number().int().positive().nullable(), text: nullableString, unknown: z.boolean() }).strict()
const applicationResponseSchema = z.object({ fields: fieldsSchema, evidence: z.array(evidenceItemSchema), warnings: z.array(z.string()) }).strict()
const mappingResponseSchema = z.object({ mapping: z.array(z.object({ header: z.string(), field: nullableString, confidence: z.number().min(0).max(1) }).strict()), warnings: z.array(z.string()) }).strict()
const candidateSchema = z.object({ value: nullableString, confidence: z.number().min(0).max(1), page: z.number().int().positive().nullable(), text: nullableString }).strict()
const statementResponseSchema = z.object({ bankLabel: candidateSchema, statementMonth: candidateSchema, accountSuffix: candidateSchema, warnings: z.array(z.string()) }).strict()

function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null).map(([key, item]) => [key, stripNulls(item)]))
  return value
}

const stringOrNull = { type: ["string", "null"] }
const applicationJsonSchema = {
  type: "object", additionalProperties: false, required: ["fields", "evidence", "warnings"], properties: {
    fields: { type: "object", additionalProperties: false, required: ["legalName", "dbaName", "ein", "entityType", "address", "contactName", "contactEmail", "contactPhone", "startDate", "industry", "naicsCode", "monthlyRevenue", "ficoScore", "fundingPurpose", "requestedAmount", "owners"], properties: {
      legalName: stringOrNull, dbaName: stringOrNull, ein: stringOrNull,
      entityType: { type: ["string", "null"], enum: ["llc", "corporation", "s_corporation", "partnership", "sole_proprietor", "nonprofit", "other", null] },
      address: { anyOf: [{ type: "null" }, { type: "object", additionalProperties: false, required: ["line1", "line2", "city", "state", "postalCode", "country"], properties: Object.fromEntries(["line1", "line2", "city", "state", "postalCode", "country"].map((key) => [key, stringOrNull])) }] },
      contactName: stringOrNull, contactEmail: stringOrNull, contactPhone: stringOrNull, startDate: stringOrNull,
      industry: stringOrNull, naicsCode: stringOrNull, monthlyRevenue: { type: ["number", "null"] }, ficoScore: { type: ["number", "null"] }, fundingPurpose: stringOrNull, requestedAmount: { type: ["number", "null"] },
      owners: { type: "array", items: { type: "object", additionalProperties: false, required: ["firstName", "lastName", "ownershipPercent", "isPrimary", "dateOfBirth", "identityLast4", "email", "phone"], properties: { firstName: stringOrNull, lastName: stringOrNull, ownershipPercent: { type: ["number", "null"] }, isPrimary: { type: ["boolean", "null"] }, dateOfBirth: stringOrNull, identityLast4: stringOrNull, email: stringOrNull, phone: stringOrNull } } },
    } },
    evidence: { type: "array", items: { type: "object", additionalProperties: false, required: ["field", "confidence", "page", "text", "unknown"], properties: { field: { type: "string" }, confidence: { type: "number", minimum: 0, maximum: 1 }, page: { type: ["integer", "null"] }, text: stringOrNull, unknown: { type: "boolean" } } } },
    warnings: { type: "array", items: { type: "string" } },
  },
} as const

function fileData(input: ExtractionFileInput): string {
  return `data:${input.mimeType};base64,${Buffer.from(input.bytes).toString("base64")}`
}

type RawResponse = { id?: string; error?: { message?: string }; output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> }

export class OpenAiDocumentExtractionProvider implements DocumentExtractionProvider {
  readonly name = "openai-responses"
  constructor(private readonly apiKey: string, private readonly model: string, private readonly endpoint = "https://api.openai.com/v1/responses", private readonly timeoutMs = 45_000) {}

  private async call(input: unknown[], schemaName: string, schema: Record<string, unknown>): Promise<{ json: unknown; requestId?: string }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Response
    try {
      response = await fetch(this.endpoint, {
        method: "POST", headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, store: false, input, text: { format: { type: "json_schema", name: schemaName, strict: true, schema } } }), signal: controller.signal,
      })
    } catch (error) {
      if ((error as Error).name === "AbortError") throw new AppError(504, "provider_timeout", "Document AI timed out. Retry the extraction.")
      throw new AppError(503, "provider_unavailable", "Document AI could not be reached. Check the configured provider and retry.")
    } finally { clearTimeout(timer) }
    const requestId = response.headers.get("x-request-id") ?? undefined
    const body = await response.json().catch(() => ({})) as RawResponse
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new AppError(503, "provider_authentication_failed", "Document AI credentials were rejected. Rotate OPENAI_API_KEY and retry.")
      throw new AppError(502, "provider_failed", body.error?.message?.slice(0, 300) || "Document AI could not process this request.")
    }
    const text = body.output_text ?? body.output?.flatMap((item) => item.content ?? []).find((item) => item.type === "output_text")?.text
    if (!text) throw new AppError(502, "provider_invalid_response", "Document AI returned no structured output. Retry or review the file manually.")
    try { return { json: JSON.parse(text), requestId: requestId ?? body.id } } catch { throw new AppError(502, "provider_invalid_response", "Document AI returned invalid structured output. Retry or review the file manually.") }
  }

  async extractApplication(_actor: DealActor, input: ExtractionFileInput): Promise<ApplicationExtraction> {
    const prompt = "Extract MCA application fields. Never infer an SSN or identity last four. Use null and unknown=true when absent. Capture every owner separately. Evidence text must be a short source excerpt and page must be the PDF page number when known."
    const result = await this.call([{ role: "user", content: [{ type: "input_text", text: prompt }, { type: "input_file", filename: input.filename, file_data: fileData(input) }] }], "mca_application_extraction", applicationJsonSchema as unknown as Record<string, unknown>)
    const parsed = applicationResponseSchema.safeParse(result.json)
    if (!parsed.success) throw new AppError(502, "provider_schema_mismatch", "Document AI output did not match the application schema. Retry or review manually.")
    const evidence = Object.fromEntries(parsed.data.evidence.map((item) => [item.field, { confidence: item.confidence, ...(item.page ? { page: item.page } : {}), ...(item.text ? { text: item.text } : {}), ...(item.unknown ? { unknown: true } : {}) }]))
    return { version: 1, fields: stripNulls(parsed.data.fields) as DealWriteInput, evidence, warnings: parsed.data.warnings, provider: this.name, requestId: result.requestId }
  }

  async suggestFieldMapping(_actor: DealActor, input: { headers: string[]; samples: string[][]; allowedFields: string[] }): Promise<FieldMappingSuggestion> {
    const schema = { type: "object", additionalProperties: false, required: ["mapping", "warnings"], properties: { mapping: { type: "array", items: { type: "object", additionalProperties: false, required: ["header", "field", "confidence"], properties: { header: { type: "string" }, field: stringOrNull, confidence: { type: "number", minimum: 0, maximum: 1 } } } }, warnings: { type: "array", items: { type: "string" } } } }
    const prompt = `Map headers only to allowed fields. Leave uncertain fields null. Allowed: ${JSON.stringify(input.allowedFields)}\nHeaders: ${JSON.stringify(input.headers)}\nSample rows: ${JSON.stringify(input.samples.slice(0, 10))}`
    const result = await this.call([{ role: "user", content: [{ type: "input_text", text: prompt }] }], "mca_field_mapping", schema)
    const parsed = mappingResponseSchema.safeParse(result.json)
    if (!parsed.success) throw new AppError(502, "provider_schema_mismatch", "Document AI output did not match the mapping schema.")
    const allowed = new Set(input.allowedFields)
    const accepted = parsed.data.mapping.filter((item) => item.field && input.headers.includes(item.header) && allowed.has(item.field))
    return { mapping: Object.fromEntries(accepted.map((item) => [item.header, item.field!])), confidence: Object.fromEntries(accepted.map((item) => [item.header, item.confidence])), warnings: parsed.data.warnings, provider: this.name }
  }

  async extractStatementMetadata(_actor: DealActor, input: ExtractionFileInput): Promise<StatementMetadataExtraction> {
    const candidate = { type: "object", additionalProperties: false, required: ["value", "confidence", "page", "text"], properties: { value: stringOrNull, confidence: { type: "number", minimum: 0, maximum: 1 }, page: { type: ["integer", "null"] }, text: stringOrNull } }
    const schema = { type: "object", additionalProperties: false, required: ["bankLabel", "statementMonth", "accountSuffix", "warnings"], properties: { bankLabel: candidate, statementMonth: candidate, accountSuffix: candidate, warnings: { type: "array", items: { type: "string" } } } }
    const prompt = "Extract the bank label, statement month as YYYY-MM, and only the final four account digits. Never return a full account number. Use null and a warning for uncertainty."
    const result = await this.call([{ role: "user", content: [{ type: "input_text", text: prompt }, { type: "input_file", filename: input.filename, file_data: fileData(input) }] }], "mca_statement_metadata", schema)
    const parsed = statementResponseSchema.safeParse(result.json)
    if (!parsed.success) throw new AppError(502, "provider_schema_mismatch", "Document AI output did not match the statement schema.")
    const convert = (item: z.infer<typeof candidateSchema>) => item.value ? { value: item.value, confidence: item.confidence, ...(item.page ? { page: item.page } : {}), ...(item.text ? { text: item.text } : {}) } : undefined
    const account = convert(parsed.data.accountSuffix)
    if (account) account.value = account.value.replace(/\D/g, "").slice(-4)
    return { bankLabel: convert(parsed.data.bankLabel), statementMonth: convert(parsed.data.statementMonth), accountSuffix: account, warnings: parsed.data.warnings, provider: this.name, requestId: result.requestId }
  }
}

let providerOverride: DocumentExtractionProvider | undefined
export function setDocumentExtractionProviderForTests(provider?: DocumentExtractionProvider): void { providerOverride = provider }

function configuredProvider(): DocumentExtractionProvider {
  if (providerOverride) return providerOverride
  const provider = process.env.MCA_DOCUMENT_AI_PROVIDER
  if (!provider) throw new AppError(503, "provider_unavailable", "Configure MCA_DOCUMENT_AI_PROVIDER=openai, OPENAI_API_KEY, and MCA_DOCUMENT_AI_MODEL before using document AI.")
  if (provider !== "openai") throw new AppError(503, "provider_unavailable", `Unsupported document AI provider: ${provider}.`)
  if (!process.env.OPENAI_API_KEY) throw new AppError(503, "provider_unavailable", "Configure OPENAI_API_KEY before using document AI.")
  if (!process.env.MCA_DOCUMENT_AI_MODEL) throw new AppError(503, "provider_unavailable", "Configure MCA_DOCUMENT_AI_MODEL before using document AI.")
  return new OpenAiDocumentExtractionProvider(process.env.OPENAI_API_KEY, process.env.MCA_DOCUMENT_AI_MODEL)
}

export function extractionProviderStatus(): { configured: boolean; provider: string; action?: string } {
  const provider = process.env.MCA_DOCUMENT_AI_PROVIDER
  const configured = provider === "openai" && Boolean(process.env.OPENAI_API_KEY && process.env.MCA_DOCUMENT_AI_MODEL)
  return { configured, provider: provider ?? "unconfigured", ...(configured ? {} : { action: "Set MCA_DOCUMENT_AI_PROVIDER=openai, OPENAI_API_KEY, and MCA_DOCUMENT_AI_MODEL." }) }
}

export function extractApplication(actor: DealActor, input: ExtractionFileInput): Promise<ApplicationExtraction> { return configuredProvider().extractApplication(actor, input) }
export function suggestFieldMapping(actor: DealActor, input: { headers: string[]; samples: string[][]; allowedFields: string[] }): Promise<FieldMappingSuggestion> { return configuredProvider().suggestFieldMapping(actor, input) }
export function extractStatementMetadata(actor: DealActor, input: ExtractionFileInput): Promise<StatementMetadataExtraction> { return configuredProvider().extractStatementMetadata(actor, input) }

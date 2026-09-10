import "server-only"

import { z } from "zod"
import { AppError } from "../errors"
import type { DealActor } from "../deals/schema"
import type { ExtractionFileInput } from "../documents/contracts"
import { STATEMENT_ACCOUNT_KINDS, type MetricEvidence, type StatementAccountKind } from "./contracts"

export interface StatementPositionCandidate {
  label: string
  estimatedPayment?: number
  evidence: string
}

export interface StatementExtraction {
  accountKind: StatementAccountKind
  period: string
  accountSuffix?: string
  deposits: MetricEvidence
  depositCount: MetricEvidence
  averageDailyBalance: MetricEvidence
  nsfCount: MetricEvidence
  negativeDays: MetricEvidence
  endingBalance: MetricEvidence
  positions: StatementPositionCandidate[]
  warnings: string[]
  provider: string
  requestId?: string
}

export interface StatementExtractionProvider {
  readonly name: string
  extractStatement(actor: DealActor, input: ExtractionFileInput): Promise<StatementExtraction>
}

const metricSchema = z.object({
  value: z.number().nullable(),
  unknown: z.boolean(),
  page: z.number().int().positive().nullable(),
  text: z.string().nullable(),
  confidence: z.number().min(0).max(1),
}).strict()

const positionSchema = z.object({
  label: z.string(),
  estimatedPayment: z.number().nullable(),
  evidence: z.string(),
}).strict()

const extractionSchema = z.object({
  accountKind: z.enum(STATEMENT_ACCOUNT_KINDS),
  period: z.string().nullable(),
  accountSuffix: z.string().nullable(),
  deposits: metricSchema,
  depositCount: metricSchema,
  averageDailyBalance: metricSchema,
  nsfCount: metricSchema,
  negativeDays: metricSchema,
  endingBalance: metricSchema,
  positions: z.array(positionSchema),
  warnings: z.array(z.string()),
}).strict()

const numberOrNull = { type: ["number", "null"] }
const stringOrNull = { type: ["string", "null"] }
const metricJson = {
  type: "object", additionalProperties: false,
  required: ["value", "unknown", "page", "text", "confidence"],
  properties: {
    value: numberOrNull, unknown: { type: "boolean" }, page: { type: ["integer", "null"] },
    text: stringOrNull, confidence: { type: "number", minimum: 0, maximum: 1 },
  },
}
const statementJsonSchema = {
  type: "object", additionalProperties: false,
  required: ["accountKind", "period", "accountSuffix", "deposits", "depositCount", "averageDailyBalance", "nsfCount", "negativeDays", "endingBalance", "positions", "warnings"],
  properties: {
    accountKind: { type: "string", enum: [...STATEMENT_ACCOUNT_KINDS] },
    period: stringOrNull,
    accountSuffix: stringOrNull,
    deposits: metricJson, depositCount: metricJson, averageDailyBalance: metricJson,
    nsfCount: metricJson, negativeDays: metricJson, endingBalance: metricJson,
    positions: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["label", "estimatedPayment", "evidence"],
        properties: { label: { type: "string" }, estimatedPayment: numberOrNull, evidence: { type: "string" } },
      },
    },
    warnings: { type: "array", items: { type: "string" } },
  },
} as const

function fileData(input: ExtractionFileInput): string {
  return `data:${input.mimeType};base64,${Buffer.from(input.bytes).toString("base64")}`
}

export function normalizeMetric(metric: MetricEvidence): MetricEvidence {
  if (metric.unknown || metric.value == null || !Number.isFinite(metric.value)) {
    return { value: null, unknown: true, confidence: metric.confidence ?? 0, ...(metric.page ? { page: metric.page } : {}), ...(metric.text ? { text: metric.text } : {}) }
  }
  return { value: metric.value, unknown: false, confidence: metric.confidence, ...(metric.page ? { page: metric.page } : {}), ...(metric.text ? { text: metric.text } : {}) }
}

function fromSchemaMetric(metric: z.infer<typeof metricSchema>): MetricEvidence {
  return normalizeMetric({
    value: metric.value, unknown: metric.unknown, confidence: metric.confidence,
    ...(metric.page ? { page: metric.page } : {}), ...(metric.text ? { text: metric.text } : {}),
  })
}

type RawResponse = { id?: string; error?: { message?: string }; output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> }

export class OpenAiStatementExtractionProvider implements StatementExtractionProvider {
  readonly name = "openai-responses"
  constructor(private readonly apiKey: string, private readonly model: string, private readonly endpoint = "https://api.openai.com/v1/responses", private readonly timeoutMs = 45_000) {}

  private async call(input: unknown[]): Promise<{ json: unknown; requestId?: string }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Response
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model, store: false, input,
          text: { format: { type: "json_schema", name: "mca_statement_underwriting", strict: true, schema: statementJsonSchema } },
        }),
        signal: controller.signal,
      })
    } catch (error) {
      if ((error as Error).name === "AbortError") throw new AppError(504, "provider_timeout", "Statement AI timed out. Retry the analysis.")
      throw new AppError(503, "provider_unavailable", "Statement AI could not be reached. Check the configured provider and retry.")
    } finally { clearTimeout(timer) }
    const requestId = response.headers.get("x-request-id") ?? undefined
    const body = await response.json().catch(() => ({})) as RawResponse
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new AppError(503, "provider_authentication_failed", "Statement AI credentials were rejected. Rotate OPENAI_API_KEY and retry.")
      throw new AppError(502, "provider_failed", body.error?.message?.slice(0, 300) || "Statement AI could not process this request.")
    }
    const text = body.output_text ?? body.output?.flatMap((item) => item.content ?? []).find((item) => item.type === "output_text")?.text
    if (!text) throw new AppError(502, "provider_invalid_response", "Statement AI returned no structured output. Retry or review the file manually.")
    try { return { json: JSON.parse(text), requestId: requestId ?? body.id } } catch { throw new AppError(502, "provider_invalid_response", "Statement AI returned invalid structured output. Retry or review the file manually.") }
  }

  async extractStatement(_actor: DealActor, input: ExtractionFileInput): Promise<StatementExtraction> {
    const prompt = [
      "Extract MCA bank-statement underwriting metrics from this document.",
      "Classify accountKind as checking, savings, credit_card, loan, or unsupported.",
      "period must be YYYY-MM. accountSuffix is only the final four digits, never a full account number.",
      "Return deposits, depositCount, averageDailyBalance, nsfCount, negativeDays, and endingBalance.",
      "If a metric is missing, illegible, or uncertain: unknown=true and value=null. Never invent 0 as a substitute for missing data.",
      "A true zero (for example NSF count 0 on a clear statement) is allowed only when the statement actually shows zero.",
      "Identify likely existing MCA/funding ACH withdrawals as positions for human review; do not treat them as confirmed debts.",
      "Evidence text must be a short source excerpt; page is the PDF page number when known.",
    ].join(" ")
    const result = await this.call([{ role: "user", content: [{ type: "input_text", text: prompt }, { type: "input_file", filename: input.filename, file_data: fileData(input) }] }])
    const parsed = extractionSchema.safeParse(result.json)
    if (!parsed.success) throw new AppError(502, "provider_schema_mismatch", "Statement AI output did not match the underwriting schema. Retry or review manually.")
    const suffix = parsed.data.accountSuffix?.replace(/\D/g, "").slice(-4)
    return {
      accountKind: parsed.data.accountKind,
      period: parsed.data.period ?? "",
      ...(suffix ? { accountSuffix: suffix } : {}),
      deposits: fromSchemaMetric(parsed.data.deposits),
      depositCount: fromSchemaMetric(parsed.data.depositCount),
      averageDailyBalance: fromSchemaMetric(parsed.data.averageDailyBalance),
      nsfCount: fromSchemaMetric(parsed.data.nsfCount),
      negativeDays: fromSchemaMetric(parsed.data.negativeDays),
      endingBalance: fromSchemaMetric(parsed.data.endingBalance),
      positions: parsed.data.positions
        .filter((item) => item.label.trim())
        .map((item) => ({ label: item.label.trim(), ...(item.estimatedPayment != null ? { estimatedPayment: item.estimatedPayment } : {}), evidence: item.evidence })),
      warnings: parsed.data.warnings,
      provider: this.name,
      requestId: result.requestId,
    }
  }
}

let providerOverride: StatementExtractionProvider | undefined
export function setStatementExtractionProviderForTests(provider?: StatementExtractionProvider): void { providerOverride = provider }

function configuredProvider(): StatementExtractionProvider {
  if (providerOverride) return providerOverride
  const provider = process.env.MCA_DOCUMENT_AI_PROVIDER
  if (!provider) throw new AppError(503, "provider_unavailable", "Configure MCA_DOCUMENT_AI_PROVIDER=openai, OPENAI_API_KEY, and MCA_DOCUMENT_AI_MODEL before analyzing bank statements.")
  if (provider !== "openai") throw new AppError(503, "provider_unavailable", `Unsupported statement AI provider: ${provider}.`)
  if (!process.env.OPENAI_API_KEY) throw new AppError(503, "provider_unavailable", "Configure OPENAI_API_KEY before analyzing bank statements.")
  if (!process.env.MCA_DOCUMENT_AI_MODEL) throw new AppError(503, "provider_unavailable", "Configure MCA_DOCUMENT_AI_MODEL before analyzing bank statements.")
  return new OpenAiStatementExtractionProvider(process.env.OPENAI_API_KEY, process.env.MCA_DOCUMENT_AI_MODEL)
}

export function statementExtractionProvider(): StatementExtractionProvider {
  return configuredProvider()
}

export function statementExtractionStatus(): { configured: boolean; provider: string; action?: string } {
  if (providerOverride) return { configured: true, provider: providerOverride.name }
  const provider = process.env.MCA_DOCUMENT_AI_PROVIDER
  const configured = provider === "openai" && Boolean(process.env.OPENAI_API_KEY && process.env.MCA_DOCUMENT_AI_MODEL)
  return { configured, provider: provider ?? "unconfigured", ...(configured ? {} : { action: "Set MCA_DOCUMENT_AI_PROVIDER=openai, OPENAI_API_KEY, and MCA_DOCUMENT_AI_MODEL." }) }
}

/**
 * Secret-free summary of an unexpected (non-AppError) exception for native logs.
 * Only the class, a redacted and truncated message, and provider metadata that is
 * safe to share (Stripe type/code/status/request id/param, Postgres SQLSTATE) are kept.
 */
export interface ErrorDiagnostics {
  errorClass: string
  errorMessage: string
  errorCode?: string
  providerType?: string
  providerStatus?: number
  providerRequestId?: string
  providerParam?: string
}

const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]+/g,
  /\bwhsec_[A-Za-z0-9]+/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/gi,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
]

export function redactDiagnosticText(value: string, max = 300) {
  let text = value
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "[redacted]")
  text = text.replace(/\s+/g, " ").trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

const token = (value: unknown, max = 80) =>
  typeof value === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(value) ? value.slice(0, max) : undefined

export function describeUnexpectedError(error: unknown): ErrorDiagnostics {
  if (!(error instanceof Error)) return { errorClass: typeof error, errorMessage: "non-error value thrown" }
  const e = error as Error & { type?: unknown; code?: unknown; statusCode?: unknown; requestId?: unknown; param?: unknown }
  const errorClass = token(e.constructor?.name) ?? token(e.name) ?? "Error"
  const out: ErrorDiagnostics = { errorClass, errorMessage: redactDiagnosticText(e.message ?? "") }
  const code = token(e.code)
  if (code) out.errorCode = code
  const type = token(e.type)
  if (type && type !== errorClass) out.providerType = type
  if (typeof e.statusCode === "number" && Number.isInteger(e.statusCode)) out.providerStatus = e.statusCode
  const requestId = token(e.requestId)
  if (requestId) out.providerRequestId = requestId
  const param = token(e.param)
  if (param) out.providerParam = param
  return out
}

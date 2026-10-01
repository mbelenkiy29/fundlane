/** Native diagnostics intentionally exclude arbitrary exception text and properties.
 * Regex redaction cannot identify unlabeled OAuth secrets, bank numbers or document
 * excerpts echoed by a provider. Keep only known classes/codes and HTTP status.
 */
export interface ErrorDiagnostics {
  errorClass: string
  errorMessage: string
  errorCode?: string
  providerType?: string
  providerStatus?: number
}

const ERROR_CLASSES = new Set([
  "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "URIError", "AggregateError",
  "StripeError", "StripeInvalidRequestError", "StripeAPIError", "StripeAuthenticationError",
  "StripePermissionError", "StripeRateLimitError", "StripeConnectionError", "StripeCardError",
  "StripeIdempotencyError", "StripeSignatureVerificationError",
])
const PROVIDER_TYPES = new Set(["api_error", "invalid_request_error", "authentication_error", "card_error", "idempotency_error", "rate_limit_error"])
const PROVIDER_CODES = new Set(["resource_missing", "api_key_expired", "rate_limit", "parameter_missing", "parameter_invalid_empty", "idempotency_key_in_use"])

export function redactDiagnosticText(value: string) {
  return value ? "[excluded]" : ""
}

export function describeUnexpectedError(error: unknown): ErrorDiagnostics {
  if (!(error instanceof Error)) return { errorClass: typeof error, errorMessage: "non-error value thrown" }
  const e = error as Error & { type?: unknown; rawType?: unknown; code?: unknown; statusCode?: unknown }
  const stripeClass = typeof e.type === "string" && e.type.startsWith("Stripe") && ERROR_CLASSES.has(e.type) ? e.type : undefined
  const errorClass = stripeClass ?? (ERROR_CLASSES.has(e.name) ? e.name : "Error")
  const out: ErrorDiagnostics = { errorClass, errorMessage: redactDiagnosticText(e.message ?? "") }
  // SQLSTATEs are fixed five-character codes. Do not accept arbitrary provider codes.
  if (typeof e.code === "string" && (/^[0-9]{2}[A-Z0-9]{3}$/.test(e.code) || PROVIDER_CODES.has(e.code))) out.errorCode = e.code
  const type = stripeClass ? e.rawType : e.type
  if (typeof type === "string" && PROVIDER_TYPES.has(type)) out.providerType = type
  if (typeof e.statusCode === "number" && Number.isInteger(e.statusCode) && e.statusCode >= 100 && e.statusCode <= 599) out.providerStatus = e.statusCode
  return out
}

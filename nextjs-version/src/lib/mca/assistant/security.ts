import "server-only"
import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { z } from "zod"
import { AppError } from "../errors"

export const delegationSchema = z.object({
  aud: z.literal("mca-chatkit"), requestId: z.string().uuid(),
  userId: z.string().min(1), workspaceId: z.string().min(1), membershipId: z.string().min(1),
  sessionId: z.string().min(1), contextDealId: z.string().max(128).optional(), bodyHash: z.string().length(64),
  exp: z.number().int(), iat: z.number().int(),
}).strict()
export type Delegation = z.infer<typeof delegationSchema>
export const bodyHash = (body: string) => createHash("sha256").update(body).digest("hex")
const verificationSchema = z.object({ userId: z.string().min(1), workspaceId: z.string().min(1), expiresAt: z.string().datetime() }).strict()
function verificationScope() {
  try {
    const scope = verificationSchema.parse(JSON.parse(process.env.MCA_ASSISTANT_VERIFICATION_SCOPE ?? "null"))
    const remaining = Date.parse(scope.expiresAt) - Date.now()
    return remaining > 0 && remaining <= 3_600_000 ? scope : null
  } catch { return null }
}
export function assistantEnabled(context?: { userId: string; workspaceId: string }) {
  if (process.env.MCA_ASSISTANT_ENABLED === "true") return true
  const scope = verificationScope()
  return Boolean(context && scope && context.userId === scope.userId && context.workspaceId === scope.workspaceId)
}
export function requireAssistant(context?: { userId: string; workspaceId: string }) {
  if (!assistantEnabled(context)) throw new AppError(404, "assistant_disabled", "The assistant is not enabled.")
}
/** Only permits proceeding to normal authentication, never grants access itself. */
export function requireAssistantConfigured() {
  if (!assistantEnabled() && !verificationScope()) requireAssistant()
}
function signingKey() {
  const key = process.env.MCA_ASSISTANT_SIGNING_SECRET
  if (!key || Buffer.byteLength(key) < 32) throw new AppError(503, "assistant_unconfigured", "The assistant is not configured.")
  return key
}
export function signDelegation(input: Delegation) {
  const payload = Buffer.from(JSON.stringify(delegationSchema.parse(input))).toString("base64url")
  return `${payload}.${createHmac("sha256", signingKey()).update(payload).digest("base64url")}`
}
export function verifyDelegation(token: string, now = Math.floor(Date.now() / 1000)): Delegation {
  try {
    const [payload, signature, extra] = token.split(".")
    if (!payload || !signature || extra || token.length > 4096) throw new Error()
    const expected = createHmac("sha256", signingKey()).update(payload).digest()
    const actual = Buffer.from(signature, "base64url")
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error()
    const claims = delegationSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString()))
    if (claims.exp <= now || claims.iat > now + 5 || claims.exp - claims.iat > 125) throw new Error()
    return claims
  } catch { throw new AppError(401, "invalid_delegation", "Assistant authorization expired. Please retry.") }
}

/** Bound input before JSON parsing, including requests with no Content-Length. */
export async function boundedBody(request: Request, limit = 64_000) {
  const reader = request.body?.getReader()
  if (!reader) throw new AppError(400, "invalid_request", "A request body is required.")
  const chunks: Uint8Array[] = []; let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) { await reader.cancel(); throw new AppError(413, "request_too_large", "The assistant request is too large.") }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks).toString("utf8")
}

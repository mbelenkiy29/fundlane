import "server-only"
import { createHash, timingSafeEqual } from "node:crypto"
import { z } from "zod"
import { demoSchema } from "./demo-schema"
import { encryptSensitive } from "../mca/crypto"
import { getDatabase } from "../mca/db"

export const demoEnvelopeSchema = demoSchema.omit({ website: true }).extend({
  requestId: z.string().regex(/^[a-f0-9]{64}$/),
  type: z.literal("fundlane.demo_requested"),
  version: z.literal(1),
}).strict()

export async function persistDemo(envelope: z.infer<typeof demoEnvelopeSchema>) {
  // The primary key serializes concurrent retries. Commit precedes acknowledgement.
  const cipher = encryptSensitive(JSON.stringify(envelope), `marketing-demo:${envelope.requestId}`)
  const digest = createHash("sha256").update(JSON.stringify(envelope)).digest("hex")
  const row = await getDatabase().queryOne(`INSERT INTO marketing_demo_requests (request_id, payload_cipher, payload_digest, created_at)
    VALUES (?, ?, ?, ?) ON CONFLICT (request_id) DO UPDATE SET request_id = EXCLUDED.request_id
    WHERE marketing_demo_requests.payload_digest = EXCLUDED.payload_digest RETURNING request_id`,
    [envelope.requestId, cipher, digest, new Date().toISOString()])
  if (!row) throw new Error("Conflicting retry")
}

function response(status: number, accepted = false) {
  return Response.json({ accepted }, { status, headers: { "Cache-Control": "no-store" } })
}

export function createDemoReceiver(deps = { token: () => process.env.MCA_DEMO_WEBHOOK_TOKEN, persist: persistDemo }) {
  return async (request: Request) => {
    const token = deps.token()?.trim()
    if (!token) return response(503)
    const digest = (value: string) => createHash("sha256").update(value).digest()
    if (!timingSafeEqual(digest(request.headers.get("authorization") || ""), digest(`Bearer ${token}`))) return response(401)
    if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") return response(415)
    const reader = request.body?.getReader()
    if (!reader) return response(400)
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.length
        if (size > 12_000) { await reader.cancel(); return response(413) }
        chunks.push(chunk.value)
      }
    } catch { return response(400) }
    finally { reader.releaseLock() }
    let envelope: z.infer<typeof demoEnvelopeSchema>
    try {
      envelope = demoEnvelopeSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")))
    } catch { return response(400) }
    if (request.headers.get("idempotency-key") !== envelope.requestId) return response(400)
    try { await deps.persist(envelope) }
    catch { return response(503) }
    // No email, SMS, CRM automation, or contact data is returned or logged.
    return response(202, true)
  }
}

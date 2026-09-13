import "server-only"
import { createHash, randomUUID } from "node:crypto"
import { encryptSensitive, decryptSensitive } from "../crypto"

export const maintenanceEnabled = () => process.env.MCA_MAINTENANCE_MODE === "enabled"
const CAPTURE_AAD = "mca-maintenance-webhook-v1"
const MAX_BYTES = 35 * 1024 * 1024
const MAX_PART_BYTES = 20 * 1024 * 1024
const MAX_CIPHERTEXT_BYTES = 64 * 1024 * 1024
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")
const webhookPaths = [
  /^\/api\/webhooks\/(stripe|stripe-credits)$/,
  /^\/api\/mca\/intake\/email\/[^/]+$/,
  /^\/api\/mca\/intake\/providers\/[^/]+\/[^/]+$/,
  /^\/api\/mca\/sms\/webhooks\/twilio\/[^/]+\/(inbound|status)$/,
  /^\/api\/mca\/sms\/webhooks\/registration\/[^/]+$/,
  /^\/api\/mca\/closing\/psf\/webhook\/[^/]+$/,
  /^\/api\/mca\/submissions\/webhooks\/(?!refresh$)[^/]+$/,
]
export const isCapturedWebhook = (request: Request) => request.method === "POST" && webhookPaths.some(pattern => pattern.test(new URL(request.url).pathname))
export interface CapturedWebhook {
  version: 1
  id: string
  receivedAt: string
  method: "POST"
  url: string
  headers: Array<[string, string]>
  bodyBase64: string
}
interface CaptureManifest {
  version: 2
  kind: "webhook-ciphertext-parts"
  key: string
  ciphertextBytes: number
  sha256: string
  parts: Array<{ key: string; bytes: number; sha256: string }>
}
const partKey = (key: string, index: number) => `parts/${key.slice("pending/".length, -".enc".length)}/${String(index).padStart(4, "0")}.encpart`
function storageConfig() {
  const url = process.env.MCA_MAINTENANCE_SUPABASE_URL
  const key = process.env.MCA_MAINTENANCE_SUPABASE_SECRET_KEY
  const bucket = process.env.MCA_MAINTENANCE_CAPTURE_BUCKET ?? "mca-cutover-events"
  // Explicit isolated destination prevents accidentally writing into the frozen source.
  if (!url || !key || !/^[a-z0-9][a-z0-9-]{2,62}$/.test(bucket)) throw new Error("Independent maintenance capture storage is not configured.")
  const parsed = new URL(url)
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("Maintenance capture requires a private HTTPS Supabase project.")
  if (!process.env.MCA_DATA_ENCRYPTION_KEY) throw new Error("Maintenance capture requires the preserved data encryption key.")
  return { origin: parsed.origin, key, bucket }
}
async function storageRequest(path: string, init: RequestInit, fetchImpl: typeof fetch) {
  const config = storageConfig()
  return fetchImpl(`${config.origin}/storage/v1/${path}`, { ...init, signal: AbortSignal.timeout(20_000), headers: { apikey: config.key, Authorization: `Bearer ${config.key}`, ...init.headers } })
}
const objectPath = (bucket: string, key: string) => `object/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`
async function rawBytes(request: Request) {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BYTES) throw new Error("Webhook exceeds capture limit.")
  return boundedBytes(request.body, MAX_BYTES)
}
async function boundedBytes(body: ReadableStream<Uint8Array> | null, maxBytes: number) {
  const reader = body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const chunks: Uint8Array[] = []; let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > maxBytes) { await reader.cancel(); throw new Error("Webhook object exceeds capture limit.") }
      chunks.push(next.value)
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks)
}
export async function captureWebhook(request: Request, fetchImpl: typeof fetch = fetch) {
  if (!isCapturedWebhook(request)) throw new Error("Only registered provider webhook routes can be captured.")
  const { bucket } = storageConfig()
  const id = randomUUID(), receivedAt = new Date().toISOString()
  const record: CapturedWebhook = { version: 1, id, receivedAt, method: "POST", url: request.url, headers: [...request.headers.entries()], bodyBase64: (await rawBytes(request)).toString("base64") }
  const key = `pending/${receivedAt.replace(/[:.]/g, "-")}_${id}.enc`
  const encrypted = encryptSensitive(JSON.stringify(record), `${CAPTURE_AAD}:${key}`)
  if (Buffer.byteLength(encrypted) > MAX_CIPHERTEXT_BYTES) throw new Error("Encrypted webhook exceeds capture limit.")
  const upload = async (objectKey: string, body: string) => {
    const response = await storageRequest(objectPath(bucket, objectKey), { method: "POST", body, headers: { "Content-Type": "application/octet-stream", "x-upsert": "false" } }, fetchImpl)
    if (!response.ok) throw new Error("Durable webhook capture failed.")
  }
  let pendingObject = encrypted
  if (encrypted.length > MAX_PART_BYTES) {
    // Split the already authenticated ASCII ciphertext, never the request plaintext.
    const manifest: CaptureManifest = { version: 2, kind: "webhook-ciphertext-parts", key, ciphertextBytes: encrypted.length, sha256: sha256(encrypted), parts: [] }
    for (let start = 0; start < encrypted.length; start += MAX_PART_BYTES) {
      const part = encrypted.slice(start, start + MAX_PART_BYTES), objectKey = partKey(key, manifest.parts.length)
      await upload(objectKey, part)
      manifest.parts.push({ key: objectKey, bytes: part.length, sha256: sha256(part) })
    }
    pendingObject = encryptSensitive(JSON.stringify(manifest), `${CAPTURE_AAD}:${key}`)
  }
  // The immutable pending object is the commit marker. Failed partial uploads are
  // invisible to replay and remain orphaned ciphertext until retention cleanup.
  await upload(key, pendingObject)
  return { id, key }
}
export async function maintenanceResponse(request: Request, fetchImpl: typeof fetch = fetch): Promise<Response | undefined> {
  if (!maintenanceEnabled()) return undefined
  if (isCapturedWebhook(request)) {
    try {
      await captureWebhook(request, fetchImpl)
      // Twilio accepts an empty TwiML response; other providers accept 2xx acknowledgements.
      if (new URL(request.url).pathname.includes("/sms/webhooks/twilio/")) return new Response("<Response/>", { status: 200, headers: { "Content-Type": "text/xml", "Cache-Control": "no-store" } })
      return Response.json({ received: true, queued: true }, { status: 202, headers: { "Cache-Control": "no-store" } })
    } catch {
      // Never acknowledge a provider delivery until the encrypted record is durable.
      return Response.json({ error: "Maintenance capture is unavailable; retry delivery." }, { status: 503, headers: { "Retry-After": "60", "Cache-Control": "no-store" } })
    }
  }
  return Response.json({ error: "Fundlane is temporarily unavailable for a scheduled database migration." }, { status: 503, headers: { "Retry-After": "60", "Cache-Control": "no-store" } })
}
export async function listCapturedWebhooks(fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const { bucket } = storageConfig(), keys: string[] = []
  for (let offset = 0; ; offset += 100) {
    const response = await storageRequest(`object/list/${bucket}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prefix: "pending", limit: 100, offset, sortBy: { column: "name", order: "asc" } }) }, fetchImpl)
    if (!response.ok) throw new Error("Capture inventory failed.")
    const rows = await response.json() as Array<{ name: string }>
    keys.push(...rows.filter(row => /^[A-Za-z0-9_-]+\.enc$/.test(row.name)).map(row => `pending/${row.name}`))
    if (rows.length < 100) return keys
  }
}
export async function readCapturedWebhook(key: string, fetchImpl: typeof fetch = fetch): Promise<CapturedWebhook> {
  if (!/^pending\/[A-Za-z0-9_-]+\.enc$/.test(key)) throw new Error("Invalid capture object key.")
  const { bucket } = storageConfig()
  const response = await storageRequest(objectPath(bucket, key), { method: "GET" }, fetchImpl)
  if (!response.ok) throw new Error("Capture download failed.")
  let record = JSON.parse(decryptSensitive((await boundedBytes(response.body, MAX_CIPHERTEXT_BYTES)).toString("utf8"), `${CAPTURE_AAD}:${key}`)) as CapturedWebhook | CaptureManifest
  if (record.version === 2) {
    const manifest = record
    if (manifest.kind !== "webhook-ciphertext-parts" || manifest.key !== key || !Number.isSafeInteger(manifest.ciphertextBytes) || manifest.ciphertextBytes <= MAX_PART_BYTES || manifest.ciphertextBytes > MAX_CIPHERTEXT_BYTES || !/^[a-f0-9]{64}$/.test(manifest.sha256) || !Array.isArray(manifest.parts) || manifest.parts.length !== Math.ceil(manifest.ciphertextBytes / MAX_PART_BYTES)) throw new Error("Invalid capture manifest.")
    const chunks: string[] = []
    for (const [index, part] of manifest.parts.entries()) {
      const expectedBytes = Math.min(MAX_PART_BYTES, manifest.ciphertextBytes - index * MAX_PART_BYTES)
      if (part.key !== partKey(key, index) || part.bytes !== expectedBytes || !/^[a-f0-9]{64}$/.test(part.sha256)) throw new Error("Invalid capture part descriptor.")
      const partResponse = await storageRequest(objectPath(bucket, part.key), { method: "GET" }, fetchImpl)
      if (!partResponse.ok) throw new Error("Capture part download failed.")
      const bytes = await boundedBytes(partResponse.body, MAX_PART_BYTES), ciphertext = bytes.toString("utf8")
      if (bytes.length !== part.bytes || sha256(ciphertext) !== part.sha256) throw new Error("Capture part integrity check failed.")
      chunks.push(ciphertext)
    }
    const encrypted = chunks.join("")
    if (Buffer.byteLength(encrypted) !== manifest.ciphertextBytes || sha256(encrypted) !== manifest.sha256) throw new Error("Capture ciphertext integrity check failed.")
    // Original AES-GCM authentication and original pending-key AAD still apply.
    record = JSON.parse(decryptSensitive(encrypted, `${CAPTURE_AAD}:${key}`)) as CapturedWebhook
  }
  if (record.version !== 1 || record.method !== "POST" || !Array.isArray(record.headers) || typeof record.bodyBase64 !== "string" || !Number.isFinite(Date.parse(record.receivedAt))) throw new Error("Invalid captured event envelope.")
  if (!isCapturedWebhook(new Request(record.url, { method: record.method }))) throw new Error("Captured event path is not allowed.")
  return record
}
export async function markCapturedWebhookProcessed(key: string, fetchImpl: typeof fetch = fetch) {
  if (!/^pending\/[A-Za-z0-9_-]+\.enc$/.test(key)) throw new Error("Invalid capture object key.")
  const { bucket } = storageConfig()
  // Keep encrypted source objects immutable: the separate receipt records completion.
  const response = await storageRequest(objectPath(bucket, `processed/${key.slice("pending/".length)}`), { method: "POST", headers: { "Content-Type": "application/octet-stream", "x-upsert": "true" }, body: encryptSensitive(JSON.stringify({ key, completedAt: new Date().toISOString() }), `${CAPTURE_AAD}:receipt:${key}`) }, fetchImpl)
  if (!response.ok) throw new Error("Replay completed but receipt persistence failed; an idempotent retry is required.")
}
export async function capturedWebhookProcessed(key: string, fetchImpl: typeof fetch = fetch) {
  if (!/^pending\/[A-Za-z0-9_-]+\.enc$/.test(key)) throw new Error("Invalid capture object key.")
  const { bucket } = storageConfig()
  const response = await storageRequest(objectPath(bucket, `processed/${key.slice("pending/".length)}`), { method: "GET" }, fetchImpl)
  if (response.status === 404 || response.status === 400) return false
  if (!response.ok) throw new Error("Replay receipt lookup failed.")
  const receipt = JSON.parse(decryptSensitive(await response.text(), `${CAPTURE_AAD}:receipt:${key}`)) as { key: string }
  if (receipt.key !== key) throw new Error("Replay receipt identity mismatch.")
  return true
}

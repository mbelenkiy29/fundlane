import { createHmac, timingSafeEqual } from "node:crypto"
import { z } from "zod"
import { AppError } from "../errors"
import { executionSignal } from "../jobs/execution"

const baseUrl = "https://us1.api.av.ionxsolutions.com/v1"
export const verisysResult = z.object({
  id: z.string().uuid(), scan_type: z.literal("malware"), status: z.enum(["pending", "clean", "threat", "error"]),
  content_length: z.number().int().nonnegative(), content_type: z.string(),
  metadata: z.record(z.string(), z.string()).nullable().optional(),
  created_at: z.string(), completed_at: z.string().nullable().optional(), signals: z.array(z.string()).nullable().optional(),
}).passthrough()
export type VerisysResult = z.infer<typeof verisysResult>
export type ObjectScanResult = { status: "pending" | "clean" | "infected" | "error"; provider: "verisys"; evidence: Record<string, unknown> }

export function verifiedObjectScan(raw: unknown, expected: { scanId: string; sha256: string; bytes: number }): ObjectScanResult {
  const result = verisysResult.parse(raw)
  if (result.id !== expected.scanId) throw new AppError(409, "scan_receipt_mismatch", "The scan result belongs to a different request.")
  if (result.status === "pending") return { status: "pending", provider: "verisys", evidence: { scanId: result.id } }
  const matches = result.content_length === expected.bytes && result.metadata?.hash_sha256?.toLowerCase() === expected.sha256.toLowerCase()
  if (!matches || result.status === "error") return { status: "error", provider: "verisys", evidence: { scanId: result.id, reason: matches ? "provider_scan_error" : "scan_content_mismatch" } }
  return { status: result.status === "clean" ? "clean" : "infected", provider: "verisys", evidence: { scanId: result.id, engineVerified: true, sha256: expected.sha256, bytes: expected.bytes } }
}

export function verifyVerisysSignature(raw: Uint8Array, signature: string | null, secret = process.env.MCA_VERISYS_WEBHOOK_SECRET): void {
  if (!secret || secret.length < 16) throw new AppError(503, "scanner_unconfigured", "The scanner webhook secret is not configured.")
  const value = signature ?? ""
  const decoded = /^[a-f\d]{64}$/i.test(value) ? Buffer.from(value, "hex") : /^[A-Za-z\d+/]{43}=$/.test(value) ? Buffer.from(value, "base64") : Buffer.alloc(0)
  const expected = createHmac("sha256", secret).update(raw).digest()
  if (decoded.length !== expected.length || !timingSafeEqual(decoded, expected)) throw new AppError(401, "scanner_signature_invalid", "Invalid scanner signature.")
}

async function api(path: string, init: RequestInit = {}): Promise<unknown> {
  const key = process.env.MCA_VERISYS_API_KEY
  if (!key) throw new AppError(503, "scanner_unconfigured", "The antivirus API key is not configured.")
  const response = await fetch(`${baseUrl}${path}`, { ...init, redirect: "error",
    signal: AbortSignal.any([AbortSignal.timeout(15000), ...(executionSignal() ? [executionSignal()!] : [])]),
    headers: { "content-type": "application/json", "X-API-Key": key, ...init.headers } })
  if (!response.ok) {
    const retry = Number(response.headers.get("retry-after"))
    await response.body?.cancel()
    throw new AppError(503, response.status === 429 ? "scanner_rate_limited" : "scanner_unavailable", "Antivirus scanning is temporarily unavailable.", undefined,
      { retryAfterSeconds: Number.isFinite(retry) && retry > 0 ? Math.min(3600, retry) : 30 })
  }
  const reader = response.body?.getReader(); if (!reader) throw new AppError(502, "scanner_response_invalid", "The scanner returned no result.")
  let size = 0; const parts: Uint8Array[] = []
  try {
    while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength
      if (size > 64000) { await reader.cancel(); throw new AppError(502, "scanner_response_invalid", "The scan result was too large.") }
      parts.push(next.value)
    }
  } finally { reader.releaseLock() }
  try { return JSON.parse(Buffer.concat(parts).toString("utf8")) } catch { throw new AppError(502, "scanner_response_invalid", "The scan result was invalid.") }
}

export async function submitVerisysScan(input: { signedUrl: string; filename: string; callbackUrl: string }): Promise<string> {
  const object = new URL(input.signedUrl), callback = new URL(input.callbackUrl)
  const project = new URL(process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://invalid")
  if (object.protocol !== "https:" || object.origin !== project.origin || !object.pathname.startsWith("/storage/v1/object/sign/") ||
    callback.protocol !== "https:" || callback.origin !== project.origin || callback.pathname !== "/functions/v1/mca-scan-callback") {
    throw new AppError(400, "scanner_url_invalid", "The scan must use this project's private Storage and callback endpoint.")
  }
  const receipt = z.object({ id: z.string().uuid() }).parse(await api("/malware/submit/url", { method: "POST", body: JSON.stringify({ file_url: object.href, file_name: input.filename, callback_url: callback.href }) }))
  return receipt.id
}
export async function fetchVerisysScan(id: string): Promise<VerisysResult> {
  return verisysResult.parse(await api(`/malware/${z.string().uuid().parse(id)}`))
}

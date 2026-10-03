import { createHash } from "node:crypto"
import { z } from "zod"
import { executionSignal } from "../jobs/execution"
import type { DocumentScanner, ScanResult } from "./scanner"

const receipt = z.object({
  CleanResult: z.boolean(),
  FoundViruses: z.array(z.object({ FileName: z.string(), VirusName: z.string() })).nullable().optional(),
})

/** Cloudmersive's free plan rejects files over 3.5 MB and allows one call per second. */
export const CLOUDMERSIVE_MAX_SCAN_BYTES = 3_500_000
export const CLOUDMERSIVE_MIN_INTERVAL_MS = 1_000
export const SCAN_TOO_LARGE_REASON = "file_too_large"
export const SCAN_TOO_LARGE_MESSAGE = "File too large for virus scan (max 3.5 MB)"

let nextCallAt = 0
/** Reserve the next one-second slot synchronously so concurrent scans in one process stay spaced out. */
async function throttle(): Promise<void> {
  const now = Date.now()
  const wait = Math.max(0, nextCallAt - now)
  nextCallAt = Math.max(now, nextCallAt) + CLOUDMERSIVE_MIN_INTERVAL_MS
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait))
}

export function resetCloudmersiveThrottleForTests(): void { nextCallAt = 0 }

/** Scan the exact supplied bytes; a transport failure never authorizes promotion. */
export class CloudmersiveScanner implements DocumentScanner {
  readonly name = "cloudmersive"

  async scan(bytes: Uint8Array, filename: string): Promise<ScanResult> {
    const key = process.env.MCA_CLOUDMERSIVE_API_KEY
    if (!key) return { status: "unavailable", provider: this.name, evidence: { reason: "scanner_unconfigured" } }
    if (bytes.byteLength > CLOUDMERSIVE_MAX_SCAN_BYTES) {
      return { status: "error", provider: this.name, evidence: { reason: SCAN_TOO_LARGE_REASON, message: SCAN_TOO_LARGE_MESSAGE, bytes: bytes.byteLength, maxBytes: CLOUDMERSIVE_MAX_SCAN_BYTES } }
    }
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120) || "upload.bin"
    // Native FormData is required: the hosted Edge runtime's custom multipart
    // stream did not deliver the complete fixture to the provider in acceptance.
    const body = new FormData()
    body.append("inputFile", new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" }), safeName)
    try {
      const signal = executionSignal()
      const init: RequestInit = {
        method: "POST", redirect: "error", body,
        headers: { Apikey: key, Accept: "application/json" },
        signal: AbortSignal.any([AbortSignal.timeout(75_000), ...(signal ? [signal] : [])]),
      }
      await throttle()
      const response = await fetch("https://api.cloudmersive.com/virus/scan/file", init)
      if (!response.ok) {
        await response.body?.cancel()
        return { status: "unavailable", provider: this.name, evidence: { reason: "scanner_http_error", httpStatus: response.status } }
      }
      const reader = response.body?.getReader()
      if (!reader) throw new Error("missing_receipt")
      const chunks: Uint8Array[] = []; let size = 0
      try {
        while (true) {
          const next = await reader.read(); if (next.done) break
          size += next.value.byteLength
          if (size > 64 * 1024) { await reader.cancel(); throw new Error("oversized_receipt") }
          chunks.push(next.value)
        }
      } finally { reader.releaseLock() }
      const result = receipt.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      const threats = result.FoundViruses?.length ?? 0
      if (result.CleanResult && threats) throw new Error("contradictory_receipt")
      return { status: result.CleanResult ? "clean" : "infected", provider: this.name,
        evidence: { engineVerified: true, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength, threatCount: threats } }
    } catch {
      return { status: "error", provider: this.name, evidence: { reason: "scanner_request_failed" } }
    }
  }
}

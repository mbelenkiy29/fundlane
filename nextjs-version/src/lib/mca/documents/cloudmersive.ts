import { createHash } from "node:crypto"
import { z } from "zod"
import { executionSignal } from "../jobs/execution"
import type { DocumentScanner, ScanResult } from "./scanner"

const receipt = z.object({
  CleanResult: z.boolean(),
  FoundViruses: z.array(z.object({ FileName: z.string(), VirusName: z.string() })).nullable().optional(),
})

/** Scan the exact supplied bytes; a transport failure never authorizes promotion. */
export class CloudmersiveScanner implements DocumentScanner {
  readonly name = "cloudmersive"

  async scan(bytes: Uint8Array, filename: string): Promise<ScanResult> {
    const key = process.env.MCA_CLOUDMERSIVE_API_KEY
    if (!key) return { status: "unavailable", provider: this.name, evidence: { reason: "scanner_unconfigured" } }
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

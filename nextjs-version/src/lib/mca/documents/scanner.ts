import "server-only"

import { spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

export type ScanResult =
  | { status: "clean"; provider: string; evidence: Record<string, unknown> }
  | { status: "infected"; provider: string; evidence: Record<string, unknown> }
  | { status: "unavailable"; provider: string; evidence: Record<string, unknown> }
  | { status: "error"; provider: string; evidence: Record<string, unknown> }

export interface DocumentScanner {
  readonly name: string
  scan(bytes: Uint8Array, filename: string): Promise<ScanResult>
}

function run(command: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    child.stdout.on("data", (chunk) => { stdout += String(chunk).slice(0, 4096) })
    child.stderr.on("data", (chunk) => { stderr += String(chunk).slice(0, 4096) })
    child.on("error", reject)
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL") }, timeoutMs)
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }) })
  })
}

export class ClamAvScanner implements DocumentScanner {
  readonly name: string
  constructor(private readonly mode: "clamdscan" | "clamscan", private readonly command: string, private readonly timeoutMs = 30_000) {
    this.name = `clamav:${mode}`
  }

  async scan(bytes: Uint8Array, filename: string): Promise<ScanResult> {
    const dir = await mkdtemp(join(tmpdir(), "mca-scan-"))
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120) || "upload.bin"
    const path = join(dir, safeName)
    try {
      await writeFile(path, bytes, { mode: 0o600 })
      const args = this.mode === "clamdscan" ? ["--no-summary", path] : ["--no-summary", path]
      let result: Awaited<ReturnType<typeof run>>
      try {
        result = await run(this.command, args, this.timeoutMs)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === "ENOENT") return { status: "unavailable", provider: this.name, evidence: { reason: "scanner_executable_not_found" } }
        return { status: "error", provider: this.name, evidence: { reason: "scanner_process_error" } }
      }
      if (result.timedOut) return { status: "error", provider: this.name, evidence: { reason: "scanner_timeout" } }
      if (result.code === 0) return { status: "clean", provider: this.name, evidence: { engineVerified: true } }
      if (result.code === 1) return { status: "infected", provider: this.name, evidence: { engineVerified: true, signatureDetected: true } }
      return { status: "error", provider: this.name, evidence: { reason: "scanner_failed", exitCode: result.code, detail: result.stderr.trim().slice(0, 500) } }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
}

class UnavailableScanner implements DocumentScanner {
  readonly name = "unconfigured"
  async scan(): Promise<ScanResult> {
    return { status: "unavailable", provider: this.name, evidence: { reason: "Configure MCA_DOCUMENT_SCANNER=clamdscan or clamscan." } }
  }
}

let scannerOverride: DocumentScanner | undefined

export function setDocumentScannerForTests(scanner?: DocumentScanner): void {
  scannerOverride = scanner
}

export function documentScanner(): DocumentScanner {
  if (scannerOverride) return scannerOverride
  const mode = process.env.MCA_DOCUMENT_SCANNER
  if (mode === "clamdscan" || mode === "clamscan") {
    return new ClamAvScanner(mode, process.env.MCA_DOCUMENT_SCANNER_COMMAND ?? mode)
  }
  return new UnavailableScanner()
}

import "server-only"

import { newId } from "../db"
import type { DealActor } from "../deals/schema"
import { documentScanner, scannerFailure, type ScanResult } from "../documents/scanner"
import { quarantineBucket, storageClient } from "../documents/storage"
import { AppError } from "../errors"
import { enqueueBackgroundJob, getBackgroundJob, inBackgroundWorker } from "./queue"

function assertClean(result: ScanResult): void {
  if (result.status === "infected") throw new AppError(422, "file_quarantined", "Security scanning rejected this file.")
  if (result.status !== "clean") throw scannerFailure(result.evidence, "Security scanning must succeed before this file is available.")
}

/** Generated assistant files stay private while a Render worker runs the native scanner. */
export async function scanOnWorker(actor: DealActor, filename: string, bytes: Buffer): Promise<void> {
  if (inBackgroundWorker()) { assertClean(await documentScanner().scan(bytes, filename)); return }
  const key = `${actor.workspaceId}/scans/${newId()}`
  const storage = storageClient().storage.from(quarantineBucket())
  const { error } = await storage.upload(key, bytes, { upsert: false, contentType: "application/octet-stream" })
  if (error) throw new AppError(503, "scanner_unavailable", "The file could not be staged for security scanning.")
  const job = await enqueueBackgroundJob({ actor, kind: "assistant_scan", resourceId: key, idempotencyKey: key, payload: { filename } })
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const current = await getBackgroundJob(actor, job.id)
    if (current.state === "complete") {
      await storage.remove([key])
      assertClean(JSON.parse(current.result_json ?? "{}") as ScanResult)
      return
    }
    if (current.state === "failed") throw new AppError(503, "scanner_unavailable", "Security scanning did not complete.")
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new AppError(503, "scanner_timeout", "Security scanning is taking longer than expected. Retry creating this file.")
}

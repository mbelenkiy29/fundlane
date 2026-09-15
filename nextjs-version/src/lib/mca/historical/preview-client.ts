import { z } from "zod"
import type { HistoricalImportPreview } from "./contracts"

const count = z.number().int().nonnegative()
const previewSchema: z.ZodType<HistoricalImportPreview> = z.object({
  runId: z.string().min(1),
  state: z.enum(["preview", "committed", "failed"]),
  previewRevision: z.number().int().positive(),
  rows: z.array(z.object({
    externalId: z.string(), funderName: z.string(), fundedAt: z.string(), amountCents: z.number(),
    duplicateReason: z.enum(["already_imported", "repeated_in_file"]).optional(),
    rowNumber: count, duplicate: z.boolean(), errors: z.array(z.string()),
  }).passthrough()),
  totals: z.object({
    rows: count, valid: count, invalid: count, duplicates: count,
    principalCents: count, expectedCommissionCents: count, paidCommissionCents: count, feeCents: count,
  }),
})

export function parseHistoricalPreview(payload: unknown): HistoricalImportPreview {
  const result = previewSchema.safeParse(payload)
  if (!result.success) throw new Error("The server returned an invalid preview. Retry with the same file, source and batch IDs.")
  return result.data
}

export function historicalResultMessage(result: import("./contracts").HistoricalImportResult): string {
  const summary = `${result.created} imported; ${result.duplicates} duplicates skipped; ${result.invalid} invalid; ${result.failed} failed.`
  if (result.failed) return `${summary} Retry to finish the failed rows safely.`
  if (!result.created) return `No new records imported. ${summary}`
  return `${summary} Original funding dates were preserved.`
}

export function historicalRowMessage(row: import("./contracts").HistoricalRowPreview): string {
  const duplicate = row.duplicate ? row.duplicateReason === "repeated_in_file" ? "Repeated external ID in this file." : "Already imported." : ""
  return [duplicate, ...row.errors].filter(Boolean).join(" ")
}

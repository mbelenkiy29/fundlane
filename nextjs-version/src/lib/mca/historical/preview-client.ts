import { z } from "zod"
import type { HistoricalImportPreview } from "./contracts"

const count = z.number().int().nonnegative()
const previewSchema: z.ZodType<HistoricalImportPreview> = z.object({
  runId: z.string().min(1),
  state: z.enum(["preview", "committed", "failed"]),
  previewRevision: z.number().int().positive(),
  rows: z.array(z.object({
    externalId: z.string(), funderName: z.string(), fundedAt: z.string(), amountCents: z.number(),
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

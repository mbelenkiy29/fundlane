import { requestJson } from "../client"
import type { HistoricalImportPreview, HistoricalImportResult } from "./contracts"

export async function commitHistoricalPreview(preview: HistoricalImportPreview): Promise<HistoricalImportResult> {
  try {
    return await requestJson<HistoricalImportResult>(`/api/mca/historical/${encodeURIComponent(preview.runId)}/commit`, {
      method: "POST",
      body: JSON.stringify({ expectedPreviewRevision: preview.previewRevision }),
      signal: AbortSignal.timeout(180_000),
    })
  } catch (error) {
    if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) {
      throw new Error("The import is taking longer than expected. Its outcome is not yet confirmed. Retry this preview to safely check or finish the same import.")
    }
    throw error
  }
}

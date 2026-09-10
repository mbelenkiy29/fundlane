export interface DataMerchConfig {
  workspaceId: string
  enabled: boolean
  hasCredential: boolean
  lastDiagnostic?: string
}

export interface DataMerchCheck {
  id: string
  dealId: string
  dealVersion: number
  status: "queued" | "no_result" | "records" | "failed"
  correlationId: string
  resultSummary?: string
  recordCount: number
  createdAt: string
}

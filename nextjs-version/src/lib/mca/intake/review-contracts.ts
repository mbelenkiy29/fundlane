import type { DocumentSummary } from "../documents/contracts"
import type { IntakeProgress } from "./processing-contracts"

export interface ApplicationNotice {
  id: string
  intakeId: string
  merchantName: string
  state: string
  message?: string
  createdAt: string
  readAt: string | null
}

export interface ApplicationReview {
  intakeId: string
  dealId: string | null
  merchantName: string
  receivedAt: string
  provider: string
  originalAnswersAvailable: boolean
  answers: Array<{ key: string; label: string; value: string }>
  documents: DocumentSummary[]
  progress: IntakeProgress | null
  message?: string
  summary: {
    reportedMonthlyRevenue: number | null
    statementMonthlyRevenue: number | null
    industry: string | null
    requestedAmount: number | null
    warnings: string[]
    missing: string[]
    stale: boolean
    analyzedAt: string | null
  }
  candidates: Array<{ id: string; name: string; rank: number; score: number; grade: string; eligible: boolean; reasons: string[] }>
  canPrepare: boolean
  canRetry: boolean
  jobs: Array<{ jobId: string; displayFunderName: string; state: string; reason?: string }>
}

export interface ApplicationSubmissionPreview {
  id: string
  expiresAt: string
  destinations: Array<{
    funderId: string
    name: string
    method: string
    providerReadiness?: string
    destination: string
    documents: Array<{ id: string; filename: string }>
    email?: { from: string; to: string[]; cc: string[]; replyTo: string; subject: string; body: string }
    errors: string[]
  }>
}

import "server-only"

import { isDocumentReady, type DocumentSummary } from "../documents/contracts"
import type { FunderRoute } from "../funders/contracts"
import type { AttemptState, JobState, OutgoingDocument, QueuedJobSummary, SubmissionJob } from "./contracts"

export const MISSING_ROUTE: FunderRoute = {
  id: "missing-route",
  kind: "email",
  label: "Missing route",
  destination: "",
  documentExceptions: [],
  active: false,
}

export function activeRoute(routes: FunderRoute[]): FunderRoute | undefined {
  return routes.find((route) => route.active)
}

export function displayName(funder: { legalName: string; nickname?: string }): string {
  return funder.nickname?.trim() || funder.legalName
}

export function freezeDocumentVersions(documents: DocumentSummary[]): SubmissionJob["documentVersions"] {
  return documents.map((document) => ({
    documentId: document.id,
    checksum: document.checksum,
    category: document.category,
  }))
}

export function originalsForRoute(documents: DocumentSummary[], route: FunderRoute): OutgoingDocument[] {
  const excluded = new Set(route.documentExceptions.map((item) => item.toLowerCase()))
  return documents
    .filter((document) => isDocumentReady(document.processingState) && !excluded.has(document.category.toLowerCase()))
    .map((document) => ({
      documentId: document.id,
      originalDocumentId: document.id,
      checksum: document.checksum,
      byteLength: document.byteLength,
      stage: "original" as const,
    }))
}

export function checklistForRoute(documents: DocumentSummary[], route: FunderRoute | null) {
  const excluded = new Set((route?.documentExceptions ?? []).map((item) => item.toLowerCase()))
  return documents.map((document) => ({
    documentId: document.id,
    filename: document.displayFilename,
    category: document.category,
    checksum: document.checksum,
    excluded: excluded.has(document.category.toLowerCase()),
  }))
}

export function toQueuedSummary(job: SubmissionJob): QueuedJobSummary {
  return {
    jobId: job.id,
    funderId: job.funderId,
    state: job.state,
    reason: job.reason,
  }
}

export function toAttemptState(state: JobState): AttemptState {
  if (state === "sent") return "sent"
  if (state === "failed" || state === "preflight_failed" || state === "blocked_duplicate") return "failed"
  if (state === "skipped") return "skipped"
  return "queued"
}

export function reasonFromErrors(errors: Array<{ field: string; message: string }>, fallback: string): string {
  return errors[0]?.message ?? fallback
}

import "server-only"

import { AppError } from "../../../errors"
import type { AdapterStatusResult, AdapterSubmitResult, FunderAdapter, SubmissionJob } from "../../contracts"
import {
  KAPITUS_SLUG,
  kapitusCorrelationId,
  kapitusEventId,
  kapitusExternalRef,
  resolveKapitusScenario,
  scenarioStatus,
  scenarioTerms,
  type KapitusFixtureScenario,
} from "./fixtures"
import { mapKapitusStatus, validateKapitusApplication, validateKapitusJobDocuments } from "./mapping"

export {
  KAPITUS_FIXTURE_TRANSPORT,
  KAPITUS_SLUG,
  kapitusAcceptedApplication,
  type KapitusFixtureScenario,
} from "./fixtures"
export {
  kapitusResultContainsSecret,
  mapKapitusApplication,
  mapKapitusStatus,
  selectPrimaryOwner,
  validateKapitusApplication,
} from "./mapping"

export interface KapitusDocumentReceipt {
  kind: "signed_application" | "bank_statement"
  documentId: string
  checksum: string
  received: true
}

export interface KapitusStoredAttempt {
  attemptKey: string
  externalRef?: string
  submitResult: AdapterSubmitResult
  providerSubmissions: number
  documentReceipts: KapitusDocumentReceipt[]
}

const attempts = new Map<string, KapitusStoredAttempt>()
let fixtureOverride: KapitusFixtureScenario | undefined

export function setKapitusFixtureOverride(scenario?: KapitusFixtureScenario): void {
  fixtureOverride = scenario
}

export function resetKapitusAdapterState(): void {
  attempts.clear()
  fixtureOverride = undefined
}

export function getKapitusAttempt(attemptKey: string): KapitusStoredAttempt | undefined {
  return attempts.get(attemptKey)
}

function scenarioFor(job: SubmissionJob): KapitusFixtureScenario {
  return resolveKapitusScenario(job.route.destination, fixtureOverride)
}

function documentReceipts(job: SubmissionJob): KapitusDocumentReceipt[] {
  const receipts: KapitusDocumentReceipt[] = []
  for (const document of job.documentVersions) {
    if (document.category === "application") {
      receipts.push({
        kind: "signed_application",
        documentId: document.documentId,
        checksum: document.checksum,
        received: true,
      })
    }
    if (document.category === "statement") {
      receipts.push({
        kind: "bank_statement",
        documentId: document.documentId,
        checksum: document.checksum,
        received: true,
      })
    }
  }
  return receipts
}

function receiptFields(receipts: KapitusDocumentReceipt[]): Record<string, string> {
  const signed = receipts.find((item) => item.kind === "signed_application")
  const statement = receipts.find((item) => item.kind === "bank_statement")
  return {
    signedApplication: signed ? "received" : "missing",
    bankStatements: statement ? "received" : "missing",
    documentCount: String(receipts.length),
    ...(signed?.checksum ? { signedApplicationChecksum: signed.checksum } : {}),
    ...(statement?.checksum ? { bankStatementChecksum: statement.checksum } : {}),
  }
}

function remember(attempt: KapitusStoredAttempt): AdapterSubmitResult {
  attempts.set(attempt.attemptKey, attempt)
  return attempt.submitResult
}

export const kapitusAdapter: FunderAdapter = {
  slug: KAPITUS_SLUG,
  capabilities: { submit: true, statusPoll: true, webhooks: false, offers: true },
  validate: validateKapitusApplication,
  async submit(job) {
    const existing = attempts.get(job.attemptKey)
    if (existing) return existing.submitResult

    const scenario = scenarioFor(job)
    const correlationId = kapitusCorrelationId(job.attemptKey)

    if (scenario === "expired-credential") {
      return remember({
        attemptKey: job.attemptKey,
        providerSubmissions: 0,
        documentReceipts: [],
        submitResult: {
          ok: false,
          correlationId,
          errorCode: "expired_credential",
          errorMessage: "Kapitus credentials are expired. Update the client id and client secret for this environment.",
          fields: { credentials: "Kapitus client credentials are expired for this environment." },
        },
      })
    }

    if (scenario === "timeout") {
      const externalRef = kapitusExternalRef(job.attemptKey)
      return remember({
        attemptKey: job.attemptKey,
        externalRef,
        providerSubmissions: 1,
        documentReceipts: [],
        submitResult: {
          ok: false,
          correlationId,
          externalRef,
          errorCode: "timeout",
          errorMessage: "The Kapitus request timed out before an underwriting decision.",
          fields: { timeout: "Retry using the same attempt key. A second application was not created." },
        },
      })
    }

    const documentErrors = validateKapitusJobDocuments(job.documentVersions)
    if (Object.keys(documentErrors).length) {
      return {
        ok: false,
        correlationId,
        errorCode: "validation_failed",
        errorMessage: "Review the highlighted fields.",
        fields: documentErrors,
      }
    }

    const receipts = documentReceipts(job)
    const externalRef = kapitusExternalRef(job.attemptKey)
    return remember({
      attemptKey: job.attemptKey,
      externalRef,
      providerSubmissions: 1,
      documentReceipts: receipts,
      submitResult: {
        ok: true,
        correlationId,
        externalRef,
        rawStatus: "Application Received",
        fields: receiptFields(receipts),
      },
    })
  },
  async getStatus(job) {
    const scenario = scenarioFor(job)
    if (scenario === "expired-credential") {
      throw new AppError(401, "expired_credential", "Kapitus credentials are expired. Update the client id and client secret for this environment.", {
        credentials: ["Kapitus client credentials are expired for this environment."],
      })
    }
    if (scenario === "timeout") {
      const stored = attempts.get(job.attemptKey)
      throw new AppError(503, "timeout", "The Kapitus status request timed out.", {
        ...(stored?.externalRef ? { externalRef: [stored.externalRef] } : {}),
      })
    }

    const stored = attempts.get(job.attemptKey)
    const rawStatus = scenario === "accepted" || scenario === "document-receipt"
      ? stored?.submitResult.rawStatus || "Application Received"
      : scenarioStatus(scenario) || "Application Received"
    const mapped = mapKapitusStatus(rawStatus)
    const terms = mapped.normalized === "approved" || mapped.normalized === "funded"
      ? scenarioTerms(scenario)
      : undefined
    const result: AdapterStatusResult = {
      rawStatus: mapped.rawStatus,
      normalized: mapped.normalized,
      correlationId: stored?.submitResult.correlationId || kapitusCorrelationId(job.attemptKey),
      eventId: kapitusEventId(job.attemptKey, mapped.rawStatus),
      unknown: mapped.unknown,
      ...(terms ? { terms } : {}),
    }
    return result
  },
}

export default kapitusAdapter

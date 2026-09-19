import "server-only"

import type { DealActor } from "../deals/schema"
import type { DocumentSummary } from "../documents/contracts"
import { AppError } from "../errors"
import type { FunderRecord, FunderRoute } from "../funders/contracts"
import { getFunder } from "../funders/directory"
import { assertSenderUsable, listSenders } from "../senders/service"
import { activeRoute, displayName, MISSING_ROUTE, originalsForRoute } from "./jobs"
import type { OutgoingDocument } from "./contracts"

export interface PreflightError {
  field: string
  message: string
}

export interface PreflightWarning {
  field: string
  message: string
  severity: "warning"
}

export interface SenderProbe {
  senderId?: string
  error?: PreflightError
}

export interface DestinationPreflight {
  funder?: FunderRecord
  displayName: string
  route: FunderRoute
  errors: PreflightError[]
  warnings: PreflightWarning[]
  originals: OutgoingDocument[]
}

export function dataMerchPreflightWarnings(check?: { status?: string; resultSummary?: string } | null): PreflightWarning[] {
  if (check?.status !== "records") return []
  const summary = check.resultSummary?.trim()
  return [{
    field: "datamerch",
    message: summary ? `DataMerch records: ${summary}` : "DataMerch returned records for this merchant.",
    severity: "warning",
  }]
}

export async function probeSubmissionSender(actor: DealActor): Promise<SenderProbe> {
  try {
    const listed = await listSenders(actor)
    const candidates = listed.senders.filter((sender) => sender.purpose === "submission" && sender.state === "verified" && sender.hasCredential)
    const preferred = candidates.find((sender) => sender.isDefault) ?? candidates[0]
    if (!preferred) {
      return { error: { field: "sender", message: "Connect and verify a submission email sender before sending by email." } }
    }
    await assertSenderUsable(actor, preferred.id, "submission")
    return { senderId: preferred.id }
  } catch (error) {
    const message = error instanceof AppError ? error.message : "A verified submission email sender is required."
    return { error: { field: "sender", message } }
  }
}

export async function loadFunderForDestination(actor: DealActor, funderId: string): Promise<FunderRecord | undefined> {
  try {
    return await getFunder(actor, funderId)
  } catch (error) {
    if (error instanceof AppError && error.status === 404) return undefined
    throw error
  }
}

export function preflightDestination(input: {
  funder?: FunderRecord
  documents: DocumentSummary[]
  sender: SenderProbe
  dataMerch?: { status?: string; resultSummary?: string } | null
}): DestinationPreflight {
  const errors: PreflightError[] = []
  const warnings = dataMerchPreflightWarnings(input.dataMerch)
  if (!input.funder) {
    return {
      displayName: "Unknown funder",
      route: MISSING_ROUTE,
      errors: [{ field: "funderId", message: "The requested funder was not found." }],
      warnings,
      originals: [],
    }
  }
  if (!input.funder.active) {
    errors.push({ field: "funderId", message: "Inactive funders cannot be selected for new targeting." })
  }
  const route = activeRoute(input.funder.routes)
  if (!route) {
    errors.push({ field: "route", message: "This funder has no active submission route." })
  }
  const selected = route ?? input.funder.routes[0] ?? MISSING_ROUTE
  if (selected.kind === "email") {
    if (input.sender.error) errors.push(input.sender.error)
  }
  const originals = originalsForRoute(input.documents, selected)
  if (!originals.length) {
    errors.push({ field: "documents", message: "No ready documents are available to send." })
  }
  return {
    funder: input.funder,
    displayName: displayName(input.funder),
    route: selected,
    errors,
    warnings,
    originals,
  }
}

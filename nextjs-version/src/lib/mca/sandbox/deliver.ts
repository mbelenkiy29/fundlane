import "server-only"

import { getDatabase, newId } from "../db"
import type { DealActor } from "../deals/schema"
import { findFunderById } from "../funders/directory-repository"
import { createOffer } from "../offers/service"
import type { DeliverResult, SubmissionJob } from "../submissions/contracts"
import {
  SANDBOX_LEGAL_NAME,
  SANDBOX_PRODUCT,
  isSandboxDestination,
  isSandboxFunder,
  sandboxDeclineRequested,
} from "./labels"

function sandboxActor(job: SubmissionJob): DealActor {
  return {
    workspaceId: job.workspaceId,
    userId: null,
    membershipId: null,
    role: null,
    managedMembershipIds: [],
    activeMembershipIds: [],
    source: "system",
    intakeDealId: job.dealId,
    correlationId: job.id,
  }
}

export function isSandboxSubmissionJob(job: Pick<SubmissionJob, "route">): boolean {
  return isSandboxDestination(job.route.destination)
}

async function loadDealLegalName(workspaceId: string, dealId: string): Promise<string> {
  const row = await getDatabase()
    .prepare<{ legal_name: string | null }>("SELECT legal_name FROM deals WHERE workspace_id = ? AND id = ?")
    .get(workspaceId, dealId)
  return row?.legal_name ?? ""
}

export async function deliverSandboxSubmission(job: SubmissionJob): Promise<DeliverResult> {
  const funder = await findFunderById(job.workspaceId, job.funderId)
  if (!funder || !isSandboxFunder(funder)) {
    return {
      ok: false,
      state: "failed",
      correlationId: newId(),
      errorCode: "sandbox_funder_mismatch",
      errorMessage: "Sandbox delivery is reserved for the workspace sandbox funder.",
    }
  }
  if (funder.workspaceId !== job.workspaceId) {
    return {
      ok: false,
      state: "failed",
      correlationId: newId(),
      errorCode: "sandbox_workspace_mismatch",
      errorMessage: "Sandbox delivery cannot leave this workspace.",
    }
  }

  const legalName = await loadDealLegalName(job.workspaceId, job.dealId)
  if (sandboxDeclineRequested(legalName)) {
    return {
      ok: true,
      state: "declined",
      correlationId: newId(),
      externalRef: `sandbox:decline:${job.id}`,
      errorMessage: "[SANDBOX] Synthetic decline — not a real underwriting decision. Remove SANDBOX-DECLINE from the deal name to receive a sample offer.",
    }
  }

  const offer = await createOffer(sandboxActor(job), {
    dealId: job.dealId,
    submissionId: job.id,
    funderId: funder.id,
    funderName: SANDBOX_LEGAL_NAME,
    source: "manual",
    externalId: `sandbox:${job.id}`,
    terms: {
      product: SANDBOX_PRODUCT,
      amountCents: 5_000_000,
      factorRate: 1.35,
      buyRate: 1.28,
      termMonths: 8,
      paymentAmountCents: 210_938,
      paymentFrequency: "weekly",
      feeCents: 0,
      commissionCents: 0,
      stipulations: [
        "SYNTHETIC SANDBOX OFFER — not a real lender commitment.",
        "No email, SMS, or external HTTP was sent.",
      ],
    },
  })

  return {
    ok: true,
    state: "sent",
    correlationId: newId(),
    externalRef: `sandbox:offer:${offer.id}`,
  }
}

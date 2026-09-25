import "server-only"

import { createHash } from "node:crypto"
import type { AdapterStatusResult, FunderSubmissionAdapter, SubmissionJob } from "../contracts"
import type { AdapterSecretValues } from "./contracts"

export interface SandboxApplication {
  applicationId: string
}

export interface SandboxPayload {
  dealId: string
  applicationId: string
  funderId: string
  attemptKey: string
}

function externalRef(job: SubmissionJob): string {
  return `sandbox-${createHash("sha256").update(`${job.workspaceId}:${job.attemptKey}`).digest("hex").slice(0, 20)}`
}

export const sandboxAdapter: FunderSubmissionAdapter<AdapterSecretValues, SandboxApplication, SandboxPayload> = {
  slug: "sandbox",
  readiness: "sandbox",
  capabilities: { submit: true, statusPoll: true, webhooks: false, offers: false },
  validateConfig: () => ({ ok: true }),
  validate(input) {
    if (!input || typeof input !== "object" || typeof (input as SandboxApplication).applicationId !== "string" || !(input as SandboxApplication).applicationId.trim()) {
      return { ok: false, fields: { applicationId: "Enter an application ID." } }
    }
    return { ok: true }
  },
  mapSubmission(job, application) {
    return { dealId: job.dealId, applicationId: application.applicationId, funderId: job.funderId, attemptKey: job.attemptKey }
  },
  normalizeStatus(rawStatus): AdapterStatusResult["normalized"] {
    return rawStatus === "accepted" ? "submitted" : rawStatus === "rejected" ? "declined" : "unknown"
  },
  async submit(job) {
    const validation = this.validate({ applicationId: job.dealId })
    if (!validation.ok) return { ok: false, correlationId: job.id, errorCode: "validation_failed", fields: validation.fields }
    const payload = this.mapSubmission(job, { applicationId: job.dealId })
    return { ok: true, correlationId: job.id, externalRef: externalRef(job), rawStatus: "accepted", fields: { applicationId: payload.applicationId } }
  },
  async getStatus(job) {
    return { rawStatus: "accepted", normalized: "submitted", correlationId: job.id, eventId: `sandbox-status-${externalRef(job)}`, unknown: false }
  },
}

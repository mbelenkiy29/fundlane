import "server-only"

import { newId } from "../../../db"
import type { AdapterCapabilities, AdapterSubmitResult, FunderAdapter, SubmissionJob } from "../../contracts"
import { adapterRuntime, redactAdapterSecrets } from "../credentials"
import {
  accountIdForAttempt,
  acceptedChannelPartnersCapitalSubmission,
  applicationForChannelPartnersCapitalFixture,
  CHANNEL_PARTNERS_CAPITAL_EXPIRED_API_KEY,
  CHANNEL_PARTNERS_CAPITAL_SLUG,
  documentReceiptsField,
  rememberChannelPartnersCapitalSubmission,
  resolveChannelPartnersCapitalFixture,
  type ChannelPartnersCapitalFixture,
} from "./fixtures"
import {
  documentsFromJob,
  mapChannelPartnersCapitalRequest,
  validateChannelPartnersApplication,
} from "./mapping"

export const CHANNEL_PARTNERS_CAPITAL_CAPABILITIES = {
  submit: true,
  statusPoll: false,
  webhooks: false,
  offers: false,
} as const satisfies AdapterCapabilities

function correlationIdFor(job: SubmissionJob): string {
  return adapterRuntime()?.correlationId || job.id || newId()
}

function finalize(result: AdapterSubmitResult): AdapterSubmitResult {
  return redactAdapterSecrets(result, adapterRuntime()?.secrets ?? {})
}

function failed(
  job: SubmissionJob,
  errorCode: string,
  errorMessage: string,
  fields?: Record<string, string>,
): AdapterSubmitResult {
  return finalize({
    ok: false,
    correlationId: correlationIdFor(job),
    errorCode,
    errorMessage,
    fields,
  })
}

async function submitChannelPartnersCapital(job: SubmissionJob): Promise<AdapterSubmitResult> {
  const prior = acceptedChannelPartnersCapitalSubmission(job.attemptKey)
  if (prior) return finalize({ ...prior.result, correlationId: prior.result.correlationId })

  const fixture: ChannelPartnersCapitalFixture = resolveChannelPartnersCapitalFixture(job)
  const runtime = adapterRuntime()
  if (fixture === "expired" || runtime?.secrets.apiKey === CHANNEL_PARTNERS_CAPITAL_EXPIRED_API_KEY) {
    return failed(job, "expired_credential", "The Channel Partners Capital API credentials have expired. Update the workspace credential slot.")
  }
  if (fixture === "timeout") {
    return failed(job, "provider_unavailable", "The Channel Partners Capital request timed out before an Account ID was returned.")
  }

  const validated = validateChannelPartnersApplication(applicationForChannelPartnersCapitalFixture(fixture))
  if (!validated.ok) {
    return failed(job, "validation_failed", "Review the highlighted fields.", validated.fields)
  }

  const documents = documentsFromJob(job)
  const request = mapChannelPartnersCapitalRequest(validated.value, job, documents)
  const accountId = accountIdForAttempt(job.attemptKey)
  const response = {
    accountId,
    status: "Sent" as const,
    documents: documents.map((document) => ({ ...document, received: true as const })),
  }
  const result = finalize({
    ok: true,
    correlationId: correlationIdFor(job),
    externalRef: accountId,
    rawStatus: response.status,
    fields: {
      documentReceipt: documents.length ? "accepted" : "none",
      documentsReceived: String(documents.length),
      ...(documents.length ? { documentReceipts: documentReceiptsField(documents) } : {}),
    },
  })
  rememberChannelPartnersCapitalSubmission({ request, response, result })
  return result
}

export const channelPartnersCapitalAdapter: FunderAdapter = {
  slug: CHANNEL_PARTNERS_CAPITAL_SLUG,
  capabilities: CHANNEL_PARTNERS_CAPITAL_CAPABILITIES,
  validate(input) {
    const validated = validateChannelPartnersApplication(input)
    return validated.ok ? { ok: true } : { ok: false, fields: validated.fields }
  },
  submit: submitChannelPartnersCapital,
}

export {
  CHANNEL_PARTNERS_CAPITAL_EXPIRED_API_KEY,
  CHANNEL_PARTNERS_CAPITAL_SLUG,
  lastChannelPartnersCapitalSubmission,
  resetChannelPartnersCapitalAdapterForTests,
  setChannelPartnersCapitalFixtureForTests,
} from "./fixtures"

export {
  documentsFromJob,
  mapChannelPartnersCapitalRequest,
  validateChannelPartnersApplication,
} from "./mapping"

export default channelPartnersCapitalAdapter

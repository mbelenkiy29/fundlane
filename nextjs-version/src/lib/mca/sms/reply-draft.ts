/** Client draft state: a reserved attempt always retains the exact body and key. */
export type SmsReplyDraft = { body: string; idempotencyKey?: string }

export function editSmsReplyDraft(draft: SmsReplyDraft, body: string): SmsReplyDraft {
  return draft.idempotencyKey ? draft : { body }
}

export function reserveSmsReplyDraft(draft: SmsReplyDraft, key: string): SmsReplyDraft {
  return draft.idempotencyKey ? draft : { ...draft, idempotencyKey: key }
}

export function settleSmsReplyDraft(draft: SmsReplyDraft, state?: string): SmsReplyDraft {
  return ["accepted", "sent", "delivered"].includes(state ?? "") ? { body: "" } : draft
}

/** A rejection of a retry cannot establish the outcome of its earlier request. */
export function rejectSmsReplyDraft(
  draft: SmsReplyDraft,
  code: string | undefined,
  wasRetry: boolean
): SmsReplyDraft {
  const rejectedBeforeDispatch = [
    "sms_recipient_opted_out", "sms_consent_required", "sms_setup_incomplete",
    "sms_route_unavailable", "sms_account_not_found", "sms_account_not_assigned",
    "recipient_deal_mismatch", "employee_inactive", "sms_us_only",
  ].includes(code ?? "")
  return !wasRetry && rejectedBeforeDispatch ? { body: draft.body } : draft
}

/** A failed conversation refresh cannot change the outcome of a completed POST. */
export async function postSmsReplyAndRefresh<T>(input: {
  post: () => Promise<T>
  onResult: (result: T) => boolean
  onPostError: (error: unknown) => void
  refresh: () => Promise<void>
  onRefreshError: (error: unknown) => void
}): Promise<void> {
  let result: T
  try {
    result = await input.post()
  } catch (error) {
    input.onPostError(error)
    return
  }
  if (!input.onResult(result)) return
  try {
    await input.refresh()
  } catch (error) {
    input.onRefreshError(error)
  }
}

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

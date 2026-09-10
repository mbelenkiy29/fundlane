# MIC-156 acceptance

Linear: https://linear.app/michael-belenkiy/issue/MIC-156/sms-account-routing-and-direct-merchant-texting

## Boxes

| Criterion | Result | Evidence |
| --- | --- | --- |
| A rep cannot send through an unassigned account | Pass | Service and `POST /api/mca/sms/messages` return `403 sms_account_not_assigned` when a rep selects an account assigned only to an admin. Preview uses the same route check. |
| An opted-out merchant is blocked from outreach | Pass | After a later opt-out event, send throws `sms_recipient_opted_out`. Preview returns `canSend: false` with the same code. Consent is rechecked while the account row is locked. |
| Realistic synthetic scenario with expected output | Pass | Assigned Twilio send of `Exact synthetic composer preview` is accepted once (`SM` identity, one transport call). Replay of the same idempotency key returns the same `messageId`. An `entrance` account persists `provider=entrance` and fails closed through `getSmsAdapter` with `sms_provider_unavailable`. |
| Loading, empty, validation, success and failure; retries preserve identity | Pass | `smsComposerGate` covers loading / empty / blocked / validation / ready. Composer copy includes loading, empty, validation, `role="alert"` failure, and `role="status"` success. Send retries keep `sendKey.current` until accepted. |
| Direct API permissions match the UI; logs/responses exclude secrets | Pass | Composer GET is deals-scoped (works with integrations page disabled, blocked when deals is disabled). Unassigned HTTP POST is 403. Composer context and preview JSON do not contain Twilio API secrets or the env JSON blob. |

## Expected synthetic output

- Unassigned send: `{ status: 403, error.code: "sms_account_not_assigned" }`
- Opted-out send: `{ status: 409, error.code: "sms_recipient_opted_out" }`
- Recipient mismatch: `{ status: 422, error.code: "recipient_deal_mismatch" }`
- Entrance adapter send: stored row `{ provider: "entrance", state: "failed", error_code: "sms_provider_unavailable" }`
- Twilio preview/send: `{ canSend: true, provider: "twilio" }` then `{ state: "accepted", messageId, externalId: "SM…" }` with one provider call on retry

## Remaining gate

Live Twilio account and handset delivery. Do not treat fixture acceptance as production integration readiness.

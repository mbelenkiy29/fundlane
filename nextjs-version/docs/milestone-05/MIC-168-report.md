# MIC-168 report — Email or text offers and record merchant pitch

Status: **software extract complete**. Linear remains In Progress. Do not mark Done.

## What changed

Merchant offer SMS mapping was copied out of `closing/service.ts` into the exclusive module `src/lib/mca/closing/offer-sms.ts`. The new export is a `ClosingTransport` that calls existing `deliverClosingSms` (which already uses `getSmsAdapter`) and maps `SmsDeliveryResult` to `ClosingTransportResult`.

Required export:

```ts
export function createMerchantOfferSmsTransport(
  actor: DealActor,
  dealId: string,
  transport?: TwilioSmsTransport,
): ClosingTransport
```

Copied behavior from `merchantSmsTransport` / `smsTransportResult` in `closing/service.ts` (584–613):

- `deliver(request)` calls `deliverClosingSms` with `deliveryMode: "never_attempted"` and the optional `TwilioSmsTransport` override.
- `reconcile(request)` uses `deliveryMode: "reconcile_only"`.
- `accepted` + `externalId` → `{ state: "sent", correlationId, externalId }`.
- `failed` → `{ state: "failed", errorCode, errorMessage }` (`sms_provider_rejected` fallback).
- else (unknown, or accepted without an id) → `{ state: "blocked", errorCode: "provider_outcome_unknown", ... }`.
- `AppError` from deliver/reconcile → `{ state: "failed", errorCode: error.code, errorMessage: error.message }`.
- Non-`AppError` throws are rethrown.

`TwilioSmsTransport` remains an optional third argument so existing `tests/milestone05-closing.test.ts` SMS fixtures stay green after the conductor replaces `merchantSmsTransport(...)` with this function. `deliverClosingSms` still routes non-override sends through `getSmsAdapter`.

A mapping helper `mapClosingSmsResult(request, result)` is exported so the unit tests can assert sent/failed/blocked without a live database. An optional fourth `deliverSms` argument exists only so those tests can inject a fake; the conductor should call the three-argument form.

Pitch recording was not moved. `sendMerchantOfferPreview` still records pitch rows only when `sent.state === "sent"`. Failed, blocked, and `AppError` outcomes from this transport are not `"sent"`.

## Files changed

- `src/lib/mca/closing/offer-sms.ts`
- `tests/milestone05-mic-168.test.ts`
- `docs/milestone-05/MIC-168-report.md`
- `docs/milestone-05/MIC-168-acceptance.md`

Did not edit: `closing/service.ts`, `closing-panel.tsx`, `sms/service.ts`, `sms/adapters/registry.ts`, schema, Linear.

## Tests

```
cd nextjs-version
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/milestone05-mic-168.test.ts
```

```
ℹ tests 10
ℹ pass 10
ℹ fail 0
duration_ms 248.164416
```

Covered without a live DB or live SMS/email:

- accepted + external id → `sent` (would record pitch after conductor wiring)
- failed adapter result → `failed`, not `sent`
- failed without provider details → fallback `sms_provider_rejected`
- unknown outcome → `blocked` / `provider_outcome_unknown`, not `sent`
- accepted without external id → `blocked`, not `sent`
- `deliver` uses `never_attempted` and forwards the Twilio override
- `reconcile` uses `reconcile_only`
- `AppError` in `deliver` → `failed`, not `sent`
- unexpected errors are not swallowed as sent or failed

No live SMS or email was sent.

## Remaining gate

Live merchant email/SMS to a controlled recipient/handset. Synthetic mapping success is not production send readiness.

## NEEDS_CONDUCTOR

Wire `createMerchantOfferSmsTransport` into `sendMerchantOfferPreview` in `closing/service.ts`. Replace `merchantSmsTransport(actor, String(row.deal_id), smsTransport)` with `createMerchantOfferSmsTransport(actor, String(row.deal_id), smsTransport)`. Keep the optional `TwilioSmsTransport` argument so existing closing SMS fixtures stay green. Do not mark Linear Done.

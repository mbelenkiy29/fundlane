# MIC-168 acceptance — Merchant offer SMS transport extract

Executed 2026-09-09. Scope: exclusive extract of merchant offer text delivery into `src/lib/mca/closing/offer-sms.ts`. Preview/pitch/consent software already existed in `closing/service.ts`. Conductor wiring of the export is still required.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| Focused mapping suite | 10/10 passed | `tests/milestone05-mic-168.test.ts` |
| accepted + external id → sent | Passed | `mapClosingSmsResult` and injected `deliver` |
| failed adapter → failed, not sent | Passed | failed mapping + `deliver` adapter failure |
| unknown / no id → blocked, not sent | Passed | unknown result and accepted-without-id |
| AppError in deliver → failed, not sent | Passed | injected `deliverClosingSms` throws `AppError` |
| deliver / reconcile modes | Passed | `never_attempted` vs `reconcile_only` |
| Twilio override forwarded | Passed | optional `TwilioSmsTransport` passed into `deliverClosingSms` |
| Pitch only on `state === "sent"` | Passed at mapping layer | failed/blocked/`AppError` never return `"sent"`; `sendMerchantOfferPreview` still gates pitch on `sent.state === "sent"` |
| Live SMS/email | Not performed | remaining provider gate |

Command:

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

## Behavior

- `createMerchantOfferSmsTransport(actor, dealId, transport?)` returns `ClosingTransport`.
- Delivery calls `deliverClosingSms`, which already uses `getSmsAdapter` for non-override sends. The optional Twilio transport is preserved for existing closing tests after conductor wiring.
- Mapping:
  - `state === "accepted"` and truthy `externalId` → `sent`
  - `state === "failed"` → `failed` (`errorCode` default `sms_provider_rejected`)
  - otherwise → `blocked` / `provider_outcome_unknown`
- `AppError` is failed with `error.code` / `error.message`. Other errors rethrow.
- `deliver` is a first attempt (`never_attempted`). `reconcile` is lookup-only (`reconcile_only`).
- Failed or unknown outcomes are not `"sent"`. After wiring, pitch events remain recorded only when `sendMerchantOfferPreview` sees `sent.state === "sent"`.

Existing lane-C scenarios in `tests/milestone05-closing.test.ts` still cover preview hash, commission exclusion, failed-email no pitch, successful multi-revision pitch, assigned SMS account, consent, exact preview body, Twilio acknowledgement, unknown-result unpitched, and reconcile-only retry. This ticket did not re-run that disposable-DB suite.

## Local vs live gates

Unit tests use an injected `deliverClosingSms` and `mapClosingSmsResult`. They do not open a database, call a provider, or send a message. They do not prove production Twilio/Postmark readiness.

Remaining gate: live merchant email/SMS to a controlled recipient/handset.

`NEEDS_CONDUCTOR`: wire `createMerchantOfferSmsTransport` into `sendMerchantOfferPreview`. Do not mark Linear Done.

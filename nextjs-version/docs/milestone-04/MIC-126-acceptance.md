# MIC-126 acceptance — Kapitus direct funder API integration

Executed September 8, 2026. Scope: Kapitus `FunderAdapter` with synthetic fixtures for required-field preflight, accepted submit, document receipt, asynchronous status/offer mapping, and idempotent retries. Live Kapitus APIs remain an external gate.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| Required-field rejection | Passed | `tests/adapters/kapitus.test.ts` — missing primary owner, annual revenue, requested amount, unsigned application, and bank statements return actionable field errors; complete fixture validates |
| Accepted submission is not approval | Passed | Submit `ok: true`, `rawStatus` `Application Received`, mapped `submitted` not `approved`; even an `approved` fixture still acknowledges as received |
| Document receipt | Passed | Signed application and bank statements marked `received` with job checksums; stored receipts have `received: true` |
| Delayed underwriting / closing mapping | Passed | Credit Review → pending; Closing / Closing Documents Missing → approved without invented terms; Funded → funded with terms; Declined / Expired → declined; `CREDIT_COMMITTEE_HOLD` stays unknown with original raw value |
| Offers only when terms exist | Passed | Approved/funded fixtures include amount/rate/term; acknowledgement, credit review, and closing have no terms |
| Timeouts, expired credentials, attemptKey replay | Passed | Timeout reserves `kapitus-app-<attemptKey>` and replay keeps one `providerSubmissions`; expired credentials have no external ref and `providerSubmissions` 0; accepted replay returns the same correlation id and ref |
| Loading / empty / validation / success / failure | Passed | Empty payload → field errors; missing job documents → `validation_failed` then a corrected retry succeeds; accepted submit success; timeout/expired failure messages |
| Capability flags match implementation | Passed | `{ submit: true, statusPoll: true, webhooks: false, offers: true }`; `getStatus` present; `parseWebhook` undefined |
| Secrets and sensitive contents omitted | Passed | Submit/status results do not echo owner SSN; error fields do not include credential values or document bytes |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/adapters/kapitus.test.ts
```

5/5 passed.

## Behavior

- Primary owner is the highest ownership percentage. Only that owner is mapped.
- Gross annual revenue accepts `annualRevenue`, `grossAnnualRevenue`, or `monthlyRevenue * 12`. Amount must be > 0.
- Signed application is `kind: signed_application` or `category: application` with `signed: true` on validate, and job `category: application` on submit. Bank statements are `statement`.
- First provider acknowledgement is `Application Received` (submitted). Closing states are approved, not funded.
- `attemptKey` is the idempotency key. Validation failures are not stored, so a corrected package can reuse the key. Timeout/success/expired outcomes are stored and replayed.
- Direct adapter methods do not call the network. Logs and result payloads omit SSN and credential secrets.

## Local vs live gates

Local fixtures prove validation, acknowledgement-vs-approval, document receipt, status/offer mapping, and identity-preserving retries. Commercial Kapitus sandbox credentials, current endpoint contract, product codes, and live document upload are not production-verified. Mock success is not production integration readiness.

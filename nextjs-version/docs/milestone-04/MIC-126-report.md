# MIC-126 report — Kapitus direct funder API integration

**Status:** DONE locally with synthetic fixtures. Commercial Kapitus sandbox credentials and the live request/response contract remain an external gate.

## Contract

`kapitusAdapter` implements `FunderAdapter` with slug `kapitus` and honest capabilities `{ submit: true, statusPoll: true, webhooks: false, offers: true }`. `getStatus` is implemented. `parseWebhook` is omitted.

`validate` returns field errors for the public-guide required set, including primary owner (highest ownership percentage), gross annual revenue, requested amount, signed application, and bank statements. Secondary owners are not mapped.

`submit` is fixture-driven (`job.route.destination` or `setKapitusFixtureOverride`). A successful acknowledgement is always `Application Received` / submitted — never approved. Signed application and bank-statement receipts are recorded from job document versions. Timeouts reserve one external ref for the `attemptKey`. Expired credentials return `expired_credential` and create no application. Replay of the same `attemptKey` returns the first result and does not increment `providerSubmissions`.

`getStatus` maps delayed underwriting and closing states from the public guide. Closing states normalize to approved, not funded. Terms are returned only for approved/funded fixtures that include them. Unknown raw values stay `unknown: true` with the original string.

No live HTTP. Transport is `fixture://kapitus/applications`. Client id / client secret are expected later from `submitViaAdapter` runtime (MIC-124). Product codes are not published in the public guide and stay unresolved.

## Tests

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/adapters/kapitus.test.ts
```

5/5 passed.

Covered: required-field rejection (primary owner, annual revenue, amount, unsigned application); accepted submit + document receipt + acknowledgement is not approval + primary owner only + SSN omitted from results; status mapping for received/pending/closing/funded/declined/unknown with offers only when terms exist; timeout reserved ref, expired credentials with no ref, attemptKey replay; capability flags.

## Files

- `src/lib/mca/submissions/adapters/kapitus/index.ts`
- `src/lib/mca/submissions/adapters/kapitus/mapping.ts`
- `src/lib/mca/submissions/adapters/kapitus/fixtures.ts`
- `tests/adapters/kapitus.test.ts`
- `docs/milestone-04/MIC-126-report.md`
- `docs/milestone-04/MIC-126-acceptance.md`

Did not edit `registry.ts`, schema, drizzle, or shared mounts.

## Remaining gates

Commercial provider sandbox access, current Kapitus request/response schemas, mandatory product codes, and live document transport. Fixture success is not production integration readiness.

## Handoff

Register `kapitusAdapter` from `src/lib/mca/submissions/adapters/kapitus` in `registry.ts`. Route destination should be `kapitus`. Status poll + offer reconciliation can consume `getStatus`; do not enable webhooks for this slug.

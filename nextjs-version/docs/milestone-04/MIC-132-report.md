# MIC-132 report — Fundomate adapter

**Status:** DONE locally with synthetic fixtures. Commercial Fundomate sandbox access remains an external gate.

## Contract

`fundomateAdapter` (`slug: fundomate`) implements `FunderAdapter` with `validate` and `submit` only. Capabilities are honest: `submit: true`, `statusPoll: false`, `webhooks: false`, `offers: false`. There is no `getStatus` or `parseWebhook`. `assertStatusPollAllowed` / `getStatusViaAdapter` therefore 409 `capability_unsupported`. The public guide documents submit-only acknowledgement without API status updates or offers; later outcomes are email/manual review. Financial terms are never invented.

`validate` requires business identity (name, address, business email, 9-digit EIN with dashes stripped, start month/year, ownership type, industry), at least one owner (name, address, 9-digit SSN; email/phone/DOB recommended only), signed merchant application, and bank statements. Texas merchants also require a requested funding amount greater than zero. Ownership type and industry map onto unpublished Fundomate category labels used by this adapter (`LLC` / `Corporation` / `S-Corporation` / `Partnership` / `Sole Proprietor` / `Other`, plus a closed industry set). Official provider codes remain a remaining gate.

`submit(job)` is fixture-backed (keyed by `job.route.destination` or `setFundomateFixture`) and idempotent on `job.attemptKey`. Timeouts reserve the external reference `fm_<attemptKey>` and recover on replay. Expired credentials do not mint a new reference. Replay of a completed attempt returns the original `externalRef` and document receipt ids. Signed application / `api_application` and statement categories become `signed_application` and `bank_statements` receipts. Successful acknowledgement is raw status `Received`.

Secrets and owner SSNs are omitted from adapter results (mapped snapshot stores EIN digits and owner count, not SSN). The adapter does not call live HTTP, copy MCA Pilot endpoints, or embed sample provider credentials. Production vs development slots remain MIC-124. Tenant secrets are read from `adapterRuntime()` (`clientId` / `clientSecret` or expired fixture token).

## Tests

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/adapters/fundomate.test.ts
```

5/5 passed.

Covered: required-field rejection (including Texas amount, normalized EIN, signed application + statements, recommended owner fields optional); accepted submission with dashed EIN → 9 digits, `s_corporation` → S-Corporation, restaurant → Food Services, Texas amount, submit-only capabilities; document receipts stable on replay; timeout then recover without a second external ref; expired credential without a new submission; missing documents mint no ref; `assertStatusPollAllowed` 409.

## Files

- `src/lib/mca/submissions/adapters/fundomate/index.ts`
- `src/lib/mca/submissions/adapters/fundomate/mapping.ts`
- `src/lib/mca/submissions/adapters/fundomate/fixtures.ts`
- `tests/adapters/fundomate.test.ts`
- `docs/milestone-04/MIC-132-report.md`
- `docs/milestone-04/MIC-132-acceptance.md`

Did not edit `registry.ts`, `framework.ts`, `credentials.ts`, schema, or drizzle.

## Remaining gates

Commercial provider sandbox access, current Fundomate request/response contract tests, documented product/ownership/industry codes, and certification. Mock/fixture success is not production integration readiness. No live merchant submission or provider outreach was performed.

## Handoff

Conductor should `registerAdapter(fundomateAdapter)` in `registry.ts` after review. Route destination should be `fundomate`. Do not enable status poll, webhooks, or offers for this slug.

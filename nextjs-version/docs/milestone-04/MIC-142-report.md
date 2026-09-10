# MIC-142 report — Lendr adapter

**Status:** DONE locally with synthetic fixtures. Commercial Lendr sandbox access remains an external gate.

## Contract

`lendrAdapter` (`slug: lendr`) implements `FunderAdapter` with `validate`, `submit`, and `getStatus`. Capabilities are honest to the public guide (deal and document delivery, Open in Lendr portal, Check Status): `submit: true`, `statusPoll: true`, `webhooks: false`, `offers: false`. There is no `parseWebhook`. The public guide does not document financial offer terms or webhooks, so offer sync stays disabled. Status is persisted as raw provider status plus a normalized outcome; terms are never invented. Unpublished raw values stay `unknown` for email/manual review.

`validate` requires business identity (name, address, phone, 9-digit EIN, industry, entity type), at least one owner (name, home address, phone, email, date of birth, 9-digit SSN, ownership percent), an application file (`application` / `api_application` / `app`), and bank statements (`statement` / `bank_statement` / `banks`). Owner phone is required because the public guide calls it out. DBA and start date are optional; if a start date is present it must be `YYYY-MM-DD`. Annual revenue and business email are not required.

`submit(job)` is fixture-backed (`job.route.destination` or `setLendrFixture`) and idempotent on `job.attemptKey`. Success stores Deal ID `lendr_${attemptKey}` and a synthetic portal URL (`portal.example.test` only). Timeouts reserve that Deal ID and recover on replay. Expired credentials (API key or `lendr:expired-credential` destination) do not mint a new Deal ID. Replay of a completed attempt returns the original Deal ID, portal URL, and document receipt ids. Application and bank-statement files are receipted separately.

`getStatus` maps Check Status buckets: Submitted / Received / Sent / New Submission → `submitted`; In Review / Pending / In Progress → `pending`; Approved → `approved` with no terms; Declined / Decline / Rejected → `declined`; Funded → `funded`. Offer, Hold, and other unpublished values stay `unknown` with the original raw string and no terms. Expired credentials fail closed with 503 `provider_unavailable`.

Secrets and owner SSNs are omitted from adapter results. The adapter does not call live HTTP, copy MCA Pilot endpoints, or embed sample provider credentials. API key is read from `adapterRuntime()` when `submitViaAdapter` injects it. Production vs development slots remain MIC-124.

## Tests

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/adapters/lendr.test.ts
```

5/5 passed.

Covered: required-field rejection (business identity, owner phone, application file, bank statements); accepted Deal ID with portal URL and status-only flags without inventing terms; document receipts stable on replay; missing statement/application artifacts reject without a Deal ID; timeout then recover without a second Deal ID; expired credential without a new submission; submitted/pending/approved/declined/funded mapping; Offer/Hold/unpublished statuses preserved as unknown.

## Files

- `src/lib/mca/submissions/adapters/lendr/index.ts`
- `src/lib/mca/submissions/adapters/lendr/mapping.ts`
- `src/lib/mca/submissions/adapters/lendr/fixtures.ts`
- `tests/adapters/lendr.test.ts`
- `docs/milestone-04/MIC-142-report.md`
- `docs/milestone-04/MIC-142-acceptance.md`

Did not edit `registry.ts`, `framework.ts`, `credentials.ts`, schema, or drizzle.

## Remaining gates

Commercial provider sandbox access, current Lendr request/response contract tests, product codes, document transport, and documented certification. Mock/fixture success is not production integration readiness. No live merchant submission or provider outreach was performed.

## Handoff

Conductor should `registerAdapter(lendrAdapter)` in `registry.ts` after review. Route destination `lendr`. Status poll can consume `getStatus`; do not enable webhooks or API offer rows for this slug. Fallback statuses remain raw/unknown for email/manual review.

# MIC-130 report — Channel Partners Capital adapter

**Status:** DONE locally with synthetic fixtures. Commercial Channel Partners Capital sandbox credentials remain an external gate.

## Contract

Slug `channel-partners-capital` implements `FunderAdapter`. Capabilities are submit-only: `submit: true`, `statusPoll: false`, `webhooks: false`, `offers: false`. `getStatus` and `parseWebhook` are omitted. `assertStatusPollAllowed` / `getStatusViaAdapter` therefore 409 `capability_unsupported`.

`validate` requires a resolvable primary owner (explicit `isPrimary` or highest ownership percentage), two-letter state of incorporation, 6-digit NAICS, plus the public-guide business/owner identity fields. Field errors are actionable and do not create an Account ID.

`submit` is fixture-driven (`job.route.destination` suffix or test override). Success returns durable `externalRef` Account ID `CPC-ACC-<attemptKey>` and raw status `Sent`. Outcomes after send are email/manual — this adapter does not poll, ingest webhooks, or invent offers. Application and statement documents on the job are acknowledged by id/checksum/category only (no bytes).

Idempotent on `job.attemptKey`: a stored success is replayed unchanged. Timeouts, expired credentials, and missing-field fixtures write no Account ID. Replay of a later accepted attempt for a previously timed-out key creates at most one Account ID.

Tenant secrets are read from `adapterRuntime()` when the framework injects them. Expired fixture key `cpc-expired-credential` fails closed. Results are passed through `redactAdapterSecrets`. No MCA Pilot endpoints, IPs, or sample credentials are embedded; there is no live HTTP.

Deal records still have no `stateOfIncorporation` column. The adapter validates that field on the application payload, not on `DealRecord`.

## Tests

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/adapters/channel-partners-capital.test.ts
```

5/5 passed.

Covered: required-field rejection (primary owner, state of incorporation, NAICS); accepted Account ID; document receipt for application + bank statement; timeout / expired credential / missing fields without an Account ID; `attemptKey` replay preserves Account ID and correlation id; submit-only capabilities and 409 status poll; mapped payload stores SSN last four only.

## Files

- `src/lib/mca/submissions/adapters/channel-partners-capital/index.ts`
- `src/lib/mca/submissions/adapters/channel-partners-capital/mapping.ts`
- `src/lib/mca/submissions/adapters/channel-partners-capital/fixtures.ts`
- `tests/adapters/channel-partners-capital.test.ts`
- `docs/milestone-04/MIC-130-report.md`
- `docs/milestone-04/MIC-130-acceptance.md`

Did not edit `registry.ts`, schema, drizzle, or shared mounts.

## Remaining gates

Commercial provider sandbox access, current Channel Partners Capital request/response contract tests, and documented certification. Mock/fixture success is not production integration readiness.

## Handoff

Register `channelPartnersCapitalAdapter` (`slug: channel-partners-capital`) in `src/lib/mca/submissions/adapters/registry.ts`.

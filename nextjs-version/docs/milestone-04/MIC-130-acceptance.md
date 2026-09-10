# MIC-130 acceptance — Channel Partners Capital adapter

Executed September 8, 2026. Scope: submit-only Channel Partners Capital adapter with Account ID acknowledgement, primary-owner / state-of-incorporation / NAICS validation, document receipt, and honest capability flags. Live Channel Partners Capital APIs remain an external gate.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| Required-field rejection | Passed | `tests/adapters/channel-partners-capital.test.ts` — empty and incomplete applications return `primaryOwner`, `stateOfIncorporation`, `naicsCode`; submit `:missing-fields` is `validation_failed` with no Account ID |
| Accepted submission | Passed | Complete fixture maps primary owner Ava (60%), DE incorporation, NAICS `722511`; submit returns `externalRef` `CPC-ACC-attempt-cpc-1` and raw status `Sent` |
| Document receipt | Passed | `:documents` job with application + statement package ids returns `documentReceipt=accepted`, `documentsReceived=2`, receipts `doc-app:application;doc-bank:statement`; excluded `other_stip` is not sent |
| Timeout / expired credential / replay | Passed | `:timeout` and `:expired` (plus expired runtime key) fail with no `externalRef`; success replay of the same `attemptKey` keeps Account ID and correlation id even when a timeout override is set; a prior timeout key can later accept once |
| Capability flags | Passed | `submit: true`, `statusPoll/webhooks/offers: false`; `getStatus` / `parseWebhook` absent; `assertStatusPollAllowed` throws `409 capability_unsupported` |
| Loading / empty / validation / success / failure | Passed | Empty validate input, field errors, `Sent` success, timeout and expired failure messages; retries preserve Account ID |
| Direct API permissions; secrets and document bytes omitted | Passed | Adapter has no HTTP routes (MIC-124 ACL). Runtime API key and full SSN are absent from submit JSON and mapped request (last four only, no document bytes) |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/adapters/channel-partners-capital.test.ts
```

5/5 passed.

## Behavior

- Public guide: submit business + one owner (highest ownership or `isPrimary`), upload application/bank documents when present, persist Account ID, show `Sent`. Status checking is not available.
- After `Sent`, offers and later outcomes are email/manual review. This adapter does not poll or create offers.
- Fixtures are in-memory and keyed by `job.route.destination` (`channel-partners-capital`, `:timeout`, `:expired`, `:missing-fields`, `:documents`) or `setChannelPartnersCapitalFixtureForTests`.
- Production vs development credential slots remain MIC-124. The adapter reads `adapterRuntime()` secrets when present.

## Local vs live gates

Local synthetic fixtures prove validation, Account ID idempotency, document acknowledgement, and submit-only 409s. Commercial Channel Partners Capital sandbox credentials and the current provider HTTP contract are not production-verified. Mock success is not production integration readiness.

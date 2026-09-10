# MIC-129 acceptance — Quantum Lends adapter

Executed against synthetic fixtures only. Scope: Quantum Lends `FunderAdapter` mapping, submit, and status poll. Live Quantum Lends APIs were not called.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| Required-field rejection | Passed | Empty application and missing requested amount / annual revenue return field errors; LLC without EIN fails |
| Sole-proprietor EIN exception | Passed | Sole proprietor without EIN maps; EIN omitted on the outbound merchant |
| Highest-ownership primary applicant | Passed | 30% / 70% owners → Miles is the only `isPrimary` owner |
| NAICS mapping | Passed | `Restaurants` → `722511`, `Trucking` → `484121`; unmapped industry is a field error |
| Accepted submission | Passed | `submit` returns `ok`, `rawStatus: Sent`, durable `ql-<attemptKey>` |
| Document receipt | Passed | Two `statement` documents → `documentReceipt=accepted`, `documentsReceived=2`; application docs excluded |
| Timeout / expired / replay | Passed | Timeout and expired credentials have no external ref; retry after timeout creates one ref; later timeout fixture still returns the original success |
| Status capabilities | Passed | Sent/Approved/Funded/Declined map to submitted/approved/funded/declined; `OnHold` stays unknown; no terms; no `parseWebhook` |
| Secrets / sensitive contents | Passed | Full SSN, fixture API key, and document checksums/bytes are absent from results |
| Loading / empty / validation / success / failure | Passed | Empty object → field errors; valid application → `{ ok: true }`; timeout/expired messages are actionable |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/adapters/quantum-lends.test.ts
```

6/6 passed.

## Behavior

- Slug `quantum-lends`. Capabilities `{ submit: true, statusPoll: true, webhooks: false, offers: false }`.
- Annual revenue prefers `annualRevenue`, else `monthlyRevenue * 12`.
- EIN required unless `entityType` is `sole_proprietor`.
- Primary applicant is the highest `ownershipPercent` (ties keep an existing `isPrimary` mark).
- Fixtures only. Destination suffix or `setQuantumLendsFixtureForTests` selects accepted / timeout / expired / status outcomes. No MCA Pilot endpoints or sample credentials.
- Direct HTTP permission checks stay on the adapter framework (MIC-124). This adapter is server-side and does not log secrets.

## Local vs live gates

Local fixtures prove mapping, idempotent submit, document receipt, and documented statuses. Commercial Quantum Lends sandbox access is not production-verified. Mock success is not production integration readiness.

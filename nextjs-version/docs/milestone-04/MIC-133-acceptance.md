# MIC-133 acceptance — Rapid Finance adapter

Executed September 8, 2026. Scope: Rapid Finance `FunderAdapter` with synthetic fixtures for application/owner/document mapping, Deal ID and portal navigation, status and offer polling, withdrawn/rescinded preservation, and attemptKey idempotency. Live provider APIs remain an external gate.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| Required-field rejection | Passed | `tests/adapters/rapid-finance.test.ts` — empty payload errors on business identity, owners, annual revenue, application, and bank statements; monthly revenue annualizes; invalid EIN/SSN/owner fields are actionable |
| Accepted submission | Passed | Valid application submits `ok: true` with stable `rf_${attemptKey}` Deal ID, synthetic portal URL, `SubmittedDeal` / `submitted`; SENT acknowledgement has no offer terms |
| Document receipt | Passed | `api_application` and `statement` become application and bank-statement receipts; replay of the same attemptKey returns the same receipt ids, portal URL, and a single Deal ID; incomplete job documents fail without minting a Deal ID |
| Timeout / expired credential / replay without duplicates | Passed | Timeout reserves `rf_attempt-timeout` then recovers on the same ref; expired token returns `provider_unavailable` with no new ref and 503 on status; completed attempt replay under an expired token keeps the original Deal ID |
| Status / offers / fallback | Passed | SENT/pending/approved/declined/funded map as documented; Withdrawn / ContractsOut / RescindByClient / RescindByRapidFinance stay `unknown` with original raw values and no terms; approved/funded fixtures include synthetic offer terms |
| Capability flags match implementation | Passed | `{ submit: true, statusPoll: true, webhooks: false, offers: true }`; `getStatus` implemented; `parseWebhook` absent |
| Loading / empty / validation / success / failure usable | Passed | `validate({})` is the empty/validation state; accepted submit is success; timeout and expired credential are failure states with correlation ids; retries preserve `attemptKey` identity |
| Logs omit secrets and sensitive document contents | Passed | Submit/status JSON omit API keys, expired token, and owner SSNs; fixtures never attach document bytes |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/adapters/rapid-finance.test.ts
```

5/5 passed.

## Behavior

- Slug `rapid-finance`. Status poll and offers; no webhooks.
- Validate: annual revenue required; application + bank statements required; owner SSN, date of birth, and home address required.
- Submit: fixtures keyed by `job.route.destination` or test override; idempotent on `job.attemptKey`; Deal ID `rf_${attemptKey}`; synthetic portal URL only (`portal.example.test`).
- Status: SENT / InProgress / SubmittedDeal → `submitted`; Pending / ConditionallySubmitted → `pending`; Approved / ApprovedWithStips / Quoted / PrequalPass → `approved`; Declined / PreQualFail / Unqualified_WillingReconsiderLater / Rejected → `declined`; Funded → `funded`. Withdrawn / ContractsOut / RescindByClient / RescindByRapidFinance remain unknown for email/manual review.
- Offers: terms only on approved/funded fixtures. Approval without terms would not invent amounts.
- Direct API permissions stay on MIC-124 credential routes. This ticket has no exclusive HTTP surface.

## UI

No exclusive UI. Conductor registers the adapter and mounts status refresh and offer reconciliation through MIC-113 / MIC-124.

## Local vs live gates

Local synthetic fixtures prove mapping, receipts, Deal ID/portal fields, status/offer mapping, withdrawn/rescinded preservation, and idempotent retries. Commercial Rapid Finance sandbox credentials and current endpoint contracts are not production-verified. Mock success is not production integration readiness.

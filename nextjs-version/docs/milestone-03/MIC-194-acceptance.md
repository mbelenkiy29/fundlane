# MIC-194 acceptance — AI scan funder criteria

Executed September 8, 2026. Scope: proposed criteria changesets from clean vault PDF/PNG/JPEG sheets, contact preservation, no silent broadening, unspecified-without-sentinels, accept/reject/rollback history.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| Ambiguous range flagged; unspecified stays null | Passed | FICO 600-650 is unspecified; NSF sentinel 9999999 stored as null |
| Contacts preserved; rules not silently broadened | Passed | Configured contact `pat@harbor.test` survives scan+accept; min FICO 650 kept over extracted 600 |
| Accept / reject / rollback history | Passed | Accept publishes; reject leaves current book; rollback restores previous rules; retries keep proposal id |
| Clean vault PDF/PNG/JPEG only | Passed | PNG/JPEG scan; quarantined document 423 `document_not_clean` |
| Yearly revenue conversion + industry alias | Passed | `$120,000` annual → `usd_monthly` 10000; `restaurants` → `Food Services` |
| HTTP permissions / isolation | Passed | `intake:write` 403; rep write 403 / GET 200; `deals:read` GET 200; foreign funder 404 |
| Provider missing | Passed | 503 `provider_unavailable` |
| UI states | Implemented | `CriteriaScanPanel` loading, empty, validation, success, failure, retry keys |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/funders-scan.test.ts
```

## Behavior

- Only **clean** vault PDF, PNG, or JPEG documents are scanned. Pending, quarantined, and `scan_failed` documents are 423 `document_not_clean`.
- Extraction writes a **proposed** changeset. Contacts are never written; populated funder contacts stay as configured.
- Unspecified limits stay `value: null` / `unspecified: true`. Sentinel numbers (`9999999`, `|n| >= 999999`) are not stored.
- Ambiguous ranges (for example `FICO 600-650`) are flagged for review and left unspecified. The scanner does not pick the least-restrictive bound.
- Extracted values that would **broaden** an existing min/max/`in`/`not_in` rule are blocked; the current stricter limit is kept and a warning is recorded.
- Yearly revenue is converted with `convertRevenueThreshold` (`usd_annual` 120000 → `usd_monthly` 10000). Industry names go through `resolveIndustry`.
- Accept publishes via `publishFunderCriteria`. Reject leaves the current book. Rollback restores the pre-accept rules. Re-scanning the same clean document while a proposal is open returns the same proposal id.
- Reads: session users or API keys with `deals:read`. Writes: interactive `admin` / `super_admin`. `intake:write` is 403. Cross-workspace funders are 404.
- `CriteriaScanPanel({ funderId })` is exported for the conductor to mount on funder detail.

## Local vs live gates

Local fixtures prove the changeset, contact preservation, broadening block, unspecified nulls, history/rollback, isolation, and permission envelope. Live OpenAI document AI (`MCA_DOCUMENT_AI_PROVIDER=openai`, `OPENAI_API_KEY`, `MCA_DOCUMENT_AI_MODEL`) is an external credential gate. Fixture success is not production integration readiness.

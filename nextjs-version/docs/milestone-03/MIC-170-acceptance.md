# MIC-170 acceptance — Funder eligibility rules

Executed September 8, 2026. Scope: typed funder eligibility rules, yearly→monthly revenue conversion, contradiction checks, unspecified nulls, and workspace industry/NAICS aliases.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| Criteria core + HTTP acceptance | 8/8 passed | `tests/funders-criteria.test.ts` |
| Yearly 120000 → monthly 10000 | Passed | `convertRevenueThreshold({ value: 120000, from: "usd_annual", to: "usd_monthly" }) === 10000` |
| Same field+unit min > max | Passed | 422 `criteria_conflict`; rules not persisted; `criteriaVersion` stays 1 |
| Yearly vs monthly revenue conflict | Passed | min $120k/year vs max $9k/month is 422 after `/ 12` |
| `unspecified: true` | Passed | Stored `value` is SQL `NULL`, never `0` / `-1` |
| Field coverage + versioning | Passed | 14 rule types publish; identical replay keeps version; edit bumps `criteriaVersion` |
| Industry aliases | Passed | Case-insensitive upsert; NAICS resolve; cross-workspace 404 |
| Permissions / isolation | Passed | `intake:write` 403; rep PUT 403 / GET 200; `deals:read` GET 200; foreign funder 404 |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/funders-criteria.test.ts
```

## Behavior

- Rules are typed with `field`, `operator` (`min`/`max`/`eq`/`in`/`not_in`), `unit`, `value`, `sourceText`, and `unspecified`.
- Fields: revenue, FICO, time in business, positions, requested amount, term, ADB, deposit count, NSF, negative days, default status, entity, state, industry.
- `convertRevenueThreshold` converts `yearly`/`usd_annual` ↔ `monthly`/`usd_monthly` using annual / 12. Yearly min 120000 is stored as authored (`usd_annual`, 120000) and is equivalent to monthly min 10000 for matching and conflict checks.
- Conflicting min/max on the same field+unit cannot publish (`422 criteria_conflict`). Revenue annual/monthly pairs are compared after conversion.
- `unspecified: true` always persists `value = null`. Sentinel numbers are not used.
- Publishing a changed ruleset increments `mca_funders.criteria_version` (directory `updateFunder` only versions profile). Identical replay keeps version and rule ids.
- Workspace industry aliases map alias/NAICS → `normalizedIndustry`. Editable; isolated per workspace.
- Reads: session users or API keys with `deals:read`. Writes: interactive `admin` / `super_admin`. `intake:write` is 403. Cross-workspace funders/aliases are 404.
- `CriteriaPanel({ funderId })` covers loading, empty, validation, success, and failure, plus unspecified, yearly→monthly convert, and alias CRUD. Conductor mounts it on funder detail.

## Local vs live gates

Local SQLite fixtures prove conversion, conflict rejection, unspecified nulls, versioning, aliases, isolation, and permission envelopes. No external provider is involved. There is no live-integration gate for this ticket.

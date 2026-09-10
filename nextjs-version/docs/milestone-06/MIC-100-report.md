# MIC-100 report — Role-scoped deal/offer CSV and admin workspace exports

**Linear:** https://linear.app/michael-belenkiy/issue/MIC-100  
**Status:** implemented locally (conductor mounts UI; do not mark Linear Done from this agent)

## What shipped

New export suite under `src/lib/mca/exports`, `src/app/api/mca/exports`, and `src/components/mca/exports/export-panel.tsx`. Jobs persist on `mca_export_jobs` / `mca_export_download_tokens` (migration `0012`). `GET /api/mca/deals/export` was not changed.

| Kind | Who | Query | Fields |
| --- | --- | --- | --- |
| `deals` | Rep/manager/admin with `exportDeals` | Same `listDealRecords` + `canActorAccessDeal` as the Deals screen | List/contact/owner **name** only; no EIN, identity, commissions, ledger |
| `offers` | Same | Offers on those visible deals | Terms except commission/buy rate/fee |
| `all_deals_owners` | Admin/super_admin (or `deals:export` API key) | All workspace deals | Explicit 5-owner manifest including EIN and identity last 4 |
| `funded_deals` | Same | Committed `mca_funding_events` | Funded amount/date/funder; **not** ledger rows |

Large snapshots (`async: true` or ≥ 250 rows) stay `queued` until `POST /api/mca/exports/:id/process`. Downloads are hashed tokens (1h default), workspace-authorized, and audited. `correlationId` retries return the same job.

CSV: formula prefixes `= + - @ tab CR` are apostrophe-escaped; identifier columns are tab-prefixed so spreadsheet apps keep UUIDs as text.

## API

- `GET /api/mca/exports` — capabilities + recent jobs
- `POST /api/mca/exports` — `{ kind, filters?, correlationId, async? }`
- `GET /api/mca/exports/:id`
- `POST /api/mca/exports/:id/process`
- `POST /api/mca/exports/:id/token`
- `GET /api/mca/exports/download/:token` — `text/csv; charset=utf-8`, `cache-control: private, no-store`

Session: `deals:read` + workspace `exportDeals` for role-scoped kinds; admin/super_admin for workspace kinds. API keys need `deals:export`. Direct API matches the panel.

## Tests

```bash
cd nextjs-version && node --conditions=react-server --import tsx --test --test-concurrency=1 tests/milestone06-exports.test.ts
```

8 passed (synthetic Postgres). Remaining gate: none (no live provider).

## Handoff

Mount `<ExportPanel filters={currentDealFilters} />` on the Deals workspace. Leave `GET /api/mca/deals/export` in place until that remount. This is not a payment export.

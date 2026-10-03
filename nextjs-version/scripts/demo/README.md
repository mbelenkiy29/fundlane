# Ben's synthetic demo batch

Run from `nextjs-version/` with the existing application environment. No deployment or migration is needed.

```sh
# Read-only preview; requires Ben's single active membership in the expected workspace.
node --conditions=react-server --env-file=.env.local --import tsx scripts/demo/seed-ben.ts

# Populate once. Replays verify the persisted batch without adding records.
node --conditions=react-server --env-file=.env.local --import tsx scripts/demo/seed-ben.ts \
  --apply --workspace=c880cbaf-f18d-4050-beab-840220624406 \
  --manifest=/absolute/path/ben-demo-manifest.json

# Uses a disposable local PostgreSQL cluster, never the application database.
MCA_TEST_DATABASE_ADMIN_URL=postgresql://USER@127.0.0.1:PORT/postgres \
  node --experimental-test-module-mocks --conditions=react-server --import tsx --test tests/seed-ben.test.ts
```

Batch `ben-demo-20260916-v1` adds 120 deals, 180 historical submissions, 80 funded advances, repayment receipts and commissions. Search `TEST-BEN-` in the pipeline, deal book or submissions. Contacts use `example.invalid`; the script does not create delivery jobs. It enables the existing Payments feature if disabled, preserving all other feature flags. The manifest records that setting change.

Funding dates and schedules are anchored to the first run's date. Actual receipt totals show 20 fully repaid advances, 20 half repaid, 30 other partially repaid and 10 newly funded. Schedule estimates naturally advance with time. Synthetic applications omit personal owner data and documents and remain partial drafts.

All inserts and the settings change commit together. Existing rows and outbound tables are fingerprinted before and after insertion. The complete manifest is also stored in `audit_events` under action `demo.seed.completed`, resource ID equal to the batch, so an interrupted local manifest write can be recovered by rerunning.

For an explicitly requested cleanup, load that manifest and review whether users have added related data since seeding. Delete only the listed IDs within the listed workspace, in reverse table order, in one transaction; stop on new dependent records instead of cascading into them. Remove the batch audit entry only after successful cleanup. Restore the previous Payments feature value only if it is still appropriate; preserve unrelated settings changed since the seed. Do not delete by business-name prefix.

## Humanizing Ben's demo batch

`humanize-demo-deals.ts` replaces the placeholder `TEST … 0NN` deals of that batch with realistic sample businesses: names and emails from a CSV (`name,email`, `#` lines ignored), owners, `555-01XX` phones, unique valid-format EINs, merchants, funding purposes, readiness (`missing_required_json` / `draft_state`), app-format display ids (`MCA-XXXXXXXX`) and non-TEST funder names. With `--documents` it also generates a 4-month bank statement and a signed application per deal (fictitious banks, footer "SAMPLE — FOR SOFTWARE TESTING ONLY") and uploads them through the app's document service, so they are malware-scanned and land in `fundlane-documents`.

```sh
# Dry run (default). Prints counts and five sample deals.
node --conditions=react-server --env-file=<env> --import tsx scripts/demo/humanize-demo-deals.ts \
  --workspace=<workspace id> --csv=/absolute/path/businesses-120.csv --documents

# Write. Rerunning afterwards reports zero changes.
... same command ... --apply
```

The env file needs `DATABASE_URL` and the `MCA_DATA_ENCRYPTION_KEY` used by the app that will read the data. `--documents` also needs `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `MCA_DOCUMENT_STORAGE_PROVIDER=supabase` and a working scanner (`MCA_DOCUMENT_SCANNER`). Applying against production refuses to run without `--allow-prod`. Deals are matched by the batch idempotency key, never by name. Values are derived deterministically from the deal position, so staging and production get the same sample data.

If existing encrypted values were written with a different key, the script stops. Pass `--reencrypt-unreadable` only when the key in the env file is the right one for the app; the script then rewrites those demo values with it.

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

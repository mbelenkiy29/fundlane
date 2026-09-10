# Neon migration verification

Completed at `2026-09-08T18:36:08Z`.

## Neon target

- Project: [Fundlane (`cool-pine-95841889`)](https://console.neon.tech/app/projects/cool-pine-95841889)
- Production branch: `br-aged-sun-aeqj80uv`
- Verification branch: `br-gentle-sound-aencsy8p`
- Database: `fundlane`
- Runtime: pooled `DATABASE_URL`; direct `DATABASE_URL_UNPOOLED` for migrations
- Protected connection metadata: `.neon/migration-connections.json`, mode `0600`, excluded by `.gitignore`

The local application environment now points to the Neon production branch. `MCA_DB_PATH` was removed from `.env.local`; the encryption key and all unrelated settings were preserved. `.env.local` remains mode `0600`.

## Schema and data

- Six checked Drizzle migrations were applied to verification and production.
- The resulting schema has 57 public tables: 56 application tables plus `mca_data_migrations`.
- The authoritative SQLite snapshot imported 7 rows: 1 workspace, 1 user, 1 membership, 2 sessions, and 2 request-rate windows.
- The production import ledger contains one entry tied to the protected snapshot digest.
- Production parity passed for all 56 mapped application tables and all 7 rows after the smoke session and its rate-limit side effects were removed.
- No encrypted source values required authentication because the source contained no encrypted records. A separate isolated import test authenticated a workspace-bound AES-GCM fixture and verified replay and changed-snapshot refusal.

## Verification

- Full real-Postgres suite: 130 passed, 0 failed.
- TypeScript: passed with `tsc --noEmit`.
- ESLint: 0 errors; 3 existing TanStack React Compiler advisories.
- Next.js production build: passed; all 83 static pages and dynamic application routes compiled.
- Fresh isolated migration/import test: passed, including committed SQLite WAL data, matching-snapshot replay, changed-snapshot refusal, and forced database cleanup.
- Transaction tests: passed for same-client read/write visibility, rollback, nested transactions, and serialized concurrent commands on a checked-out client.
- Concurrency tests: passed for Data Merch claims and stale-completion fencing, funder/group disjoint edits and scan decisions, and underwriting analysis/corrections.
- Production smoke: sign-in `200`, authenticated session `200`, workspace read `200`, sign-out `200`, ended-session check `401`.
- Final production parity passed after smoke cleanup.
- The local Next.js server is stopped and port 3000 has no listener.

## Recovery artifacts

- SQLite snapshot: `data/mca-pre-neon-20260908T164321Z.sqlite`, mode `0600`, SHA-256 `d5dd8173bb45f34b06daacb3171728f3e5f6db023da96d9ce229d858fce0c167`.
- Source archive: `data/mca-source-pre-neon-20260908T164631Z.tar.gz`, mode `0600`, SHA-256 `e75dded7d4bd79ae9688f228d360d2a224d985e4e6fcedd1d940fe36778e5710`.
- Environment backup: `.env.local-pre-neon-20260908T165500Z`, mode `0600`.
- The SQLite source and snapshot passed `quick_check`; the snapshot passed `foreign_key_check`; table counts matched before migration.

## Storage and hosting boundary

Document metadata is stored in Neon. Document bytes still use local filesystem storage at `MCA_DOCUMENT_STORAGE_PATH` (default `data/documents`). The migrated source had no document records or document bytes, and no object-storage migration was required.

No Vercel deployment or domain change was performed. The Neon free-account project reports its default suspend interval as `0`, and that setting could not be customized on this account; this report does not claim automatic scale-to-zero behavior.

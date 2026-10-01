# T0: local acceptance foundation (#35 / #46 / #49)

Scope: synthetic local SQL/service acceptance, on branch `codex/t0-acceptance-foundation` from `3901e7e8a41b72bd08177cbd0c7b5967d9a7cb09`. The existing healthy Supabase project is not staging. This report does not approve launch or identify any hosted check as passing.

## Reproduce

From `nextjs-version/`, install the locked dependencies with Node 24 and pnpm 11.1.2, then run:

```sh
pnpm install --frozen-lockfile
T0_POSTGRES_BIN=/opt/homebrew/opt/postgresql@16/bin \
T0_POSTGRES_PORT=56435 scripts/ops/local-acceptance.sh
```

On Linux, set `T0_POSTGRES_BIN` to the directory containing `initdb`, `pg_ctl`, `pg_dump`, `pg_restore`, and `psql`. Run as a non-root user. Choose an unused unprivileged port per task. The runner refuses an occupied port; it cannot attach to an existing database. It starts a private temporary loopback cluster, clears inherited application/provider/PG credentials, applies checked Drizzle migrations through the existing test helper, creates uniquely named databases, and stops/removes only its cluster on exit. PostgreSQL process creation may require execution-environment approval. No `.env.local` is loaded.

The scoped command includes `acceptance-foundation`, `documents-core`, `jobs-worker`, `foundation-core`, and `ops-backup-safety`. Keep console output as sanitized local evidence; no archive key, provider credentials, bank content, or document payload is printed. Test archives and keys are disposable and deleted automatically.

## Coverage and limits

| Criterion | Local evidence | Remaining gate |
| --- | --- | --- |
| Second tenant and restricted role | Restored company B cannot read company A document/deal; unassigned company A rep cannot read the private file | Real Supabase identities, MFA, cookies, grants/RLS and browser checks |
| Private upload and quarantine | Existing document suites plus restored clean/infected-response files; quarantined download denied | Private Supabase buckets, signed upload/download access and real scanner engine |
| Scan clean / malware / outage | Existing fixture scanner responses, quarantine and retry tests | Authorized sandbox scanner must detect safe EICAR and scan the maximum valid PDF; fixtures do not prove engine detection |
| Maximum file and retry | Existing job suite records 25 MiB private synthetic PDF, job identity, attempts, duration, no duplicate document | Hosted valid PDF/native processing, connection/runtime limits and selected production execution arrangement |
| Process interruption | New child actually receives SIGKILL after claim; unexpired lease blocks reclaim; same ID reclaims with attempt 2; old completion rejected | Lease expiry is accelerated in the disposable row; this is not wall-clock expiry or killing every production executor |
| Side-effect uncertainty | Existing submission worker recovery/uncertain outcomes use local provider fixtures | Interrupt each active provider executor after authorized sandbox side effect and reconcile with provider receipts; no live send was performed |
| Database plus documents | Real pg_dump, authenticated encrypted test bundle, source DB/files deleted, real pg_restore, exact document metadata and bytes/hashes, linked memberships, billing payment/invoice and credit ledger/account | Operational age encryption/key custody, private Storage object export/import, Auth identities and runtime grants, offsite retention and hosted restore |
| Missing/corrupt bytes | Restored clean file altered at same length, truncated, then deleted: downloads reject checksum/length mismatch or return sanitized storage-unavailable error | Hosted object integrity and signing path verification |
| Alerts/retention/secrets | Existing backup safety guards and retention tests; runner clears inherited credentials | Approved operator alert destination, live delivery, secret rotation and deletion drill; shared notification owner owns scheduler/alerts |
| Release acceptance | Targeted local evidence only | Full pilot flow, provider sandbox proofs, hosted revision/rollback, aggregate/type/lint/build and human go/no-go |

## Restore procedure and key requirements

The new integration drill captures a real custom PostgreSQL dump and both clean/quarantined document objects in a **test-only AES-256-GCM bundle**. A random 32-byte key authenticates the bundle; wrong keys and ciphertext modification fail decryption before any restore. It deletes the source database/files, restores to an empty separate loopback database using existing `restoreDrill`, restores immutable document objects, compares metadata/length/SHA-256, then verifies authorization and linked SQL references. Diagnostics report encrypted bundle SHA-256, document count/size and total drill duration. The duration includes fixture creation and backup; it is not a production RTO promise.

This fixture format is not a production backup format. Existing operational `backup-database.ts` uses `age` and its current encrypted-path integration test substitutes a passthrough age executable; that test proves tool plumbing only. Before operational acceptance, run real `age` encryption/decryption with separately held recipient identity, preserve immutable document objects **including quarantine**, capture object keys/checksums and a consistent DB snapshot, verify wrong-key/tamper failures, and restore into separately approved staging. Never release quarantined objects merely because a restore succeeds. DB-only backups do not contain Supabase Storage bytes or prove Auth/grants restoration.

Existing commands (for approved local disposable sources/targets):

```sh
MCA_OPS_BACKUP_ENABLED=true MCA_OPS_SOURCE_DATABASE_URL="$LOCAL_SOURCE_URL" \
  node --import tsx scripts/ops/backup-database.ts \
  --confirm --kind pre-migration --directory "$PRIVATE_ARCHIVE_DIRECTORY" --recipient "$AGE_RECIPIENT"
MCA_OPS_RESTORE_DRILL_ENABLED=true MCA_OPS_SOURCE_DATABASE_URL="$LOCAL_SOURCE_URL" \
  MCA_OPS_TARGET_DATABASE_URL="$EMPTY_LOCAL_TARGET_URL" \
  node --import tsx scripts/ops/restore-drill.ts \
  --confirm --archive "$ARCHIVE" --sha256 "$ARCHIVE_SHA256" --identity "$PRIVATE_AGE_IDENTITY_FILE"
```

These existing commands restore SQL only. They do not implement hosted object backup. Supply all paths/keys privately; no production credentials or hosted targets belong in the local runner. `restoreDrill` rejects hosted targets, source-equal targets, nonempty targets and wrong dump checksums. Keep application encryption keys available separately when restoring encrypted database fields; the synthetic fixture does not prove production key rotation.

## Functional defect fixed

`getDocumentContent` previously returned any bytes at a clean document's storage key. It now compares length and SHA-256 to the document record on every server byte read and refuses altered content with `document_integrity_failed` (409). Missing storage returns a sanitized `document_storage_unavailable` (503). Authorization/quarantine checks still happen before reading storage. This change does not alter auth, schema, schedulers, or hosted configuration; direct signed Storage URLs still require independent provider acceptance.

## Ownership and decision

T0 owns this local runner, fixtures, evidence and byte-read integrity fix. Shared notification foundation owns scheduler and delivery/alert contracts. Parent integration owner must pin dependent feature revisions and allocate aggregate/build execution. Hosted staging, production runtime cutover, provider receipt reconciliation and operator activation require separate approval and owners. Current release decision: **NO-GO for hosted acceptance**, because local proofs cannot satisfy #49's hosted criteria.

## Verification evidence

- `scripts/ops/local-acceptance.sh`: **58/58 passed, 0 skipped**, PostgreSQL 16.14, Node 24.7.0, pnpm 11.1.2; final scoped run about 14.9 seconds.
- Restored two private synthetic documents, 49 bytes each; total fixture/backup/restore drill reported 1,158 ms in that run. Encrypted bundle SHA-256 `8fa77422768a7683f55fd9547d36421f72607857003c0a4b58459c213062fc02` (randomized key/nonce means future runs differ).
- Literal claim process exited by `SIGKILL`; retry kept `t0-killed-job`, attempt 2, stale completion denied, zero external sends.
- `pnpm typecheck` and focused ESLint for the changed test/service: passed.
- Full aggregate/lint/build: awaiting parent allocation; no result claimed here yet.

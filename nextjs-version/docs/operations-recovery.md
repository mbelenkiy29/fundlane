# Operations recovery runbook

Owner: Michael Belenkiy. Execute hosted drills only in an approved nonproduction Supabase project and Vercel preview with synthetic records. Record dates, operator, project reference, measured time, sanitized row counts and provider receipt IDs in the private incident record. This repository change does not execute a hosted restore or send a live alert.

## Inventory and signals

`audit_events` records workspace scoped mutations; platform billing actions and the failed-job decisions below use it. `mca_background_jobs` records state, attempt count, lease, error code and idempotency identity. A running job with an expired ten-minute lease may be reclaimed; three attempts lead to `failed`. `mca_private.ops_control` holds the document worker heartbeat. The monitor samples website, database, queue, email sender and billing reconciliation health into `mca_private.ops_health`, manages incidents in `mca_private.ops_incidents`, and stores delivery attempts in `mca_private.ops_alert_attempts`. `/admin/status` is owner gated; `/api/platform/companies/{id}/failed-jobs` is platform-admin and MFA gated. Request rate limits live in the shared request-rate table; provider-specific send limits remain with their worker. Alerts use the existing transactional webhook. An unknown alert send is not retried automatically.

The document host has a dedicated heartbeat; the default-off recovery monitor also checks the existing email runtime completion timestamp. Generic job owners are observed through due queue age and expired leases. Other schedulers have no dedicated tick heartbeat and need separate instrumentation and hosted owner acceptance before claiming full worker coverage. See the [runtime coverage audit](platform-status.md#runtime-coverage-audit-46-steps-45-38-step-4) for signal sources, gates and limits. The recovery endpoint limits an authenticated administrator to 60 inventory reads and 10 decisions per minute through the existing request-rate table.

The existing deployed monitor rules remain: three bad checks for website/database/queue age/expired leases/document heartbeat, immediate ambiguous email, and five recent email failures or five errors. Billing reconciliation incidents require `MCA_BILLING_RECONCILIATION_ALERTS_ENABLED=true`; the unset default leaves them disabled. The additional recovery incidents use `MCA_OPERATIONS_RECOVERY_ALERTS_ENABLED=true`. Delivery still requires the existing `MCA_OPERATIONS_ALERTS_ENABLED=true`. An unset recovery flag preserves current delivery. Configure these as **Supabase platform-monitor secrets**, not browser settings:

| Variable | Default | Action |
| --- | ---: | --- |
| `MCA_OPERATIONS_RECOVERY_ALERTS_ENABLED` | `false` | Evaluate extra recovery incidents. |
| `MCA_BILLING_RECONCILIATION_ALERTS_ENABLED` | `false` | Evaluate retrying billing reconciliation incidents separately. |
| `MCA_OPERATIONS_WORKER_STALE_SECONDS` | `90` | Document heartbeat age, three checks. A missing heartbeat is stale. |
| `MCA_OPERATIONS_QUEUE_AGE_SECONDS` | `600` | Oldest due queued job age per kind, three checks. |
| `MCA_OPERATIONS_QUEUE_AGE_BY_KIND_SECONDS` | `{}` | JSON object of kind-to-seconds overrides, e.g. `{"document_scan":300}`. Invalid entries are ignored. |
| `MCA_OPERATIONS_PROVIDER_FAILURES` | `5` | Recent email failures or senders requiring reconnect, one check. |
| `MCA_OPERATIONS_BILLING_FAILURES` | `1` | Due, retried billing notification, one check. Billing reconciliation retry uses its separate opt-in flag. |
| `MCA_OPERATIONS_ASSISTANT_RUNS_PER_HOUR` | `100` | Assistant runs in the preceding hour, one check, only when `MCA_ASSISTANT_ENABLED=true` in the monitor. |

Positive integer thresholds up to 86,400 are accepted. Review counts and expected traffic in synthetic staging, configure the approved operator recipient (`MCA_OPERATIONS_ALERT_EMAIL`) and transactional receiver, invoke `platform-monitor` with its dedicated `MCA_MONITOR_TOKEN`, then verify one opening and one recovery notification. Check `ops_alert_attempts` and the approved mailbox. A receiver timeout is an unknown outcome; inspect provider receipts before reconciling. Install or verify the existing monitor schedule only after acceptance; no new cron schedule is declared in this repository.

### Offline alert drill

The local alert drill requires an already migrated, disposable PostgreSQL database on `localhost`, `127.0.0.1`, or `::1`. It refuses the production Supabase project reference and does not read `DATABASE_URL` or `MCA_MONITOR_DATABASE_URL`. Its dedicated switch defaults to off and accepts only the exact value `true`; `--confirm` is also required. From `nextjs-version/`, run:

```sh
MCA_OPS_ALERT_DRILL_ENABLED=true MCA_OPS_ALERT_DRILL_DATABASE_URL='postgresql://operator:PLACEHOLDER@127.0.0.1:5432/disposable_alert_drill' pnpm exec tsx scripts/ops/alert-drill.ts --confirm
```

The command exercises the production monitor and transactional transport path with in-process health and webhook mocks. It opens and recovers a synthetic website incident, checks attempt IDs against transport idempotency keys, prints sanitized JSON evidence, and rolls back every database row. It binds no socket, performs no DNS lookup, and sends nothing. This proves only local incident, attempt, unknown-outcome, and idempotency behavior; it **does not** satisfy the hosted alert receipt requirement described above. Never replay an unknown external effect without inspecting the provider receipt first.

For the offline half of worker-kill evidence, run `tests/jobs-worker.test.ts`; it expires and reclaims the same job identity in disposable PostgreSQL. The later hosted half remains the guarded staging command `MCA_OPS_JOB_PROOF_ENABLED=true pnpm exec tsx scripts/ops/job-runtime-proof.ts --confirm`, using only Michael's approved nonproduction target and synthetic objects. The alert drill does not duplicate that queue harness.

## Failed-job review and worker kill drill

Set `MCA_JOB_RECOVERY_ENABLED=true` on an approved preview to expose the recovery endpoint. Its unset default is `false`. An authenticated platform administrator with MFA lists `GET /api/platform/companies/{workspaceId}/failed-jobs`. Results expose only job ID, kind, resource ID, attempts, error code and update time. `POST` to the same path with trusted same-origin request and JSON `{ "jobId": "...", "action": "replay" }` requeues only `document_scan`, `draft_scan`, `assistant_scan`, `document_upload`, `export` or `export_create`, preserving the job and idempotency IDs while resetting attempts. A paused-company failure cannot be replayed. Inspect the underlying resource and current authorization before using it. Other kinds require a new reviewed request or explicit reconciliation.

For an external send, kill the worker immediately after claim, then separately after the mocked or staging provider accepts the effect. Wait for the lease to expire, observe the same job identity and attempt increment, and compare application state with the provider receipt or idempotency key. **Do not replay an unknown send.** When evidence shows the provider acted, POST `external_effect_confirmed`; when evidence shows it did not, POST `external_effect_absent`. Both leave the job failed and retain its identity. Initiate a new business request only through its normal authorized flow after review. Save provider receipt evidence in a restricted incident record, not an API body or audit metadata. Repeat for invitation, submission, messaging and billing workers as their hosted owners become available. Verify one financial ledger record and one submission record after recovery. Record kill time, lease expiry, detection time and recovery time. This source-only change cannot establish that a hosted provider deduplicates the external effect.

## Staging backup and restore drill

### Manual database archive and local rehearsal

These scripts are operator commands, never scheduled by the app. Install PostgreSQL client tools (`pg_dump`, `pg_restore`, `psql`), Node 24/tsx, and `age` for encrypted archives. Use compatible PostgreSQL client versions, a private local directory with mode `0700`, an age recipient and separately held age identity. The source URL belongs only in `MCA_OPS_SOURCE_DATABASE_URL`; the disposable target URL belongs only in `MCA_OPS_TARGET_DATABASE_URL`. Neither script reads the application's `DATABASE_URL`. Both switches require the exact value `true` plus `--confirm`; unset and `false` refuse. The target must be a new, empty loopback database. A non-loopback source requires age encryption. Unencrypted archives require a synthetic loopback fixture and explicit `--synthetic`.

For a synthetic local source, or in Michael's separately approved operator environment, run a manual backup:

```sh
export MCA_OPS_BACKUP_ENABLED=true
export MCA_OPS_SOURCE_DATABASE_URL='postgresql://operator:PLACEHOLDER@127.0.0.1:5432/synthetic_source'
mkdir -m 700 -p /private/path/fundlane-backups
pnpm exec tsx scripts/ops/backup-database.ts --confirm --kind weekly --directory /private/path/fundlane-backups --recipient 'age1PLACEHOLDER'
# Use --kind pre-migration immediately before a reviewed migration.
```

The command refuses empty or invalid archives before reporting success. It prints the completed archive path, SHA-256 and dump completion time. Save the hash in the private evidence record. It prunes only matching regular archives in that directory after success, leaving the newest four weekly and three pre-migration names. It does not upload or schedule backups. Verify the hash again before restore; the restore command checks it before running any database tool. Copy encrypted archives to Michael's private “Fundlane backups” location using a separately reviewed process. The script cannot establish that the local directory or later copy is an approved private location.

Restore locally with a disposable, empty database prepared by the operator:

```sh
export MCA_OPS_RESTORE_DRILL_ENABLED=true
export MCA_OPS_TARGET_DATABASE_URL='postgresql://operator:PLACEHOLDER@127.0.0.1:5432/disposable_restore'
pnpm exec tsx scripts/ops/restore-drill.ts --confirm --archive /private/path/fundlane-backups/mca-weekly-YYYYMMDDTHHMMSSmmmZ.dump.age --sha256 EXPECTED_64_HEX_DIGITS --identity /private/path/age-identity.txt
```

The restore refuses hosted targets, the production project reference and source-equal targets. It uses `pg_restore` without `--clean` or `--create`, then `verify-restore.sql` with stop-on-error. The SQL reports only table and orphan counts and fails if an orphan is found. Compare a linked deal ID, document ID and stored checksum against the pre-backup manifest privately. SQL can compare stored document checksums but cannot prove restored private object bytes. A database dump does not include private Storage object bytes or custody of `MCA_DATA_ENCRYPTION_KEY`. `pg_dump` does not include global roles; export and verify them separately in the hosted procedure. Restore and verify private Storage and Auth separately in an approved hosted drill. A full Supabase dump can include managed schemas or extensions that ordinary local PostgreSQL cannot restore; record those gaps rather than claiming full hosted recovery. Local restore timing is rehearsal evidence, not proof of production RTO or RPO.

Private evidence template: operator; backup and drill dates; source snapshot/dump completion time; chosen recovery point and source data cutoff; disposable target; sanitized counts and orphan counts; linked deal/document IDs and stored checksum comparison; private object byte checksum and access result; membership/owner links; invoice/payment and credit ledger references; RTO measured from restore start through verification; RPO calculated from source data cutoff to chosen recovery point; key requirements; alert receipt; worker kill outcome; gaps. Keep bank fields, credentials and document content out of the record.

Michael owns the weekly encrypted backup, a monthly copy of private Storage buckets to the private backup location, the quarterly restore drill, monitoring and key custody. Keep `MCA_DATA_ENCRYPTION_KEY` separately in a password manager. Upgrade to Supabase Pro when the first paying customer signs up or real customer data arrives, whichever comes first. Keep `MCA_JOB_RECOVERY_ENABLED` off until the staging kill drill. The existing alert thresholds above remain unchanged; record a delivered alert and worker kill evidence separately before closing issue #46.

1. Select an approved **nonproduction** Supabase project with synthetic workspaces, deals, private documents, memberships and billing ledger references. Record a manifest of immutable IDs, table counts, foreign-key links, private object keys and SHA-256 checksums; never copy customer documents or bank fields into diagnostics. Note the project's PITR/backup entitlement and available restore point in the Supabase dashboard.
2. Record start time. Use Supabase's dashboard backup/PITR restore procedure to create or recover into an isolated staging target. Use a staging encryption key matching the synthetic source key; preserve the key and Supabase Storage object backups separately because a Postgres restore alone does not prove private object recovery. Do not redirect production Auth callbacks, webhooks or cron to the target.
3. Apply only the reviewed target's migration history and restricted runtime grants if the restored point predates the code revision. Recreate private Storage buckets and restore synthetic objects using the approved staging procedure. Validate Auth identities and memberships against the restored project; do not assume Postgres alone restores Auth/Storage state consistently.
4. With a staging account, open a linked deal and its private document, verify the checksum and access denial from another workspace, inspect membership/owner links, and compare invoice/payment/credit ledger references and counts with the manifest. Check FK integrity and queue state. Record completion time, RTO, selected recovery point, RPO, required encryption/storage/Auth keys and any gaps. Keep sanitized counts and hashes as evidence; remove the isolated target under the approved retention policy.

## Rotation, retention and redaction

Rotate monitor token, cron secret, database role password, Supabase secret, email/provider tokens, Stripe secrets and sender OAuth credentials in their respective provider consoles and secret stores. Stage the new value on a nonproduction target, verify health/one authorized call, cut over exactly one worker owner, revoke the old value and confirm old-token rejection. `MCA_DATA_ENCRYPTION_KEY` needs a planned decrypt/re-encrypt migration: replacing it alone makes stored ciphertext unreadable. Never log old or new values.

The monitor deletes health, operational errors, activity and alert attempts after 30 days in bounded batches. Business audit events, ledger records, jobs and private documents have separate product/legal retention obligations; decide those with Michael before deletion. Use existing per-resource deletion flows and verify linked records, object deletion and backup expiry. Do not manually delete financial ledger entries to make a drill pass.

Telemetry accepts syntax-constrained component/code/deployment IDs and allowlisted route families only. It discards exception text, full URL paths, query strings, request bodies, provider payloads and SQL parameters. Recovery inventory does not return `actor_json`, `payload_json`, results or provider errors. Review native host logs and provider dashboards for accidental credentials, bank data or full document content during staging; redact evidence before sharing it. Local tests prove identifier validation and route filtering, not every external log source.

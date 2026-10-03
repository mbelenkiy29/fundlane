# Accepting uploads without a virus scan (owner opt-in)

`MCA_DOCUMENT_SCAN_BYPASS=true` turns virus scanning off. Only the exact value `true` enables it. Use it only when the owner has decided to accept files without a scan. It takes precedence over any `MCA_DOCUMENT_SCANNER` value.

## What it does

- `documentScanner()` returns the `not_scanned` scanner. Every file is accepted (`status: "clean"`) with the evidence `{ scanBypassed: true, malwareScanPerformed: false, note: "Not scanned: …" }`. Each accepted file logs a `document_scan_bypassed` warning that records only the byte count.
- Deal document uploads through the multipart upload routes, including on Vercel, become available inline. No `document_scan` job is queued. The bytes are promoted from the quarantine bucket to the documents bucket as usual.
- Presigned direct uploads still go through `document_upload` jobs, so they still need the documents cron (`MCA_DOCUMENT_JOB_RUNTIME=vercel_cron`).
- Documents in `scan_failed` (a scanner ran and could not verify the file) and `quarantined` (infected) stay blocked. Retry scan, intake processing and re-uploading the same file all leave them as they are. To use the file, upload a new version.
- Application scan drafts (the "Upload application" panel) follow the same rule. A draft in `scan_failed` or `quarantined` stays blocked under the bypass: retry, the `draft_scan` job and re-uploading the same file all leave it as it is. The panel shows no "Retry scan" button for a quarantined draft. If a quarantined file was a false positive, upload a new file; the bypass never releases it.
- The audit row `document.ready` records `malwareScanPerformed: false`.
- Files the bypass lets through are labelled **Not virus-checked** next to "Ready" in the document vault and next to "clean" in the application panel. The label comes from columns that already exist (`scan_provider='not_scanned'` and `scan_evidence.scanBypassed`), so it needs no migration. Application invitation files (`mca_application_invitation_files`) have no scan column, so they carry no label; until a column is added on purpose, find them through the saved ID list and the audit log.
- The documents cron also claims the scan job kinds while the bypass is on, so already-queued jobs finish once that cron runs. That includes queued `intake_process` jobs, which start underwriting and matching for the intake backlog.
- All other upload checks still apply: size, type/magic bytes, checksum and storage immutability.

## Releasing files that were stuck before the bypass

A SQL-only release is **not enough**. Pending files' bytes live in the quarantine bucket, and downloads are signed from the documents bucket. Use the existing recovery script, which runs the normal retry path (and so the bypass scanner) for each pending file:

```bash
cd nextjs-version
# Production env: DATABASE_URL, MCA_DATA_ENCRYPTION_KEY, MCA_DOCUMENT_STORAGE_PROVIDER=supabase,
# SUPABASE_URL, SUPABASE_SECRET_KEY, plus MCA_DOCUMENT_SCAN_BYPASS=true.
# Leave MCA_DEAL_AGENT_ENABLED unset so released files don't each start a Deal Agent run.
node --conditions=react-server --import tsx scripts/documents/recover.ts --workspace-id=<id>          # preview: counts per state, writes nothing
node --conditions=react-server --import tsx scripts/documents/recover.ts --workspace-id=<id> --apply  # release
```

Check first which states the stuck files are in. Only `pending_scan` is released under the bypass:

```sql
SELECT workspace_id, processing_state, count(*) FROM mca_documents
WHERE processing_state IN ('pending_scan','scan_failed','pending_upload','upload_failed','quarantined') GROUP BY 1, 2;
```

The preview prints `byState` (counts per state) and `candidates` (the `pending_scan` files it would release). With the bypass on, the script leaves `scan_failed`, `pending_upload`, `upload_failed` and `quarantined` documents untouched. For each `pending_scan` document in that workspace, the script:

1. Copies the object to the documents bucket under the same key, then removes it from the quarantine bucket.
2. Sets `processing_state='clean'`, `scan_provider='not_scanned'` and `scan_evidence` (bypass note), and updates `scan_attempted_at` and `updated_at`.
3. Inserts one `document.ready` audit event.

It never deletes a document row. A file that fails integrity checks (checksum or type) becomes `upload_failed` and is listed in `failed`; it is not released.

Optional tidy-up afterwards. Queued `document_scan` jobs for released files would otherwise complete as no-ops whenever the documents cron runs:

```sql
UPDATE mca_background_jobs SET state='complete', updated_at=to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
WHERE kind='document_scan' AND state='queued'
  AND resource_id IN (SELECT id FROM mca_documents WHERE processing_state='clean' AND scan_provider='not_scanned');
```

## Turning scanning back on

Unset `MCA_DOCUMENT_SCAN_BYPASS` and configure a scanner (see `docs/cloudmersive-scanner.md`). Files accepted while the bypass was on keep `scan_provider='not_scanned'` until they are rescanned.

## Rescanning files the bypass let through

`scripts/documents/rescan.ts` rescans deal documents (`mca_documents`) with the configured real scanner.

```bash
cd nextjs-version
# Env: DATABASE_URL, MCA_DATA_ENCRYPTION_KEY, MCA_DOCUMENT_STORAGE_PROVIDER=supabase, SUPABASE_URL, SUPABASE_SECRET_KEY,
# MCA_DOCUMENT_SCANNER=cloudmersive (or clamdscan/clamscan) and NO MCA_DOCUMENT_SCAN_BYPASS.
R="node --conditions=react-server --import tsx scripts/documents/rescan.ts --workspace-id=<id>"
$R                                                    # preview: files marked not_scanned; writes nothing
$R --ids-file=released.txt --include-audit            # preview, also the ID list and document.ready audit rows with malwareScanPerformed:false
$R --ids-file=released.txt --include-audit --apply --confirm-database=<host>/<database>   # rescan
```

- **Finding files.** It always takes files with `scan_provider='not_scanned'`. `--ids-file` adds an explicit list (one document ID per line; blank lines and `#` comments are ignored). `--include-audit` adds documents whose `document.ready` audit row says `malwareScanPerformed:false`. Only documents in `--workspace-id` are read or changed; IDs from other workspaces are reported in `notFound`.
- **Preview by default.** Without `--apply` nothing is written. The output (one JSON line) names the target database (`database: "host/database"`), the scanner, and whether it is a real one (`scannerReady`).
- **Refuses to write unless the database is confirmed.** `--apply` needs `--confirm-database=` equal to the `database` value from the preview. Without it, or with any other value, the tool refuses and writes nothing. This makes it hard to run `--apply` against the wrong database (for example production by mistake).
- **Refuses without a real scanner.** `--apply` refuses while `MCA_DOCUMENT_SCAN_BYPASS=true` or when no scanner is configured. It never marks a file clean without a real scan.
- **Results.**
  - **Clean:** the real provider and evidence (`malwareScanPerformed: true`, `rescannedAfterBypass: true`) replace the "not scanned" marker, and one `document.rescanned` audit row is added.
  - **Infected:** the document becomes `quarantined`, so downloads, previews and new submissions stop, and a `document.rescanned` audit row records it. Copies already sent to lenders are not recalled, and the bytes stay in the documents bucket.
  - **Scanner error, unreadable bytes, or a changed checksum:** the file is left exactly as it was and listed in `failed`. The exit code is 1.
- **Skipped.** Files that are not available (pending, failed or quarantined) are listed in `notReady` and never touched.
- **Safe to rerun.** Files a real scanner already cleared are counted in `alreadyScanned` and skipped.

### Optional: label files released without the marker

Files released before the marker existed, or relabelled since, can be labelled from the same ID list. This mode only adds the label (`scan_provider='not_scanned'`, `scanBypassed: true`, `markerBackfilled: true`) and one `document.scan_marker_backfilled` audit row per file. It never changes `processing_state` or `scan_attempted_at`, and it skips files a real scanner already cleared:

```bash
$R --ids-file=released.txt --backfill-marker                                              # preview
$R --ids-file=released.txt --backfill-marker --apply --confirm-database=<host>/<database>
```

Application drafts are short-lived and become deal documents when they are confirmed, so the tool doesn't rescan drafts. Invitation files have no marker column; see above.

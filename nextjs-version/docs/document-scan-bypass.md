# Accepting uploads without a virus scan (owner opt-in)

`MCA_DOCUMENT_SCAN_BYPASS=true` turns virus scanning off. Only the exact value `true` enables it. Use it only when the owner has decided to accept files without a scan. It takes precedence over any `MCA_DOCUMENT_SCANNER` value.

## What it does

- `documentScanner()` returns the `not_scanned` scanner. Every file is accepted (`status: "clean"`) with the evidence `{ scanBypassed: true, malwareScanPerformed: false, note: "Not scanned: …" }`. Each accepted file logs a `document_scan_bypassed` warning that records only the byte count.
- Deal document uploads, including on Vercel, become available inline. No `document_scan` job is queued and no documents cron is needed. The bytes are promoted from the quarantine bucket to the documents bucket as usual.
- The audit row `document.ready` records `malwareScanPerformed: false`.
- The documents cron also claims the scan job kinds while the bypass is on, so already-queued jobs finish once that cron runs.
- All other upload checks still apply: size, type/magic bytes, checksum and storage immutability.

## Releasing files that were stuck before the bypass

A SQL-only release is **not enough**. Pending files' bytes live in the quarantine bucket, and downloads are signed from the documents bucket. Use the existing recovery script, which runs the normal retry path (and so the bypass scanner) for each pending file:

```bash
cd nextjs-version
# Production env: DATABASE_URL, MCA_DATA_ENCRYPTION_KEY, MCA_DOCUMENT_STORAGE_PROVIDER=supabase,
# SUPABASE_URL, SUPABASE_SECRET_KEY, plus MCA_DOCUMENT_SCAN_BYPASS=true.
# Leave MCA_DEAL_AGENT_ENABLED unset so released files don't each start a Deal Agent run.
node --conditions=react-server --import tsx scripts/documents/recover.ts --workspace-id=<id>          # preview: counts only
node --conditions=react-server --import tsx scripts/documents/recover.ts --workspace-id=<id> --apply  # release
```

For each `pending_scan`, `scan_failed`, `pending_upload` or `upload_failed` document in that workspace, the script:

1. Copies the object to the documents bucket under the same key, then removes it from the quarantine bucket.
2. Sets `processing_state='clean'`, `scan_provider='not_scanned'` and `scan_evidence` (bypass note), and updates `scan_attempted_at` and `updated_at`.
3. Inserts one `document.ready` audit event.

It never deletes a document row. A file that fails integrity checks (checksum or type) stays pending and is listed in `failed`.

Optional tidy-up afterwards. Queued `document_scan` jobs for released files would otherwise complete as no-ops whenever the documents cron runs:

```sql
UPDATE mca_background_jobs SET state='complete', updated_at=to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
WHERE kind='document_scan' AND state='queued'
  AND resource_id IN (SELECT id FROM mca_documents WHERE processing_state='clean' AND scan_provider='not_scanned');
```

## Turning scanning back on

Unset `MCA_DOCUMENT_SCAN_BYPASS` and configure a scanner (see `docs/cloudmersive-scanner.md`). Files accepted while the bypass was on keep `scan_provider='not_scanned'`, so they can be found and rescanned later.

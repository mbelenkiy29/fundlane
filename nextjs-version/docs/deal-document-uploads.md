# Deal document uploads

All deal document categories stay in quarantine until `documentScanner()` returns `clean`. After content/type/size validation, immutable storage, and checksum verification, the vault scans the bytes. Only a `clean` result calls `promoteClean` and makes the file available for preview, download, filename suggestions, underwriting, completeness, stipulations, and submissions.

Scan outcomes:

- `clean` → promote to the private document bucket and write processing state `clean` (`malwareScanPerformed: true`)
- `infected` → `quarantined` (never released by retry)
- `unavailable` (unconfigured or scanner down) → `pending_scan`
- `error` → `scan_failed`

`ready` remains a historical processing state accepted by `isDocumentReady` (`ready` or `clean`). New uploads write `clean`, not `ready`. Application drafts before deal creation retain their separate scanning flow.

On Vercel (or when `MCA_BACKGROUND_JOBS=enabled`), HTTP uploads enqueue a `document_scan` job and return `pending_scan` without scanning in-request. The retained worker code can run the scan, but Render is historical and no current production document consumer is verified. See [background job runtime](background-job-runtime.md) for the non-Render cutover and fail-closed acceptance gate. Direct uploads inside the background worker still scan inline.

Incomplete uploads use `pending_upload` or `upload_failed`. Retry with the same file and upload key after an interrupted request. Existing rows offer **Retry malware scan**, which calls `retryDocumentScan` and actually scans; it does not mark a document ready or `clean` without a `clean` scanner result. Quarantined files are never released by this operation. Missing or corrupt files require a replacement version; transient storage errors can be retried.

## Recover existing documents

Deploy the updated web application and document worker together before recovery so old workers cannot reapply skip-scan states. With the target environment's database and storage credentials loaded, preview one workspace:

```sh
node --conditions=react-server --env-file=.env.local --import tsx scripts/documents/recover.ts --workspace-id=WORKSPACE_ID
```

Add `--apply` to complete the recovery. It processes pending/failed scan and upload records in batches, verifies each file's size, checksum and content, then calls `retryDocumentScan`. That path scans and promotes only when the scanner returns `clean`; it does not mark files `ready` without a clean scan. It preserves IDs, versions and filenames, skips ready/clean/quarantined files, records audit events, and reports failures by document ID and error code without file contents. Re-running is safe; failure of one file does not stop the remaining records. No blanket SQL status update is appropriate because private storage promotion must succeed first.

No database DDL migration is needed: processing states are stored as text. Deploy all consumers with the additive state contract before writing `clean` records.

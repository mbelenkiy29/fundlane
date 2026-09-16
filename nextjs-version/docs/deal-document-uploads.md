# Deal document uploads

All deal document categories become `ready` after content/type/size validation, immutable storage, checksum verification, and promotion to the private document bucket. Deal uploads do not invoke malware scanners or require scanner credentials. Existing `clean` documents remain usable; `ready` does not claim a malware scan occurred. Application drafts before deal creation retain their separate scanning flow.

Preview, downloads, filename suggestions, underwriting, completeness, stipulations, and submissions accept both `ready` and `clean`. AI features still need their provider credentials. Private storage, download authorization, and workspace isolation remain enforced.

Incomplete uploads use `pending_upload` or `upload_failed`. Retry with the same file and upload key after an interrupted request; existing rows also offer **Retry upload completion**. The legacy POST document `/scan` endpoint and queued `document_scan` jobs now perform storage completion without scanning. Quarantined files are never released by this operation. Missing or corrupt files require a replacement version; transient storage errors can be retried.

## Recover existing documents

Deploy the updated web application and document worker together before recovery so old workers cannot reapply scanner states. With the target environment's database and storage credentials loaded, preview one workspace:

```sh
node --conditions=react-server --env-file=.env.local --import tsx scripts/documents/recover.ts --workspace-id=WORKSPACE_ID
```

Add `--apply` to complete the recovery. It processes pending/failed scan and upload records in batches, verifies each file's size, checksum and content, promotes its immutable bytes, then marks it `ready`. It preserves IDs, versions and filenames, skips ready/clean/quarantined files, records audit events, and reports failures by document ID and error code without file contents. Re-running is safe; failure of one file does not stop the remaining records. No blanket SQL status update is appropriate because private storage promotion must succeed first.

No database DDL migration is needed: processing states are stored as text. Deploy all consumers with the additive state contract before writing `ready` records.

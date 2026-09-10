# SQLite baseline before Neon migration

Captured at `2026-09-08T16:43:21Z` with the application stopped. No process had the SQLite database, WAL, or shared-memory file open. The source resolved from `MCA_DB_PATH` to `/Users/mbele/Desktop/mca/nextjs-version/data/mca.sqlite`; its committed WAL contents were included by creating the snapshot with read-only `node:sqlite` `VACUUM INTO`.

## Protected backup

- Path: `/Users/mbele/Desktop/mca/nextjs-version/data/mca-pre-neon-20260908T164321Z.sqlite`
- File mode: `0600`
- Size: `249856` bytes
- SHA-256: `d5dd8173bb45f34b06daacb3171728f3e5f6db023da96d9ce229d858fce0c167`
- Verification: source `quick_check` passed; backup `quick_check` and `foreign_key_check` passed; all source and backup row counts matched.

## Table row counts

| Table | Rows |
| --- | ---: |
| `api_keys` | 0 |
| `api_rate_windows` | 0 |
| `audit_events` | 0 |
| `deal_activity` | 0 |
| `deal_assignments` | 0 |
| `deal_notes` | 0 |
| `deal_offers` | 0 |
| `deal_owners` | 0 |
| `deal_submissions` | 0 |
| `deals` | 0 |
| `invitations` | 0 |
| `memberships` | 1 |
| `recovery_tokens` | 0 |
| `request_rate_windows` | 2 |
| `sessions` | 2 |
| `users` | 1 |
| `workspaces` | 1 |

## Environment key names

`.env.local` defines these names: `MCA_DB_PATH`, `MCA_APP_ORIGIN`, `MCA_BOOTSTRAP_WORKSPACE_NAME`, `MCA_BOOTSTRAP_ADMIN_EMAIL`, `MCA_BOOTSTRAP_ADMIN_PASSWORD`, `POSTMARK_ACCOUNT_TOKEN`.

`.env.example` defines these names: `MCA_DATA_ENCRYPTION_KEY`, `MCA_DB_PATH`, `MCA_APP_ORIGIN`, `MCA_BOOTSTRAP_WORKSPACE_NAME`, `MCA_BOOTSTRAP_ADMIN_EMAIL`, `MCA_BOOTSTRAP_ADMIN_PASSWORD`, `MCA_GOOGLE_DRIVE_CLIENT_ID`, `MCA_GOOGLE_DRIVE_CLIENT_SECRET`, `MCA_GOOGLE_DRIVE_REDIRECT_URI`, `MCA_EMAIL_WEBHOOK_URL`, `MCA_EMAIL_WEBHOOK_TOKEN`, `MCA_ALLOWED_ORIGINS`, `MCA_ALLOW_RECOVERY_PREVIEW`.

No environment values were copied into this baseline.

## Encryption key and documents

`MCA_DATA_ENCRYPTION_KEY` is absent from `.env.local`, so local encryption would use the code's deterministic development fallback. The source snapshot has no stored non-empty `*_cipher` values, so existing data encrypted under that fallback was **not detected**. Production requires one base64url-encoded 32-byte key stored outside the repository and database in the deployment secret manager. Preserve the exact key across migration and rollback whenever ciphertext exists; rotating it without re-encrypting every protected value makes AES-256-GCM data unreadable. Ciphertext also authenticates the immutable workspace ID as associated data.

`MCA_DOCUMENT_STORAGE_PATH` is absent from `.env.local`, so the resolved document path is `/Users/mbele/Desktop/mca/nextjs-version/data/documents`. That directory did not exist at capture time and contained no document files. A SQLite backup does not include this filesystem storage; back it up separately if documents are added before cutover.

# MIC-171 acceptance — Destination funder stamps

Executed September 8, 2026. Scope: workspace enablement and per-funder exclusions, destination-specific PDF derivatives from immutable originals, derivative identity bound to original checksum + destination + template version, and admin-only settings. Live funder delivery is out of scope.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| Two funders receive distinct correct stamps | Passed | `tests/submissions-stamps.test.ts` — Harbor vs Northwind output checksums and document IDs differ; inflated PDF streams contain `Submitted to Harbor Capital Partners LLC` vs `Submitted to Northwind Funding Inc` |
| Stored original checksum unchanged | Passed | Vault `mca_documents.checksum`, filesystem/memory storage hash, and `prepareOutgoingPackage.originalChecksums` stay the original SHA-256; derivative checksum differs |
| Exclusion skip | Passed | Northwind in `excludedFunderIds` returns original id/checksum/`stage: "original"`; Harbor still stamps; preview `skipped: "excluded"` |
| Settings admin-only | Passed | GET/PATCH require admin session; rep, `deals:read`, and `intake:write` are 403; empty GET defaults; PATCH validation 422; invalid JSON 400 |
| Preview validates all pages; retries keep identity | Passed | Two-page statement (portrait + landscape) `fitted`; second apply/preview returns the same derivative id (`replayed: true`) |
| Direct API matches UI; no document bytes in JSON | Passed | Preview `deals:read` 200; cross-workspace 404; responses omit `%PDF` and statement figures |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/submissions-stamps.test.ts
```

4/4 passed.

## Behavior

- Settings: `mca_stamp_settings` `enabled` + `exclusions_json`. Disabled or excluded funders skip stamping and still send the allowed original.
- Stamp text is `Submitted to {funder legal name}` in a 36pt footer margin with a light backing rectangle. Helvetica-Bold, wrapped, WinAnsi-safe.
- Derivatives stored under `{workspaceId}/derivatives/stamp/{id}` and recorded in `mca_outgoing_derivatives` stage `stamp`. Unique `(original_document_id, funder_id, stage, template_version)`.
- `applyStamp` is the package.ts hook. Non-PDF originals pass through. Dirty originals 423. Frozen checksum mismatch 409.
- GET/PATCH `/api/mca/submissions/stamps`: interactive admin/super_admin, `assertTrustedMutation` on PATCH, `cache-control: no-store`, `runtime = "nodejs"`.
- POST `/api/mca/submissions/stamps/preview`: `deals:read`, same deal visibility as the vault. Does not return PDF bytes.

## UI

No exclusive UI on this ticket. API empty/validation/success/failure states are ready for a conductor-mounted settings + preview panel.

## Local vs live gates

Local Postgres fixtures prove distinct destination stamps, original immutability, exclusion skip, ACL, and preview page validation. There is no external stamp provider. Fixture success is not production sending readiness.

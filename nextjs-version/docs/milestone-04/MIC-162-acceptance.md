# MIC-162 acceptance — Broker logo watermarks

Executed September 8, 2026. Scope: workspace enablement, logo attach/upload, per-funder exclusions independent from stamps, non-obscuring PDF derivatives from allowed prior bytes, derivative identity bound to original checksum + destination + template version, and admin-only settings. Live funder delivery is out of scope.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| Funder exclusion sends original/prior derivative | Passed | `tests/submissions-watermarks.test.ts` — Northwind in watermark `excludedFunderIds` returns original id/checksum/`stage: "original"`; Harbor watermarks; preview `skipped: "excluded"` |
| Stamp exclusions are independent | Passed | Watermark-excluded Northwind keeps `stage: "stamp"`; stamp-excluded Harbor still watermarks the original |
| Stored original checksum unchanged | Passed | Vault `mca_documents.checksum`, memory storage hash, and `prepareOutgoingPackage.originalChecksums` stay the original SHA-256; derivative checksum differs; statement figure remains in the outgoing PDF |
| Wide logo / landscape / rotated page | Passed | Three-page statement (portrait + landscape + 90°). Preview `fitted` on every page; watermark box stays inside a 48pt inset at opacity `0.16`; 800×40 logo is scaled below 25% page width |
| Settings admin-only; branding invalidates cache | Passed | GET/PATCH/logo POST require admin session; rep, `deals:read`, and `intake:write` are 403; empty GET defaults; PATCH validation 422; invalid JSON 400; logo upload bumps `template_version` and yields a new derivative id; retry before branding change replays the same id |
| Direct API matches UI; no document bytes in JSON | Passed | Preview `deals:read` 200; cross-workspace 404; responses omit `%PDF`, statement figures, and PNG tEXt secrets |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/submissions-watermarks.test.ts
```

4/4 passed.

## Behavior

- Settings: `mca_watermark_settings` `enabled` + `logo_document_id` + `exclusions_json`. Disabled, excluded, missing-logo, and non-PDF inputs skip watermarking and still send the allowed original or prior stamp derivative.
- Logo: clean workspace `mca_documents` PNG/JPEG, sanitized upload stored under `{workspaceId}/derivatives/watermark-logo/{id}`, or workspace `logo_url` data URI. HTTP logo URLs are not fetched.
- Placement: bottom-right corner, opacity 0.16, 48pt content inset, scaled into a corner band so wide logos cannot cover left-side statement figures.
- Derivatives stored under `{workspaceId}/derivatives/watermark/{id}` and recorded in `mca_outgoing_derivatives` stage `watermark`. Unique `(original_document_id, funder_id, stage, template_version)`.
- `applyWatermark` is the package.ts hook. Reads stamp/original bytes via stamps `getOutgoingDocumentBytes`. Dirty originals 423. Frozen checksum mismatch 409.
- GET/PATCH `/api/mca/submissions/watermarks` and POST `/api/mca/submissions/watermarks/logo`: interactive admin/super_admin, `assertTrustedMutation` on writes, `cache-control: no-store`, `runtime = "nodejs"`.
- POST `/api/mca/submissions/watermarks/preview`: `deals:read`, same deal visibility as the vault. Does not return PDF or logo bytes.

## UI

No exclusive UI on this ticket. API empty/validation/success/failure states are ready for a conductor-mounted settings + preview panel.

## Local vs live gates

Local Postgres fixtures prove exclusion skip, stamp/watermark independence, original immutability, 48pt inset on landscape and rotated pages, ACL, cache identity, and branding invalidation. There is no external watermark provider. Fixture success is not production sending readiness.

# MIC-160 acceptance — Manual and automatic PDF compression with size gates

Executed September 8, 2026. Scope: workspace automatic-email compression, manual compress action, per-funder exclusions, keep-pre-compress when size does not drop, encoded payload ceiling with a size report, original immutability, and page-count preservation. Live funder delivery is out of scope.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| Incompressible oversized package blocked with sizes | Passed | `tests/submissions-compress.test.ts` — two 10-page statements, `maxPayloadBytes: 800`; `applyCompression` / `prepareOutgoingPackage` / preview POST throw 413 `payload_too_large` with `encodedPayloadBytes`, `rawPayloadBytes`, `maxPayloadBytes`, and per-document input/output/encoded/pages |
| Stored original checksum unchanged | Passed | Vault `mca_documents.checksum`, memory storage hash, and `prepareOutgoingPackage.originalChecksums` stay the original SHA-256 after both a successful compress and a blocked oversized job |
| Exclusion skip | Passed | Northwind in `excludedFunderIds` returns original id/checksum/`stage: "original"`; Harbor still compresses; preview `skipped: "excluded"`; manual POST with automatic off still honors the exclusion |
| Page count preserved; output legible | Passed | 10-page bloated statement stays 10 pages; inflated PDF streams still contain `Average daily balance 12,500.00`; landscape 2-page statement stays 2 pages on the Harbor path |
| Keep pre-compress when size does not drop | Passed | `outputBytes <= inputBytes` or `keptPreCompress`; automatic off leaves `stage: "original"` in `prepareOutgoingPackage` |
| Settings admin-only; retries keep identity | Passed | GET/PATCH require admin session; rep, `deals:read`, and `intake:write` are 403; empty GET defaults to `automaticEmail: false` / `25_000_000`; PATCH validation 422; invalid JSON 400; manual POST `deals:write` 200; `deals:read` POST 403; second manual POST replays the same derivative id when compression stored a row |
| Direct API matches UI; no document bytes in JSON | Passed | Preview `deals:read` 200; cross-workspace 404; 413/200 JSON omits `%PDF` and statement figures |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/submissions-compress.test.ts
```

4/4 passed.

## Behavior

- Settings: `mca_compress_settings` `automatic_email` + `max_payload_bytes` (default 25_000_000) + `exclusions_json`. Automatic off skips compression in `package.ts` but still measures encoded payload. Excluded funders skip compression and still send the allowed original or prior stamp/watermark derivative.
- Compression: pdf-lib object-stream rebuild of the incoming allowed derivative. If output is not smaller, keep the pre-compress document. Page count must match or the candidate is discarded.
- Encoded payload: sum of RFC 4648 base64 attachment lengths. Over the configured ceiling → 413 `payload_too_large` with a size report. Originals are never rewritten.
- Derivatives stored under `{workspaceId}/derivatives/compress/{id}` and recorded in `mca_outgoing_derivatives` stage `compress`. Unique `(original_document_id, funder_id, stage, template_version)` with `template_version` derived from the incoming checksum.
- `applyCompression` is the package.ts hook (automatic mode). Dirty originals 423 via prior-byte helpers. Frozen checksum mismatch 409.
- GET/PATCH `/api/mca/submissions/compress`: interactive admin/super_admin, `assertTrustedMutation` on PATCH/POST, `cache-control: no-store`, `runtime = "nodejs"`.
- POST `/api/mca/submissions/compress`: `deals:write` manual compress (runs even when automatic email is off).
- POST `/api/mca/submissions/compress/preview`: `deals:read`, same deal visibility as the vault. Does not return PDF bytes.

## UI

No exclusive UI on this ticket. API empty/validation/success/failure states are ready for a conductor-mounted settings + preview/manual panel.

## Local vs live gates

Local Postgres fixtures prove oversized size reports, original immutability, exclusion skip, page-count preservation, ACL, and retry identity. There is no external compression provider. Fixture success is not production sending readiness.

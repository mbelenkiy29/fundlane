# MIC-160 review — Manual and automatic PDF compression with size gates

**Spec:** PASS
**Quality:** Approved (Minor)

No exclusive UI on this ticket. Live funder delivery is out of scope. Fixture success is not production sending readiness. Do not mark Linear Done from this review.

## Spec

| Requirement | Result | Evidence |
| --- | --- | --- |
| Incompressible oversized package blocked with a size report | Pass | Encoded payload is RFC 4648 base64 (`4 * ceil(bytes / 3)`); `assertFits` throws 413 `payload_too_large` with `maxPayloadBytes` / `encodedPayloadBytes` / `rawPayloadBytes` and per-document input/output/encoded/pages (`compress.ts:170-195`, `484-498`). Test: two 10-page bloated statements, `maxPayloadBytes: 800`; `applyCompression`, `prepareOutgoingPackage`, and preview POST all 413 with those fields and no `%PDF` / statement figures (`tests/submissions-compress.test.ts:281-339`). HTTP JSON carries the report as `fieldErrors`, not a nested `report` object (`errors.ts:16-27`). |
| Stored originals unchanged | Pass | Compress writes `{workspaceId}/derivatives/compress/{id}` (`166-168`, `528`) and records `mca_outgoing_derivatives` stage `compress`. Vault `putImmutable` is never called on the original key. `prepareOutgoingPackage` freezes `originalChecksums` before stamp → watermark → compress (`package.ts:12-17`). Tests: `mca_documents.checksum`, memory storage SHA-256, and package map stay the bloated digest after a successful compress and after a blocked oversized job (`test.ts:319-323`, `342-377`). Cached hit rejects original checksum mismatch (`510-512`). |
| Compression increase keeps the pre-compress derivative | Pass | `compressPdf` keeps source unless a candidate is strictly smaller and page count matches (`475-481`). `persistCompress` returns `input.source` (incoming stamp/watermark/original identity) when `keptPreCompress` (`522-524`). Tests assert `outputBytes <= inputBytes \|\| keptPreCompress` and automatic-off packaging stays `stage: "original"` (`test.ts:310`, `464-466`). No fixture forces a PDF that grows. |
| Funder exclusions skip compression | Pass | `skipReason` returns `excluded` in both automatic and manual modes (`400-405`). Excluded / disabled / non-PDF paths push the incoming document (`600-616`). Test: Northwind in `excludedFunderIds` keeps original id/checksum/`stage: "original"`; Harbor still compresses or keeps pre-compress; preview `skipped: "excluded"`; manual POST with automatic off still honors the exclusion (`test.ts:381-416`, `493-501`). |
| `package.ts` already calls `applyCompression` | Pass | `package.ts:3,16` `documents = await applyCompression(documents, input.funderId)` after stamp and watermark. Order original → stamp → watermark → compress matches the milestone plan. This ticket did not need to edit `package.ts`. Tests package through `prepareOutgoingPackage` (`test.ts:326-328`, `352-366`, `464-466`). |

Exclusive files match the brief: `compress.ts`, `src/app/api/mca/submissions/compress/**`, `tests/submissions-compress.test.ts`, report, acceptance. Table `mca_compress_settings` already exists.

## Quality

Approved. Minor only:

1. `POST /compress/preview` persists a real derivative (`previewCompression` → `transformDocuments` → `persistCompress`, `673-679`) without `assertTrustedMutation`. Identity reuse is intentional (`replayed: true`), but it is a mutating `deals:read` POST. SameSite=Lax cookies still mitigate browser CSRF. Same pattern as MIC-162 watermark preview.
2. Preview uses `mode: "automatic"` (`676`), so `automaticEmail: false` skips compression (`401`). Manual POST still compresses while automatic is off (`727-733`, `test.ts:468-479`). Preview is not a dry-run of the manual action.
3. Size gate runs after `persistCompress` (`617-639`). A 413 still leaves stored compress rows for retry identity. Originals are not rewritten.
4. HTTP 413 exposes sizes only via `fieldErrors` (`180-195`, `apiError`). In-process callers get `PayloadTooLargeError.report`; `applyCompression` itself returns documents only.
5. `template_version` is `parseInt(checksum.slice(0, 7), 16)` (`418-423`). Distinct incoming checksums can collide on the unique `(original_document_id, funder_id, stage, template_version)` key. Cache hits still require `original_checksum` match (`510-512`).
6. Acceptance “Dirty originals 423” is delegated to stamp/watermark `getOutgoingDocumentBytes` (`595-597`, `watermarks.ts:884-894`, `stamps.ts:459`). Not exercised on this test surface. Compress cache hits do verify stored bytes against `output_checksum` (`514-516`), unlike watermark cache hits.

No Critical or Important defects on the exclusive surface.

## Unverified claims

- **4/4 passed:** four `test("MIC-160:…")` cases match the report/acceptance; this review did not re-execute Postgres.
- **Did not edit `package.ts` / `schema.ts` / `stamps.ts` / `watermarks.ts` / settings UI:** current `applyCompression` call, unique constraint, and settings table match the handoff; the repo has no git, so in-place rewrites cannot be proven.
- **Live funder delivery / production sending:** not production-verified (documented remaining gate).

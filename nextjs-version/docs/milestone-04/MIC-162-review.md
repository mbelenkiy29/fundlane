# MIC-162 review — Broker logo watermarks

**Spec:** PASS
**Quality:** Approved (Minor)

No exclusive UI on this ticket. Live funder delivery is out of scope. Fixture success is not production sending readiness. Do not mark Linear Done from this review.

## Spec

| Requirement | Result | Evidence |
| --- | --- | --- |
| Funder exclusion sends original / allowed prior derivative | Pass | Disabled or excluded funders return the incoming identities (`watermarks.ts:791`). Test: Northwind in `excludedFunderIds` keeps original id/checksum/`stage: "original"`; Harbor watermarks; preview `skipped: "excluded"` (`submissions-watermarks.test.ts:341-369`). Non-PDF path pushes the incoming document (`801-804`). |
| Independent from stamp exclusions | Pass | Watermark exclusions live on `mca_watermark_settings.exclusions_json` (`schema.ts:1541-1548`); stamp exclusions are a separate table. Test: watermark-excluded Northwind keeps `stage: "stamp"`; stamp-excluded Harbor still watermarks the original (`test.ts:371-385`). `applyWatermark` reads stamp/original bytes via stamps `getOutgoingDocumentBytes` (`707-718`, `16`). |
| Stored original checksum unchanged | Pass | Hook writes `{workspaceId}/derivatives/watermark/{id}` (`181-183`, `746`) and records `original_checksum` without mutating vault rows. `prepareOutgoingPackage` freezes `originalChecksums` before stamp/watermark (`package.ts:12-17`). Test: `mca_documents.checksum`, memory storage SHA-256, and package map stay the source digest; derivative checksum differs; statement figure remains (`test.ts:388-407`). Cached hit rejects original checksum mismatch (`735-737`). |
| `applyWatermark` used by conductor `package.ts` | Pass | `package.ts:6,15` `documents = await applyWatermark(documents, input.funderId)` after stamps and before compression. Pipeline order original → stamp → watermark → compress matches the milestone plan. Test packages through `prepareOutgoingPackage` (`test.ts:398-401`). |
| Non-obscuring placement; branding invalidates cache | Pass | Bottom-right, opacity `0.16`, 48pt inset, corner band ≤25% width / ≤72pt height (`19-21`, `619-634`). Unique `(original_document_id, funder_id, stage, template_version)` (`schema.ts:1467`; insert `583-596`). Settings/logo persist bumps `template_version` (`457`). Tests: three-page portrait/landscape/90° all `fitted`; replay same id; logo POST version 2 mints a new derivative (`test.ts:410-514`). |
| Settings admin-only; JSON omits document bytes | Pass | GET/PATCH/logo POST `requireWatermarkAdmin` → session `admin`/`super_admin` (`552-556`; `auth.ts:104-106`). Writes `assertTrustedMutation`. Preview is `deals:read` (`558-561`). Tests: empty GET defaults disabled; PATCH 422/400; rep / `deals:read` / `intake:write` 403; preview 200; cross-workspace 404; responses omit `%PDF`, statement figures, PNG tEXt (`test.ts:439-570`). |

## Quality

Approved. Minor only:

1. `POST /watermarks/preview` persists a real derivative (`previewWatermark` → `persistWatermark`, `watermarks.ts:869`) without `assertTrustedMutation`. Identity reuse is intentional (`replayed: true`), but it is a mutating `deals:read` POST. SameSite=Lax cookies still mitigate browser CSRF.
2. Replay preview rebuilds page boxes from **vault original** bytes when `persistWatermark` returns `pages: []` (`870`, `733-739`). Layout matches the original page sizes; it does not re-read the stored watermarked PDF. Preview always sources `stage: "original"` (`862-868`), so it never previews a stamp-then-watermark stack.
3. Cache hit in `persistWatermark` does not verify stored bytes against `output_checksum` (`738-739`). `getOutgoingDocumentBytes` does (`888-891`).
4. `layoutWatermark` records `page.getRotation().angle` but does not transform coordinates (`637-653`, `668-677`). Fixture “rotated” page is a 90° flag on a 612×792 box; landscape is a different page size.
5. `applyWatermark` reads source bytes before `persistWatermark` reads them again (`800` vs `742`). Extra read only. It also does **not** 423 dirty statement PDFs (only dirty **logos** at `407-409` / `423-425`). Acceptance “Dirty originals 423” is an overclaim on this hook; stamps still gate originals.
6. Direct logo POST stores sanitized PNG/JPEG under `{workspaceId}/derivatives/watermark-logo/{id}` with a synthetic id, not an `mca_documents` row (`531-532`). Attach-existing and workspace data-URI paths still match the brief.
7. Untested on this surface: non-PDF passthrough, disabled `prepareOutgoingPackage` identity, encrypted PDF 422, HTTP `logo_url` skip, `deals:write` key on settings (sessionOnly would 403).

No Critical or Important defects on the exclusive surface.

## Unverified claims

- **4/4 passed:** four `test("MIC-162:…")` cases match the report; this review did not re-execute Postgres.
- **Did not edit `package.ts` / `schema.ts` / `stamps.ts` / settings UI:** current `applyWatermark` call, unique constraint, and stamp table remain separate; the repo has no git, so in-place rewrites cannot be proven.
- **Live funder delivery:** not production-verified (documented remaining gate).

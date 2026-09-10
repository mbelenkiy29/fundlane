# MIC-162 report — Broker logo watermarks

**Status:** DONE locally with synthetic PDFs and PNG logos. No external provider.

## Contract

`applyWatermark(documents, funderId)` in `src/lib/mca/submissions/watermarks.ts` is called by conductor-owned `package.ts` after stamps. Workspace watermark settings default to disabled (identity), so existing packaging stays unchanged until an admin enables watermarks and supplies a logo.

When enabled, each PDF is watermarked from the **incoming allowed derivative** (stamp output, or the immutable original when stamps skipped) with pdf-lib. Broker logo placement is bottom-right, opacity `0.16`, with a 48pt content inset. Wide logos scale into a corner band (≤25% page width, ≤72pt height) so statement figures stay readable. Non-PDF files, disabled workspaces, missing logos, and excluded funders return the incoming document unchanged (`stage: "original"` or `stage: "stamp"`). Original vault checksum and storage bytes never change.

Logo source is `mca_documents` id (PNG/JPEG, clean) or a workspace `logo_url` data URI. HTTP `logo_url` values are not fetched. PNG ancillary chunks are stripped before embed. Direct API JSON omits data-URI bytes.

Derivative identity is unique on `(original_document_id, funder_id, stage, template_version)` in `mca_outgoing_derivatives` stage `watermark`. Retry of the same original + destination + template returns the same `documentId` / output checksum. Settings PATCH and logo upload bump `template_version`.

Watermark exclusions are stored on `mca_watermark_settings` and are independent of stamp exclusions: an excluded watermark funder still receives the stamp derivative when stamps ran, or the original when stamps also skipped.

Permissions: watermark settings GET/PATCH and logo POST require interactive `admin` / `super_admin`. Preview is `deals:read` (same as the deal). `intake:write` is 403. Direct API matches the UI. JSON omits PDF bytes, statement figures, and logo file contents.

## Tests

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/submissions-watermarks.test.ts
```

4/4 passed.

Covered: Northwind watermark exclusion returns original; Harbor watermarks; stamp+watermark independence (excluded watermark keeps stamp; excluded stamp still watermarks original); `prepareOutgoingPackage` originalChecksums + vault checksum/bytes unchanged; wide logo / landscape / 90° page fitted inside 48pt inset at low opacity without throw; empty GET defaults; PATCH validation 422 / invalid JSON 400; logo upload and attach bump `template_version` and mint a new derivative; workspace data-URI fallback; rep and `deals:read` / `intake:write` settings 403; cross-workspace preview 404.

## Files

- `src/lib/mca/submissions/watermarks.ts`
- `src/app/api/mca/submissions/watermarks/route.ts`
- `src/app/api/mca/submissions/watermarks/preview/route.ts`
- `src/app/api/mca/submissions/watermarks/logo/route.ts`
- `tests/submissions-watermarks.test.ts`
- `docs/milestone-04/MIC-162-acceptance.md`
- `docs/milestone-04/MIC-162-report.md`

Did not edit `package.ts`, `schema.ts`, `stamps.ts`, or settings UI mounts.

## Remaining gates

None for this ticket. Watermarks are local pdf-lib transforms. Fixture success is not production sending readiness.

## Handoff

Mount admin watermark settings (enable, logo upload/attach, funder exclusions) on Settings → Connections. Optional: watermark preview on the deal document panel using `POST /api/mca/submissions/watermarks/preview`. MIC-160 should read `stage: "watermark"` outgoing documents via `getOutgoingDocumentBytes` from `watermarks.ts` (that helper already delegates stamp/original bytes to stamps).

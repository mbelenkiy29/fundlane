# MIC-171 report — Destination funder stamps

**Status:** DONE locally with synthetic PDFs. No external provider.

## Contract

`applyStamp(documents, funderId)` in `src/lib/mca/submissions/stamps.ts` is called by conductor-owned `package.ts`. Workspace stamp settings default to disabled (identity), so existing packaging stays unchanged until an admin enables stamps.

When enabled, each PDF is stamped from the **immutable original** with pdf-lib. Legible footer-margin text: `Submitted to {funder legal name}`. Two funders produce two distinct derivatives. Non-PDF files and excluded funders return the original identity (`stage: "original"`). Original vault checksum and storage bytes never change.

Derivative identity is unique on `(original_document_id, funder_id, stage, template_version)` in `mca_outgoing_derivatives`. Retry of the same original + destination + template returns the same `documentId` / output checksum. Settings PATCH bumps `template_version`.

Permissions: stamp settings GET/PATCH require interactive `admin` / `super_admin`. Preview is `deals:read` (same as the deal). `intake:write` is 403. Direct API matches the UI. JSON omits PDF bytes and document contents.

## Tests

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/submissions-stamps.test.ts
```

4/4 passed.

Covered: Harbor vs Northwind distinct stamp text and checksums; all pages fitted including landscape; retry preserves derivative id; `prepareOutgoingPackage` originalChecksums + vault checksum/bytes unchanged; Northwind exclusion skip; empty GET defaults; PATCH validation 422 / invalid JSON 400; rep and `deals:read` / `intake:write` settings 403; cross-workspace preview 404.

## Files

- `src/lib/mca/submissions/stamps.ts`
- `src/app/api/mca/submissions/stamps/route.ts`
- `src/app/api/mca/submissions/stamps/preview/route.ts`
- `tests/submissions-stamps.test.ts`
- `docs/milestone-04/MIC-171-acceptance.md`
- `docs/milestone-04/MIC-171-report.md`

Did not edit `package.ts`, `schema.ts`, `watermarks.ts`, or settings UI mounts.

## Remaining gates

None for this ticket. Stamps are local pdf-lib transforms. Fixture success is not production sending readiness.

## Handoff

Mount admin stamp settings (enable + funder exclusions) on Settings → Connections. Optional: stamp preview on the deal document panel using `POST /api/mca/submissions/stamps/preview`. MIC-162 should read `stage: "stamp"` outgoing documents via `getOutgoingDocumentBytes`.

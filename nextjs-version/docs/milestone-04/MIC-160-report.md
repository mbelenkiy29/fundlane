# MIC-160 report — Manual and automatic PDF compression with size gates

**Status:** DONE locally with synthetic PDFs. No external compression provider.

## Contract

`applyCompression(documents, funderId)` in `src/lib/mca/submissions/compress.ts` is called by conductor-owned `package.ts` after stamps and watermarks. Workspace compress settings default to `automaticEmail: false` and `maxPayloadBytes: 25_000_000` (identity packaging until an admin enables automatic email compression). The size gate still runs on the outgoing package.

When automatic email compression is on, each PDF is compressed from the **incoming allowed derivative** (watermark, stamp, or immutable original). pdf-lib rebuilds the file with object streams. Page count is verified before the output is kept. If the result is not smaller, the pre-compress derivative is returned (`stage` stays `original` / `stamp` / `watermark`). Non-PDF files, disabled automatic mode, and excluded funders skip compression and still send the allowed prior derivative. Original vault checksum and storage bytes never change.

Encoded email payload is the sum of RFC 4648 base64 attachment lengths (`4 * ceil(bytes / 3)`). If that total exceeds `max_payload_bytes`, the job is blocked with HTTP 413 `payload_too_large` and a size report (`maxPayloadBytes`, `encodedPayloadBytes`, `rawPayloadBytes`, per-document input/output/encoded/pages/`keptPreCompress`). JSON omits PDF bytes and statement contents.

Manual POST compresses even when `automaticEmail` is false, but still honors funder exclusions and the payload ceiling. Derivative identity is unique on `(original_document_id, funder_id, stage, template_version)` in `mca_outgoing_derivatives` stage `compress`. `template_version` is derived from the incoming document checksum so stamp/watermark template changes mint a new compress row. Retry of the same original + destination + incoming checksum returns the same `documentId` / output checksum.

Permissions: compress settings GET/PATCH require interactive `admin` / `super_admin`. Manual POST is `deals:write`. Preview is `deals:read` (same as the deal). `intake:write` is 403. Direct API matches the UI.

## Tests

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/submissions-compress.test.ts
```

4/4 passed.

Covered: two-document incompressible package blocked at 413 with encoded/raw/max sizes and per-file rows; vault checksum unchanged after the block; `prepareOutgoingPackage` and preview return the same gate; bloated 10-page statement compresses (or keeps pre-compress) with page count and statement figures preserved; original SHA-256 unchanged; Northwind exclusion returns original; Harbor still compresses; empty GET defaults; PATCH validation 422 / invalid JSON 400; manual POST compresses while automatic is off; exclusion skip on manual POST; retry preserves derivative id; rep and `deals:read` / `intake:write` settings 403; `deals:read` cannot POST; cross-workspace preview 404.

## Files

- `src/lib/mca/submissions/compress.ts`
- `src/app/api/mca/submissions/compress/route.ts`
- `src/app/api/mca/submissions/compress/preview/route.ts`
- `tests/submissions-compress.test.ts`
- `docs/milestone-04/MIC-160-acceptance.md`
- `docs/milestone-04/MIC-160-report.md`

Did not edit `package.ts`, `schema.ts`, `stamps.ts`, `watermarks.ts`, or settings UI mounts.

## Remaining gates

None for this ticket. Compression is a local pdf-lib transform. Fixture success is not production sending readiness.

## Handoff

Mount admin compress settings (automatic email compression, max encoded payload, funder exclusions) on Settings → Connections. Optional: size-report preview on the deal document panel using `POST /api/mca/submissions/compress/preview`. Manual compress uses `POST /api/mca/submissions/compress` with `deals:write`. `package.ts` already calls `applyCompression` after watermark.

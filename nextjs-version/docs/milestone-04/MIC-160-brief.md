# MIC-160 brief — PDF compression with size gates

**Linear:** https://linear.app/michael-belenkiy/issue/MIC-160
**Depends on:** MIC-153, MIC-162

## Exclusive files

- `src/lib/mca/submissions/compress.ts`
- `src/app/api/mca/submissions/compress/**`
- `tests/submissions-compress.test.ts`
- `docs/milestone-04/MIC-160-report.md`
- `docs/milestone-04/MIC-160-acceptance.md`

Table `mca_compress_settings` exists.

## Rules

- Manual compress action + automatic email-submission setting.
- Order is already stamp → watermark → compress in `package.ts`. Keep that.
- If compression increases size, keep the pre-compress derivative.
- Measure total encoded email payload against `max_payload_bytes` (default 25_000_000). Block oversized jobs with a size report.
- Originals unchanged. Page count preserved. Funder exclusions skip compression.

## Tests

Incompressible oversized package blocked with sizes. Original checksum unchanged. Exclusion skip.

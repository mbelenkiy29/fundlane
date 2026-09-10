# MIC-171 brief — Destination funder stamps

**Linear:** https://linear.app/michael-belenkiy/issue/MIC-171
**Depends on:** MIC-166, MIC-169

## Exclusive files

- `src/lib/mca/submissions/stamps.ts`
- `src/app/api/mca/submissions/stamps/**`
- `tests/submissions-stamps.test.ts`
- `docs/milestone-04/MIC-171-report.md`
- `docs/milestone-04/MIC-171-acceptance.md`

Tables `mca_stamp_settings` and `mca_outgoing_derivatives` already exist.

## Rules

- Workspace enablement + per-funder exclusions JSON.
- Generate destination-specific PDF derivatives from **immutable originals** via pdf-lib. Safe margin placement, legible text: `"Submitted to {funder legal name}"`.
- Bind derivative identity to original checksum, destination, template version.
- Two funders → two distinct stamps. Original checksum unchanged.
- `applyStamp(documents, funderId)` is called by conductor-owned `package.ts`. Honor exclusions by returning originals for excluded funders.

## Tests

Two funders distinct stamps. Original checksum unchanged. Exclusion skip. Settings admin-only.

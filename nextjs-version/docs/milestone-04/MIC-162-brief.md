# MIC-162 brief — Broker logo watermarks

**Linear:** https://linear.app/michael-belenkiy/issue/MIC-162
**Depends on:** MIC-171

## Exclusive files

- `src/lib/mca/submissions/watermarks.ts`
- `src/app/api/mca/submissions/watermarks/**`
- `tests/submissions-watermarks.test.ts`
- `docs/milestone-04/MIC-162-report.md`
- `docs/milestone-04/MIC-162-acceptance.md`

Table `mca_watermark_settings` exists.

## Rules

- Logo upload stored as an `mca_documents` id (or workspace logo_url). Non-obscuring placement (low opacity, corner). Wide logo / rotated page must not cover statement figures — keep a 48pt content inset.
- Per-funder exclusions independent from stamp exclusions.
- Cache versioned derivatives in `mca_outgoing_derivatives` stage `watermark`. Invalidate on branding change (bump template_version).
- Funder exclusion sends clean original/allowed prior derivative.

## Tests

Exclusion sends original. Opacity/placement does not throw on landscape page. Original checksum unchanged.

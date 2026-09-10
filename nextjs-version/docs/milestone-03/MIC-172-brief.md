# MIC-172 brief — Manual underwriting corrections

Ticket: https://linear.app/michael-belenkiy/issue/MIC-172/manual-underwriting-corrections-and-recalculation

Exclusive files:
- `src/lib/mca/underwriting/corrections.ts`
- `src/app/api/mca/underwriting/corrections/**`
- `src/components/mca/underwriting/correction-panel.tsx`
- `tests/underwriting-corrections.test.ts`
- `docs/milestone-03/MIC-172-acceptance.md`
- `docs/milestone-03/MIC-172-report.md`

You may **append** correction columns/original JSON on `statement-repository.ts` after Wave 1 MIC-179 has landed. Keep original extraction immutable.

Changing one monthly revenue recalculates aggregate and sets `stale: true`. Concurrent analyze cannot silently overwrite a reviewed correction unless `replaceReviewed: true`.

No git. No subagents. TDD. Report short contract.

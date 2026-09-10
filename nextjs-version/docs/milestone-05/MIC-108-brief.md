# MIC-108 brief — Contract request, acceptance, repricing and signature tracking

Software is already implemented. Linear is In Progress for live submission-sender contract delivery/evidence.

**Exclusive:** `src/lib/mca/closing/contract-activation.ts` (only if a real remaining software gap), `tests/milestone05-mic-108.test.ts` (optional), `docs/milestone-05/MIC-108-report.md`, `docs/milestone-05/MIC-108-acceptance.md`.

**Do not edit:** `closing/service.ts`, `closing-panel.tsx`, schema, drizzle, Linear.

Prove from existing tests/source: a request does not mark signed; missing DL/VC is a visible blocker or explicit exception; repricing requires a reason; external ID alone is not signature evidence.

If no gap: `REVIEW_PASS` with file:line. Remaining gate: verified submission sender + live contract delivery/evidence. **No live funder email.** Do not mark Linear Done.

# MIC-106 brief — Stipulation tasks and secure merchant upload requests

Software is already implemented (`closing/service.ts`, merchant-upload page, lane-c-acceptance). Linear is In Progress only for a live Postmark merchant send.

**Exclusive:** `src/lib/mca/closing/stipulation-activation.ts` (only if you find a real remaining software gap), `tests/milestone05-mic-106.test.ts` (optional), `docs/milestone-05/MIC-106-report.md`, `docs/milestone-05/MIC-106-acceptance.md`.

**Do not edit:** `closing/service.ts`, `closing-panel.tsx`, `merchant-upload-panel.tsx`, schema, drizzle, Linear.

1. Re-read Linear MIC-106 AC and `docs/milestone-05/lane-c-acceptance.md`.
2. Independently verify token isolation, Request Info preview identity, and upload-resolves-correct-task in `tests/milestone05-closing.test.ts` and source. Cite file:line.
3. If a real gap exists, fix it only in `stipulation-activation.ts` and add a focused test. If none, leave that module as a documented no-op export and write `REVIEW_PASS`.
4. Activation checklist: pending Postmark merchant sender, authorized recipient, Test sender, one Request Info send. **Do not send live email.**
5. Remaining gate to document: authorized merchant recipient + real Postmark Request Info delivery.

Do not mark Linear Done.

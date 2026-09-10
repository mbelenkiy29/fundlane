# MIC-194 brief — AI scan funder criteria

Ticket: https://linear.app/michael-belenkiy/issue/MIC-194/ai-scan-funder-criteria-pdfs-and-images

Depends on MIC-170 + MIC-169. Exclusive: `src/lib/mca/funders/criteria-scan.ts`, `scan-repository.ts`, `src/app/api/mca/funders/scan/**`, `src/components/mca/funders/criteria-scan-panel.tsx`, `tests/funders-scan.test.ts`, acceptance+report.

Clean vault PDFs/PNG/JPEG only. Proposed changeset; preserve contacts; do not silently broaden rules; unspecified stays unspecified; ambiguous ranges flagged. Accept/reject with history/rollback.

No git. No subagents. TDD.

# MIC-180 brief — Data Merch

Ticket: https://linear.app/michael-belenkiy/issue/MIC-180/data-merch-account-configuration-checks-and-result-viewer

Exclusive: `src/lib/mca/datamerch/**` except `contracts.ts` (already frozen), `src/app/api/mca/datamerch/**`, `src/components/mca/datamerch/data-merch-panel.tsx`, `tests/datamerch.test.ts`, `docs/milestone-03/MIC-180-acceptance.md`, `docs/milestone-03/MIC-180-report.md`.

Selected contract: GET https://api.datamerch.com/v2/merchants Authorization Bearer, query `q` = EIN else legal name. Encrypt credential with workspace-bound crypto. Disabled → hide UI and API 409 `datamerch_disabled`. Expired credential recoverable, no secret leak. Fixture HTTP in tests. Live key is an external gate.

No git. No subagents. TDD. Report short contract.

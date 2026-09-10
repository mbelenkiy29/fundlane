# MIC-174 brief — Duplicate submission blocking

**Linear:** https://linear.app/michael-belenkiy/issue/MIC-174
**Depends on:** MIC-166

## Exclusive files

- `src/lib/mca/submissions/duplicate-policy.ts` (replace Wave 0 allow-all stub)
- `tests/submissions-duplicates.test.ts`
- `docs/milestone-04/MIC-174-report.md`
- `docs/milestone-04/MIC-174-acceptance.md`

No git, no subagents, no Linear Done, no schema edits.

## Rules (verbatim)

- Same workspace/deal/funder cooldown is atomic across UI, API, and background senders.
- Error retries blocked within **2 minutes**.
- Non-errored active duplicates blocked inside **24 hours**.
- Show eligibility time (`eligibleAt` ISO).
- Privileged reasoned retry (`privilegedRetry` + `privilegedReason` required) retains history; do not delete prior jobs.
- Other destinations remain independent.
- Clock via `src/lib/mca/submissions/clock.ts` (`nowIso`, `setClock`) so tests can pin time.
- Concurrent submit requests produce **one** accepted attempt (unique/lock on job or outbox).

## Tests

Boundary at 2 minutes and 24 hours with `setClock`. Concurrent queueSubmissions. Privileged retry. Cross-funder allowed.

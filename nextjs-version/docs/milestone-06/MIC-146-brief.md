# MIC-146 brief — Opt-in daily deal activity email digest

**Linear:** https://linear.app/michael-belenkiy/issue/MIC-146
**Depends on:** MIC-121, MIC-118, MIC-93 (done)

Exclusive: `src/lib/mca/comms/digest.ts`, `src/app/api/mca/comms/digest/**`, `src/components/mca/comms/digest-settings.tsx`, `tests/milestone06-digest.test.ts`, docs.

Frozen: profile opt-in; workspace-local 6 AM default; trailing 24h **event** timestamps (edit today of a 3-day-old funding does not include it); visibility-scoped; unique `(workspace, membership, window_start)` on `mca_digest_deliveries`. Register handler via `registerCommsJob("digest", ...)` from conductor-owned `comms/jobs.ts`. No live email.

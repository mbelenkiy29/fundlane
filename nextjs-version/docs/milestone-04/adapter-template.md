# Funder adapter ticket template (MIC-123 … MIC-145)

Each adapter ticket is the same shape. Implement only `src/lib/mca/submissions/adapters/<slug>/**` and `tests/adapters/<slug>.test.ts` plus your report/acceptance docs.

## Locked rules

- Implement `FunderAdapter` from `src/lib/mca/submissions/contracts.ts`.
- Do not edit `registry.ts`. Conductor registers the slug after review.
- Do not call live funder APIs. Use synthetic fixtures in `fixtures.ts`.
- Do not copy MCA Pilot endpoints, IPs, or sample credentials.
- Capability flags must be honest. Submit-only adapters must not advertise `statusPoll` or `offers`.
- `validate` returns field errors for missing required application fields.
- `submit` is idempotent on `job.attemptKey`. Timeouts and repeated fixtures must not create duplicate external refs.
- Production vs development credentials are MIC-124's problem; your adapter reads whatever `submitViaAdapter` passes later. For this ticket, `submit(job)` uses fixtures keyed by `job.route.destination` or a test override.

## Files

```
src/lib/mca/submissions/adapters/<slug>/index.ts
src/lib/mca/submissions/adapters/<slug>/mapping.ts
src/lib/mca/submissions/adapters/<slug>/fixtures.ts
tests/adapters/<slug>.test.ts
docs/milestone-04/<MIC>-report.md
docs/milestone-04/<MIC>-acceptance.md
```

## Tests

- required-field rejection
- accepted submission
- document receipt (if the public guide documents it)
- timeout / expired credential / replay of the same attemptKey
- capability flags match what you implemented

Gate remaining: commercial provider sandbox access. State that in the report. Mock success is not production verified.

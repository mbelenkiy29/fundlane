# MIC-124 brief — Adapter framework and credential environments

**Linear:** https://linear.app/michael-belenkiy/issue/MIC-124
**Depends on:** MIC-166, MIC-174

## Exclusive files

- `src/lib/mca/submissions/adapters/framework.ts`
- `src/lib/mca/submissions/adapters/credentials.ts`
- `src/lib/mca/submissions/adapters/contracts.ts` (may extend, do not break exported `FunderAdapter`)
- `src/app/api/mca/adapters/**`
- `src/components/mca/submissions/adapter-credentials-panel.tsx`
- `tests/adapters-framework.test.ts`
- `docs/milestone-04/MIC-124-report.md`
- `docs/milestone-04/MIC-124-acceptance.md`

Do **not** edit `registry.ts` except if you must — prefer conductor. Table `mca_adapter_credentials` exists.

## Rules

- Adapter contract: validate, submit, optional getStatus, optional parseWebhook, capability flags.
- Isolated development/production secrets. Production cannot fall back to test endpoints or another tenant's credential.
- Submit-only adapter cannot advertise a working status-check action (`capabilities.statusPoll === false` hides the UI action and 409s the API).
- Rate-limit handling + correction/retry UI with external references.
- Logs redacted.

## Tests

Submit-only cannot status-check. Production env does not read development cipher. Missing credential → `provider_unavailable`. Admin-only writes.

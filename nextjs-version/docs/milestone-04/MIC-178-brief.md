# MIC-178 brief — Manual portal tasks and custom webhook

**Linear:** https://linear.app/michael-belenkiy/issue/MIC-178
**Depends on:** MIC-166

## Exclusive files

- `src/lib/mca/submissions/portal.ts`
- `src/lib/mca/submissions/webhook.ts`
- `src/app/api/mca/submissions/portal/**`
- `src/components/mca/submissions/portal-panel.tsx`
- `tests/submissions-portal.test.ts`
- `docs/milestone-04/MIC-178-report.md`
- `docs/milestone-04/MIC-178-acceptance.md`

## Rules

- Opening a portal URL does **not** mark submitted. State stays `pending_portal` until a `deals:write` actor confirms completion with an optional external reference.
- Custom webhook: schema preview, authentication header from funder route destination, delivery log on attempts. Failures stay `failed`, distinct from portal complete.
- Use shared job ledger. Do not claim response-sync for webhooks.

## Tests

Portal open ≠ sent. Confirm completion. Webhook 500 stays failed. Intake key 403.

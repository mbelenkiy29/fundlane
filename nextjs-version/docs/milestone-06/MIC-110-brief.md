# MIC-110 brief — Lead providers, purchase batches and cost attribution

**Linear:** https://linear.app/michael-belenkiy/issue/MIC-110
**UUID:** `7f184bad-4d79-44fd-8484-f7deb96e7533`
**Depends on:** MIC-91, MIC-155 (done)

## Exclusive files

- `src/lib/mca/leads/**`
- `src/app/api/mca/leads/**`
- `src/components/mca/leads/providers-panel.tsx`
- `tests/milestone06-leads.test.ts`
- `docs/milestone-06/MIC-110-report.md`
- `docs/milestone-06/MIC-110-acceptance.md`

Do not edit `schema.ts`, `imports/**`, `deals-workspace.tsx`. Conductor already added `lead_batches.purchased_on`, `cost_cents`, `inactive` and `mca_deal_acquisition_events`. No git. No subagents. Do not mark Linear Done.

## Frozen behavior

- Extend existing `import_sources` / `lead_batches`. Do not invent a second batch identity.
- Purchase cost is integer cents. Zero is allowed; missing cost is null, not zero.
- Importing a purchased package attaches every created deal to the chosen batch and writes an append-only acquisition event.
- Inactive sources cannot be selected for new deals; historical rows remain.
- A source in another workspace cannot be selected.
- Cost editing is admin/super_admin. Expose unassigned-deal reconciliation.

## Acceptance

- Purchased-package import attaches every created deal to the chosen batch.
- Cross-workspace source IDs are rejected.
- Synthetic scenario, UI states, API permissions, no secrets in logs.

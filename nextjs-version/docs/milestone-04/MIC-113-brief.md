# MIC-113 brief — Status polling, webhooks, offer reconciliation

**Linear:** https://linear.app/michael-belenkiy/issue/MIC-113
**Depends on:** MIC-124

## Exclusive files

- `src/lib/mca/submissions/poll.ts`
- `src/lib/mca/submissions/webhooks.ts`
- `src/lib/mca/submissions/reconciliation.ts`
- `src/app/api/mca/submissions/webhooks/**`
- `tests/submissions-status.test.ts`
- `docs/milestone-04/MIC-113-report.md`
- `docs/milestone-04/MIC-113-acceptance.md`

## Rules

- Poll only adapters with `capabilities.statusPoll`. Manual refresh same gate.
- Webhooks: verify authenticity (shared secret header), dedupe by provider event/reference.
- Retain raw provider status. Map through a versioned table. Create/update `deal_offers` **only** when financial terms are present. Unknown statuses stay visible (`unknown: true`).
- Out-of-order / replayed events must not duplicate offers or regress `funded`.
- Offers comparison UI is M5 — persist rows only.

## Tests

Replay webhook. Out-of-order funded vs pending. Unknown status preserved. Submit-only adapter poll 409.

# MIC-102 report — Home Needs Action queue and in-place deal panel

**Linear:** https://linear.app/michael-belenkiy/issue/MIC-102  
**Status:** implemented locally (conductor mounts UI on `dashboard/page.tsx`; do not mark Linear Done from this agent)

## What shipped

A derived Home queue under `src/lib/mca/home`, `src/app/api/mca/home`, and `src/components/mca/home/needs-action.tsx`. Reasons are computed from deal, offer, pitch, submission, stipulation, contract, funding, and renewal rows. There is no parallel mutable task table.

| Reason | Own-action | Overdue-waiting | Clears when |
| --- | --- | --- | --- |
| `submit` | `ready_to_submit` / submission-ready application | — | Deal leaves that stage |
| `resubmit` | All returns declined/errored, or `resubmitting` | — | New send or close-out |
| `pitch` | Active offers with no pitch event | — | `recordPhonePitch` / successful offer send |
| `merchant_follow_up` | — | Pitched, merchant wait ≥ 48h | Accept / contract / fund |
| `funder_follow_up` | — | Sent submission unanswered ≥ 72h | Funder reply, offer, or decline |
| `contract` | Offer accepted | Requested, funder wait ≥ 48h | Contract sent / signed |
| `missing_doc` | Open stip or `missing_documents` | Open stip past due / 48h | Verified or waived |
| `signature` | — | `contract_sent` ≥ 48h | Signature recorded |
| `repricing` | Status `repricing` without request | Repricing requested ≥ 48h | Offer returns / request leaves |
| `funding` | Signed / final review, no committed funding | — | `confirmOfferFunding` |
| `renewal` | — | — (category `renewal`) | Converted or dismissed |

Queue membership uses `list`-equivalent workspace load plus `canActorAccessDeal` (same visibility as Deals). Completing one reason leaves any others. GET is live (no stored hourly snapshot); `?now=` is a UTC clock for tests.

## API

- `GET /api/mca/home/needs-action` — queue (`?now=`, optional `?category=own_action|overdue_waiting|renewal`)
- `GET /api/mca/home/needs-action/:dealId` — in-place panel: contacts, offers, submissions/responses, notes, stipulations, contracts, advances, workflow actions

Session: `deals:read`. Dashboard **or** deals page must be visible. API keys need `deals:read`. Hidden deals 404. `cache-control: no-store`. Mutations stay on existing deal/closing/offer routes; Home does not invent a done flag.

## Tests

```bash
cd nextjs-version && node --conditions=react-server --import tsx --test --test-concurrency=1 tests/milestone06-home.test.ts
```

5 passed (synthetic Postgres). Remaining gate: none (no live provider).

## Handoff

Replace the dashboard placeholder with `<NeedsAction />` from `src/components/mca/home/needs-action.tsx`. Do not edit a second task store. Conductor owns `src/app/(dashboard)/dashboard/page.tsx`.

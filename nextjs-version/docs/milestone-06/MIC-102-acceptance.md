# MIC-102 acceptance — Home Needs Action queue and in-place deal panel

**Linear:** https://linear.app/michael-belenkiy/issue/MIC-102  
**Synthetic clock:** `2026-01-15T12:00:00.000Z`

## Completing one reason leaves the others

Pitch Combo LLC is on Home for **Pitch offer** and **Collect missing docs** (open DL stipulation). Logging a phone pitch (`recordPhonePitch`, replay-safe idempotency key) removes only `pitch`. Waiving the stipulation then removes `missing_doc` and the deal leaves the queue. Funding Final LLC leaves after `confirmOfferFunding`. No Home-owned task row is written.

## Queue and panel obey deal visibility

| Actor | Sees |
| --- | --- |
| Admin | All workspace actionable deals, including Hidden Admin LLC |
| Manager of the rep | Rep-originated deals; not Hidden Admin LLC |
| Assigned rep | Submit Ready / Pitch Combo / merchant & funder waits; not Hidden Admin or admin-only contract deals |
| Unassigned rep | 404 on combo panel; combo absent from queue |
| Other workspace | Only Other Workspace LLC |

Unauthenticated GET is `401`. `intake:write` API key is `403`. `deals:read` key matches the admin session queue. Invalid `now` is `422` with a field error. Retry of the same GET returns the same deal ids.

## Synthetic reasons (expected output at the frozen clock)

| Deal | Primary reason | Category |
| --- | --- | --- |
| Submit Ready LLC | submit | own_action |
| Resubmit Shop LLC | resubmit | own_action |
| Pitch Combo LLC | pitch + missing_doc | own_action |
| Merchant Wait LLC | merchant_follow_up | overdue_waiting (pitched 72h) |
| Funder Wait LLC | funder_follow_up | overdue_waiting (sent 96h) |
| Contract Ask LLC | contract | own_action |
| Signature Chase LLC | signature | overdue_waiting |
| Reprice Follow LLC | repricing | overdue_waiting |
| Funding Final LLC | funding | own_action |
| Missing Docs LLC | missing_doc | own_action |
| Renewal Bakery LLC | renewal | renewal |
| Fresh Send LLC | — (6h wait, under 72h SLA) | not on Home |
| Closed LLC | — | not on Home |

SLA: merchant/docs/contract/signature/repricing **48h**; unanswered funder **72h**. Action-since is the underlying event timestamp.

## UI states

`homeQueueView` / `<NeedsAction />`: loading, empty (“You are all caught up”), validation, success, failure with Retry. Panel keeps the selected deal id across retries. Pitched retries reuse the same idempotency key. In-place panel shows contacts, offers, submissions/responses, notes, and workflow actions (Full Deal, Update Status, Submit, Pitched, Add note).

## Permissions and secrets

Direct API uses the same `deals:read` + `canActorAccessDeal` gate as the UI. Queue JSON omits EIN, commissions, and credentials. Panel contact email/phone are the deal’s authorized contacts, not identity documents.

## Checks

`cd nextjs-version && node --conditions=react-server --import tsx --test --test-concurrency=1 tests/milestone06-home.test.ts` — pass.

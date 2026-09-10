# Milestone 5 integration verification

Execution uses the three GPT-5.6 Sol/high lanes in `execution-plan.md`. The lane acceptance files contain ticket-level implementation and verification evidence.

## Database

- Registered the three milestone schema fragments in `drizzle.config.ts`.
- Generated `drizzle/0008_chief_squadron_sinister.sql`: 25 new tables and their indexes/constraints; no existing table drops or alterations.
- Applied all migrations to a disposable database on the protected Neon verification branch. Observed 95 public tables, then removed the disposable database.
- Added the new tables to the migration inventory so destination-empty guards and parity checks include them.
- The initial regression run exposed a stale test expectation of 56 mapped tables (the existing inventory already contained 69). Changed the assertion to use the maintained inventory size. The focused SQLite WAL preservation/import/replay/parity/refused-changed-snapshot test passed after this change (1/1).
- No production database migration has been run.
- Follow-up `0009_material_kid_colt.sql` pins closing attachment references and scopes historical external identities by import source. The source column is backfilled from its owning run before enforcing NOT NULL. Both fresh migration and a populated pre-0009 upgrade scenario passed; distinct sources can reuse an external ID while the same source cannot duplicate it.
- `0010_careless_aaron_stack.sql` adds separate expected fee dates to funding events and advances.

## Shared UI and authorization

- Offers, advances and renewals inherit configured Deals page visibility in both sidebar and dashboard route guard.
- Payment navigation and the route guard additionally require payment-table permission; session capabilities match that rule.
- Added a permission-filtered deal picker for the offer workspace, with loading, empty, unavailable-deal, search and retry states.
- Focused ESLint passed for the picker, sidebar, layout and Drizzle configuration.
- Explicit Offers, Advances, Payments and Renewals pages replace their placeholder routes. Offers and Closing tabs are also available in the existing deal dialog.
- Browser sandbox uses fresh synthetic administrator/representative accounts and two merchants. Verified offer creation ($40,000 at factor 1.25, $5,000 monthly payment, $3,200 commission), immutable revision history, explicit revision selection, and funding. Funding created a $50,000 payback advance, $3,800 expected commission/fees, and $1,920/$1,280 recipient distributions. The deal header refreshed to Funded.
- Browser verified that the representative has no Payments navigation and direct `/payments` access redirects to Forbidden. An independent synthetic representative HTTP request to `/api/mca/accounting/payments` returned 403.
- Browser verified closing acceptance bound to the selected revision, driver-license request creation, secure upload-link creation, and phone pitch recorded independently of delivery. No configured sender yields disabled outbound preview actions with a connection-settings link.
- Browser reconciled a $1,600 partial commission receipt: expected $3,800, collected $1,600, outstanding $2,200. Marking the representative's $1,920 distribution paid retained the same company totals and removed paid-row mutation controls. Native date controls were exercised through accessibility; the browser's Playwright `fill` did not dispatch a usable controlled-date change.
- Browser verified a second merchant funded on January 5, 2026: $10,000 principal, $12,000 payback, six monthly payments, and a correctly capped $12,000/100% scheduled paid-in estimate. The confirmation form initialized commission, fee and monthly frequency from that exact offer.
- Renewal policy creation and eligibility passed in the browser; rerunning created zero duplicates. Fresh statement and voided-check tasks appeared in closing. A synthetic PDF submitted through the public upload page moved only its driver-license task to Received; verification stayed blocked while the document was not clean.
- Browser rejected reversal of funding with collected receipts/paid distributions and retained its funded revision. Email/Text selection is explicit; unconfigured SMS stays disabled with connection guidance.
- The disposable browser database, document storage, temporary build directory and browser tabs were removed after verification. Screenshots remain in `screenshots/`.
- Deal hydration merges new versioned offers with legacy summaries by ID. Workflow callbacks refresh deal status and activity after mutations.
- Date-only rendering now preserves the business calendar day instead of shifting to the prior day in America/New_York. Payment rows and drilldown include merchant, funder, originator and expected/received dates.

## Focused calculation checks

The corrected calculation module passed direct assertions: 4,000,000 principal cents at factor 1.25 yields 5,000,000 payback cents; 800 basis points on principal yields 320,000 commission cents; omitted calendar/count yields `null` periodic estimate. A 10,001-cent base split 33.33/33.33/33.34 produced 3,333/3,333/3,335 cents under the documented largest-remainder policy, totaling exactly 10,001 cents.

## Final verification

Initial existing-suite run: 150 tests, 149 passed; the only failure was the stale migration inventory count described above. Its focused rerun passed after repair. This is baseline evidence, not verification of the new milestone services.

A later full-suite attempt encountered a temporary verification-endpoint DNS/network outage (`ENOTFOUND`/`EADDRNOTAVAIL`), resulting in setup failures and cleanup errors. Connectivity recovered. The full retry ran 205 checks: 203 passed and two existing MIC-174 retry fixtures failed because development email preview now returns success. The fixture now injects an explicit provider failure instead of relying on absent configuration; its targeted rerun is recorded below. These infrastructure failures are not counted as passing evidence.

- Final combined milestone suite: **26 passed, 0 failed** (accounting core/database, closing HTTP/services, offers/funding/history, populated migration upgrade).
- Corrected MIC-174 provider-failure fixture: **5 passed, 0 failed**. The complete 205-test suite was not rerun after this fixture-only repair; its earlier result remains 203 passed and two now-corrected fixture failures.
- `pnpm typecheck`, `pnpm build`, and `pnpm lint` exited 0. Lint reports six warnings outside this milestone and no errors.
- Drizzle schema generation reports no remaining schema changes.
- Graphify incremental update and final clustering refreshed `GRAPH_REPORT.md`, `graph.json`, and `graph.html`. Visualization limit raised to 6,000 for the 5,962-node graph.
- Final test/build/typecheck/lint logs are retained in `verification-logs/`.

## Ticket disposition after verification

| Tickets | Disposition | Remaining criteria |
| --- | --- | --- |
| MIC-109, MIC-161, MIC-118, MIC-107, MIC-112, MIC-103, MIC-105, MIC-125, MIC-120 | Done | Local implementation and acceptance verified; production migration/deployment not performed |
| MIC-106 | In Progress | Production upload/artifact secrets and origin; verified sender and real request delivery |
| MIC-108 | In Progress | Live contract/repricing delivery and external signing evidence |
| MIC-157 | In Progress | MIC-158 provider mapping, real request acknowledgment and authenticated signature callback |
| MIC-168 | In Progress | Real merchant email and MIC-156 SMS routing/delivery |
| MIC-111 | Backlog | User-validated recurring-distribution schedule example required before implementation |

MIC-111 remains pending the ticket's required validated schedule example. Provider-backed email/SMS/signature activation requires real configuration and evidence; simulated transport tests alone do not establish production readiness.

Linear updates were applied only after final verification. A fresh read confirmed all 14 ticket statuses match the table above; see `linear-final-statuses.json`. Every ticket received an evidence comment. The optional milestone-level summary comment was rejected by Linear because milestone description content was unavailable; ticket updates succeeded.

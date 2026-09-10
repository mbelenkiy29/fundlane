# Milestone 5 execution plan

Project: MCA. Milestone: **05 Offers funding and commissions**, ID `8f1c9349-feca-42c8-b2ac-28263430d190`. All 14 tickets were in Backlog when read from Linear on September 8, 2026. The exact requirements and native dependencies are captured in `linear-tickets.json`; live Linear remains authoritative.

## Team and ownership

Three execution subagents use **GPT-5.6 Sol, high reasoning**, as requested. The parent coordinates dependencies, integration, verification, and Linear updates. Agents share this workspace and must preserve existing work.

| Lane | Tickets | Owned implementation |
| --- | --- | --- |
| A: Offers and funding | MIC-109 offers/revisions/selection; MIC-118 atomic funding; MIC-125 manual submissions; MIC-120 historical funding import | `src/lib/mca/offers/`, `funding/`, `historical/`, matching API/component modules, offer tests, `db/milestone05-offers.ts` |
| B: Accounting and lifecycle | MIC-161 exact calculations; MIC-107 advances; MIC-112 commission/fee ledger; MIC-103 split rules; MIC-105 renewals; MIC-111 recurring distributions | `src/lib/mca/accounting/`, `advances/`, `renewals/`, matching API/component modules, accounting tests, `db/milestone05-accounting.ts` |
| C: Closing and merchant actions | MIC-106 stipulations/uploads; MIC-108 contracts/repricing/signatures; MIC-157 PSF; MIC-168 offer messages/pitch | `src/lib/mca/closing/`, matching APIs/components and merchant upload page, closing tests, `db/milestone05-closing.ts` |

The parent owns shared-page integration and migration generation. Agents publish schema and exported interfaces early and coordinate directly. Nobody independently edits shared `db/schema.ts`, generates competing migrations, or refreshes Graphify during concurrent work. New schema modules are registered together, then a single coordinated migration is generated.

## Execution sequence

1. **Contracts and foundations:** A defines versioned offers and selection/state interfaces; B defines exact-money calculations and the transactional accounting interface; C defines closing/request contracts against immutable offer revisions. Build schemas and tests in parallel, then generate the combined migration.
2. **Core workflow:** A implements MIC-109 and MIC-118 against B's MIC-161/MIC-112 interfaces. C implements MIC-106, then MIC-108. All paths reuse workspace authorization, deal visibility, immutable documents and existing sender capabilities.
3. **Dependent workflows:** A completes MIC-125 and MIC-120; B completes MIC-107, MIC-103 and MIC-105; C completes MIC-157 and MIC-168. MIC-111 proceeds only after its required validated example is available.
4. **Integration and review:** Wire the offers, advances, payments, renewals and closing UI; exercise a synthetic deal from offer through funding and reconciliation. Review each lane against every ticket requirement and repair omissions.
5. **Verification and ticket closure:** Run focused service/HTTP tests, TypeScript, relevant lint, build and browser verification. Check concurrency, retries, negative permissions, correction/reversal, historical dates, and failure states. Refresh Graphify after final code changes. Update each Linear ticket with evidence only after verification; leave unresolved criteria explicitly open.

## Required cross-lane contracts

- Offers expose permissioned current/revision reads, optimistic concurrency, immutable terms and active selections. Closing and funding always bind to a specific revision.
- Calculations use exact decimal or integer money, versioned rules, explicit commission base and payment calendar. Unknown payment count produces an unknown estimate.
- Funding creates the advance and expected accounting records in the same database transaction; ordinary deal status changes never create money records.
- Payment/distribution states distinguish expected, received and paid records. No automatic bank transfer is implemented or executed under these tickets.
- Historical import uses stable source identities and actual event dates. It does not send notifications or submit applications.
- Closing transports retain correlation/idempotency identities and fail clearly without provider setup. A request or successful transport is never signature evidence.

## Dependencies and decision gates

Already Done: MIC-91 deal model, MIC-94 permissions, MIC-119 spreadsheet import, MIC-121 sender connections, MIC-159 DocuSeal intake and MIC-169 document vault.

MIC-166 submission orchestration is In Progress outside this milestone. Use its existing contracts where valid and report any missing prerequisite; do not silently declare the dependency complete.

MIC-156 merchant texting and MIC-158 outbound workflow webhooks are in Milestone 6 Backlog. Build bounded configured integration ports where needed, with explicit unavailable states; do not fabricate provider readiness or mark unrelated tickets Done.

MIC-111 explicitly requires a validated example before implementation. Proposed example submitted to the user: four Monday installments of $1,000 starting 2026-10-05, split 60/40; amendments affect only unpaid future installments; records are expected distributions, not transfers. This decision is pending and does not block other tickets.

## Verification matrix

| Ticket | Decisive scenario |
| --- | --- |
| MIC-109 | Unselected revision leaves deal unchanged; prior revisions and selections survive |
| MIC-161 | $40,000 × 1.25 = $50,000; 8 points on principal = $3,200; missing count stays unknown |
| MIC-118 | Concurrent funding confirms yield one advance/accounting set; plain status change yields none |
| MIC-107 | Future funding has zero paid-in estimate; default records no fictional collections |
| MIC-112 | Auto-add replay creates no duplicate; company totals denied without payment permission |
| MIC-103 | 33.33/33.33/33.34 splits reconcile exactly; excessive allocation rejected |
| MIC-105 | Two advances retain separate eligibility; renewal preserves prior funding/commission lineage |
| MIC-111 | Scheduler retry creates each installment once; amendment preserves paid history |
| MIC-125 | Manual submission sends nothing; approval/funding preserve historical dates and identity |
| MIC-120 | Reimport does not double-count; reconciliation uses historical event dates |
| MIC-106 | Upload token cannot read documents or change deal; validated upload resolves correct request |
| MIC-108 | Contract request does not mark signed; missing DL/VC is visible or explicitly excepted |
| MIC-157 | Failed webhook remains failed; repeated confirmation uses one document-request identity |
| MIC-168 | Preview matches sent revision; failed send records no successful pitch |

Every ticket also needs loading/empty/validation/success/failure UI states, direct API authorization, retry identity and sensitive-data-safe logs.

Tests use disposable databases created by `tests/helpers/postgres-test-db.mjs` on the protected verification branch. Do not run test fixtures or migrations against the application's production connection. No deployment, live message, external signature request or financial transfer is authorized by this implementation plan. Provider-backed completion requires real evidence or an explicit remaining gate.

## Deliverables

- Working code, schema migration and usable UI for every unblocked requirement.
- Lane acceptance documents and combined acceptance report in this directory.
- Test results and browser evidence tied to ticket IDs.
- Linear ticket updates reflecting verified completion or precise remaining criteria.

Execution started with the three named Sol/high subagents after this inventory and ownership split.

## Execution outcome — September 8, 2026

All three requested GPT-5.6 Sol/high subagents completed their assigned unblocked implementation and review repairs. Combined verification passed 26 milestone tests plus build, TypeScript and lint (six unrelated warnings). Browser acceptance used disposable synthetic data, which was removed afterward. Nine tickets qualify as Done; four remain In Progress for real provider activation; MIC-111 remains Backlog pending the required validated example. See `integration-acceptance.md` and lane acceptance files for evidence and limits.

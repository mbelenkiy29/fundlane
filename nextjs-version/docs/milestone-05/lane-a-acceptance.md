# Milestone 05 lane A acceptance evidence

Verification uses synthetic records in a disposable database on the protected Neon verification branch created by `tests/helpers/postgres-test-db.mjs`. It does not migrate production, read production rows, send a submission, notify a merchant, or transfer money.

## MIC-109 — offer records, revisions, comparison, and selection

- `src/lib/mca/offers/` stores workspace-scoped offers and immutable numbered revisions with source, funder, product, integer cents, factor/buy rates, term, payment frequency, fees, commission, stipulations, incomplete-term indicators, and stable external identity.
- Active selection records allow more than one offer per deal. Selection changes serialize on the offer, same-selection retries are no-ops, and an old revision cannot deselect a newer active selection.
- Revising retains the prior snapshot and its selection history. Creating or revising an unselected offer leaves deal status unchanged; selecting moves an eligible deal through the deterministic offer transition.
- `OffersPanel({ dealId, onChanged? })` provides loading, empty, validation, failure, and success states; side-by-side terms; prior revisions and selection history; buy rate and stipulations; stable create identity; revise/select/deselect actions; and shared workspace refresh through `onChanged`.
- `getOfferRevisionForClosing` and `listOfferRevisionsForClosing` return immutable, workspace/deal-scoped snapshots. Exact selected superseded revisions remain eligible because selection pins that revision; withdrawn and funded revisions cannot start a fresh closing action.
- The shared deal hydration bridge preserves legacy `deal_offers`, exposes a selected MCA offer as `presented`, and exposes an offer with any funded revision as `accepted`.
- Evidence: the first two cases in `tests/milestone05-offers-funding.test.ts` prove unselected stability, immutable revisions, retained selection, closing resolution, concurrent selection replay, stale deselection safety, and legacy/new deal-summary hydration.

## MIC-118 — atomic funding and auditable correction

- `confirmOfferFunding` pins the exact offer revision and requires a stable funding key. It rechecks replay after acquiring the common offer lock, then creates the funding event, base advance, commission/fee payments, immutable split allocations, state transitions, linked submission cache, activity, and audit event in one transaction. The transport job and attempt evidence remain unchanged; the local submission becomes approved and its legacy offer cache becomes accepted.
- The funding form has independent state initialized every time from the selected revision. It captures actual funding date, commission, fee, distinct expected dates, explicit payment count/frequency/calendar, and named workspace-member split rows. Exact decimal parsing rejects more than two fractional digits.
- A missing factor leaves payback/calculation unknown. The service does not invent a factor or calendar. Accounting records are explicitly records only; no transfer code is called.
- Source is derived server-side from the linked manual/historical submission and historical offer source. An omitted client submission ID still links and funds the manual record; a mismatched client source is rejected.
- Reversal is administrator-session-only. It locks the event, parent advance, accounting payments, and distributions; refuses to erase collected payments or paid distributions; voids only outstanding expected rows; appends advance status, deal activity, and audit history; and resets the deal only when no other committed advance remains. A linked submission remains approved on reversal while its legacy offer cache returns to presented when no other committed funding remains for that submission. Transport job and attempt evidence stay unchanged. A later funding event can explicitly reference the reversed event as its correction and restore the accepted cache state.
- Evidence: the MIC-118 test double-confirms concurrently and observes one advance and one accounting set, proves a deal-only status update creates no payment, injects an accounting failure and observes a complete rollback, verifies separate fee/commission dates and schedules, preserves paid history on rejected reversal, keeps a two-advance deal funded, and records reversal/correction histories.

## MIC-125 — permissioned manual submission history

- `src/lib/mca/offers/manual-submissions.ts` exposes a fixed capability for administrator sessions. API keys and non-admin sessions cannot create mock financial history.
- Creation captures funder, historical date, reason, source, and a stable key; it creates no submission job or outbound provider request. Approval creates and selects normal immutable offer terms, and normal funding atomically links the manual submission even when the UI omits its ID.
- The panel labels local-only behavior and exposes manual creation/approval only after the server capability succeeds.
- Evidence: the MIC-125 test denies an API actor, proves create replay, asserts zero outbound jobs, approves terms, funds without caller-provided source/linkage, and verifies the event source, linked submission, state, and historical date.

## MIC-120 — historical import and opening accounting history

- `src/lib/mca/historical/` parses CSV/TSV/XLSX or typed rows and validates integer cents, dates, required schedule groups, expected/paid commission, and paid split history. The panel supplies a downloadable CSV example plus row-level preview errors, totals, duplicates, and reconciliation results.
- Preview identity is workspace + source + batch; concurrent/replayed previews resolve to the same run. Record identity is workspace + source + external ID. A stable SHA-256 identity of source and external ID scopes every downstream deal, manual submission, and funding key, so two systems may reuse an external ID without cross-replaying records.
- Commit serializes each run and uses a savepoint per row. One failed row cannot leave a partial deal/offer/advance, and retry includes previously created rows in reconciliation totals while safely retrying pending rows.
- Funding, expected payment, actual commission receipt, and paid distribution dates are preserved as supplied. Historical source tags flow through funding and accounting, and no outbound send or transfer is initiated.
- Evidence: the MIC-120 test replays a preview, injects a second-row accounting failure, observes the first row committed and the failed row fully rolled back, retries to a two-row/17,000,000-cent reconciliation, verifies the 2023 funding/receipt/paid-split dates, proves same-source reimport duplicates both records, and commits the same external ID from another source to distinct deal and advance IDs.

## HTTP and integration contracts

- Offer list/create: `GET|POST /api/mca/offers/[dealId]`
- Revision: `POST /api/mca/offers/[dealId]/[offerId]/revisions`
- Selection: `POST /api/mca/offers/[dealId]/[offerId]/selection`
- Funding list/confirm: `GET|POST /api/mca/offers/[dealId]/funding`
- Funding reversal: `POST /api/mca/offers/[dealId]/funding/[eventId]/reverse`
- Manual list/create/approve: `GET|POST /api/mca/offers/[dealId]/manual` and `POST .../manual/[submissionId]/approve`
- Historical preview/read/commit: `POST /api/mca/historical/preview`, `GET /api/mca/historical/[runId]`, and `POST .../[runId]/commit`
- Session endpoints enforce configured Deals page visibility and deal-level access. Financial-history creation additionally enforces the administrator-session capability. API parsing returns actionable validation errors rather than converting malformed nested terms into server errors.

## Verification result

- `node --conditions=react-server --import tsx --test --test-concurrency=1 tests/milestone05-offers-funding.test.ts`: 5 passed, 0 failed in 46.1 seconds.
- Scoped ESLint across lane A services, APIs, component, and tests: passed.
- `pnpm typecheck`: passed with zero TypeScript errors.
- Root browser verification confirmed revision `v1 → v2`, exact selection, funding with actual date and 60/40 named-recipient splits, and reopening another selected offer with its own monthly frequency, commission, and fee state.

## Known dependencies and limits

- Commission, fee, split, receipt, and renewal behavior uses lane B's accounting services and tables. Funding deliberately passes its existing transaction executor to `writeFundingAccounting`; the writer opens no transaction and performs no transfer.
- Merchant offer delivery, pitch logging, closing documents, and signing use the immutable revision interfaces above and belong to lane C.
- Historical spreadsheet import accepts the defined column contract. It does not attempt AI column inference; malformed rows remain visible in preview/reconciliation for correction.

# Billing recovery completion tasks

Status: tasks and design approved. Paths below are relative to `nextjs-version/`.

## Phase 1 — Complete debt controls

- [x] 1.1 Scope recoverable debt to verified Fundlane subscriptions
  - Classify original debt, missed-period drafts and unrelated invoices using verified customer/subscription ownership and original invoice periods.
  - Include canceled historical Fundlane subscriptions with outstanding debt.
  - Test: unrelated invoices are never mutated; partial settlement and canceled-subscription debt remain correctly classified.
  - _Requirements: R1.1, R4.1, R4.2_
  - _Files: src/lib/mca/billing-reconciliation.ts, src/lib/mca/billing.ts, tests/billing.test.ts_
  - Verified: 38 billing/HTTP/company-pause tests passed; typecheck and touched-file lint passed. Graph refreshed. Changes are local and not deployed.
  - Handoff: eligible paused-period drafts now block recovery but are not finalized yet (task 1.3). Existing-open-invoice retry controls remain task 1.2; stricter processing coverage remains task 2.1. All invoices remain in accounting projections, but only verified Fundlane subscription invoices affect company recovery/seat decisions.

- [x] 1.2 Stop automatic retries at the collection cutoff
  - Disable automatic advancement on applicable open invoices and pause future subscription collection.
  - Repeat invariant checks after partial provider success or local rollback, using stable operation keys.
  - Test: existing open invoices stop retrying; debt is retained; duplicate events and retries cannot reset grace.
  - _Requirements: R2.1, R2.2, R4.1_
  - _Files: src/lib/mca/billing-reconciliation.ts, src/lib/mca/billing.ts, tests/billing.test.ts, tests/helpers/stripe-http.mjs_
  - Verified: 44 billing/HTTP/company-pause tests passed against disposable PostgreSQL (`MCA_TEST_DATABASE_ADMIN_URL=postgresql://mbele@127.0.0.1:55439/postgres`); `pnpm typecheck` and touched-file ESLint passed. Tests were added first and reproduced missing invoice retry controls and provider/local pause mismatch before implementation.
  - Implementation: relevant open invoices receive `auto_advance:false`; future collection uses indefinite `keep_as_draft`. Independent controls are attempted despite individual provider failures. Fresh reconciliation checks provider state even when the local pause flag is set; audit-backed operation generations retain rollback retry keys while allowing later provider drift repairs. Recovery handles provider pauses left by local rollback without changing debt or the original grace deadline.
  - Handoff: no deployment or commit. Task 1.3 draft finalization and task 2.1 processing eligibility remain pending; already-dispatched processing payments cannot be recalled. Graph update and no-label clustering completed; HTML generation skipped at the 5,000-node limit (13,168 nodes).

- [x] 1.3 Require missed-month settlement before recovery
  - Finalize only eligible paused-period renewal drafts with automatic advancement disabled, preserving Stripe amounts and payment links.
  - Re-read provider debt before clearing delinquency; failures and unresolved drafts prevent recovery.
  - Test: paying the original debt leaves access paused while another missed month remains unpaid; full settlement restores eligible access without reviving canceled subscriptions or overriding manual suspension.
  - _Requirements: R1.1, R4.1, R4.2_
  - _Files: src/lib/mca/billing-reconciliation.ts, src/lib/mca/billing.ts, tests/billing.test.ts, tests/helpers/stripe-http.mjs_

  - Verified: 52 billing/HTTP/company-pause tests passed against disposable PostgreSQL (`MCA_TEST_DATABASE_ADMIN_URL=postgresql://mbele@127.0.0.1:55439/postgres`); `pnpm typecheck` passed; `pnpm lint` passed with 17 warnings outside the touched files. Tests were added first and reproduced missing finalization and fresh-read recovery checks.
  - Implementation: eligible original renewal drafts finalize with only `auto_advance:false` and stable invoice-specific keys. Complete fresh invoice reads follow finalization attempts, including partial failures, and precede recovery. Unresolved/ambiguous drafts, partial balances and uncollectible debt block recovery. Cutoff audit generations remain intact; canceled subscriptions and manual suspensions retain their access rules.
  - Provider clarification: current Stripe [invoice object](https://docs.stripe.com/api/invoices/object) docs define invoice-level periods as invoice-item association bounds, while [line-item periods](https://docs.stripe.com/api/invoice-line-item/object) identify subscription service periods. Eligibility now uses complete, matching non-proration subscription line periods, recorded pause evidence, draft creation time and effective cancellation; it does not use invoice `period_start` or the subscription's current period. This corrects the existing classifier without changing the approved design. The [finalize API](https://docs.stripe.com/api/invoices/finalize) documents `auto_advance:false` as disabling automatic collection.
  - Handoff: real-provider acceptance remains task 4.2; processing-coverage changes remain task 2.1. No commit or deployment. Parent session performs the final Graphify refresh.

## Phase 2 — Bounded processing exception

- [x] 2.1 Enforce one fully covered processing extension
  - Add a new migration and matching schema field for the durable extension-granted marker; preserve migration 0047.
  - Validate per-invoice payment allocations, identities, currencies and current processing status; unknown coverage cannot grant an extension.
  - Grant only before cutoff, cap at grace end plus 48 hours, revoke when coverage fails, and clear the marker only after the episode resolves.
  - Test: insufficient/duplicated coverage, late processing, failed processing followed by retry, migration backfill and exact deadline boundaries.
  - _Requirements: R2.1, R2.2, R3.1, R3.2, R4.1_
  - _Files: drizzle/0048_billing_recovery.sql, drizzle/meta/_journal.json, src/lib/mca/db/schema.ts, src/lib/mca/billing-reconciliation.ts, tests/billing.test.ts_
  - Verified: 84 billing/HTTP/company-pause tests passed against disposable PostgreSQL (`MCA_TEST_DATABASE_ADMIN_URL=postgresql://mbele@127.0.0.1:55439/postgres`); `pnpm typecheck` and touched-file ESLint passed. Full `pnpm lint` passed with 17 warnings outside the touched files. Tests were added first and reproduced the late-grant behavior and missing durable marker.
  - Implementation: additive migration 0048 backfills existing active/expired extension markers from `updated_at`; deployed 0047 is unchanged. Current intents are retrieved once even when expanded. Per-invoice `amount_requested` allocations are verified against complete paginated per-intent allocation reads, deduplicated, and bounded by the intent amount across all attached invoices. Unknown/unsupported coverage, identity/currency/mode mismatches, insufficient allocations and failed/action-required payments cannot grant or retain eligibility. Grants require pre-cutoff observation and no episode pause, expire at original grace plus 48 hours, and cannot recur after revocation until verified episode recovery.
  - Tests cover allocation/intent mismatches, shared-intent budgets, repeated pagination records, partial balances, uncovered debt, current expanded intent reads, failed/unavailable verification and retries, exact deadline boundaries, pause non-reopening, subsequent episodes and SQL migration backfill. The existing outbox test now deterministically selects its own notification, avoiding dependence on the enlarged fixture backlog.
  - Handoff: no deployment or commit. Parent session performs the Graphify refresh. Real-provider validation remains task 4.2; complete per-intent InvoicePayment listing adds provider reads and requires the restricted key to support that documented list filter. Broader reconciliation transaction failures retain previously committed cached state only until its fixed deadline, as described in the approved design.

## Phase 3 — Customer recovery experience

- [x] 3.1 Expose the verified recovery balance
  - Add the approved server-derived recovery projection to existing company billing data.
  - Preserve company authorization, billing access during suspension and verification-pending status after payment.
  - Test: cross-company isolation, incomplete verification and multiple unpaid invoice projections.
  - _Requirements: R4.1, R4.2, R5.1_
  - _Files: src/lib/mca/billing.ts, src/lib/mca/billing-display.ts, src/app/api/billing/route.ts, tests/billing-display.test.ts, tests/billing-http.test.mjs_
  - Implementation ready: reconciliation returns the approved recovery projection from its verified Fundlane invoice set (including historical canceled-subscription debt). Existing audit storage retains customer/mode-scoped snapshots and failed-verification markers; local billing GETs use those snapshots without provider calls. Unrelated accounting invoices cannot enter the projection. Missing scope, failed verification, unresolved drafts, processing payments, unsupported currencies and unavailable payment links signal verification pending. Identical successful snapshots are deduplicated. Existing authorized billing GET/sync responses expose `recovery` through their shared presentation function.
  - Verification: tests added first reproduced the missing projection; all 87 billing/display/HTTP/company-pause tests now pass against disposable PostgreSQL at `127.0.0.1:55439` (user `mbele`). Touched-file ESLint passes; full `pnpm lint` passes with 17 unrelated warnings. `pnpm typecheck` remains blocked by concurrent changes in `src/components/mca/assistant/chat-messages.tsx` (line 182 nullable draft assignment and lines 248/257 undefined `receivedDraft`). Checkbox intentionally remains open until full typecheck passes. No policy/design divergence; the reconciliation file is additionally touched to reuse verified scope instead of querying the generic accounting projection. Parent session owns the final Graphify refresh.
  - Subsequent verification: tasks 3.2 and 4.1 both passed full typecheck after the concurrent errors were resolved. The combined relevant suite now passes 94 tests; task 3.1 is complete locally.

- [x] 3.2 Show outstanding invoices and continuing-fee notices
  - Use existing billing components to display each payable invoice and its hosted payment link.
  - Explain continued monthly fees, cancellation and full-payment recovery in billing and suspension notices.
  - Test: paused administrators can reach payment/cancellation; paid redirects cannot grant access; unavailable links have a verification-pending state.
  - _Requirements: R1.1, R4.1, R5.1_
  - _Files: src/components/mca/billing-panel.tsx, src/components/mca/company-paused.tsx, src/lib/mca/billing-operations.ts, tests/billing-display.test.ts, tests/billing-http.test.mjs_
  - Implementation: existing billing cards now show the server-derived USD outstanding balance, every projected invoice's identifier, period, status, exact remaining cents and individual hosted payment link. Missing links and incomplete verification show status messages; payment returns do not imply recovery. Billing and paused-company notices explain continuing monthly fees through effective cancellation, missed-month debt and verified full-payment recovery, preserving manual suspensions and canceled-subscription boundaries. Existing payment/cancellation controls remain reachable while paused.
  - Email location: notice text is rendered in `src/lib/mca/email.ts`; renewal-failure, pause and recovery copy is updated there. `billing-operations.ts` now freezes rendered content for both supported transports, preserving existing frozen retry payloads. The existing UseSend/outbox regression in `tests/billing.test.ts` verifies updated copy and frozen retries.
  - Verified: all 91 billing/display/HTTP/company-pause tests passed against disposable PostgreSQL (`MCA_TEST_DATABASE_ADMIN_URL=postgresql://mbele@127.0.0.1:55439/postgres`). Rendered-component checks cover multi-invoice amounts/links, missing-link and pending states, and administrator/member suspension notices; HTTP checks cover paused billing-page/portal access and non-authoritative paid redirects. `pnpm typecheck` now passes (the prior concurrent assistant errors are no longer present); full `pnpm lint` passed with 17 unrelated warnings and touched-file ESLint is clean. Graphify update and no-label clustering completed; HTML skipped at its 5,000-node limit (13,208 nodes). No commit or deployment.

## Phase 4 — Stripe acceptance and release

- [x] 4.1 Make new Checkout billing configuration explicit
  - Select flexible billing for new subscriptions and add the documented stable integration identifier.
  - Retain existing subscription modes; verify catalog and restricted Portal configuration.
  - Test: Checkout request contract, paid increases and renewal reductions; validate provider compatibility in task 4.2.
  - _Requirements: R6.1_
  - _Files: src/lib/mca/billing.ts, scripts/stripe/setup-catalog.ts, tests/billing.test.ts, tests/helpers/stripe-http.mjs_
  - Implementation: new Checkout requests explicitly select `subscription_data.billing_mode.type=flexible` and use `fundlane_company_subscription_ndmotxpw`, a stable company-subscription flow identifier with an eight-letter suffix randomly generated once. Existing subscription modes and reused sessions are preserved. Catalog/setup and restricted Portal validators were reviewed; no catalog mutation or setup-script change was needed. Configuration rationale and documentation references are in `docs/supabase-billing.md`.
  - Verified: tests were added first and reproduced the missing Checkout mode. All 94 billing/display/HTTP/company-pause tests pass against disposable PostgreSQL (`MCA_TEST_DATABASE_ADMIN_URL=postgresql://mbele@127.0.0.1:55439/postgres`); `pnpm typecheck` passes; full `pnpm lint` passes with 17 unrelated warnings. SDK HTTP contracts check API `2026-08-26.dahlia`, Checkout serialization/stable identifier, payment-gated increases, and no-proration renewal schedule payloads for both classic and flexible subscriptions. Stripe 22.6.0 installed types and current docs were reviewed with CLI 1.51.1.
  - Handoff: task 4.2 remains open and R6.1 real-provider acceptance is not complete. Stripe documents that scheduled subscription updates can prevent Portal cancellation; the R5.1 application fallback below resolves the local access gap, with real-provider verification still required alongside configured payment-method/pending-update compatibility. No provider mutation, deployment or commit.
  - R5.1 cancellation completion: added strict session-only owner/admin `POST /api/billing/cancel`, exact paused recovery allowlisting, and a direct Plans & Billing control. Ordinary subscriptions use period-end cancellation; scheduled reductions become a single final current phase ending at current period end with `end_behavior:cancel`, preserving current quantities/settings and no proration. No release-then-update renewal gap exists. Fresh provider verification precedes pending-reduction cleanup and actor audit; lost responses/local rollback retry from live state. Invoice debt, collection pause, manual suspension and trial boundaries are retained. Seat changes reject schedule-managed `cancel_at` as well as `cancel_at_period_end`.
  - R5.1 verification: tests-first missing-service failures reproduced. All 104 billing/display/HTTP/company-pause tests pass on disposable PostgreSQL 55439; `pnpm typecheck` passes. Full lint passes with 18 warnings outside this change. SDK contracts cover classic/flexible schedules, retained phase settings, safe retries and failure/no-op behavior; HTTP covers paused owner/admin, trusted origin, session-only authorization and company isolation. Documentation compares schedule cancellation with release `preserve_cancel_date`. Real-provider cancellation/date/renewal evidence remains task 4.2; no acceptance-runner or acceptance-report edits were made by this change.

- [ ] 4.2 Exercise isolated real-provider recovery
  - Use the authorized FundLane sandbox with synthetic customers, test clocks and a disposable application database.
  - Exercise cutoff, missed months, partial/full payment, SCA, processing eligibility, cancellation, webhook replay and seat transitions.
  - Test: record provider evidence proving finalized recovery invoices do not auto-charge and access only returns after all required invoices settle.
  - Dependencies: sandbox application credentials, webhook signing secret and an isolated reachable test runtime; MCP OAuth is not an application API key.
  - _Requirements: R1.1, R2.1, R2.2, R3.1, R3.2, R4.1, R4.2, R5.1, R6.1_
  - _Files: scripts/stripe/acceptance-recovery.ts, docs/acceptance/stripe-billing-recovery.md, docs/supabase-billing.md_
  - Real-provider verification: supplied restricted sandbox key verified `acct_1UIDeIBP3qJwlwms`. Core run 9 passed 21 checks, including cutoff, missed-month finalization without automatic charge, partial/full settlement, classic/flexible seat changes, both cancellation paths, manual suspension and durable outbound reapproval. Processing runs 7–8 passed genuine zero-attempt SCA/ACH renewals, fixed extension, revocation and multi-invoice coverage shortfall. Webhook run 2 passed genuine signed HTTP, duplicate/tampered-body handling and out-of-order cancellation-before-active-event delivery. All resources from these latest runs were cleaned. Reports are in `docs/acceptance/`.
  - Provider constraint: Stripe rejects partial-amount attachment to automatic subscription invoices; real multi-invoice partial settlement and uncovered-total-debt cases passed instead. The first synthetic sandbox Portal configuration from historical run 5 remains the undeactivatable default and is documented for owner review.
  - Hosted acceptance blocker: desktop browser disconnected; standalone Chrome reached application-generated two-seat Checkout and the genuine 3DS challenge, but completion stalled. Interrupted resources were explicitly cleaned. Hosted Portal cancellation and authenticated staging return-route acceptance remain unverified. See `docs/acceptance/stripe-hosted-browser.md`; task 4.2 remains open. Live Stripe, tax and external auth/email activation are separate dependencies.

- [x] 4.3 Verify and release the completed recovery changes
  - Run full regression suite, typecheck, lint and production build; refresh Graphify after code changes.
  - Apply the additive migration before compatible application deployment; record source revision, deployment and smoke-check evidence.
  - Track live Stripe, tax, Google OAuth and email configuration as distinct activation dependencies.
  - Test: production legacy companies retain access, protected billing endpoints enforce authorization, and authenticated scheduler execution succeeds.
  - _Requirements: R2.1, R4.1, R5.1, R6.1_
  - _Files: docs/auth-subscription-rollout.md, docs/supabase-billing.md, docs/acceptance/stripe-billing-recovery.md, ../graphify-out/graph.json, ../graphify-out/GRAPH_REPORT.md_
  - Local release verification: full regression confirmation completed with 968 tests, 967 passed, one skipped, zero failed; production builds passed in the working tree and isolated committed-source snapshot. Implementation `8202a1e` and acceptance `e0e10af` are pushed. Typecheck and relevant lint passed; supplemental script-inclusive checking also found and fixed a test-helper query overload annotation and the catalog script's SDK account-retrieve argument.
  - Applied migration 0048 hash `d12ce4e1ec6c70ca501f78f025431e51b057d49fa9fe4d5dd0143d1ed4c122c0`, ledger timestamp `1790035200002`. Fresh production readback confirms the marker column and all three companies retain legacy exemptions. Compatible application deployment and smoke evidence follow in the rollout document.
  - Released application source `8202a1e` as Vercel `FeCKA2FnNUfi1SrRfUu2ZRF32yYX`, aliased to `fundlane.io`; production build passed. Public-page/auth-gate smoke passed, authenticated billing maintenance returned 200 with three scanned/no errors, and Supabase Vault/pg_net request 299 independently returned 200. All three companies retain legacy access. Live billing activation remains gated by task 4.2's hosted acceptance and the external credentials/configuration checklist; this checkbox records compatible code release, not activation.

# Fundlane Owner Portal Implementation Plan

> Historical planning snapshot. The subsequent direct execution authorization and current scope are recorded in [owner portal decisions](../../acceptance/owner-portal-decisions.md); unanswered policy gates remain binding.
> **For agentic workers:** REQUIRED SUB-SKILL at future execution: use Superpowers subagent-driven-development (recommended) or executing-plans task by task. This document is a review draft; it does not authorize execution. Resolve each task's decision gates first. Do not turn a proposed policy into a default because Mike has not answered it.

**Goal:** Extend Fundlane's existing platform console into an equal-access owner portal for Mike and Ben, with company oversight, monitoring, reviewed Twilio onboarding, multiple assigned local numbers, pooled prepaid SMS segments, and audited sensitive support access.

**Architecture:** Reuse `/platform`, platform grants/MFA/TOTP/audit, the existing operations dashboard, company billing, and checkpointed Twilio workflows. Deliver owner operations, SMS enablement, and prepaid SMS commerce as separate reviewable slices. Preserve explicit company scoping; provider effects run through durable operations, never through unrestricted owner impersonation.

**Tech Stack:** Existing Node.js 24.x, pnpm 11.1.2, Next.js 16, React 19, TypeScript, Zod, `pg`, Drizzle migrations, Supabase Auth/Postgres/private Storage, Stripe and Twilio. Vercel hosts the app. No new queue, ORM or observability vendor is planned.

**Spec:** [Owner portal design brief](../specs/2026-10-01-owner-portal-design.md). [Discovery/source evidence](../specs/2026-10-01-owner-portal-discovery.md). Read all three together.

## Global constraints

- Mike and Ben have equal platform-owner permissions. Customer company roles never grant platform access.
- V1 SMS serves the US only, for updates and conversations about an existing application.
- Paid companies can use CRM/application tools while SMS review is pending. SMS and number purchase remain locked.
- Internal approval and Submit to Twilio are separate actions. Show the registration charge before submission.
- Multiple local numbers, including employee assignments, are required in v1.
- Customers buy SMS segment packs. Show required credits before sending. One company balance serves all its employees and numbers.
- Operational details are visible to owners by default. Private deals, documents and message content require an explicit audited support-access action.
- No product execution, migration, deployment, provider action, credential creation/transmission, purchase or send is authorized by this planning turn.
- Future tests use disposable local PostgreSQL and synthetic data; hosted tests require an approved nonproduction target and explicit approval for their external effects.
- Do not edit historical migrations, seed grants, impersonate customers, expose secrets, replay unknown paid effects or bypass consent/seat/tenant gates.

## Review focus

These five failure classes must receive explicit tests in addition to happy paths:

1. A revoked owner session, legacy single-owner route or tenant role bypasses the new portal gate — covered by T1 and T8.
2. Two owners approve different submission versions or double-submit a paid registration — covered by T4.
3. Number reassignment or employee deactivation exposes another company's or inaccessible deal's conversations — covered by T5 and T8.
4. Duplicate/out-of-order payment, send or callback events grant/debit credits twice, or permit concurrent overspend — covered by T6/T7.
5. An interrupted provider mutation or monitoring outage is falsely shown as success/healthy — covered by T3/T4/T7/T10.

## Execution gates and current baseline

**STOP before T0 implementation:** Mike must approve the plan and explicitly instruct Codex to start. The request to write it is not that instruction. D1–D9 are listed in the design brief with recommendations and impact. An approved early slice may proceed without unrelated later decisions, but a gated task cannot be called complete or activated.

Source baseline: `594679dad98c5c28af9794787c476ccf496e2c6c`; latest observed main: `4bc1894f37080be5f0230f10921b34c7d463eea0` after #216. GitHub comparison showed merchant application changes only. A later read of the release checkout found `f30f380b4e2ba4dc985be88901cd57ed58f3e113` on `codex/launch-batch-validation-20261001`; it is another task's checkout, not this plan's execution base.

Open overlap to resolve at T0:

- **#210 SMS readiness:** modifies `sms/managed.ts`, `onboarding.ts`, `service.ts`, composer/inbox/onboarding UI and adds `sms/number-ownership.ts`. Prefer its merged implementation as the base of T4/T5/T7; if unmerged, coordinate scope rather than cherry-picking blindly.
- **#223 invitation profile isolation:** modifies `memberships.ts`; T8 user-support operations must preserve its fix and tests.
- **#224 interrupted assistant cleanup:** modifies assistant maintenance; reuse recovery evidence without reimplementing it.
- **#208/#217 email; #212/#219 notifications; #213 browser voice:** maintain their provider ownership and contracts; T3 may display safe health projections but does not replace these implementations.
- **#211 acceptance foundation, #214 reports, #215 fit:** read final merged state as needed; no ownership of those features transfers to this plan.

No branch/worktree/PR has been created for implementation. Proposed future branches below are names to allocate after approval, not existing branches.

## Workstreams, dependency and PR order

| Task / proposed worktree | Proposed branch suffix after `codex/` | Dependencies | Decision gate | Reviewable deliverable |
| --- | --- | --- | --- | --- |
| T0 coordinator | `owner-portal-contracts` | Execution approval | D9 | Pinned base, approved decisions/contracts, migration ownership |
| T1 access + shell | `owner-portal-access` | T0 | Architecture/security review | Equal owner gates and unified navigation |
| T2 company/review inventory | `owner-portal-queues` | T1 | None beyond approved design | Read-only paginated owner queues and company inventory |
| T3 monitoring/recovery | `owner-portal-operations` | T1 | D6 for delivery, recovery policy review | Reused health UI, safe recovery controls, optional dual-owner alerts |
| T4 review + provider workflow | `owner-portal-onboarding` | T2, #210 disposition | D1/D4; D7 for purge | Versioned review, explicit submission, provider diagnostics/recovery |
| T5 multiple numbers | `owner-portal-numbers` | T4, #210 disposition | D3; rental activation also D2 | Multi-number inventory, assignment and scoped routing |
| T6 credit ledger | `owner-portal-credit-ledger` | T0 | Core arithmetic only; no pricing assumed | Company credit reservation/purchase storage with no live charge/send |
| T7 commerce + send integration | `owner-portal-sms-commerce` | T5/T6 | D2 | Pack checkout, credited balance, preview/reservation/settlement and rental lifecycle |
| T8 support | `owner-portal-support` | T2, #223 disposition | D5/D8, D7 for purge | Audited sensitive reads and approved membership support actions |
| T9 schema integration | coordinator-owned, each owning PR | T4/T5/T6/T8 contracts | Migration review | Serialized additive migrations and tested upgrade/rollback posture |
| T10 integrated acceptance | `owner-portal-acceptance` | All enabled slice tasks | Hosted approvals; all launch decisions | Cross-slice tests, preview evidence, staged release runbook |

**Safe parallelism after T1:** T2 and T3 can run alongside T6; they own different service files. T8 can run after T2 while T4/T5 proceed, provided shared company navigation changes are handed to the coordinator. T4 → T5 → T7 is sequential because they share SMS provisioning/routing. T6 must land before T7. All edits to `db/schema.ts`, migration journal, runtime DB privileges and common navigation are serialized by the coordinator. No worker starts from another task's dirty worktree.

One PR per task is the target; T9 is a mandatory gate within schema-owning PRs, not a giant migration PR detached from consumers. Split T3 UI and alert delivery if D6 remains unanswered; split T8 metadata actions and sensitive reads if only one policy is approved. Each PR names its exact base, decision gates, flag state, tests, migration and rollback limitations. Do not stack unreviewed schema/consumer contracts across branches without a pinned dependency.

## Shared interface contract

All source paths below are under `nextjs-version/`. New signatures are proposed implementation contracts, not claims that these functions already exist. T0 freezes the accepted contract; changes require updating consumers and tests before parallel work resumes.

- Reuse `SuperAdminActor`, `requireSuperAdmin(request?)`, `requirePlatformStepUp(actor)` and `withSuperAdminAction(input, action)`. Do not use a customer `DealActor` as owner authority.
- Create `src/lib/mca/platform-contracts.ts` with `Page<T> = { items: T[]; nextCursor: string | null }`; validated `OwnerQueueQuery = { workspaceId?: string; state?: string; cursor?: string; limit: number }`, limit default 50/max 100. Cursors use a stable timestamp/ID pair; workspace filters are server-bound.
- `CompanyOperationsRow`: `workspaceId`, `name`, `ownerEmail`, `occupiedSeats`, `purchasedSeats`, `subscriptionStatus`, `accessState`, `smsReviewState`, `providerState`, `blockedReasons: string[]`, `observedAt: string | null`. Never includes provider ciphertext, profile payloads or customer content.
- `SmsReviewItem`: `workspaceId`, `companyName`, `submissionId: string | null`, `version: number | null`, `reviewState`, `submittedAt: string | null`, `registrationSummary`, `blockedReasons`. Form/detail fetch is separate from queue inventory.
- `ProviderObservation`: `kind: 'customer_profile'|'trust_product'|'brand'|'campaign'`, `attempt: number`, `providerSid: string | null`, `state: 'not_started'|'pending'|'approved'|'rejected'|'unknown'`, `providerStatus: string | null`, `observedAt: string`, `errorCodes: string[]`. Raw bodies remain private and are never this DTO.
- `SmsCreditBalance`: `balanceSegments: number`, `reservedSegments: number`, `availableSegments: number`, `updatedAt: string`; integer segment units. Core invariant: available = balance − reserved, and admission requires available ≥ requested. Chargeback debt may make balance negative only through an approved reversal policy; no new send is admitted then.
- `SmsSegmentQuote`: `encoding: 'GSM-7'|'UCS-2'`, `segments: number`, `bodyHash: string`; UI and server recompute from the exact outgoing body. No reservation is created by a preview. A changed body/sender/recipient must be revalidated at dispatch.

Each owner HTTP mutation authenticates live actor, validates trusted Origin, rate-limits, validates body with Zod, binds workspace/resource, checks required step-up, and writes audit. APIs return `no-store`; denied/missing resources do not reveal another tenant's content. A browser is not trusted to supply reviewer identity, balances, provider approval or prices.

## Verification convention

For each task, write the named behavior tests, run them to demonstrate the intended missing behavior fails, implement the smallest change, rerun them and relevant regressions, then run `pnpm typecheck` and targeted ESLint. Use:

`node --experimental-test-module-mocks --conditions=react-server --import tsx --test --test-concurrency=1 tests/<named-file>`

Multiple explicit filenames may be passed. Database tests require `MCA_TEST_DATABASE_ADMIN_URL` pointing to disposable local PostgreSQL; never fall back to app `DATABASE_URL`. A missing tool/database is a blocker to report, not a pass. Each task ends with one clean commit and an independent review. T10 runs the broad suite/build once on the integrated revision.

### T0 — Freeze the approved contract and isolate future work

**Files:** copy the approved versions of these planning artifacts into `docs/superpowers/specs/2026-10-01-owner-portal-design.md` and `docs/superpowers/plans/2026-10-01-owner-portal-plan.md` in a future isolated checkout; add `docs/acceptance/owner-portal-decisions.md`.

**Produces:** pinned main SHA, D1–D9 answer ledger, exact scope for the next task, branch/file ownership, and a migration allocator. No product interfaces yet.

- [ ] Read repository AGENTS/navigation/task-workflow and using-git-worktrees skill; inspect worktrees/status and latest main/open PRs.
- [ ] Record explicit implementation authorization, approved recommendations and unresolved gates. No answer means keep that gate open.
- [ ] Create isolated feature worktrees from the agreed clean base; never reuse the release task's branches/checkouts. No production environment files are copied.
- [ ] Decide #210/#223 disposition and record ownership conflicts. Pin schema names and shared interfaces before parallel workers start.
- [ ] Commit the accepted planning documents; independent Codex reviewer checks scope and dependencies before product work begins.

### T1 — Equal owner authorization and one portal shell

**Modify:** `src/lib/mca/platform-auth.ts`, `platform-page-access.ts`, `operations/access.ts`; `src/app/platform/layout.tsx`; `src/app/admin/status/page.tsx`; `src/app/api/admin/status/route.ts`, `errors/route.ts`; `src/app/(dashboard)/settings/sms-review/page.tsx`; `src/lib/mca/sms/onboarding.ts`; `docs/platform-super-admin.md`, `docs/platform-status.md`.

**Create:** `src/app/platform/monitoring/page.tsx`, `src/app/platform/sms/page.tsx`; extract reusable SMS review UI to `src/components/mca/platform/sms-review.tsx` rather than duplicating it. Old page paths redirect after authorization; retained legacy APIs enforce the same owner check.

**Interfaces:** consume existing `SuperAdminActor`; preserve `requireSuperAdmin`. Keep `requirePlatformOwner` as a temporary compatibility wrapper only if callers require its identity shape; inspect every caller, adapt without weakening the grant/MFA checks. Both existing owner emails may approve SMS, but still require live grants and step-up. Remove/narrow obsolete owner-only configuration only through reviewed release instructions, never during code setup.

- [ ] Add tests in `tests/platform-owner-parity.test.ts`: Mike/Ben with live grants and MFA both succeed; tenant admin, tenant `super_admin`, API key, unconfirmed identity, revoked grant, wrong session, MFA-less session all fail on new and legacy routes. Missing/expired TOTP fails material actions.
- [ ] Run that test and confirm the intended parity/legacy-route failures.
- [ ] Implement shared authorization, redirects and navigation. Audit first portal entry as today; no grant auto-seeding.
- [ ] Rerun new tests plus `platform-super-admin-auth.test.ts`, `platform-status-http.test.mjs`, `platform-routes.test.ts`; typecheck and lint touched files. Verify both owners' navigation and unauthorized direct URLs with synthetic identities.
- [ ] Commit `feat: unify platform owner access and navigation`; independent reviewer checks all old/new entry points and email-ceiling semantics.

### T2 — Read-only company and operational queues

**Create:** `src/lib/mca/platform-contracts.ts`, `platform-queues.ts`; `src/app/api/platform/queues/route.ts`; `src/components/mca/platform/operations-queues.tsx`.

**Modify:** `src/lib/mca/platform-console.ts` (add safe membership/seat projection only); `src/app/platform/page.tsx`, `companies/[id]/page.tsx`, `sms/page.tsx`; reuse existing platform table primitives.

**Interfaces:** `listCompanyOperations(actor: SuperAdminActor, query: OwnerQueueQuery): Promise<Page<CompanyOperationsRow>>`; `listSmsReviewQueue(actor: SuperAdminActor, query: OwnerQueueQuery): Promise<Page<SmsReviewItem>>`. Types defined in the shared contract. The service uses explicit columns and company IDs; no unbounded decrypt-all list.

- [ ] Add `tests/platform-queues.test.ts`: 101 fixtures page without loss/duplication; filtering occurs before page limit; missing provider observation returns unknown; queue data excludes profile/credentials/message/document content; tenant IDs cannot bypass owner authorization.
- [ ] Run it and confirm failures for absent queue behavior.
- [ ] Implement queue queries and empty/loading/error/stale UI, preserving existing financial projections. Queue rows link to exact company/submission/operation IDs.
- [ ] Rerun new tests and `platform-console.test.ts`; typecheck/lint; keyboard and narrow-screen check for tables, filters and error states.
- [ ] Commit `feat: add owner company and onboarding queues`; independent reviewer inspects query projections and pagination.

### T3 — Monitoring, safe recovery and optional alert delivery

**Modify:** `src/components/mca/operations/status-dashboard.tsx`, `src/lib/mca/operations/{status,monitor,contracts,job-recovery}.ts`; `src/app/platform/monitoring/page.tsx`; `src/app/api/platform/companies/[id]/failed-jobs/route.ts`; `scripts/operations/edge-entry.ts`; `docs/operations-recovery.md`. Create `src/components/mca/platform/job-recovery-panel.tsx`.

**Interfaces:** retain `platformStatus(window)`/`platformErrors(since,component,before)` and existing status DTOs. Extend `recoverFailedJob(workspaceId, jobId, actorUserId, action, evidence: {reason: string; reference?: string})`; internal replay needs reason, external-effect decisions need a safe restricted evidence reference. Do not store raw receipts or trigger a resend. Wrap HTTP calls with step-up and platform audit.

**D6 split:** read-only monitoring/recovery UI can be reviewed independently. New alert delivery requires approved recipients and channel. For proposed email-to-both, add per-recipient delivery attempts with unique `(incident event, recipient key)` and retain successful/unknown recipient states independently. Keep recipient addresses out of generic telemetry. Reuse existing transport. Do not provision Slack/email or send live alerts as development setup.

- [ ] Add/extend `tests/platform-status.test.ts`, `operations-recovery.test.ts`: stale/missing telemetry is unavailable; global errors remain unassigned to tenants; wrong-company job fails; fresh step-up/reason required; replay rejects outbound kinds and paused-company failures; evidence decisions leave the job failed and send count zero.
- [ ] If D6 approved, add `tests/operations-owner-alerts.test.ts`: two authorized recipients produce two independent attempts; one timeout becomes unknown without replaying either attempt or suppressing delivery to the other; opening/recovery dedup works.
- [ ] Run applicable tests to demonstrate missing behavior, then implement through existing monitoring/transport/recovery code. Keep current conservative incident thresholds unless D6 changes them.
- [ ] Rerun tests; `node scripts/operations/build-monitor.mjs` and existing documented Edge check if monitor changed; typecheck/lint. Record the dependent-database outage blind spot and approved fallback, not an uptime guarantee.
- [ ] Commit/review the UI/recovery slice; keep delivery in a separate blocked PR if D6 is unresolved. Independent reviewer verifies no uncertain send replay and no new scheduler.

### T4 — Versioned company review and explicit Twilio submission

**Gate:** D1/D4 approved; provider eligibility is also a live-activation gate. Coordinate #210 first.

**Create:** `src/lib/mca/sms/company-review.ts`, `registration-status.ts`; `src/app/api/platform/sms/submissions/[id]/route.ts`, `src/app/api/platform/sms/submissions/[id]/submit/route.ts`; `tests/sms-company-review.test.ts`, `tests/sms-registration-recovery.test.ts`.

**Modify:** `sms/{onboarding,provisioning,maintenance,registration-events}.ts`, `db/sms-onboarding.ts`, `src/app/api/mca/sms/{onboarding,provisioning}/route.ts`, `src/components/mca/sms/onboarding-panel.tsx`, `src/components/mca/platform/sms-review.tsx`; additive migration/journal/runtime privileges via T9.

**Interfaces:** `reviewSmsSubmission(actor: SuperAdminActor, input: {submissionId:string; expectedVersion:number; decision:'approved'|'changes_requested'|'rejected'; customerMessage:string; privateReason:string}): Promise<{submissionId:string; version:number; state:string}>`; `submitSmsRegistration(actor: SuperAdminActor, input: {submissionId:string; expectedVersion:number; feeAuthorizationId:string; idempotencyKey:string}): Promise<{operationId:string; state:string}>`; `refreshRegistrationStatus(workspaceId:string, api?:TwilioApi): Promise<ProviderObservation[]>`. `feeAuthorizationId` must identify a server-held, amount/currency/payer/version-bound consent record defined after D1; never trust a browser amount. Reuse `TwilioApi` injection and `sms_operations`.

- [ ] Add tests: stale-version approval 409; duplicate submit returns same operation; changed profile requires new review; missing payment/fee authorization/eligibility blocks before provider call; rejected/pending SMS does not pause CRM; two owners racing produce one accepted transition; tenant provisioning POST/PATCH cannot bypass review or fee gates.
- [ ] Add provider tests: per-resource pending/rejected states; forged/cross-account and duplicate/out-of-order callbacks; network timeout after resource creation → needs_review; reconciliation recovers existing resource without second creation; elapsed time alone never produces provider-confirmed active; Console-only corrections remain action-required.
- [ ] Run tests, then implement immutable submitted versions, separate private/customer notes and existing registration-attempt tables. Add bounded per-resource polling to the existing SMS maintenance owner, not a new scheduler. Do not overwrite historical resource identities.
- [ ] Rerun new tests plus `sms-onboarding.test.ts`, `sms-cron.test.ts`, `platform-super-admin-auth.test.ts`; typecheck/lint. Use synthetic provider responses only.
- [ ] Commit `feat: add versioned SMS review and explicit provider submission`; independent reviewer traces every path capable of creating subaccounts/keys/registrations and checks review/payment gates.

### T5 — Multiple company numbers and employee assignments

**Gate:** D3 approved; paid purchase/rental activation also waits for D2. Depends on T4 and resolved #210.

**Modify:** `sms/{provisioning,managed,service,inbox,contracts}.ts`, `db/sms-onboarding.ts`; `src/app/api/mca/sms/numbers/route.ts`; `src/components/mca/sms/{onboarding-panel,sms-connections-panel,inbox-panel,composer-panel}.tsx`; `memberships.ts` only for approved deactivation behavior after #223. Reuse #210's `sms/number-ownership.ts` if merged; otherwise explicitly settle its ownership at T0. Add `tests/sms-number-assignments.test.ts` and amend `sms-onboarding.test.ts` one-number constraint tests.

**Interfaces:** extend `assignNumber(actor:DealActor, numberId:string, membershipId:string|null): Promise<void>` where null means company-shared, subject to approved D3. Purchase intent includes intended assignment and immutable rental quote/consent identity; use a client-independent durable request identity. Two identical phone requests with different assignments/fee terms must conflict or reconcile deliberately, not silently reuse a different intent. `resolveSmsRoute` and inbox reads enforce current membership + approved number assignment + deal access.

- [ ] Tests: two different numbers purchase successfully within company cap; concurrent last-slot requests admit only one; duplicate same intent creates one resource; wrong-company/inactive membership fails; assigned number cannot leak another user's inaccessible deal; admin reassignment preserves history and removes prior user's future access; deactivation retains number but blocks use; inbound on an unassigned company number remains accessible only to permitted admins.
- [ ] Run failures, implement D3 rules and migration through T9, keeping number provider SID globally unique and all company references explicit. Preserve existing legacy manually configured senders.
- [ ] Exercise default-sender ambiguity, cross-number replies, release-in-progress callbacks, reactivation, and approved number-count cap. Do not make every account default or automatically release numbers with departing employees.
- [ ] Rerun assignment tests, `sms-onboarding.test.ts`, `milestone06-sms-composer.test.ts`, relevant #210 tests; typecheck/lint and synthetic inbox UI checks.
- [ ] Commit `feat: support company-owned SMS number assignments`; independent reviewer traces list/read/preview/send/webhook paths and schema rollback implications.

### T6 — Company segment ledger and reservations, without commercial policy

**Can proceed after overall approval independently of D2:** core integer arithmetic/idempotency only; no pack prices, charging outcomes or user-visible sale assumptions.

**Create:** `src/lib/mca/sms/credits.ts`, `src/lib/mca/db/sms-credits.ts`, `tests/sms-credits.test.ts`; schema export/migration/runtime grants via T9. Reuse AI-credit transaction patterns, not its per-user tables or units.

**Interfaces:** `getSmsCreditBalance(workspaceId:string, db?:DbExecutor): Promise<SmsCreditBalance>`; `grantSmsCredits(db:DbExecutor, input:{workspaceId:string; purchaseId:string; providerPaymentId:string; segments:number}): Promise<SmsCreditBalance>`; `reserveSmsCredits(db:DbExecutor, input:{workspaceId:string; messageId:string; segments:number; payloadHash:string}): Promise<{reservationId:string; state:'reserved'|'settled'|'released'}>`; `settleSmsCredits(db:DbExecutor, input:{workspaceId:string; messageId:string; eventKey:string; chargeSegments:number}): Promise<SmsCreditBalance>`; `releaseSmsCredits(db:DbExecutor, input:{workspaceId:string; messageId:string; eventKey:string}): Promise<SmsCreditBalance>`. Only trusted services call grants/settlement. `chargeSegments` is a policy-resolved quantity from T7, never client input.

- [ ] Add tests: grant 100 once despite repeated payment; simultaneous reservations of 60 from a 100 balance admit one; repeated same message/body is idempotent; changed body/quantity for same identity conflicts; wrong workspace fails; reserve then settle 2 consumes exactly 2; release restores availability without credit creation; repeated/reordered settlement cannot double charge; invalid/overflow/negative quantities rejected.
- [ ] Run failures, then implement row-locked account + append-only entry + reservation updates in one transaction. Provider cost totals remain separate. Journal entries record safe source references, not message text. Compute and check invariants under concurrent DB tests.
- [ ] Pin the core assertions in named tests `duplicate_payment_grants_once`, `concurrent_reservations_do_not_overspend`, and `settlement_is_idempotent`: `assert.equal(balance.balanceSegments, 100)` after duplicate grant; `assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)` for the two competing 60-segment reservations; `assert.equal(balance.balanceSegments, 98)` and `assert.equal(balance.reservedSegments, 0)` after settling a separate two-segment reservation twice. Use independent fixtures for these three tests.
- [ ] Rerun ledger tests and existing `assistant-credits.test.ts` to prove balance separation; typecheck/lint. No credit endpoint is activated yet.
- [ ] Commit `feat: add company SMS segment ledger`; independent reviewer checks arithmetic, uniqueness, lock ordering and bounded integer domains.

### T7 — Segment packs, number charges and send settlement

**Gate:** D2 fully recorded, including rental/registration charge collection and reversal policy. Depends on T5/T6. Update this task's fixtures/catalog with Mike's exact commercial values before implementation; unknown prices are not placeholders to fill autonomously.

**Create:** `sms/{segments,purchases,pricing-policy}.ts`; `src/app/api/mca/sms/credits/route.ts`, `credits/checkout/route.ts`, `src/app/api/webhooks/stripe-sms-credits/route.ts`; `src/components/mca/sms/credit-balance.tsx`; `tests/sms-segments.test.ts`, `sms-credit-purchases.test.ts`, `sms-credit-delivery.test.ts`.

**Modify:** `sms/{service,managed,maintenance,contracts}.ts`, existing status/inbound callbacks as required by D2; `sms/{composer-panel,inbox-panel,onboarding-panel}.tsx`; platform company financial projection for balances/purchases and rental status. Reuse installed Stripe SDK and validated billing/tax utilities, not the AI-credit webhook's product identity. Rental/registration charge adapter files are selected at the D2 contract checkpoint based on the approved payment model, then added to this task before coding that subtask.

**Interfaces:** `quoteSmsSegments(body:string): SmsSegmentQuote`; `createSmsCreditCheckout(actor:DealActor,input:{packId:string;idempotencyKey:string},stripe?:Stripe): Promise<{purchaseId:string;url:string}>`; `reconcileSmsCreditPurchase(purchaseId:string,stripe?:Stripe): Promise<{state:string;grantedSegments:number;reversedSegments:number}>`; `settleSmsMessageCredits(workspaceId:string,messageId:string,eventKey:string): Promise<SmsCreditBalance>` retrieves stored/provider evidence and applies the approved policy through T6. Server-side `packId` resolves exact approved version/quantity/price/currency. Never grant credits from a browser redirect alone.

- [ ] Pin GSM-7 boundary tests: 160 basic characters = 1, 161 = 2; extension-table characters consume two septets. Pin UCS-2 boundaries 70/71 code units and surrogate-pair emoji. Test actual newline and special-character handling. Verify quoted body equals transmitted body; no silent smart-encoding conversion.
- [ ] Use exact assertions in `gsm7_segment_boundaries`: `assert.equal(quoteSmsSegments('a'.repeat(160)).segments, 1)` and `assert.equal(quoteSmsSegments('a'.repeat(161)).segments, 2)`; in `ucs2_segment_boundaries`: `assert.equal(quoteSmsSegments('漢'.repeat(70)).segments, 1)` and `assert.equal(quoteSmsSegments('漢'.repeat(71)).segments, 2)`. Add extension-table and emoji cases against the approved Twilio encoding behavior, not JavaScript character count alone.
- [ ] Pin D2 commercial fixtures; tests verify signed webhook, live/test mode match, tenant/product/amount/currency validation, async payment pending, duplicate and reversed-order events, refund/chargeback reconciliation and no AI-credit changes.
- [ ] Add send tests: insufficient shared balance rejects before provider call; preview creates no reservation; concurrent sends cannot overspend; a timeout reserves and exposes unknown; retry does not send again; receipt settlement is once-only; late failure follows D2 without invented refund; STOP and company pause win over available balance.
- [ ] Implement approved pack/rental/fee flows and reservations at the shared dispatch boundary, covering both direct inbox and closing sends. Protect all alternate/legacy send paths from bypassing managed-company credit policy. Keep incoming/registration/status callbacks available when new outbound actions are paused.
- [ ] Test zero-balance inbound and number-rental exposure under D2; customer notification/release rules require separately authorized delivery and explicit release consent. Never equate no outbound credits with no provider costs.
- [ ] Rerun all new tests and existing billing/SMS/Stripe-credit regressions; typecheck/lint. Commit `feat: add prepaid SMS packs and reconciled spending`; independent reviewer traces a paid pack through reservation, provider uncertainty, settlement and refund.

### T8 — Audited support access and approved user support

**Gate:** D5/D8 approved. Sensitive reads and user mutations may be separate PRs if only one policy is ready. D7 governs future purges, not an excuse to log sensitive content.

**Create:** `src/lib/mca/platform-support.ts`; `src/app/api/platform/companies/[id]/support/route.ts`; `support/[sessionId]/route.ts`; `support/[sessionId]/resources/[kind]/[resourceId]/route.ts`; `src/components/mca/platform/support-access.tsx`; `tests/platform-support.test.ts`. Add `platform_support_sessions` through T9.

**Modify:** platform company detail view; approved user-support API `src/app/api/platform/companies/[id]/users/[membershipId]/route.ts`; `memberships.ts` only through a dedicated server-scoped function after #223. Reuse `documents/repository.ts` and storage primitives for reads; do not weaken `documents/service.ts` tenant authorization.

**Interfaces (proposed read-only D5 contract):** `SupportReadContext = {actor:SuperAdminActor; workspaceId:string; supportSessionId:string; expiresAt:string; scope:'customer_content_read'}`; `startSupportAccess(actor,input:{workspaceId:string;reason:string}): Promise<SupportReadContext>`; `requireSupportRead(actor,workspaceId,supportSessionId): Promise<SupportReadContext>`; `revokeSupportAccess(actor,supportSessionId): Promise<void>`. Approved duration and consent requirements are exact constants recorded at D5. Resource read resolves IDs under context.workspaceId, checks scope/live session/expiry, writes audit before returning content, and never fabricates `DealActor` membership.

- [ ] Tests: no support grant → 403; valid grant cannot cross company/session/actor; expiry/revocation/grant removal immediately denies next read; audit failure returns no content; another company's document ID fails; private bytes/URLs absent from ops logs; arbitrary SQL/resource-kind/export/send mutation unsupported.
- [ ] For approved D8 membership actions, test company-scoped identity, last-owner/self-deactivation protection, seat limits, invitation email identity, no shared name/phone overwrite, and no password/MFA bypass. Use synthetic tenants/users only.
- [ ] Run failing tests, implement approved capabilities with reason/step-up/audit and no impersonation. Document downloads use an authenticated checked stream; no reusable long-lived URL is returned. UI shows company, reason, expiry and End access.
- [ ] Rerun support tests plus relevant membership/invitation/document authorization regressions; typecheck/lint. Commit `feat: add audited owner support access`; independent security reviewer inspects every content path and user mutation.

### T9 — Migration ownership and rollback gate for each schema-owning task

**Owner:** one coordinator, in the owning task's branch after final base refresh. **Files:** new sequential `drizzle/<allocated>_<purpose>.sql`, `drizzle/meta/_journal.json`, relevant `src/lib/mca/db/*.ts`/`schema.ts`, `scripts/database/secure-runtime.ts`, and `tests/owner-portal-migrations.test.ts`. No fixed migration number is assigned now because main is moving.

- [ ] Inspect current schema and all references; reuse migration 0069 registration/meter structures. Confirm existing columns/indexes against source without reading production data. Allocate the next number once, serialize journal edits, and review a schema diff.
- [ ] Add upgrade tests from a pre-feature synthetic DB and fresh migration tests: preserve existing companies, provider IDs, one-number accounts, audit rows and AI balances; reject cross-tenant foreign relationships; runtime role cannot mutate append-only ledger/audit or write grants; untrusted roles cannot read private tables.
- [ ] Use expand-first migrations, nullable/backfillable associations, explicit bounded backfills and matching Drizzle schema. Mark legacy records as legacy/unverified; do not invent historical submission versions, fee consent or provider approval. Never decrypt profiles in a migration log.
- [ ] Multi-number transition: deploy code capable of reading old/new cardinality before removing `sms_company_number`; keep new purchase flag off until all relevant writers are compatible. After second numbers exist, old one-number code is no longer a safe rollback and the unique index cannot simply be recreated.
- [ ] Credit transition: no conversion from provider dollar estimates, AI credits or monthly usage rows into purchased SMS segments. New zero balances do not silently cut over existing customers; D2 defines cohort migration/notice. Disable competing metered SMS charging before prepaid activation.
- [ ] Prove guarded migration/runtime grants in disposable DB; record lock/backfill expectations and a forward-fix path. After review, commit migration with its consumer; hosted application remains a later authorized release step.

**Rollback rules:** turn off new writes/sales/sends at server dispatch gates while preserving signed callbacks, provider polling/reconciliation, audit and ledgers. Remove a new navigation link if needed, but old URLs retain secure guards. Keep additive data/tables. Do not automatically release numbers, close subaccounts, refund payments, drop balances or revoke legitimate owners. Provider resources and charges need separate reconciliation/authorized compensating actions; a Git revert cannot undo them.

### T10 — Integrated acceptance and staged release handoff

**Create:** `tests/owner-portal-journey.test.ts`, `docs/acceptance/owner-portal-2026-10-01.md`, `docs/owner-portal-release.md`; update `docs/platform-super-admin.md`, `docs/platform-status.md`, `docs/sms/company-onboarding.md`, `docs/operations-recovery.md` to remove stale single-owner/one-number/event-only claims after final behavior is known.

- [ ] Integration fixtures: two platform owners, two tenant companies, tenant admins/employees, one unapproved paid company, one approved company, several assigned numbers, credit purchases, provider failures and revoked support access. No real users/credentials.
- [ ] Prove end-to-end: signup/payment entitlement → CRM usable with SMS locked → versioned review → fee consent/submission → provider approval → number purchase/assignment → pack payment → preview/send/reply/STOP → usage/credit reconciliation → incident/recovery/audit. Include two owners racing and provider/payment duplicates.
- [ ] Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build` once on the integrated revision; explain pre-existing failures and require resolution of relevant failures. Run Graphify update after product edits per repository instructions. Rebuild/check monitor bundle if changed.
- [ ] Independent Codex reviewer, separate from authors, reviews final diff and test evidence for tenant boundaries, money effects, migration drift, provider uncertainty and source/doc consistency. No self-approval. Re-review changed fixes. Record commit SHA and review outcome before requesting release approval.
- [ ] With separate hosted permission, use nonproduction Supabase Auth/Storage and Vercel preview: verify same-session MFA, Mike/Ben parity using designated synthetic owner accounts, denial matrix, private downloads, Stripe test payment/refund, provider-signature ingress, worker shutdown/reclaim and monitoring alert opening/recovery to designated test recipients.
- [ ] Only with explicit Twilio pilot approval and validated financial-use eligibility: designated company/subaccount/campaign/local numbers, opted-in controlled recipient, bounded fees, send/reply/status/STOP, exact provider receipts and number/segment reconciliation. Test credentials/mock campaigns alone are not proof of carrier approval or delivery.
- [ ] Stage launch: (A) owner read-only portal; (B) reviewed mutations/support; (C) one approved pilot's number/credit commerce; (D) limited tenant cohort; (E) wider rollout after acceptance. Record monitored error/queue/unknown-operation/credit-mismatch signals and who can stop each stage. No rollout occurs during this plan-writing task.

## Release controls proposed for approval

Reuse existing readiness flags and worker ownership. Add server-only slice flags only where existing flags cannot safely isolate new behavior: proposed `MCA_PLATFORM_SMS_REVIEW_ENABLED`, `MCA_SMS_MULTI_NUMBER_ENABLED`, `MCA_SMS_PREPAID_ENABLED`, `MCA_PLATFORM_SUPPORT_ENABLED`; all default false. T0/T9 must check for equivalent new flags on main before adding them. Owner-auth improvements must not revert to a weaker legacy check when a feature flag is off. A flag gates both UI and mutation/dispatch; the balance ledger and callbacks must remain readable/reconcilable when sales/sends are off.

Hosted release runbook must name the exact approved project, commit, migration list, enabled flags, sole scheduler per workload, designated recipients and operator. Source files cannot verify current production settings. No secret values go in the plan, PR, logs or screenshots.

## Coverage and self-review result

| Requirement | Tasks / evidence |
| --- | --- |
| Equal Mike/Ben ownership, tenant/seat boundaries | T1, T2, T5, T8 denial and isolation tests |
| Existing admin/TOTP/audit reuse | T1 and common mutation contract; T9 privilege tests |
| Pending SMS does not block paid CRM | T4/T10 journey |
| Company review, provider submission/fee, correction/rejection | T4; D1/D4 explicitly block affected writes |
| Trust Hub/brand/campaign/number status, uncertainty | T4 provider observations and reconciliation; T10 pilot |
| Multiple assigned local numbers | T5/T9; D3 policy gate |
| Company segment packs, pre-send quote, shared balance | T6/T7; D2 pricing/settlement gate |
| Monitoring, escalation, safe recovery | T3; D6 blocks delivery only |
| Sensitive support access and user oversight | T2/T8; D5/D8 gates |
| Redaction/retention/holds, financial controls | T3/T4/T6/T8/T9; D7 no-new-purge gate |
| Worktree isolation, PR dependencies, independent review | T0, task commits/reviews, T9/T10 |
| Migration, rollout, rollback and production limits | T9/T10 and release controls |

Self-review checked requirement coverage, contract names, ownership conflicts, mutable main, unknown decisions, and rollback contradictions. Two constraints are deliberately unresolved rather than falsely precise: commercial adapter details await D2; sensitive-access policy awaits D5. Those tasks require a short contract update after answers, before coding. Independent owner-console work does not wait on them once Mike approves that slice.

**Next action belongs to Mike:** review the design and plan, answer or explicitly defer D1–D9, and choose execution scope. Recommended future method: scoped Codex implementation workers with an independent Codex Astra reviewer per PR and final integration review; use high reasoning as requested. This is a recommendation, not a claim that workers ran or runtime model settings were changed. No implementation has started.

# auth-refractor local acceptance evidence

This maps the approved A01–A20 criteria to concrete local regression anchors and combined-branch checks. It proves local code behavior, not hosted release or delivery acceptance. Independent whole-branch review and its one complete fix wave are approved; exact published SHA/CI and available preview are verified separately. The [rollout guide](../stripe-first-onboarding.md) defines migration allocation, competing-flow sequencing and runtime evidence requirements.

| Criterion | Concrete regression anchor | Core evidence / remaining acceptance |
| --- | --- | --- |
| A01 | `onboarding-navigation.test.ts`: “desktop, mobile and footer separate existing Login from Get Started pricing”; “home purchase CTAs open pricing without an account, company or seat form” | Task 6 actual controlled Chrome passed 19 named cases; scoped coordination fix passed 3 further cases. Anonymous entry, explicit completion, labels/focus and unsupported-browser zero-start behavior use real components with synthetic intercepted APIs. |
| A02 | `onboarding-checkout.test.ts`: “freezes server-selected card-first fourteen-day Checkout before I/O without a company or local trial”; `billing-catalog.test.ts` | Exact frozen catalog guard is reviewed; controlled Stripe business-name/card/terms/charge-date proof pending. |
| A03 | `onboarding-store.test.ts`: “a second activation cannot change provider association or restart the trial”; `onboarding-acceptance.test.ts`: closed-browser signed-webhook case | Delayed repair retains provider trial dates; real provider timing pending. |
| A04 | `onboarding-reconciliation.test.ts`: “wrong account, mode, customer, price, generation, card or trial dates cannot activate”; “unsigned events fail verification and foreign signed account/session events cannot activate” | Existing authority regressions; new integrated case uses actual SDK signature verification before capture. |
| A05 | `onboarding-checkout.test.ts`: concurrent starts/lost-response replay; `onboarding-claim.test.ts`: parallel same-owner and competing-identity case | Reuse reviewed idempotency/atomicity tests; no duplicate mirror implementation. |
| A06 | `onboarding-acceptance.test.ts`: “closed-browser signed webhook repairs under creation rollback, creates two intents and admits CRM despite failed mail and missing profile” | New real-PG composition needs no return-page call and creates one Checkout. Cross-device browser callback proof remains hosted. |
| A07 | `onboarding-auth.test.ts`: canonical continuations, bounded OTP/callback proof, expired links/current generations; `onboarding-claim.test.ts`: verified email without live session | Reviewed identity boundary retained; live password/Google/OTP and cross-device proof pending. |
| A08 | `onboarding-claim.test.ts`: required MFA and revocation boundaries; `platform-auth.test.ts`, `platform-super-admin-auth.test.ts`, `platform-owner-parity.test.ts` | Reuse actual owner/MFA tests. New queue checks grants, session identity, API-key denial and revocation. |
| A09 | `onboarding-checkout.test.ts`: known ineligibility; `onboarding-reconciliation.test.ts`: exact compensation, ambiguous acceptance and conversion race | Existing reviewed no-silent-paid and compensation rules; controlled cancellation proof pending. |
| A10 | `onboarding-claim.test.ts`: “faults at tenant boundaries roll back the entire claim”; final association/audit/revocation failures and competing claimants | Existing fault tests reused rather than mirrored. |
| A11 | `onboarding-store.test.ts`: transaction-only two-intent convergence and rollback; `onboarding-email.test.ts`: activation repair reuses intent identities | New closed-browser case observes two distinct pre-company intents and still exactly two after claim. |
| A12 | `onboarding-email.test.ts`: lost acceptance, interrupted lease, frozen retry/configuration fence and receipt deduplication; `onboarding-email-recovery.test.ts`: strict operator evidence/receipt ownership | Queue/detail expose generation-specific states and accepted/delivered receipts. Focused operator browser verifies explicit evidence/reissue bodies and preserves receipt-owned M1 despite a missing projection. Hosted transport/delivery proof remains pending. |
| A13 | `onboarding-acceptance.test.ts`: closed-browser/mail rejection/no-profile case; `onboarding-claim.test.ts`: live identity requirement | Both service messages fail in the mocked transport while claimed company access is operational and continuation is `/dashboard`. |
| A14 | `onboarding-acceptance.test.ts`: Checkout name → company → basic-form prefill; `onboarding-business-profile.test.ts`: encrypted EIN/sanitized validation/stale revisions | New integration proves prefill with no basic profile; reviewed profile tests cover writes and privacy. |
| A15 | `onboarding-business-profile.test.ts`: active admin/MFA/visibility/operational/CSRF checks; `onboarding-auth.test.ts`: public status and generation checks | Existing tenant protections; forwarded service locators carry no membership authority. |
| A16 | `onboarding-business-profile.test.ts`, `onboarding-readiness.test.ts`, `sms-onboarding.test.ts` | Registered profiles and communications gates remain authoritative; basics do not start registration. New old-tenant case retains registered SMS history. |
| A17 | `onboarding-readiness.test.ts`: observational readiness and preview/accepted/received sender evidence; `onboarding-ui.test.ts`: resumable checklist | Existing explicit-action behavior; controlled receipt/submission proof pending. |
| A18 | `onboarding-acceptance.test.ts`: “new enrollment recovery leaves an existing registered tenant and platform owner authority unchanged”; reviewed billing/owner/invitation regressions | New case snapshots historical trial, seat selection, registered SMS, membership, owner and platform grant through exact redundant-trial cancellation. Task 6 retained 225 affected auth/navigation/billing/setup regressions plus browser checks; live legacy/new tenant Auth proof remains a hosted gate. |
| A19 | `onboarding-acceptance.test.ts`: exact expiry boundary/cancellation/setup retention; `onboarding-reconciliation.test.ts`: late paid evidence/outage/conversion race | New company loses trial access exactly at the original deadline and routes to billing without erasing encrypted basics or restarting Checkout. Existing paid/grace/pause rules remain in force. |
| A20 | `onboarding-operator.test.ts`: runtime-off sanitized queue, due/stalled/lease facts, cursor/filter bounds and denied/stale UI; `onboarding-acceptance.test.ts`: direct maintenance selection/disabled/zero-limit/deadline; `tests/browser/onboarding-operator/run.mjs` | Local detail/action consumers verify runtime-off reads with disabled mutations, immutable drafts, shared clock and private requests. Current scheduler/provider configuration and actual useful claims/receipts remain unproven hosted gates. |

## Core checks

Fixed reviewed base: `02801de9836d29dfc417d0001f2f83daf75ea923`; Node `24.18.0`; shared dependencies read-only. Real-PG tests use clean environment and unique disposable databases on task-owned `127.0.0.1:55436`, synthetic Supabase/Stripe fixtures and mocked mail fetch only.

New core GREEN: `onboarding-migrations.test.ts`, `onboarding-operator.test.ts`, `onboarding-acceptance.test.ts`: **11 tests, 11 pass, 0 fail, 0 skip**, 8491.646416 ms. RED before implementation: 11 tests, 2 pass, 9 fail, 5677.811084 ms; six failures were absent queue/migration behavior and three were corrected synthetic fixture assumptions. No reviewed service defect was found or rewritten.

The exact core command, static results and SQL/journal byte comparison are retained in `task-7-core-report.md`. The follow-up starts from reviewed combined base `94397e74ac9bd5e85196764e41f147d59d5635f5` and consumes the existing protected detail/recovery/evidence services without changing server authority. Its installed-Chrome runner passed **22 named checks, 10 explicit synthetic POSTs and zero page errors**, including four light/dark width combinations. The affected `onboarding-operator`, `onboarding-acceptance`, `platform-console`, `platform-queues`, `platform-refresh` and `platform-shell` set passed **31/31**, zero failures/skips, 5299.025 ms. Exact final commands, static results and scoped SHA belong in `task-7-followup-report.md`.

The final operator fix adds five actual-component StrictMode checks with zero POSTs/page errors: replacement startup, abandoned-finalizer ownership, duplicate reads, stale/draft retention and denied clearing. A meaningful RED reproduced the missing replacement request. The retained Task 4/3 service suites prove authority, lease, audit and receipt behavior and were not repeated merely to test these UI consumers.

## Combined-branch verification

Full-suite code candidate `99e0ea36a5f6dd2b6b523ce6f34ba1556540c312`; whole-branch review at `f8e5b5546219a75bb100effe3cb5f706fdf025a0` plus evidence-only `4b7132d`. Its final scoped fix `c87a4a60b488e1e3c1440e0a46d62aa98060bbc8` is approved and composed in publication candidate `34853aee22d046ff7733c294e82d68e5bdb7590a`. The full suite below predates that final delta; its final affected checks are listed separately. Current main `d8cd10252a43db3d8a5b78ba37d481d1d13c4a70` is included. Node24.18.0/pnpm11.1.2; task-owned PostgreSQL14.23 on loopback55436, unique synthetic test databases and mocked external providers. CI uses PostgreSQL17. No application envfiles or production credentials/data were used.

From `nextjs-version/`, a clean environment with only the disposable `MCA_TEST_DATABASE_ADMIN_URL` ran:

| Check | Result |
| --- | --- |
| `pnpm test` | **2186 tests: 2185 pass, 0 fail, 1 skip**, 317922.360042ms. Skip is the unchanged opt-in live synthetic assistant-provider acceptance case. |
| `pnpm typecheck` | Exit0. |
| `pnpm lint` | Exit0; zero errors,16 inherited warnings. |
| `pnpm build` | Normal Next16.1.1/Turbopack exit0; compiled10.6s,274staticpages on the publication candidate. Telemetry disabled; only existing public font build access. |
| `node scripts/operations/build-monitor.mjs` plus tracked generated-file parity | Exit0; no generated monitor diff. |
| Deno2.9.7 `check --node-modules-dir=none --unstable-sloppy-imports scripts/operations/edge-entry.ts` | Exit0 with task-owned cached dependencies/copied lock; no product lock changes. |
| Graphify update and `cluster-only . --no-label` | Exit0;16175nodes,51700edges,782communities. HTML regenerated with30000-node limit. Main had13564nodes/41904edges; no shrink warning.31 files yielded zero AST nodes, including data-only JSON. |

The first combined candidate had one failure: completion copy repeated a price literal. The unchanged catalog guard caught it; a reviewed one-component change now derives the displayed USD first-user price from the canonical catalog. The corrected combined guard passes3/3 and the complete rerun above passes. No assertion or guard was weakened. Experimental/deprecated module-mock warnings and expected sanitized synthetic failure diagnostics remain disclosed.

Actual controlled Chrome evidence: public entry19cases, then3focused unsupported/supported coordination cases; operator22checks/10explicit syntheticPOSTs, then5focused StrictMode checks; zero pageerrors in all. APIs/providers are intercepted synthetic fixtures. These are real component/browser checks, not live Auth/Stripe/mail acceptance. Each implementation slice and concrete fix passed independent spec/quality review. Whole-branch review identified two integration issues and one copy issue. One complete fix wave and one independent scoped re-review addressed all three; no open code findings remain. Exact published SHA/CI/available preview verification follows publication.

## Hosted evidence still required

- Approved nonproduction target and preview revision; never infer authorization from existing staging configuration.
- Selected-flow landing order, current migration ledger/timestamps/hashes, restricted grants and no replay of renamed CREATE statements.
- Real Supabase password/Google/OTP/migration recovery, callback/template security email, live session revocation and app/provider MFA.
- Controlled Stripe business name/card/terms, exact 14-day completion clock, delayed events, renewal/invoice evidence, cancellation and interruption recovery.
- One authenticated billing/enrollment repair owner and one comms/service-email owner, with enabled flags, code SHA, useful queue claims and no competing legacy worker.
- Both distinct service mails to explicitly controlled recipients with actual receipt evidence; provider acceptance or an empty cron response cannot satisfy receipt.
- Final integrated operator/public browser checks on the reviewed release head; pending Checkout must wait/retry/support without a duplicate purchase. Local synthetic operator controls do not prove live platform MFA or provider evidence.


## Final review fixes and covering evidence

Claimed continuation now performs the existing explicit claim replay before navigation. Actual PostgreSQL tests keep company B selected during status GET, then select enrollment company A through its membership-validated replay for business/CRM/billing/paused intents. B’s encrypted basics and billing state remain unchanged; revoked A membership and required MFA reject replay without changing B. Actual Chrome tests prove one POST, no premature navigation and preserved error/MFA behavior.

Onboarding mail receives at most140seconds of the unchanged230-second comms deadline, reserving90seconds for existing discovery, receipt repair and sends. In the deterministic real-PG slow-provider regression, nine intents become held and21 remain queued; discovery/receipt/send entry retain95/80/65seconds. An old notification is accepted and an old receipt becomes delivered within180syntheticseconds, with no held-message replay. Mail-disabled runtime still serves old notifications. This addresses new-mail starvation; arbitrary preexisting digest/webhook load remains a hosted workload check.

The two conversion surfaces identify the catalog amount as the base first-user price and preserve applicable Checkout discounts/tax. No offer, coupon, tax or billing policy changed.

Final unique affected coverage: **157 passing cases** across scoped runs (31UI/navigation,114services/catalog,8pricing,4legacy discovery), plus **11/11 actual Chrome checks**, zero pageerrors; the two required PG cases are included, not double-counted. One122-case covering run had121passes/one obsolete exact copy expectation; its strengthened pricing assertions subsequently passed8/8. There is no claimed single157-case run. Final typecheck/scopedlint/diff pass; root publication build, Deno check and monitor parity pass. No source changes follow the approved fix, only evidence/plan/generated Graphify bookkeeping.

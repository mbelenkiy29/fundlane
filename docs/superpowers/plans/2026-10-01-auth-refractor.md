# Stripe-first Fundlane Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved Stripe-first 14-day onboarding flow as a reviewed draft PR titled exactly `auth-refractor`.

**Architecture:** A durable enrollment exists before a company and coordinates Stripe confirmation, verified identity claim, atomic company creation and two independent service-email intents. Existing auth, billing, platform grants and communications policies remain authoritative. Business basics and the optional checklist do not gate operational CRM access.

**Tech Stack:** Next.js 16, React 19, TypeScript, Supabase Auth/Postgres/private Storage, `pg`, Drizzle, Stripe 22.6.0, Node 24, pnpm 11.1.2.

**Spec:** [Approved design](../specs/2026-10-01-stripe-first-onboarding-design.md). User approved the delivered document and explicitly directed planning and execution into a PR at 22:29 UTC on October 1, 2026. That instruction authorizes execution after this plan's self-review without another approval request.

## Global Constraints

- Exactly **14 days**, card collected upfront through Stripe, automatic paid subscription afterward unless canceled. Show the actual price and first charge date.
- No mandatory Fundlane account registration, company form, or seat-selection wizard before Stripe. Login is separate from Get Started.
- Preserve existing Fundlane pricing: USD 399/month including the first user, validated against configured provider prices. Additional seats are managed later inside the app.
- Business-form completion, internal business review, team invitations, optional setup, and onboarding-email delivery are not CRM gates.
- Preserve verified Supabase identity, account-linking restrictions, live sessions, MFA, platform grants, existing tenants, historical trial dates, subscriptions and recovery policies.
- Never request EIN by email reply. Encrypt it with company-bound associated data; keep it out of logs, emails, URLs, telemetry and browser storage.
- Use additive Drizzle migrations and disposable PostgreSQL. No production credentials/data, live trial enrollment/charges, external email sends, new credentials or hosted security configuration changes.
- Creation and dispatch flags default off. Disabling new enrollment creation must leave existing enrollments recoverable while the runtime remains enabled.
- Open a DRAFT PR titled `auth-refractor`; do not merge or manually deploy production.

## Review Focus

- Stripe accepts a create request but the response is lost beyond its idempotency retention window: Task 2 must recover or require operator resolution, never blindly create another subscription.
- A customer's email, browser or identity changes between Checkout and claim: Task 3 must preserve authentication and purchase evidence, reject account takeover and retain the original trial dates.
- A purchase is claimed only after trial conversion or during a concurrent invoice: Task 2 must avoid promising prevented charges or inventing refunds; route ambiguous compensation to an operator.
- A provider accepts email before the worker dies, or a different worker obtains an expired lease: Task 4 must fence writes, mark uncertainty and avoid an automatic duplicate.
- Existing sender preview records appear verified and registered companies already have EIN: Task 5 must distinguish actual send evidence and preserve registered identity without forcing re-entry or exposing EIN.

## Boundaries and execution

Current main was fetched before planning: `2d6b5ea4a2eb48fcf2f8857a6a578c0c6ade48f3`, including PR #233 and #234. Worktree: `/Users/mbele/Documents/Codex/2026-10-01/task-6/implementation`, branch `codex/auth-refractor`. The approved spec travels with this branch. Tasks execute sequentially with a fresh implementer and task-scoped independent review; source research and environment preparation may run in parallel. Run the aggregate suite once against the integrated branch, then repeat only for new changes/failures.

Paths below are relative to `nextjs-version/` unless prefixed `../`. The test command prefix is `node --experimental-test-module-mocks --conditions=react-server --import tsx --test --test-concurrency=1`. Database tests receive only the task-owned loopback `MCA_TEST_DATABASE_ADMIN_URL`; tests mock every external provider. Existing source contracts are recorded in task-6 `research/plan-*-contracts.md` and must be verified against the actual worktree.

### Task 1: Durable enrollment, email intents and business-profile storage

**Files:**
- Create: `src/lib/mca/db/onboarding.ts`, `drizzle/0078_stripe_first_onboarding.sql`, `src/lib/mca/onboarding/contracts.ts`, `config.ts`, `store.ts`, `email-intents.ts`, `tests/onboarding-store.test.ts`.
- Modify: `drizzle.config.ts`, `drizzle/meta/_journal.json`, `scripts/database/secure-runtime.ts` only where the existing explicit grant registry requires it, `.env.example`.

**Interfaces:**
- `EnrollmentOffer`: `{ version: 1; accountId: string; basePriceId: string; seatPriceId: string; currency: "usd"; baseAmount: 39900; quantity: 1; trialDays: 14; livemode: boolean; promotionCodes: boolean; automaticTax: boolean }`.
- `EnrollmentActivation`: `{ sessionId: string; customerId: string; subscriptionId: string; email: string; businessName: string; trialStartedAt: string; trialEndsAt: string; verifiedAt: string; billingStatus: string; livemode: boolean }`. This is an internal server result, never trusted request JSON.
- `EnrollmentRecord` maps the enrollment row with independently typed checkout, billing, claim and recovery states; nullable provider IDs, initiating/claimed provider-user IDs, local user/workspace, immutable trial dates, offer, encrypted contact/provider snapshot, revision, generation and lease fields.
- `createEnrollment(input: { resumeSecret: string; offer: EnrollmentOffer; initiatingProviderUserId?: string }, db?: DbExecutor): Promise<EnrollmentRecord>`; `findEnrollment(id: string, db?: DbExecutor): Promise<EnrollmentRecord | undefined>`; `verifyEnrollmentResume(row: EnrollmentRecord, secret: string): boolean`.
- `recordEnrollmentActivation(id: string, activation: EnrollmentActivation, db: DbExecutor): Promise<void>` atomically records accepted activation and invokes `enqueueOnboardingEmailIntents(id: string, generation: number, db: DbExecutor): Promise<void>` for exactly the two purposes.
- `enrollmentRuntimeEnabled(): boolean`, `enrollmentCreationEnabled(): boolean`, `onboardingEmailEnabled(): boolean` read separate flags. Creation requires runtime, open signup and configured Stripe; email dispatch requires runtime and its own flag. Status/claim/reconciliation of existing records do not depend on creation being enabled.

- [ ] **Step 1: Write storage regression tests.** Assert duplicate resume secrets produce one record, foreign resume secrets fail, provider IDs and enrollment/workspace binding are unique, invalid state/revision writes fail, activation retry creates exactly two intents, a second activation cannot change trial dates, plaintext contact/EIN does not appear in persisted sensitive columns, and rollback leaves neither activation nor one partial email intent.
- [ ] **Step 2: Run `... --test tests/onboarding-store.test.ts` and record the expected missing-schema/service failure.**
- [ ] **Step 3: Add schema and matching forward migration.** Tables: enrollment; bounded expiring auth/recovery challenges; enrollment service-email outbox; service-email evidence/receipts and safety suppressions; encrypted versioned company business basics; durable sender test evidence if no existing table can represent accepted/received/preview separately. Retain generation-specific frozen Checkout requests/idempotency windows and durable prebinding event receipts, with keyed email/domain history for unclaimed provider trials. Use unique enrollment/purpose/generation delivery keys, provider-ID uniqueness, FK ownership, indexes for repair/claim, restrictive runtime grants and tenant boundaries. No ownerless normal workspace and no bulk writes to existing tenants. Verify `0078` is still available before allocating it; later task-owned additive migrations may extend interfaces after foundation review.
- [ ] **Step 4: Implement the store/config/intents interfaces.** Hash resume secrets; encrypt contact snapshots using an enrollment-specific AAD namespace; use existing keyed hashing for email comparisons. Row locks/CAS and transaction-required helpers enforce invariants. Outbox intents can exist without a workspace and contain no EIN. Add default-off `MCA_ONBOARDING_RUNTIME_ENABLED`, `MCA_STRIPE_FIRST_ONBOARDING_ENABLED`, `MCA_ONBOARDING_EMAIL_ENABLED` with rollback comments.
- [ ] **Step 5: Run the new storage tests and `tests/postgres-db.test.ts`; inspect the migration/grants, then commit `feat: persist Stripe-first enrollment state`.** Record exact exported contracts for later tasks.

### Task 2: Anonymous Checkout, authoritative reconciliation and billing recovery

**Files:**
- Create: `src/lib/mca/onboarding/checkout.ts`, `reconcile.ts`, `billing.ts`, `maintenance.ts`, `tests/onboarding-checkout.test.ts`, `tests/onboarding-reconciliation.test.ts`.
- Modify: `src/lib/mca/billing.ts`, `billing-operations.ts`, `trial-abuse.ts`, `src/app/api/webhooks/stripe/route.ts`. Create a focused `src/lib/mca/billing-customer-binding.ts` if needed to share legacy/enrollment customer-provenance validation.

**Interfaces:**
- Consumes Task 1's records, offer and atomic activation/intents.
- `startEnrollmentCheckout(input: { resumeSecret: string; initiatingProviderUserId?: string }, client?: StripeBillingClient): Promise<{ enrollmentId: string; checkoutUrl: string }>`.
- `reconcileEnrollment(id: string, client?: StripeBillingClient): Promise<EnrollmentRecord>`; `captureEnrollmentStripeEvent(event: Stripe.Event): Promise<{ handled: boolean; enrollmentId?: string }>` durably schedules work before tenant binding.
- `runEnrollmentMaintenance(options?: { limit?: number; deadlineMs?: number; client?: StripeBillingClient }): Promise<{ checked: number; repaired: number; operatorRequired: number; errors: string[] }>` joins the existing billing runtime.
- `attachEnrollmentBilling(db: DbExecutor, workspaceId: string, enrollment: EnrollmentRecord): Promise<void>` consumes only previously provider-verified state; no Stripe network call inside company finalization.
- `createEnrollmentBillingPortal(enrollment: EnrollmentRecord, client?: StripeBillingClient): Promise<string>` and `compensateEnrollment(id: string, client?: StripeBillingClient): Promise<void>` are internal functions; Task 3 supplies authentication/authorization.
- Extract a reusable identity-based trial-eligibility helper from `trial-abuse.ts` while preserving `trialAllowedForOwner` semantics and lock ordering. Final claim checks and records owner/email/domain history, reservations and card-review evidence atomically.

- [ ] **Step 1: Write mocked-provider/database tests.** Assert server price/quantity `1`, required card and `trial_period_days: 14` despite override variables; business name/email collection; tax/promotion preservation; no local trial on abandonment; concurrent start and lost create response do not duplicate; configured price mismatch fails closed; known ineligibility never produces paid fallback. Assert early, duplicate and reordered webhooks converge; wrong account/mode/customer/price/session/signature cannot activate; delayed claim keeps exact provider dates; subscription expiry uses existing access rules. Assert unknown acceptance after provider idempotency retention requires reconciliation/operator action rather than a fresh create.
- [ ] **Step 2: Run both test files and record their failing assertions before implementation.**
- [ ] **Step 3: Implement Checkout and provider validation.** Stripe 22.6.0 supports `name_collection: { business: { enabled: true, optional: false } }`; read `collected_information.business_name` with validated `customer_details.business_name` fallback. Preserve configured tax calculation and required address collection, but omit tax-ID collection because the approved flow collects EIN only in Fundlane's secure form. Verify the authenticated Stripe account against an explicitly configured expected account ID as well as mode/catalog; document this nonsecret rollout requirement without changing any hosted setting. Persist generation/idempotency identity before calls; perform provider calls outside finalization transactions. Reuse compatible open sessions; replace only after verified expiration. Require actual 14-day provider dates, accepted payment-method setup and catalog/customer association before activation. A Checkout redirect/session ID never authenticates or grants access.
- [ ] **Step 4: Implement event capture, reconciliation, projection and maintenance.** Enrollment recognition precedes the existing workspace-only webhook branch; preserve the old branch for existing tenants. Provider-read failure retains durable retry and local expiry. Capture signed events before customer binding; repair by provider reads rather than trusting event order. Use enrollment repair fields/leases rather than generic background jobs that require a workspace. Billing projection uses existing entitlement/invoice validation, preserving original subscription history and never resuming paused trials on status reads. Store provider dates in enrollment, Stripe entitlements and trial grants; leave `company_subscription_state.trial_started_at` and `trial_ends_at` NULL to prevent legacy local-trial fallback. Existing company billing/portal must accept a Checkout-created customer only through an exact committed enrollment-to-workspace/customer association; preserve legacy `customer.metadata.workspace_id` checks for legacy customers. Do not mutate Stripe metadata inside finalization or add another scheduler.
- [ ] **Step 5: Write and pass compensation/recovery tests.** Before charging, cancel only the exact redundant enrollment subscription after provider ownership and trial-state checks. If invoice/payment or conversion has started, or cancellation acceptance is unknown, create an auditable operator-required state; no refund or existing-subscription mutation. Valid unclaimed trials retain disclosed renewal terms. Assert portal customer isolation and no browser-supplied provider IDs.
- [ ] **Step 6: Run the new tests plus `billing-webhook-async.test.ts`, `billing-onboarding.test.ts`, `billing.test.ts`, `billing-test-clock-acceptance.test.ts`; commit `feat: reconcile pre-company Stripe trials`.**

### Task 3: Verified identity claim, atomic company creation and recovery routes

**Files:**
- Create: `src/lib/mca/onboarding/claim.ts`, `auth.ts`, `http.ts`, `recovery.ts`; route handlers under `src/app/api/enrollment/{session,start,status,auth,verify,claim,billing}/route.ts`; `src/app/api/platform/onboarding/[id]/route.ts`; `tests/onboarding-claim.test.ts`, `tests/onboarding-auth.test.ts`, `tests/onboarding-recovery.test.ts`.
- Modify: `src/lib/mca/auth-navigation.ts`, `supabase-auth.ts` only for shared safe provisioning primitives, `src/app/auth/callback/route.ts`, MFA continuation components/routes and `src/proxy.ts` as required by narrowly scoped public endpoints.

**Interfaces:**
- `claimEnrollment(input: { enrollmentId: string; identity: SupabaseIdentity }): Promise<{ workspaceId: string; destination: string }>`; this function revalidates live verified identity/MFA, exact email and initiating-identity binding, trial policy, and claim ownership.
- `readEnrollmentStatus(input: { enrollmentId: string; resumeSecret?: string; identity?: SupabaseIdentity }): Promise<EnrollmentPublicStatus>` exposes only `state`, `nextAction`, authorized `trialEndsAt`, and authorized local `destination`; never contact, EIN, secrets or raw provider objects.
- `requestEnrollmentAuthentication(input: { enrollmentId: string; email: string; resumeSecret?: string }): Promise<void>` gives an account-neutral result and issues only a bounded enrollment-scoped challenge for a verified activation.
- `verifyEnrollmentAuthentication(input: { challengeId: string; email: string; token: string }): Promise<{ destination: string }>` uses the correct Supabase email OTP/sign-in contract, then existing session/MFA flow.
- `recoverEnrollmentContact(actor: SuperAdminActor, input: { enrollmentId: string; verifiedProviderUserId: string; reason: string; purchaseEvidence: string }, request: Request): Promise<void>` requires fresh platform step-up and independent reviewed identity/purchase evidence. It is restricted to an unclaimed enrollment, rotates resume capabilities and mail generation, and never merges Auth identities or transfers an existing workspace.
- `authorizeEnrollmentContactVerification(actor: SuperAdminActor, input: { enrollmentId: string; correctedEmail: string; reason: string; purchaseEvidence: string }, request: Request): Promise<void>` authorizes a bounded verification challenge after operator purchase-proof review when the corrected address has no Auth identity yet. The new email must be verified normally, followed by separate operator approval through `recoverEnrollmentContact`; challenge authorization itself cannot claim or change the owner/contact.

- [ ] **Step 1: Write identity and HTTP tests.** Assert verified email match without a live session is insufficient; banned/revoked/migration-pending identities fail; password/Google/OTP continuations retain only an opaque enrollment/local destination; existing magic-link endpoint remains flag-gated and `shouldCreateUser:false`. Test matching existing password account, new account, legacy email collision, invitation placeholder, wrong Google email, expired/cross-device challenge, CSRF, enumeration resistance and rate limits.
- [ ] **Step 2: Run the new tests and record expected failures.**
- [ ] **Step 3: Implement enrollment authentication and route boundaries.** `session` bootstraps a Secure/HttpOnly/SameSite browser binding before enabling the trial button; `start` uses that same binding and rejects untrusted origins; `status` is read/reconciliation only; claim is an explicit mutation. No GET from an email scanner consumes a claim or provisions a company. Use bounded opaque auth challenges, restricted callbacks, generic auth responses and existing shared rate limits. Email supplied at Checkout is correspondence, not authentication. Security email is separate from the two onboarding messages.
- [ ] **Step 4: Implement atomic claim/finalization.** Revalidate identity and required MFA; acquire deterministic enrollment and owner/trial locks; link Auth through existing anti-takeover rules; create one workspace/admin membership/owner/billing mapping/SMS company in one transaction; initialize SMS verification from Auth; use Task 2's verified projection and immutable dates without calling `initializeCompanyTrial`. Reject existing operational company/ineligible trial into compensation/recovery rather than silently granting a duplicate. Use enrollment ID, not company name, as idempotency. Set active workspace only after membership validation.
- [ ] **Step 5: Implement billing/contact/operator recovery and fault tests.** Authenticated matching claimant can manage/cancel the enrollment before tenant finalization, subject to MFA and purchase association. Operator path uses `requireSuperAdmin`, strict trusted mutation, actor rate limits, `requirePlatformStepUp` and atomic `withSuperAdminAction` audit; require evidence and a verified target Auth identity, reject claimed/foreign ownership, suppress superseded unsent mail without replaying uncertain sends. Test the two-stage corrected-address verification case for a brand-new user; neither purchase-proof review nor email verification alone completes correction. Test transaction failures at every durable boundary and competing claimants; assert no partial grants and unchanged existing subscriptions/platform grants.
- [ ] **Step 6: Run new tests plus `supabase-auth.test.ts`, `supabase-auth-http.test.ts`, `auth-oauth-mfa.test.ts`, `platform-super-admin-auth.test.ts`, `invitation-profile-isolation.test.ts`, `company-ownership.test.ts`; commit `feat: securely claim Checkout enrollments`.**

### Task 4: Two independent onboarding service emails

**Files:**
- Create: `src/lib/mca/onboarding/email-content.ts`, `email-transport.ts`, `email-worker.ts`, `tests/onboarding-email.test.ts`.
- Modify: `src/lib/mca/comms/scheduler.ts`, `src/lib/mca/system-email.ts` only for an explicitly selected frozen provider; Task 3 operator route/recovery service for evidence-based email resolution/reissue.

**Interfaces:**
- `renderOnboardingEmail(input: { purpose: "business_information_requested" | "getting_started"; enrollmentId: string; generation: number; trialEndsAt: string; origin: string }): { subject: string; text: string; html: string }`.
- `runOnboardingEmails(options?: { limit?: number; deadlineMs?: number; clock?: string }): Promise<{ attempted: number; accepted: number; uncertain: number; suppressed: number }>`.
- `recordOnboardingEmailEvidence(actor: SuperAdminActor, input: { emailId: string; outcome: "accepted" | "delivered" | "failed" | "suppressed"; evidence: string; providerMessageId?: string }, request: Request): Promise<void>` requires fresh step-up; evidence resolution does not authorize automatic replay.

- [ ] **Step 1: Write delivery tests.** Assert two stable intents exist before tenant creation and browser return; exact distinct subjects; secure auth-required links, no EIN and “do not reply with EIN”; welcome contains sender → own-address test → default sender → explicitly initiated safe submission and authoritative trial end. Renewal/seat change/login do not regenerate emails. One failure does not block CRM or the other email.
- [ ] **Step 2: Run the tests and record failures before implementation.**
- [ ] **Step 3: Implement frozen service-message content and transport.** Initial recipient comes from provider-confirmed enrollment contact; freeze encrypted recipient/content/template/provider/from/key before dispatch. Use existing webhook/system transport without document-notification membership or unsubscribe rules. Select the exact frozen provider on retry; reject a changed/unavailable provider instead of silently switching. Preserve bounce/complaint/address suppressions. No privileged portal or Auth session token appears in mail.
- [ ] **Step 4: Implement fenced dispatch, evidence and repair.** `FOR UPDATE SKIP LOCKED`, lease tokens and persisted sending markers; expiry/unknown acceptance → uncertain, never automatic resend. Known transient non-acceptance retries at 15/30 minutes, maximum three attempts. Preserve accepted versus delivered distinction; provider receipt lookup only where actually supported, otherwise audited operator evidence. Reissue after authorized address correction uses a new generation and invalidates superseded links. Integrate one consumer into comms with the existing deadline and flag.
- [ ] **Step 5: Run killed-worker/lost-response/lease-reclaim/frozen-provider/duplicate-receipt tests and existing `notifications.test.ts`, `transactional-email.test.ts`; commit `feat: deliver durable onboarding service emails`.**

### Task 5: Secure business basics and honest setup readiness

**Files:**
- Create: `src/lib/mca/onboarding/business-profile.ts`, `readiness.ts`, `src/app/api/mca/onboarding/business/route.ts`, `src/app/api/mca/onboarding/readiness/route.ts`, `src/components/mca/onboarding/business-details-form.tsx`, `getting-started-checklist.tsx`, `src/app/(dashboard)/settings/business/page.tsx` (use actual dashboard route group), `tests/onboarding-business-profile.test.ts`, `tests/onboarding-readiness.test.ts`.
- Modify: `src/lib/mca/sms/onboarding.ts`, applicable full-registration form, `src/lib/mca/senders/service.ts` and sender test endpoint/UI, setup/dashboard integration and settings navigation.

**Interfaces:**
- `getBusinessBasics(actor: DealActor): Promise<{ legalName: string; einPresent: boolean; revision: number; registered: boolean }>`.
- `saveBusinessBasics(actor: DealActor, input: { legalName: string; ein: string; expectedRevision: number }): Promise<{ legalName: string; einPresent: true; revision: number }>`.
- `businessBasicsForRegistration(actor: DealActor, expectedRevision: number): Promise<{ legalName: string; ein: string } | null>` is server-internal and used only to compose the full validated profile; it is never a public status response.
- `getOnboardingReadiness(actor: DealActor): Promise<{ businessDetails: "missing" | "supplied" | "registered"; sender: "missing" | "configured" | "preview" | "accepted" | "received"; defaultSender: boolean; safeSubmission: "unavailable" | "ready" | "accepted"; trialEndsAt: string | null }>` derives facts and never changes access.

- [ ] **Step 1: Write profile/readiness tests.** Assert prefilled name, name 2–150 characters and EIN `^\d{2}-?\d{7}$`; encryption and no EIN in routine response/audit/error; CAS rejects stale updates; foreign tenant/member/API-key/CSRF/disabled integrations/MFA/billing-pause requests fail. Existing registered profiles count as supplied without re-entry and cannot be silently overwritten. Basic save leaves SMS `profile_cipher`/review/provider state untouched.
- [ ] **Step 2: Run tests and record failures.**
- [ ] **Step 3: Implement profile authorization, storage and UI.** Require verified session, active matching workspace, admin/super_admin, effective integrations feature/page permission and applicable MFA/operational access. Mask EIN after save; do not persist it client-side. Full phone/SMS form composes saved basics server-side and still validates every existing registration field/approval; preserve billing-recovery allowlist and all number/SMS/consent/budget gates.
- [ ] **Step 4: Implement readiness and sender evidence.** A preview response must not mark live delivery verified. Persist accepted test evidence separately; confirmed receipt is explicit customer evidence, accurately labeled rather than inferred from provider acceptance. Own-address test requires controlled recipient confirmation. Checklist links to existing setup pages, is dismissible/resumable, and never sends, creates a deal/funder, submits documents or buys a number on load. Use existing sandbox/synthetic submission route and show prerequisites when unavailable.
- [ ] **Step 5: Run new tests and `sms-onboarding.test.ts`, `workspace-setup-readiness.test.ts`, applicable sender/submission tests; commit `feat: add progressive business setup and readiness`.**

### Task 6: Public Login, pricing, Checkout completion and CRM entry

**Files:**
- Create: pricing page/components using actual marketing route group; `src/app/(auth)/enrollment/page.tsx`, enrollment completion/auth client components; `tests/onboarding-navigation.test.ts`.
- Modify: marketing navigation/footer/CTA modules, sign-in form/page, sign-up routing, owner-safe onboarding continuation, CRM dashboard/setup placement and relevant auth UI tests.
- Repair baseline test fixtures in `tests/legal-drafts.test.ts`, `marketing-site.test.ts`, `public-roadmap-page.test.mjs`, `public-roadmap.test.mjs`, `public-status-page.test.mjs`, `public-status-probe.test.mjs`: replace unsupported `mock.module` `exports` options with supported `namedExports`/`defaultExport`, preserving behavior assertions.

**Interfaces:**
- Consume Task 3's route response types and Task 5's readiness/profile endpoints. Only allowed enrollment destinations are CRM, business details and enrollment billing recovery. Email locators are navigation hints, never authority.
- Public path: **Login → existing-user auth**, **Get Started → pricing → Start 14-day free trial → Stripe → necessary secure completion → CRM**.

- [ ] **Step 1: Write navigation/rendering tests.** Assert Login/Get Started desktop/mobile/footer separation, no mandatory account/company/seats step before Stripe, email/Next and Google login with account-neutral errors and no second signup form, and correct authorized post-auth destinations. Assert clear unavailability without paid/no-card fallback when rollout/config is off.
- [ ] **Step 2: Run tests and record failures.**
- [ ] **Step 3: Implement marketing/pricing/login.** Pricing uses the existing catalog and discloses USD 399/month first user, exactly 14 days, required card, automatic conversion unless canceled, with Stripe's applicable first-charge date at completion. Disable repeated start while browser binding/Checkout is pending; show retryable errors. Preserve normal password/recovery/Google/MFA and migrated/invited account paths.
- [ ] **Step 4: Implement completion and resumable entry.** Bounded polling calls server confirmation; authentication is the only necessary post-Checkout step, followed by an explicit claim mutation. Support refresh/back, cross-device login, wrong account, expired challenge, slow webhook, original trial clock and billing management before tenant creation. Existing owner default `/platform` and explicit company intent remain intact. CRM checklist and basic form are optional; no forced invitations/modal/test sends.
- [ ] **Step 5: Verify accessible labels/focus/loading/mobile states, rendered routes and mocked browser navigation.** Do not enter credentials or submit a live Checkout. Run relevant auth/marketing/navigation regressions, then commit `feat: streamline Stripe-first onboarding entry`.

### Task 7: Integrated acceptance, operator visibility and release evidence

**Files:**
- Create: `tests/onboarding-acceptance.test.ts`, `docs/stripe-first-onboarding.md`, `docs/acceptance/auth-refractor.md`.
- Modify: operator onboarding recovery/status UI under existing `/platform`, `docs/background-job-runtime.md`, `../WORKSPACE_NAVIGATION.md`, spec status and plan checkboxes; generated Graphify artifacts only after verifying expected changes.

**Interfaces:**
- Operator views expose sanitized enrollment age/state, stalled repairs, pending compensation, email accepted/uncertain/error evidence and safe recovery actions from Tasks 3/4. They never show EIN/raw provider payloads or grant authority through a tenant role.
- Runtime evidence distinguishes disabled/no work/attempted/accepted/received, and records which existing scheduler owns billing repair and comms dispatch.

- [ ] **Step 1: Write integrated fault and old-tenant regression tests.** Map spec A01–A20 to actual tests; exercise delayed webhook plus closed browser, concurrent claim/finalization fault, late conversion, cancellation during setup, failed/uncertain email, creation-flag rollback with pending enrollment, existing registered tenant and platform owner. Fill any deterministic acceptance gap with a failing test before its fix.
- [ ] **Step 2: Implement remaining operator visibility and safe recovery UI; document exact migration/flags and rollback order.** Keep public activation off until migration/grants, runtime ownership, Auth callbacks/templates and provider acceptance are verified. Preserve historical scheduler evidence as historical; install no duplicate schedule.
- [ ] **Step 3: Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build` with task-owned local configuration.** Run the existing monitor build/generated-artifact check and Deno check required by CI. Record exact counts, commands, failures and environment limits. No hosted acceptance is inferred from mocks.
- [ ] **Step 4: Run `graphify update .` then `graphify cluster-only . --no-label`; inspect graph changes and any shrink warnings.** Update navigation only for actual new ownership.
- [ ] **Step 5: Obtain independent whole-branch code/security review, address findings with regression tests, and run covering checks on the final head.** Review verified identity/MFA, tenant isolation, secret handling, trial/payment policy, external-send fencing and rollback.
- [ ] **Step 6: Commit acceptance evidence, fetch current main and resolve only in-scope conflicts, push this feature branch and open DRAFT PR `auth-refractor`.** PR includes approved spec/plan, migration impact, tests, no-production scope and precise hosted acceptance gates. Verify published SHA, CI and available preview; fix recoverable in-scope failures. Do not merge/manual-deploy or change provider credentials/settings.

## Self-review and acceptance mapping

Inline self-review completed: scope, task steps, interface names/types, the five Review Focus cases and proportion checked. Clarified business-name SDK fields, tax calculation without Stripe EIN collection, account verification, legacy-trial fallback prevention and new-user contact-recovery verification. Storage/activation/claim/mail boundaries are sequential; shared-file changes are reviewed before the next task. The full release remains one coordinated subsystem.

| Spec acceptance | Owning tasks |
| --- | --- |
| A01–A02 public UX/offer | 2, 6 |
| A03–A06 provider timing, authority, idempotency, browser loss | 1, 2, 7 |
| A07–A10 identity, MFA, eligibility and atomicity | 2, 3, 7 |
| A11–A12 email intent and uncertain delivery | 1, 4, 7 |
| A13 CRM admission independent of setup/mail | 3, 5, 6, 7 |
| A14–A17 profile security, communications gates and safe readiness | 5, 7 |
| A18–A20 old tenants, expiry, rollback and runtime evidence | 2, 3, 4, 7 |

Hosted gates remain explicit: approved nonproduction Supabase Auth/Google/MFA callback and email-template verification, controlled Stripe Checkout and invoice/renewal timing, both controlled own-address emails with actual receipt evidence, interruption recovery, exact scheduler ownership, restricted DB grants and approved preview configuration. This coding instruction authorizes mocks/local tests and PR publication, not those live/provider actions.

Baseline evidence: Node24.7/pnpm11.1.2 on unchanged application source produced 1,912 passed, six failed and one skipped tests. The six failures are unsupported `mock.module(..., { exports: ... })` fixture options, not application failures. Task6 corrects these options without weakening assertions. Baseline typecheck passed; lint had zero errors/16 warnings; default build was interrupted after5m17 with no compiler diagnostic. Final checks must report their own actual outcomes.

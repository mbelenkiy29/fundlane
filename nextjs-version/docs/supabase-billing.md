# Company subscriptions

## Contract and migration

One monthly USD plan: **$399 including the first user**, graduated additional users 2–10 at $79 each, 11–20 at $69 each, 21+ at $59 each. Active and pending memberships reserve seats. The public `monthlyPriceCents(seats)` function quotes the total. New companies receive a no-card, app-managed 14-day trial capped at five users including the owner. Early checkout charges immediately; no Stripe trial is created.

These are the current engineering catalog amounts, not an approved launch pricing decision. All application and Stripe setup price amounts live in `src/lib/mca/billing-catalog.ts`; owner approval is pending in #79. Change the catalog only after that decision is recorded, then provision new Stripe Price objects and update the configured price IDs through a reviewed release.

Onboarding must call `initializeCompanyTrial(workspaceId, selectedSeats, executor?)` inside company creation. Also re-exported by `billing.ts`. Repeated initialization is a no-op; database triggers protect original trial start/end. Operator extensions use a separate field.

Apply **0047_company_subscriptions**, preserving 0046_company_ownership, then **0048_billing_recovery** before deploying recovery code, plus the existing runtime-security release step. Migration 0047 explicitly backfills all existing companies as `legacy_exempt=1`; it never starts a trial, creates a customer or charges them. Migration 0048 adds the durable processing-extension grant marker and backfills existing extensions. Missing state retains legacy access for older creation paths; production onboarding must initialize trials. Verified paid conversion removes exemption. Historical Clerk/Stripe rows are retained. Unknown historical Stripe prices require an explicit operator migration rather than silent contract conversion.

## Provider configuration

```dotenv
MCA_STRIPE_BILLING_ENABLED=true
MCA_STRIPE_MODE=test
STRIPE_SECRET_KEY=rk_test_...
STRIPE_BASE_PRICE_ID=price_...
STRIPE_ADDITIONAL_SEAT_PRICE_ID=price_...
STRIPE_BILLING_WEBHOOK_SECRET=whsec_...
STRIPE_BILLING_PORTAL_CONFIGURATION=bpc_...
MCA_APP_ORIGIN=https://your-app.example
CRON_SECRET=...
MCA_EMAIL_WEBHOOK_URL=https://your-email-receiver.example
MCA_EMAIL_WEBHOOK_TOKEN=...
# Billing-only fallback when no email webhook is configured:
MCA_USESEND_API_KEY=...
MCA_USESEND_FROM=Fundlane <billing@your-verified-domain.example>
```

For production deliberately switch `MCA_STRIPE_MODE=live`, with matching live key, prices, portal and signing secret. Keys and all provider objects are mode-checked. Price IDs and secrets remain server-side. STARTER/TEAM variables are retired.

**Existing test companies require an explicit operator cutover.** 0047 adds `workspace_stripe_customers.livemode`, backfilled to 0 because the preceding implementation was test-only. A mapping in the other mode produces `billing_mode_cutover_required` before customer reuse or subscription reconciliation. It is never deleted, replaced, or silently charged. Cached legacy access is retained. `GET /api/billing` exposes `modeCutoverRequired`; platform company lists expose `stripe_livemode`. Merely changing environment keys is not a customer migration. Before activation, an operator must agree the affected companies and target mode, archive old identities/projections, and perform a reviewed mapping/entitlement migration with verified target customers and owner consent for paid conversion. There is deliberately no automatic cross-account customer migration endpoint.

Create two active licensed monthly USD prices, interval_count 1, no quantity transform:

1. Base: per-unit 39900 cents, subscription quantity one.
2. Additional seats: **graduated** tiers: quantity through **9** = 7900 cents; through **19** = 6900 cents; infinity = 5900 cents; no flat amounts. These are additional-seat quantities, not total users. Omit the item when total seats is one.

Runtime validates actual prices and expanded tiers. Portal must enable payment method updates, invoices and cancellation **at period end**, with subscription updates **disabled**; application seat changes enforce payment and occupancy constraints. Portal configuration is verified live when opened.

### Checkout configuration and compatibility (task 4.1)

New company-subscription Checkout requests explicitly set `subscription_data.billing_mode.type=flexible`. The flow identifier is `fundlane_company_subscription_ndmotxpw`: its eight-letter suffix was randomly generated once and is fixed in source, not regenerated per request. Onboarding and Settings use the same subscription flow and identifier; it contains no company/customer data. Existing subscriptions and reused open Checkout sessions are not migrated.

Reviewed with Stripe CLI 1.51.1 on 2026-09-21 against installed `stripe` 22.6.0 types and API `2026-08-26.dahlia`:

- [Checkout create](https://docs.stripe.com/api/checkout/sessions/create): `integration_identifier` is a reusable string (maximum 200 characters); flexible mode is nested under `subscription_data.billing_mode`. Checkout keeps dynamic payment methods and the app-managed trial.
- [Billing mode](https://docs.stripe.com/billing/subscriptions/billing-mode): flexible mode supports this API version. A schedule created with `from_subscription` inherits the subscription's mode; supplying `billing_mode` with it is an error. Seat updates/schedules therefore omit mode changes, preserving both classic and flexible subscriptions.
- [Pending updates](https://docs.stripe.com/billing/subscriptions/pending-updates): paid increases retain `pending_if_incomplete` plus `always_invoice`. Pending updates require automatic collection and a supported payment method. Real configured methods, SCA, failed payments and successful settlement must be exercised in task 4.2; SDK fixture contracts alone do not prove provider acceptance.
- Catalog review: `scripts/stripe/setup-catalog.ts` creates the existing licensed monthly USD base and graduated additional-seat prices; `verifyBillingPrices` checks the actual prices/tiers. Billing mode belongs to subscriptions, so no price changes are needed. The dedicated Portal configuration permits payment methods, invoices and period-end cancellation and disables subscription updates, matching the runtime validator.
- **Portal constraint and application fallback:** [Portal limitations](https://docs.stripe.com/customer-management#limitations) state that customers cannot update or cancel subscriptions with a scheduled update. The application therefore exposes **Cancel at period end** directly in Plans & Billing, including while paused and while a reduction is pending. The authenticated application path below fulfills R5.1; task 4.2 still verifies real-provider behavior and R6.1 compatibility.

Tax activation remains dependent on merchant registrations/settings; this Checkout change does not enable automatic tax.

Restricted keys require customers read/write; subscriptions read/write; subscription schedules read/write; prices read; Checkout read/write; portal configurations read and sessions write; invoices read/write (collection controls and missed-month finalization), invoice payments and payment intents read. InvoicePayment reads must support both invoice and payment-intent allocation filters. Catalog provisioning separately needs product/price and Portal configuration writes.

The required `/api/webhooks/stripe` event set for live cutover is `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.paused`, `customer.subscription.resumed`, `customer.subscription.trial_will_end`, `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`, and `invoice.finalized`. `invoice.upcoming` is optional. Keep the refund/dispute events listed below. Endpoint registration and live delivery evidence belong to cutover issue #43; no account setting is changed by this code. Leave Stripe's own “3D Secure required” and failed-payment customer emails off while these owner notices are active to avoid duplicate messages; revisit this as an operator decision at cutover.

The webhook verifies the raw-body signature and mode, inserts an event-id receipt, queues one `billing_reconcile` background job, and queues invoice notices in one short database transaction. Duplicate deliveries are no-ops. After commit, a newly recorded event starts a best-effort immediate Stripe reconciliation with a five-second deadline; success completes that queued job. A failure or timeout leaves the job queued for the ten-minute billing maintenance cron, which claims up to 100 jobs with row locks and ten-minute leases, coalesces jobs for the same company into one authoritative Stripe read, and retries failures with exponential backoff capped at one day. Jobs are never marked terminally failed by the general worker; that worker excludes this billing job kind. Expired leases are reclaimable. A failed reconciliation records an operational error and the cron returns HTTP 503 with error details, making platform status and `net._http_response` monitoring actionable. It does not derive seats or access from event payloads. A replay does not trigger another provider read, but periodic maintenance may independently refresh that company. The routine also rotates through up to 100 mapped companies for time-based billing maintenance, so monitor cron execution and backlog as the company count grows.

Refund/dispute projections additionally require **charges, refunds and disputes read**. Subscribe to `charge.refunded`, `refund.created`, `refund.updated`, `refund.failed`, and `charge.dispute.created/updated/closed/funds_withdrawn/funds_reinstated`. Their signed events resolve the charge customer and store a receipt; maintenance refreshes current provider state, including resolved disputes. This is accounting visibility only: no refund/dispute creation, automatic debt forgiveness, or automatic subscription cancellation is performed.

Optional Supabase Stripe Sync Engine tables are read-only and only used as a matching snapshot. They cannot independently grant seats. Application projections do not require Sync Engine installation.

## HTTP and service interfaces

Company billing routes use existing session membership authorization and trusted-mutation protection. Keep billing recovery routes reachable during operational suspension.

- `GET /api/billing`: cached billing, occupiedSeats, local `access`, `state` and verified `recovery` balance/invoices/pending status.
- `POST /api/billing/sync`: live reconciliation plus response above.
- `POST /api/billing/checkout`: `{ selectedSeats: integer >= 1, onboarding?: boolean }`.
- `POST /api/billing/seats`: `{ selectedSeats: integer >= 1 }`.
- `POST /api/billing/portal`: optional onboarding return flag.
- `POST /api/billing/cancel`: strict empty JSON object `{}`; owner/admin session, trusted origin, mapped company only. Returns `{ cancelAt: ISO-string | null, alreadyCanceled: boolean }` after fresh provider verification. This exact route is in the paused-company recovery allowlist; members, deactivated users and API keys cannot use it.
- `GET /api/cron/billing`: exact `Authorization: Bearer ${CRON_SECRET}`; missing secret fails closed.

HTTP selected quantity is capped at 100000. Checkout locks the company, uses stable Stripe idempotency keys, reuses identical open sessions, expires replaced sessions and refuses a second active/incomplete subscription or unresolved completed checkout. Checkout and seat changes reject quantities below active+pending usage and are audited.

`company-access.ts` exports:

```ts
getCompanyAccess(workspaceId: string): Promise<{
  allowed: boolean; status: string; reason: string | null; seatLimit: number;
  trialEndsAt: string | null; graceEndsAt: string | null; manualPaused: boolean;
}>
assertCompanyOperational(workspaceId: string): Promise<void>
assertCompanyOutboundAllowed(workspaceId: string, approvedAt: string): Promise<void>
initializeCompanyTrial(workspaceId: string, selectedSeats: number, executor?: DbExecutor)
```

The assertion throws `AppError(402, 'company_paused', ...)`. Gate reads are local-only and calculate expiration without cron. Application/auth integration wires broad routes and automation gates separately. Access seatLimit is the invitation ceiling including any pending reduction; billing's cached seatLimit remains purchased capacity.

For outbound workers, pass the durable user approval/creation timestamp to `assertCompanyOutboundAllowed`, never a lease/retry/last-sync timestamp. It first enforces current access, then rejects missing/invalid/future approval timestamps or approvals at/before `company_subscription_state.last_paused_at` with **409 `company_outbound_reapproval_required`**. The persisted boundary is monotonic, database-protected pause history, not billing freshness. Manual pauses capture it immediately. Trial conversion, grace recovery, late-paid renewals and observed cancellation gaps preserve the effective expired deadline even if workers were offline throughout. Timely payments observed late do not manufacture a pause; ordinary sync never advances the boundary. Fresh reapproval after recovery remains valid. Trial extensions keep five-user capacity even if an incomplete checkout cached a one-seat entitlement.

Increases use Stripe `pending_if_incomplete` and `always_invoice`: original items remain until proration is paid. Reconciliation also blocks capacity increases while unpaid invoices exist and requires paid invoice evidence for activation. Reductions use a next-renewal subscription schedule without proration. The lower pending ceiling constrains invitations immediately. A differing second reduction is refused until renewal. Membership records are never deleted by billing.

### Application period-end cancellation (R5.1)

`cancelBillingSubscription(workspaceId, actorUserId, client?)` shares the workspace lock with seat changes. It verifies the mapped customer's mode, complete subscription selection, subscription ownership and any attached schedule's customer/subscription/mode. Cancellation deliberately does not depend on paid access, catalog-price fetching or invoice reconciliation; unavailable payment verification must not obstruct a valid cancellation request.

- Ordinary subscriptions receive `cancel_at_period_end:true` with `proration_behavior:none`.
- Scheduled subscriptions receive one atomic schedule update: retain the current phase's prices, quantities, discounts, tax and payment settings, end it at the verified current period end, remove future phases, and set `end_behavior:cancel` with no proration. An already-earlier cancellation is never postponed. The pending reduction is superseded, rather than applied early. Both classic and flexible modes are retained.
- This chooses the [schedule update API](https://docs.stripe.com/api/subscription_schedules/update) and [final-phase cancellation behavior](https://docs.stripe.com/billing/subscriptions/subscription-schedules#complete-a-schedule), reviewed using Stripe CLI 1.51.1 / API `2026-08-26.dahlia` on 2026-09-21. The [release API](https://docs.stripe.com/api/subscription_schedules/release) documents `preserve_cancel_date:true` as keeping a cancellation the schedule **already set**. Releasing a reduction schedule and then updating the subscription would leave it renewing if the second call failed; that two-call sequence is not used. Setting only `end_behavior:cancel` while retaining the reduction phase would cancel one period too late; future phases are removed in the same mutation.
- Fresh subscription reads confirm the effective date before clearing local pending-seat fields or recording the actor-attributed `billing.cancellation_scheduled` audit. Stripe success followed by response loss or local rollback is repaired on retry from current provider state; no release operation occurs. Stable per-subscription/schedule/date keys survive failures, and the count of committed cancellation-request audits provides a new generation after a later Portal/operator reversal, without timestamp-ordering ambiguity.
- Cancellation does not write invoice balances, forgive debt, change collection pause, restart trials, or lift manual suspension. Existing service fees remain due through the effective date. Local purchased-seat entitlements remain unchanged; normal signed webhooks/maintenance reconcile effective cancellation. Seat changes reject both `cancel_at_period_end` and schedule-managed `cancel_at` so they cannot replace cancellation with a renewing schedule.

Local evidence: tests were added first and failed for the missing service. The 104-test billing/HTTP/display/company-pause suite passes against disposable local PostgreSQL on port 55439. SDK HTTP tests verify ordinary cancellation and scheduled cancellation payloads, preserved current seat fees and phase settings, and no release/future renewal phase. Tests also cover ordinary/scheduled lost-response recovery, repeat requests, provider failure/no-op, schedule identity mismatch, later reversal generations, paused owner/admin access, cross-company isolation, API-key/member/deactivated-user rejection, origin checks and retained debt/manual suspension. Real-provider test-clock advancement remains the parent task 4.2 acceptance responsibility.

## Grace, collection and recovery

The first unresolved attempted/due renewal anchors seven-day grace to the original invoice due/finalization time. A verified renewal PaymentIntent requiring action or processing also starts grace even when Stripe reports zero attempts. Initial Checkout authentication and benign unattempted renewal drafts do not start renewal grace. Retries and delayed webhooks never restart the deadline. Owner notification is enqueued transactionally. Before the seven-day cutoff, verified processing allocations covering every overdue invoice can grant one extension ending at original grace plus 48 hours. Identity, currency, mode and complete per-intent allocation budgets must match. Action-required payments do not qualify; failed or insufficient coverage revokes the active extension. The durable grant marker prevents another extension in the same episode, and an existing pause cannot be reopened by late processing.

At expiry the local gate denies app/automation. Reconciliation sets Stripe `pause_collection.behavior=keep_as_draft` and separately disables `auto_advance` on existing applicable open invoices. These controls are rechecked against provider state on every reconciliation. Existing in-flight payments cannot be recalled. Missed-month drafts with verified original subscription service periods are finalized with `auto_advance:false`, producing payable invoice links without automatic catch-up charges. Monthly fees continue through effective cancellation. Unknown draft periods block recovery instead of authorizing a monetary mutation. Recovery requires full settlement of the original delinquent invoice and all applicable outstanding/missed-month debt before clearing collection pause/grace. Voiding or marking debt uncollectible is not payment. Manual pause always survives recovery; paying old debt never recreates a canceled subscription.

The billing GET exposes a customer/mode-scoped recovery snapshot of verified Fundlane invoices, rather than unrelated customer accounting invoices. Failed verification retains the last verified balance with `verificationPending:true`. Failure markers are persisted after the outermost transaction rolls back, including webhook transactions; a failed reconciliation never leaves a false newly-verified balance. The UI displays invoice-specific hosted payment links and treats return-page redirects as non-authoritative.

Cancellation does not restart trials. Access ends at the cached verified current-period boundary even when cron/webhooks are delayed. Immediate cancellation denies access when reconciled. Legacy exemptions and explicit operator extensions are separate deliberate access grants.

Supabase `pg_cron` job `fundlane-billing-maintenance` runs every ten minutes and calls the endpoint through `pg_net`. Its bearer credential is stored in Vault as `fundlane_billing_cron` and matches Vercel's sensitive `CRON_SECRET`. Vercel Hobby does not support this frequency, so `vercel.json` has no cron. Maintenance claims billing reconciliation jobs, rotates up to 100 companies, enqueues trial notices and drains notifications. Monitor both cron execution and `net._http_response`: a successful SQL job alone does not prove the HTTP request succeeded. Provider-side collection pause requires successful reconciliation, although local access expiry does not. See `auth-subscription-rollout.md` for deployment evidence.

Notifications are at-least-once: SKIP LOCKED row claims, five-minute leases, exponential retries capped at one day, stable event correlation IDs, no silent discard. The email receiver must deduplicate correlation IDs. Recipient is the currently assigned company owner; missing ownership/transport remains a visible retryable failure. Preview mode is never marked delivered. Existing `operations_alert` template receives `data.kind`: renewal_payment_failed, billing_paused, billing_recovered, trial_ending, trial_ended, payment_action_required or payment_failed, plus the billing recovery URL. Invoice notices use an invoice-id outbox key. The action-required notice includes Stripe's hosted invoice URL; the failed-payment notice links to Plans & Billing with a portal action hint, which creates a fresh authenticated Portal session after the owner opens the page. No Portal session URL is stored in email.

When `MCA_EMAIL_WEBHOOK_URL` is absent, the billing-specific `deliverBillingEmail` helper uses `MCA_USESEND_API_KEY` and `MCA_USESEND_FROM` with the existing UseSend adapter. It sends escaped HTML plus plain text and concrete billing subjects through [`POST /api/v1/emails`](https://docs.usesend.com/api-reference/emails/send-email), using the outbox ID as `Idempotency-Key`. This fallback does not change general application email delivery. The outbox freezes recipient, transport, From address, event payload and rendered UseSend subject/text/HTML before its first send; retries do not switch transports or silently change recipient, and deployments cannot change a pending message's provider body. Missing production configuration never produces a successful preview.

UseSend guarantees same-key/same-body deduplication for **24 hours**, not indefinitely. Direct sends have a frozen 23-hour retry window; unresolved sends beyond it remain undelivered with `billing_delivery_review_required`, and are not automatically resent after provider deduplication expires. Check provider delivery before deliberately reissuing such an event. A verified sender domain and usable API key are external activation requirements; no real email is sent by tests.

Billing audit events cover trial creation, verified entitlement/period/seat changes, legacy conversion, invoice/payment changes, grace start, processing extension/revocation, collection pause, recovery, pause boundaries, seat reduction application and refund/dispute state changes. Unchanged reconciliations do not create duplicate state-change audit entries. Manual operator mutations and requested seat changes retain actor-attributed audit records. Provider subscriptions are re-read immediately after changing collection pause so the returned `paymentPastDue` flag reflects current provider state.

## Platform console services and schema

`billing-operations.ts` exposes trusted internal services. HTTP callers **must first call `requirePlatformAdmin()`** (operator grant plus AAL2); company roles never imply platform authority:

- `listPlatformCompanyBilling(limit = 100, offset = 0)` — company/subscription state and occupied count; max 200.
- `getPlatformCompanyBillingDetail(workspaceId)` — local access/state, `customer: { stripe_customer_id, livemode }`, latest 200 invoices/payments/**adjustments** and 100 notification statuses.
- `setPlatformCompanyAccess(workspaceId, actorUserId, { manualPaused?, accessExtendedUntil?: ISO string | null, reason })` — locked, audited, future timestamp validation; never rewrites trial dates.

New RLS-protected server-only tables:

- `company_subscription_state`: workspace PK; exemption, immutable trial dates, selected/pending seats/effective date, schedule ID, manual pause/reason, monotonic `last_paused_at`, operator extension, delinquent invoice/time, grace/processing deadline and collection-pause flag.
- `company_billing_invoices`: Stripe invoice PK, workspace/subscription, status/reason/currency, integer-cent due/paid/remaining, hosted URL, provider `paid_at`, period and sync timestamps.
- `company_billing_payments`: Stripe invoice-payment PK, `stripe_payment_intent_id`, invoice/workspace foreign keys, observed payment status, paid cents/currency, sync time.
- `company_billing_adjustments`: provider `id`, workspace, `kind` (`refund`/`dispute`), `stripe_charge_id`, `stripe_payment_intent_id`, `status`, integer-cent `amount`, `currency`, `reason`, `livemode`, `created_at`, `synced_at`. Join payment-intent IDs to payment rows for invoice association. Statuses are original Stripe statuses, including pending/succeeded/failed refunds and needs_response/won/lost disputes; these are not conflated with invoice payment status.
- `company_billing_notifications`: stable event ID, workspace, kind/data, frozen `delivery_payload`, attempts, next availability, lease, delivery time and last error.

Migration **0047** includes the subscription/projection tables and replaces the historical entitlement seat constraint `IN (1,5,20)` with `>=1`, allowing arbitrary paid seat quantities. It has been deployed; its contents must not change. **0048** is the additive recovery migration for `processing_extension_granted_at`. Consult `auth-subscription-rollout.md` for the current deployment checkpoint.

Existing workspace_stripe_customers, workspace_billing_entitlements and stripe_billing_events retain customer mappings, entitlement cache and webhook receipts. workspace_owners determines recipients.

## Verification

```sh
MCA_TEST_DATABASE_ADMIN_URL=postgresql://mbele@127.0.0.1:55439/postgres \
node --experimental-test-module-mocks --conditions=react-server --import tsx \
  --test --test-concurrency=1 tests/billing.test.ts
pnpm typecheck
pnpm lint
```

Before activation exercise actual Stripe test Checkout, successful/failed proration, renewal failure and processing, reduction schedule, period-end cancellation, signed retries and email receiver. Fixtures verify application logic, not provider account setup. Never use the application Supabase database for tests.

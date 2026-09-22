# Stripe billing recovery acceptance

## Status — task 4.2 remains open

The executable core runner is `scripts/stripe/acceptance-recovery.ts`. **Real-provider
runs 7 and 8 passed core acceptance; run 8 passed 19 checks including supplemental
SCA seat gating, classic billing mode and application cancellation.** Task 4.2 remains
open for the gaps below. The supplied restricted test key verified `GET /v1/account`
against the fixed account; no missing permission was observed. Default CLI credentials
were never used.

**Run 9 passed 21 checks**, extending the prior run with real-provider full settlement
while manually suspended and durable outbound reapproval after recovery. Run
`fundlane-recovery-0d51f443-8465-49a5-866d-576a9a409e78`, evidence
`recovery-core-real-9.json`, ended `passed-core`, `cleaned=true`. The platform access
service applied/removes the synthetic manual pause; actual Stripe payment and
reconciliation cannot remove it. An approval predating the pause receives 409 after
recovery; a new approval succeeds and remains valid after another provider sync.

### Real-provider evidence — 2026-09-21

Supplemental evidence is recorded in [stripe-webhook-delivery.md](stripe-webhook-delivery.md)
and [stripe-processing.md](stripe-processing.md). Those independent runners cover actual
HTTP signature delivery and genuine delayed-payment processing; the core runner alone
does not represent the complete acceptance result.

Private evidence files are `recovery-core-real-{1,...,8}.json` under the session's
approved private temporary `opencode/` directory. Latest passing run:

- Run: `fundlane-recovery-9433ff05-a4bc-4b60-a63a-dfb147abc571`
- Flexible subscription: `sub_1UIJUeBP3qJwlwmsf3OPDWx8`
- Missed invoice: `in_1UIJWKBP3qJwlwms5oO3XMaI`; $399.00 remained due,
  `auto_advance=false`, zero attempts after another simulated day.
- SCA PaymentIntent: `pi_3UIJWsBP3qJwlwms3tc0c8rm`, observed `requires_action`;
  unpaid seats remained unavailable. Replacing the method and paying restored capacity.
- Classic subscription: `sub_1UIJX8BP3qJwlwmsYkt84YZh`; paid increase and renewal
  reduction both preserved `billing_mode.type=classic`.
- Pending-reduction cancellation schedule: `sub_sched_1UIJXkBP3qJwlwmsIkHUE8r8`;
  application cancellation removed the future phase, honored the effective date and
  produced no renewal invoice. A separate paused subscription also canceled with no
  renewal; paying its existing debt afterward did not restore access.
- Real deletion event replayed twice: `evt_1UIJYfBP3qJwlwmszqjPy7so`; one receipt.
- Result: `passed-core`, 19 passing checks, `cleaned=true`.

Run history and provider constraints:

| Runs | Result / adjustment |
| --- | --- |
| 1–3 | Exposed production schedule bug: `from_subscription` cannot be combined with `metadata` (`req_2qb7hFqaCE602j`). Parent fixed creation/update separation; subsequent runs passed. |
| 4 | Sandbox Managed Payments defaults require a product tax code for Checkout (`req_XFj7R0TA33DJiz`). Synthetic product now uses provider-listed SaaS business-use code `txcd_10103001`; no account setting changed. |
| 5 | External 120-second tool timeout. Marked failed, manually cleaned clock/catalog and dropped its isolated DB. Portal default retention exception below. |
| 6 | Stripe permits only three customers per clock (`req_hSaVIQIQVfv9K2`). Runner now reuses the expired Checkout fixture for scheduled cancellation. |
| 7 | 16 checks passed, including both application cancellation cases, renewal reduction and actual event replay. |
| 8 | 19 checks passed, adding actual SCA-required seat gating and classic increase/reduction. |

Independent provider reads and local catalog queries verified every run's clock deleted,
product/prices archived, and database absent. Runs 6–8 also have their synthetic Portal
configurations deactivated. **One retained resource:** run 5 created the first Portal
configuration, `bpc_1UIJJ0BP3qJwlwmsl7EgLjrV`; Stripe automatically made it the sandbox
default and refuses `active:false` (`req_pDD0SKQNkJGyiM`). It remains active for owner
review; run 5 records `cleaned=false` and a cleanup warning. The runner now refuses to
create a disposable Portal configuration in an account with no pre-existing configuration.

The only DB endpoint used was disposable loopback port 55439. Credentials were loaded
with Node `--env-file` from a mode-0600 private file; values and hosted URLs were not emitted.

The runner fixes the destination to **`acct_1UIDeIBP3qJwlwms`**, uses Stripe 22.6.0 /
API `2026-08-26.dahlia`, and calls the real application's `syncWorkspaceBilling`,
`changeBillingSeats`, `cancelBillingSubscription`, `createBillingCheckout`,
`createBillingPortal`, `processStripeBillingEvent`, and local company access gate.
It creates a migrated, randomly named disposable PostgreSQL database using the
existing test helper. It does not require a running Next.js server for core checks.

## Prerequisites and execution

Run from `nextjs-version/` with Node 24+, installed dependencies and a **disposable
local PostgreSQL cluster** permitting database creation/deletion. Export credentials
through your private environment/secret manager, not command-line arguments:

```sh
export MCA_STRIPE_MODE=test
# Privately supply STRIPE_SECRET_KEY for the account above.
# Prefer rk_test_ with all required endpoint permissions.
export MCA_TEST_DATABASE_ADMIN_URL='postgresql://LOCAL_USER@127.0.0.1:55439/postgres'

node --conditions=react-server --import tsx scripts/stripe/acceptance-recovery.ts --help
node --env-file=/absolute/private/directory/fundlane-stripe-sandbox.env \
  --conditions=react-server --import tsx scripts/stripe/acceptance-recovery.ts \
  --apply --provision-synthetic-prices \
  --evidence=/absolute/private/directory/recovery-run.json
```

The evidence parent directory must already exist; the evidence file must not exist.
Choose an ignored/private location. Files are created with mode `0600`. The script
does not load `.env` or read Stripe CLI configuration. It requires a literal
`127.0.0.1` or `[::1]` Postgres host and rejects connection URL query overrides,
including `host`/`hostaddr`. No hosted disposable opt-in bypass is available.
`DATABASE_URL` and `DATABASE_URL_UNPOOLED` are replaced with the newly created local
database before application imports. Never point the local port at a production
database tunnel.

Before any DB or Stripe mutation, the SDK reads **its own** account (`GET /v1/account`)
and checks the fixed ID. Test-key prefixes and `MCA_STRIPE_MODE=test` are mandatory.
Required SDK access includes account reads; product/price reads and optional writes;
test-clock create/read/advance/delete; customer/payment-method/subscription/schedule
operations; invoice list/read/finalize/update/pay and line reads; InvoicePayment and
PaymentIntent reads; charge/refund/dispute reads used by reconciliation; event reads;
Checkout create/read/expire/line-item reads; Portal configuration create/read/list/update
and session creation. An existing sandbox Portal configuration is required so that the
disposable configuration cannot become the undeactivatable account default. A restricted
key missing a permission should fail, not trigger a CLI fallback.

By default, pass `--provision-synthetic-prices`: the runner creates an explicitly
tagged product and two prices matching the application's $399 base and graduated
$79/$69/$59 additional-seat catalog. It uses the existing `verifyBillingPrices`
validator; it does not alter shared lookup keys or the default Portal configuration.
Alternatively omit that flag and privately configure `STRIPE_BASE_PRICE_ID` and
`STRIPE_ADDITIONAL_SEAT_PRICE_ID` from the authorized sandbox's existing catalog.
The runner verifies and reuses these prices, and never archives reused catalog prices.

Sandbox dunning must allow the failed subscription to remain `past_due` through
the app's seven-day cutoff. An account configured to cancel immediately/on an earlier
retry can invalidate the scenario. The runner deliberately does not change account
retry settings. Check those settings with the provider owner before execution.
Tax registration/collection and live billing activation are separate acceptance work.
The runner does not explicitly enable automatic tax; the sandbox's existing Managed
Payments default applies to its uncompleted Checkout session. This is session serialization
evidence, not evidence of correct tax collection or a completed Managed Payments purchase.

## Automated core scenario

1. Create a uniquely named test clock, synthetic local owner/company, clock-backed
   Stripe customer and flexible monthly subscription. Pay the first invoice with
   `pm_card_visa`; verify real app access becomes active.
2. Replace the default method with `pm_card_chargeCustomerFail`. Advance through
   renewal, finalize the normal renewal if provider webhook settings leave it draft,
   and explicitly attempt its failing payment. Require an open, attempted invoice
   and the app's original grace deadline.
3. Advance to that exact deadline. Reconcile and assert access is denied, the old
   invoice has `auto_advance=false`, future collection is `keep_as_draft`, and another
   reconciliation preserves the original deadline.
4. Advance through another renewal. Require Stripe's own missed-period draft. Call
   app reconciliation and verify it becomes open/payable without changing its amount,
   with `auto_advance=false`, no paid amount and a hosted payment link. Advance another
   clock day and verify no added collection attempts or payment.
5. Restore Visa and pay only the original delinquent invoice. Reconcile and require
   access to remain paused while the missed-month balance is unpaid. This is **partial
   settlement across invoices**, not a partial-cent payment on a single invoice.
6. Pay the missed-month invoice. Reconcile and require eligible access to return and
   collection pause to clear only after all required invoices settle.
7. Set `pm_card_authenticationRequired` and request a seat increase through the app.
   Require an actual `requires_action` PaymentIntent and unchanged seat capacity.
   Replace the method with Visa and pay the invoice; require paid capacity. Schedule
   a reduction through the app; advance and verify local/provider capacity decreases.
8. Use `cancelBillingSubscription` for cancellation, retaining its effective date and
   asserting no renewal after clock advancement. Independently exercise cancellation
   while paused with unpaid debt, and cancellation with a pending seat reduction.
   Retry cancellation to verify the same effective date. Paying canceled debt cannot
   restore access. No direct SDK cancellation or schedule-release shortcut is used.
9. Poll for the real `customer.subscription.deleted` event, pass it twice to the app's
   processor, and require one durable event receipt and continued denied access.
   This verifies processor deduplication using a genuine provider event, **not** HTTP
    delivery or signature verification.

Before advancing the clock, the runner creates a real Checkout session using the app,
verifies selected price/quantity serialization and same-plan session reuse, then expires
it without opening the hosted flow. It creates a disposable Portal configuration and
calls the application's Portal function for both active and paused companies, retaining
only IDs. The third clock-backed customer is reused for independent cancellation because
Stripe limits each clock to three customers. The settled canceled customer's company is
reused for a new classic subscription to verify paid increases and renewal reductions.

Each clock advance polls at most 120 times, sleeping two real seconds between reads;
each SDK request has a 15-second timeout and at most one network retry. Event visibility
polling is capped at 30 reads of the latest 100 deletion events. Heavy concurrent
sandbox activity or unavailable events can fail that check; rerun in a quieter isolated
window rather than inventing an event. Allow at least a 600-second overall tool timeout
for the expanded sequence. Timeout is a failed run, never acceptance evidence.

Stripe test-clock time does not automatically change application time. This standalone
runner uses Node's `mock.timers` for **Date only**, setting it to each confirmed-ready
clock timestamp. Network/sleep timers remain real. The mock is restored in `finally`
and cannot affect a production server or another process. No production clock logic
or application file is changed.

## Evidence and cleanup

Evidence is updated after each completed check and includes the account/API version,
run tag, clock/customer/subscription/product/price IDs, disposable DB name, check names
and selected invoice amounts/statuses. It excludes keys, owner passwords, customer
payloads, payment links and raw SDK errors. Failure diagnostics include stage, provider
error type/status/request ID, permission identifiers and a credential/URL-redacted
provider message, or primitive assertion values. Capture the source revision separately
alongside the evidence; `passed-core` is not a claim that every task 4.2 requirement passed.
On failure, inspect the last completed check and controlled failure stage privately.

Normally `finally` closes app pools, drops the disposable database, deletes the test
clock (which deletes its customers and their subscriptions), and archives the run's
synthetic prices/product, expires Checkout sessions and deactivates non-default Portal
configurations. Provider-prohibited default configuration cleanup is recorded explicitly
and makes cleanup fail instead of claiming all resources were removed.
Add `--keep-resources` to retain Stripe resources for private
inspection; the local database is still dropped. Then clean explicitly:

```sh
node --conditions=react-server --import tsx scripts/stripe/acceptance-recovery.ts \
  --cleanup=/absolute/private/directory/recovery-run.json
```

Cleanup repeats account/mode checks and verifies the clock name and product's
`acceptance_run` ownership before mutation. Missing clocks are tolerated for repeat
cleanup; all prices belonging to the verified synthetic product are archived, including
a price created immediately before an interrupted evidence write. Retained prices are
archived, not deleted. Cleanup has no arbitrary customer-delete operation.

An abrupt kill or machine crash can prevent `finally`. Use the recorded IDs/run tag
to inspect and clean; if the process died between Stripe creation and recording its ID,
locate the exact run name/metadata and verify ownership before manual cleanup. The
same run-derived idempotency keys prevent duplicate creation within request retries.
A surviving local database has the recorded random `fundlane_test_stripe_recovery_*`
name; remove only that disposable database from the disposable cluster. A cleanup
failure makes the process exit nonzero even if core checks passed.

## Supplemental acceptance still required

| Scenario | Required provider evidence | Current status |
| --- | --- | --- |
| Core recovery above | Successful JSON run and reviewed Stripe invoice/status evidence | Passed in runs 7–9; latest run has 21 checks |
| Single-invoice partial payment | Remaining invoice cents still block recovery | Stripe rejects partial-amount payment attachments on automatic-collection subscription invoices (provider-enforced constraint). Actual partial aggregate settlement and processing shortfall across two invoices passed. |
| SCA | Real action-required payment cannot extend grace or grant unpaid seats; complete hosted authentication then verify provider-confirmed recovery | Actual `requires_action` seat-payment gating passed. Supplemental processing runner verified no SCA extension and denial at cutoff. Standalone browser reached the genuine 3DS challenge, but completion stalled; see stripe-hosted-browser.md. |
| Processing exception | Supported delayed method creates actual per-invoice InvoicePayment allocations covering every unpaid invoice; one pre-cutoff grant capped at grace +48h; failure/retry/shortfall cannot extend it again | Supplemental runs 7–8 passed: $399 processing against $477.89 total debt grants no extension or extra seat; zero-attempt fully covered renewal starts grace and the fixed 48-hour extension; cancellation revokes extension/access and preserves grant marker. Direct zero-attempt SCA renewal starts seven-day grace with no extension and denies access at cutoff. See supplemental report. |
| Checkout | Hosted flow creates flexible subscription with stable integration identifier and verified catalog | App session creation, price/quantity serialization and reuse passed; application-generated hosted Checkout showed correct two-seat subtotal and reached 3DS. Payment completion remains unverified. |
| Portal/cancellation | Paused admin can pay/cancel; cancellation works with pending scheduled seat reduction and honors effective date | App Portal session creation for active/paused companies and both app cancellation scenarios passed. Hosted Portal interactions remain unrun. |
| Webhook HTTP | Real Stripe signature accepted, invalid signature rejected, duplicate/out-of-order delivery safe against current provider reads | Supplemental actual-route HTTP runner passed genuine CLI-forwarded signed event, durable scoped receipt, duplicate no-op and tampered-body rejection. Second run delivered genuine cancellation before older active update; both acknowledged/receipted, canceled access retained, control unchanged. |
| Existing classic subscriptions | Paid increases and renewal reductions preserve classic billing mode | Passed with real classic subscription in run 8 |
| Manual suspension/outbound approval | Full payment cannot bypass manual pause or revive pre-pause outbound approval | Passed real-provider run 9: manual pause survives full payment; outbound blocked during pause, old approval rejected after recovery, new approval preserved through another provider sync. |

Do not forward sandbox events to the production webhook for acceptance. Set up a
separately reachable isolated runtime with its own disposable database and signing
secret for the remaining hosted/signature cases. Document source revision, account,
test IDs, observed timestamps, expected/actual outcomes and cleanup result. Keep task
4.2 unchecked until the required matrix is actually exercised and blockers resolved.

## Implementation verification

The help smoke command, explicit script-inclusive TypeScript check and touched-file
ESLint passed during implementation. The project's main `tsconfig.json` does not include
`scripts/stripe/`, so `pnpm typecheck` alone does not verify this runner. No production
database or Stripe CLI default account is used for these checks.

# Real Stripe processing / SCA acceptance

## Result

**Passed: full-balance processing extension, insufficient TOTAL-debt rejection across two real invoices, cancellation revocation with retained grant marker, direct zero-attempt SCA grace/cutoff, zero-attempt processing grace/extension, and no unpaid seat grant.** Bank-decline transition and hosted SCA completion remain unverified. Stripe enforces rejection of partial attachment within an automatic subscription invoice; that provider constraint does not block total-debt coverage.

Verified account before mutations: `acct_1UIDeIBP3qJwlwms`, explicit test key, API `2026-08-26.dahlia`. All application data used randomly named disposable databases on literal loopback port **55439**. No application code, global payment settings, or live resources changed.

Initial full-coverage run: `fundlane-processing-898faa5e-10e9-4000-884a-98affe6b5944`, private evidence `processing-acceptance-6.json`.

Latest targeted runs, both exit **0**:

- `fundlane-processing-3ee6d4a2-c35c-479e-985d-8841a7392e67`: `processing-acceptance-7.json` (direct SCA and insufficient total debt).
- `fundlane-processing-e9e2baf4-02e3-41de-99b4-58ec0465396d`: `processing-acceptance-8.json` (zero-attempt processing).

All evidence files are under `/private/var/folders/4b/5cndy0z540n59lxr7hx1h0780000gn/T/opencode/`.

No forged Stripe objects or mocked SDK responses were used. Only `Date` was mocked in the standalone Node process to align actual application synchronization/access checks with real Stripe test clocks.

## Isolated payment configuration

With authorized sandbox setup, the runner created a uniquely named, non-default PaymentMethodConfiguration using:

```ts
stripe.paymentMethodConfigurations.create({
  name: run,
  us_bank_account: { display_preference: { preference: "on" } },
})
```

Configuration `pmc_1UIJUfBP3qJwlwmshxaaoYWM` returned `livemode=false`, bank `available=true`, and display value `on`. Test-only PaymentIntents explicitly selected this configuration with `payment_method_configuration`, retaining `automatic_payment_methods: { enabled: true, allow_redirects: "never" }`. No `payment_method_types` allowlist was supplied. Configuration was deactivated after the run.

## Genuine processing allocation and access

- Renewal invoice: `in_1UIJVXBP3qJwlwmsA4kq69FS`, real unpaid subscription-cycle invoice after a declined card collection.
- ACH PaymentIntent: `pi_3UIJVkBP3qJwlwms2sczb25J`, **39,900 cents**, provider status **processing**, created with documented `pm_usBankAccount_processing`.
- Attached through the documented `stripe.invoices.attachPayment(invoice.id, { payment_intent: pi.id })` API.
- Provider InvoicePayment: `inpay_1UIJVmBP3qJwlwmspW4pUwcL`, `status=open`, `amount_requested=39900`, referencing that PI. The actual default failed-card allocation also remained visible; no allocation object was invented.
- Actual `syncWorkspaceBilling` granted:
  - Original grace: `2026-10-29T03:31:42.000Z`.
  - Extension: `2026-10-31T03:31:42.000Z` (**exactly two days**).
  - One-time grant: `2026-10-22T03:31:42.000Z` (before the original deadline).
- After advancing the real clock to the original grace deadline and synchronizing again, actual `getCompanyAccess().allowed` remained **true**. Both markers were unchanged.

### Provider cancellation revocation

The runner canceled that real pending ACH PI using the supported cancellation API. Stripe returned `status=canceled`. Actual synchronization then:

- Cleared `processing_extension_until`.
- Retained `processing_extension_granted_at=2026-10-22T03:31:42.000Z`.
- Denied access at the original deadline.

This certifies revocation when a genuine pending payment is canceled. It does **not** certify an ACH bank-decline transition; that remains separate coverage.

## SCA and seats

| Check | Real evidence | Result |
| --- | --- | --- |
| Unpaid seat increase | Subscription `sub_1UIJUhBP3qJwlwmsqaIqtpco`; invoice `in_1UIJUnBP3qJwlwmsqtLtsdoa`; PI `pi_3UIJUnBP3qJwlwms2Gbb9EPe` returned `requires_action`; subscription had a pending update | Actual `changeBillingSeats` and `syncWorkspaceBilling` kept access seat limit at **1** |
| Renewal SCA | Invoice `in_1UIJUxBP3qJwlwms1vm9IzGm`; PI `pi_3UIJV2BP3qJwlwms46WgljNK` returned `requires_action` | Both processing extension markers remained null |
| SCA cutoff | Real clock advanced to original grace deadline, followed by actual synchronization | Access denied; both extension markers remained null |

Hosted SCA completion and post-authentication restoration were not automated or certified. The table above records run 6, which used a preliminary decline. Run 7 supersedes that setup: invoice `in_1UIJaHBP3qJwlwmsK2Dnh5k9` had **attempt_count=0**, and PI `pi_3UIJaKBP3qJwlwms1zEll0F3` genuinely returned `requires_action`, with **no preliminary decline**. Actual synchronization established grace at finalized time plus exactly seven days (`2026-10-29T03:37:06.000Z`), granted neither processing marker, and denied access at that original deadline. The current runner asserts this zero-attempt case directly. Its real seat-increase PI `pi_3UIJa1BP3qJwlwms3UqYpL4e` also required action and retained seat limit 1.

## Insufficient total debt: passed

Run 7 created two applicable invoices through actual Stripe subscription operations:

- Failed renewal `in_1UIJarBP3qJwlwms1R2gjp15`: **39,900 cents remaining**.
- Pending subscription seat update with `proration_behavior=always_invoice` and `payment_behavior=pending_if_incomplete` generated real open `subscription_update` invoice `in_1UIJb7BP3qJwlwmsoz0GWW28`: **7,889 cents remaining**.
- Total outstanding debt: **47,789 cents**.
- Genuine processing PI `pi_3UIJbDBP3qJwlwms1my2ioed`: **39,900 cents**, attached only to the renewal. Provider allocation `inpay_1UIJbEBP3qJwlwms7ghNHcNP` confirmed the amount and PI relationship.

Actual synchronization left **both extension markers null** and retained seat limit **1**. Access remained allowed under the original, unexpired seven-day grace; no processing extension was granted. Assertions were made while both real invoices were open, before the pending update could expire. No fabricated renewal, allocation, or local billing state was used.

## Zero-attempt processing: passed

Run 8 created a genuine subscription-cycle renewal without a preliminary failed payment. To obtain a deterministic zero-attempt fixture, only its synthetic subscription was temporarily set to `keep_as_draft` across the real renewal boundary; the generated draft was finalized with `auto_advance=false`, then the temporary provider pause was removed before application synchronization. No local pause state was fabricated.

- Invoice `in_1UIJcMBP3qJwlwms5XNTVjM5`: **attempt_count=0**, verified again after attachment.
- Real full-balance PI `pi_3UIJcVBP3qJwlwms2uvJS0rJ`: processing, **39,900 cents**.
- Allocation `inpay_1UIJcXBP3qJwlwmshFquEyJn`: open, full requested amount.
- Synchronization established original grace at finalized time plus seven days: `2026-10-29T03:39:28.000Z`.
- Extension: `2026-10-31T03:39:28.000Z`; grant marker: `2026-10-22T03:39:28.000Z`.
- Access was allowed at original grace cutoff with unchanged markers.
- Real PI cancellation cleared the extension, retained the grant marker, and denied access.

## Provider-enforced single-invoice constraint (historical run 6)

A real 100-cent ACH PI `pi_3UIJWdBP3qJwlwms0sqhnAGd` entered processing, but attaching it to automatic subscription invoice `in_1UIJWSBP3qJwlwmso7nGcj39` was rejected:

> For charge_automatically subscription invoices, you are only allowed to attach a payment with an amount that matches the invoice total.

Request: `req_MkSABByxVHQ6Ln`. No allocation was fabricated. This is a **provider-enforced amount constraint**, not a product bug or an unresolved total-debt test requirement: run 7 verifies insufficient total debt using two genuine invoices. The unattached PI was canceled during cleanup. Historical run 6 exited 2 for this constraint; the current insufficient scenario uses the supported multi-invoice flow and passed.

## Reproduce and cleanup

From `nextjs-version/`, supply the approved private environment without printing its contents, then:

```sh
MCA_TEST_DATABASE_ADMIN_URL=postgresql://mbele@127.0.0.1:55439/postgres \
node --conditions=react-server --import tsx scripts/stripe/acceptance-processing.ts \
  --apply --evidence=/private/path/new-processing-evidence.json
```

Use `--scenarios=sca,insufficient` or `--scenarios=processing-zero` for the targeted runs above. The default runs `sca,processing,insufficient`; `processing-zero` is separately selectable to avoid repeating already-certified flows unnecessarily.

Requires explicit `MCA_STRIPE_MODE=test` and a test-prefixed `STRIPE_SECRET_KEY`. Account and loopback-port gates precede mutations. Exit 1 indicates an assertion/prerequisite failure; exit 2 indicates recorded provider constraints.

Run 6 cleanup completed: both explicitly created ACH PIs canceled, three owned clocks deleted (including their customers/subscriptions), product `prod_VIvLUl7em4BcBZ` and synthetic prices archived, isolated configuration deactivated, disposable database dropped. The runner only cleans resources named/tagged for its run.

Runs 7 and 8 also completed cleanup: their standalone PIs canceled, their two/one clocks respectively deleted, synthetic catalogs archived, configurations `pmc_1UIJZtBP3qJwlwmsQ83hWcF4` and `pmc_1UIJcBBP3qJwlwmsLuYaQq1Z` deactivated, and disposable databases dropped.

Earlier evidence files `processing-acceptance-1.json` through `-5.json` remain private history. Runs 1–4 predate configuration setup; run 5 first proved full processing. Run 5's two standalone PIs were explicitly canceled in a scoped follow-up cleanup after its clock cleanup; its configuration/catalog were archived. No credentials or hosted links are included in the reports.

## Documentation and checks

Consulted via Stripe CLI **1.51.1**:

- [Testing](https://docs.stripe.com/testing): `pm_card_threeDSecure2Required` and indefinitely processing `pm_usBankAccount_processing`.
- [Create PaymentMethodConfiguration](https://docs.stripe.com/api/payment_method_configurations/create).
- [Attach payment to invoice](https://docs.stripe.com/api/invoices/attach_payment).

Final checks:

- `pnpm exec eslint scripts/stripe/acceptance-processing.ts`: **passed**.
- `pnpm exec tsc --noEmit --pretty false`: **passed** (earlier concurrent test-file diagnostic resolved).
- Shared Graphify refresh deferred to the coordinating agent to preserve two-file ownership.

Tax calculation is outside these synthetic payment-state checks; no automatic-tax setting was enabled.

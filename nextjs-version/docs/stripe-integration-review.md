# Stripe Billing planner review

Date: 2026-09-21. Scope: targeted source review, not provider acceptance testing.

## Planner evidence

- MCP connected to `FundLane sandbox`, `acct_1UIDeIBP3qJwlwms`, livemode false.
- Invoked `stripe_implementation_planner` with Fundlane's existing requirements.
- Accepted guide: `iguide_61VRbn1ytCB2uym2z41BP3qJwlwms`.
- Selected hosted Checkout, licensed graduated seats, application-managed 14-day
  no-card trial, custom seat controls plus restricted Customer Portal, scheduled
  reductions, and custom seven-day recovery/access rules.
- Tax registrations remain an unresolved merchant decision. The planner's generic
  no-card branch calls this freemium; Fundlane's free access still expires in 14 days.
- Final tool response confirms hosted Checkout and directs implementation to its
  documentation links; it does not certify existing code or account configuration.

## Aligned implementation

- `scripts/stripe/setup-catalog.ts`: $399 base plus graduated additional-seat price
  (first 9 additional users $79, next 10 $69, remainder $59). This is equivalent to
  the approved total-seat pricing. Account assertion and idempotent provisioning.
- `src/lib/mca/billing.ts`: current API version `2026-08-26.dahlia`, server-only
  credentials with explicit mode checks, hosted subscription Checkout, dynamic
  payment methods, Checkout reuse, idempotent mutations.
- Seat increases use `pending_if_incomplete` with `always_invoice`; reductions use
  subscription schedules and occupied-seat checks.
- Portal configuration disallows subscription updates while allowing payment method
  changes, invoice history and cancellation at period end.
- Webhook route verifies the raw body; processing deduplicates event IDs inside a
  transaction and reads current Stripe state instead of trusting event ordering.

## Findings and recommendations

### Merchant clarification

The merchant requires payment of the outstanding balance and missed subscription
months before restoring access. Software access is blocked after one week unpaid;
suspension does not forgive missed monthly fees. Recovery must therefore account
for paused-period drafts, not just previously finalized invoices. This is a policy
decision recorded for implementation, not evidence that recovery already enforces it.
Confirm whether the previously approved processing-payment extension is superseded
by a strict seven-day cutoff before updating access evaluation.

1. **Collection cutoff needs additional enforcement.**
   `billing-reconciliation.ts:95-101` sets `pause_collection=keep_as_draft`, which
   stops collection of future invoices but does not stop retries on existing open
   invoices. To enforce a complete automatic-collection cutoff while preserving
   debt, disable automatic advancement on relevant open invoices and verify manual
   hosted-invoice recovery. Account retry settings must match the seven-day policy.
2. **Define paused-period draft treatment.** Recovery unsets `pause_collection`
   (`billing-reconciliation.ts:108-110`) but does not process drafts accumulated
   during suspension. Stripe leaves those drafts uncollected. Decide whether those
   periods are billable before implementing any finalization or forgiveness.
   Merchant clarification above resolves this: missed months remain payable.
3. **Explicit flexible billing selection.** Checkout creation does not explicitly
   select `subscription_data.billing_mode`. Evaluate and explicitly select flexible
   billing for new subscriptions after sandbox tests for pending updates, proration,
   schedules and cancellation. Do not silently migrate existing subscriptions.
4. **Checkout tracking label.** Add a stable flow-specific `integration_identifier`
   with the documented random-letter suffix; the current Checkout request omits it.
5. **Provider acceptance remains required.** Verify SCA, async payment eligibility
   for pending updates, failed seat increases, schedule transitions, replayed and
   out-of-order webhooks, grace cutoff, retries, and recovery using isolated sandbox
   companies and test clocks. Local tests do not prove real Stripe behavior.

## Activation prerequisites

- Sandbox application API credentials and webhook signing secret are separate from
  MCP OAuth. Store a restricted API key in server-side environment configuration.
- Provision and verify sandbox prices/Portal, then run acceptance flows against an
  isolated app/database environment. Do not point production at sandbox billing.
- Authorize and verify the intended live Fundlane account before live provisioning.
- Confirm tax obligations/registrations, product tax category and customer address
  collection before enabling automatic tax.

## Stripe documentation

- https://docs.stripe.com/billing/subscriptions/build-subscriptions?payment-ui=checkout&ui=stripe-hosted
- https://docs.stripe.com/subscriptions/pricing-models/tiered-pricing?dashboard-or-api=api
- https://docs.stripe.com/billing/subscriptions/subscription-schedules
- https://docs.stripe.com/billing/subscriptions/pause-payment
- https://docs.stripe.com/invoicing/integration/automatic-advancement-collection
- https://docs.stripe.com/billing/revenue-recovery/smart-retries

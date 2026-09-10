# Integration review follow-ups

These findings were sent to the owning agents during implementation. A finding is not resolved merely because the first code draft changes; verify the behavior and record evidence in the lane acceptance file.

## Offers and funding

- Validate runtime terms/enums, workspace funder ownership and dates with actionable errors.
- Serialize selection changes; same-selection retries are no-ops and stale deselection cannot remove a newer selection.
- Preserve revisions and selection decisions; explicitly define superseded-revision eligibility.
- Funding replay precedes eligibility and is rechecked after locking; concurrent confirmations resolve to one advance/accounting set.
- Missing factor remains unknown or blocks confirmation; do not default to factor 1.
- Store explicit payment count/calendar in the calculation snapshot and advance for meaningful estimates/renewals.
- Manual/history capability requires admin session; validate submission linkage and derive trustworthy source labeling.
- Distinct commission/fee expected dates; primary originator snapshot in accounting.
- Auditable reversal/correction and historical import reconciliation remain required, with no transfers/sends.
- Bridge new offers into existing deal summaries without losing legacy records.

## Accounting and lifecycle

- Decimal parser uses the fractional capture; exact money and runtime commission-base tests.
- Monthly estimates use anniversaries/month-end rules; explicit first-payment and calendar conventions, future dates zero.
- Payment table, company totals, feature and page permissions enforced at direct APIs.
- Splits cannot overallocate through repeated application with new keys; paid history remains immutable; recipients belong to workspace.
- Renewal linkage validates target deal and permission; fresh-document requests create real tasks; messages use merchant/funder names and dollars.
- Payments UI: date/originator/status filters, selector, drilldown, reconcile, adjustments, split create/version/apply and recipient history.
- Advances UI: merchant/funder/team, term/frequency, detail/history, user-entered correction reason.
- Form retries preserve idempotency keys after response loss.

## Closing

- Configured Deals visibility enforced; PSF read visibility matches its toggle, absent configuration defaults disabled.
- Public upload response-loss retries preserve upload identity after link consumption; validate clean category before task verification.
- Persist attachment id/version/checksum in immutable previews and deliver usable private artifact references.
- Delivery SQL placeholders match; successful/signed/final-review history cannot regress on retries.
- Real external signature evidence differs from an arbitrary entered external ID/manual mark.
- PSF URL validation covers DNS/private hosts and disables redirects; provider acknowledgment includes stable external request identity.
- PSF confirmation/webhook replays are idempotent and cannot reset signed state.
- All/highest merchant preview modes allow eligible unselected offers and retain every included revision/pitch binding.
- No provider configuration yields an explicit unavailable/failed state, never a successful pitch or signature.

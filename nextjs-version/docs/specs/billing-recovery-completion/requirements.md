# Approved billing recovery policy

This records the policy already approved in conversation and elaborated in the approved design.

## R1. Missed-month debt
- **R1.1** WHILE a subscription is suspended for nonpayment, THE SYSTEM SHALL retain its unpaid balance and missed monthly fees until its effective cancellation date.

## R2. Seven-day cutoff
- **R2.1** WHEN the original unpaid renewal reaches seven days overdue without a qualifying processing extension, THE SYSTEM SHALL block business access and outbound automation and stop subsequent automatic collection attempts without forgiving debt.
- **R2.2** WHEN a payment is retried or a payment method changes, THE SYSTEM SHALL preserve the original grace deadline.

## R3. Processing exception
- **R3.1** IF verified processing payments cover every overdue invoice before the seven-day cutoff, THEN THE SYSTEM SHALL allow at most one extension ending 48 hours after that cutoff.
- **R3.2** WHEN processing coverage fails or becomes insufficient, THE SYSTEM SHALL revoke extension eligibility without allowing a second extension in the same delinquency episode.

## R4. Verified recovery
- **R4.1** WHEN all applicable overdue invoices are verified paid, THE SYSTEM SHALL restore only otherwise-eligible access while retaining manual suspensions, legacy exemptions and durable outbound reapproval boundaries.
- **R4.2** IF applicable missed-period drafts, unpaid invoices or uncollectible debt remain unresolved, THEN THE SYSTEM SHALL withhold recovery even if the original overdue invoice is paid.

## R5. Billing access and notices
- **R5.1** WHILE business access is suspended, THE SYSTEM SHALL retain authorized billing, payment and cancellation access and disclose continued monthly fees and outstanding invoices.

## R6. Provider verification
- **R6.1** THE SYSTEM SHALL pass isolated FundLane sandbox acceptance for collection cutoff, missed-month settlement, payment-before-access and Checkout seat lifecycle changes before live rollout.

## Out of scope

New pricing, automatic migration of existing subscriptions, forgiving debt, automatic tax activation without registrations, and unrelated calendar approval implementation. Provider activation credentials remain release dependencies.

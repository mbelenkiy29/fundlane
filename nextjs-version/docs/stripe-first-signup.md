# Stripe-first signup release

Get started opens setup-mode Checkout. A completed setup saves an unattached card; it does not create a customer subscription or start a trial. The existing signup form uses the Checkout email, and email verification continues to `/activate`. Activation requires the intent cookie, verified matching Supabase identity, company ownership, existing MFA checks, and explicit legal/billing consent. It creates one workspace and starts one eligible 14-day subscription using the existing catalog, including one user. Ineligible owners must explicitly review and confirm the existing paid Checkout flow. Existing workspace members continue to their current workspace.

Migration `0078_stripe_first_signup.sql` adds `company_signup_intents`. Tokens are hashed for lookup and encrypted for recovery delivery; no intent fields are exposed in JSON responses. Public Supabase roles have no table access. Intent links expire after seven days; Checkout expires after one hour. A durable intent/cookie precedes Stripe calls; stable Stripe idempotency keys preserve lost-response retries. Company creation and intent ownership commit together. Trial reservations commit before subscription creation. Interrupted reconciliation retrieves the created subscription rather than starting another trial. External creation retries stop after 23 hours and require support review beyond Stripe's deduplication window.

The existing signed Stripe endpoint handles setup completion before its unmapped-customer branch. Recovery delivery uses the existing transactional transport and a stable idempotency key; failed delivery leaves the signup ready and retries through the webhook. Providers must deduplicate webhook deliveries. Local preview delivery is not reported as sent.

## Release order

1. Select an approved, separate Supabase staging project with synthetic records. Do not inherit production credentials into the agent environment.
2. Review and apply the forward migration through the controlled database release procedure; confirm `mca_app` permissions and private Auth-session view. No hosted migration runs during build.
3. Configure Vercel Preview with Stripe **test** credentials, both existing catalog price IDs, signed webhook secret, approved synthetic email transport, and a stable `MCA_APP_ORIGIN`. Enable the existing trial-abuse checks. Allow the origin's `/auth/callback` in Supabase Auth. Register `/api/webhooks/stripe` for `checkout.session.completed` alongside the existing billing events.
4. Run real Stripe test-mode and Supabase acceptance: card setup (no subscription/charge), locked email, verification, activation start time, one user, monthly catalog price, cancellation, additional seats, repeat-trial paid confirmation, existing customer, recovery on another device, expired links, failed card, duplicate webhook/request, interrupted activation and outages. Check desktop/mobile and keyboard focus.
5. Deploy the reviewed app only after hosted acceptance and controlled production migration. Verify `/get-started`, `/sign-in`, callback and webhook on the existing app origin.
6. Update shared Framer components and every page CTA to **Get started → https://fundlane.io/get-started** and **Log in → https://fundlane.io/sign-in**. Remove demo copy; state that the trial starts after activation. Review and publish only after the destinations work.

The `fundlane.io` hosting cutover remains separate and requires the Framer hosting choice. Preserve the app's existing paths, legal, support and authentication destinations.

## Current hosted prerequisites

Vercel Preview's variable inventory does not contain `STRIPE_BASE_PRICE_ID` or `STRIPE_ADDITIONAL_SEAT_PRICE_ID`. A `fundlane-staging` Supabase project exists, but Preview's sensitive Supabase URL cannot be retrieved through Vercel's API and has not been confirmed to target it. Preview billing mode is `test`. The local Stripe profiles do not expose the Fundlane test catalog lookup keys; the intended test account/catalog still needs connection. No hosted migration, app deployment, Framer CTA edit or publication has been performed for this flow.

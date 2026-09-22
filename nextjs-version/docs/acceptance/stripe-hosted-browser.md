# Hosted Checkout, Portal and 3DS acceptance

## Status: incomplete — live activation gate remains open

The session's desktop browser was disconnected. A standalone Playwright/Chrome
runner was created at `scripts/stripe/acceptance-hosted.ts` to continue with isolated
synthetic resources in FundLane sandbox `acct_1UIDeIBP3qJwlwms`.

### Observed

- The real hosted Checkout page loaded with the expected monthly base price.
- Run 8 used the **application's** Checkout creation service, synthetic graduated
  prices, two seats, and a migrated disposable PostgreSQL database. Checkout showed
  $399 base plus $79 for the additional seat before provider-calculated tax.
- The form was submitted with Stripe's 3DS test card and reached the genuine
  **3D Secure 2 Test Page**. A private screenshot records the challenge.
- This sandbox defaults to Stripe Managed Payments/Link and calculated tax itself.
  This does not establish merchant tax registrations or activate application
  `automatic_tax` in production.
- Completing the challenge did not finish reliably in the browser harness. Runs
  9–10 exceeded their process deadlines; independent provider readback showed
  unpaid Checkout, and both interrupted runs were explicitly cleaned.
- Hosted Portal cancellation was not reached. No hosted payment success, Portal
  completion, or app-browser return-route acceptance is claimed.

Early runs 1–7 were browser-selector/form probes, not application end-to-end proof.
Run 8 reached the challenge through an application-generated Checkout session.
The final runner now targets the observed Complete button, but has not achieved a
passing full hosted run. Core real-provider acceptance and signed webhook checks
remain independently passed in their respective reports.

### Evidence and cleanup

Private evidence: `hosted-acceptance-{1,...,10}.json` in the approved session
temporary directory. Failure text, DOM summaries and screenshots remain private.
Every run's owned customers were deleted and catalog prices/products archived;
the disposable databases for app-based runs 8–10 were dropped. Open sessions were
expired. No production billing configuration or company data was used.

### Resume

Install Playwright outside production dependencies. From `nextjs-version/`, run:

```sh
MCA_ACCEPTANCE_PLAYWRIGHT_MODULE=/absolute/path/node_modules/playwright/index.mjs \
MCA_ACCEPTANCE_CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
node --env-file=/private/path/fundlane-stripe-sandbox.env \
  --conditions=react-server --import tsx scripts/stripe/acceptance-hosted.ts \
  --apply --evidence=/private/path/new-hosted-evidence.json
```

Use a fresh evidence filename and a connected, reliable browser environment. Verify
provider-paid Checkout, flexible subscription and two-seat reconciliation, then
complete Portal cancellation while paused. The loopback return target is not a
running signed-in app in this harness; separately verify the authenticated return
route in isolated staging. Keep task 4.2 open until those observations are recorded.

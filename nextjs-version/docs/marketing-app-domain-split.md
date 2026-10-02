# Marketing and app domain cutover

The selected target is Framer at `https://fundlane.io`, with `www.fundlane.io` redirecting to the apex, and the existing Vercel project at `https://app.fundlane.io`. The user subsequently chose **Keep Basic; defer the domain cutover**. The root still serves the existing Vercel site; no upgrade or cutover is authorized now. Existing Supabase identities, application data and Stripe subscriptions stay in place. Browser auth and signup-intent cookies remain host-only; do not add a shared `.fundlane.io` cookie domain.

## Prepared and verified

- Vercel project `fundlane` has verified `app.fundlane.io`. `/sign-in` returns HTTP 200 over verified HTTPS. An explicit `app` CNAME points to `6c62fd56bd6e213e.vercel-dns-017.com.` so root DNS changes will not rely on wildcard routing.
- Next.js redirects only the app hostname's `/` to `/dashboard` with a temporary 307, preserving query parameters. The existing dashboard gateway handles login, onboarding and MFA. Marketing, previews, signup and API paths retain their behavior. The routing test first failed with 200, then passed after the configuration change.
- The connected Fundlane Framer project has `fundlane.io` registered, pending DNS. Basic hosting is active. Its unpublished home, navigation, banner and footer changes contain 29 Get started destinations and eight Log in destinations across breakpoints/variants. Readback found no Book a demo, Sign in, or old demo/login URLs. Legal links point to the app's existing `/privacy` and `/terms`. Trial copy states activation starts the trial.
- The root and `www` still serve Vercel. No root/`www` DNS or email records were changed. No subscription was purchased. Framer rejected native redirect creation because Basic does not include redirects. The Pro review showed $30 due immediately after Basic credit and $45/month renewing November 1, with no add-ons selected. The user declined the upgrade and deferred cutover; the checkout was canceled.

## Release prerequisites

Finish the [Stripe-first signup acceptance](stripe-first-signup.md) using the confirmed Fundlane test account and approved separate staging project. Do not load production credentials into an agent environment or run migrations during build. `/get-started` currently returns 404 on the production app; do not publish its Framer CTAs yet.

After hosted acceptance and the controlled production migration/release:

1. Set production `MCA_APP_ORIGIN=https://app.fundlane.io` in Vercel and any active worker/edge runtime using it. Update configured overrides such as `MCA_GOOGLE_DRIVE_REDIRECT_URI`, `MCA_SMS_PUBLIC_BASE_URL` and `MCA_VOICE_PUBLIC_ORIGIN` only where enabled. Review per-workspace stored intake origins and external forms/webhook destinations; changing the environment does not rewrite stored settings.
2. Set the existing production Supabase Site URL to the app origin. Allow the exact app `/auth/callback` and supported onboarding, activation, invitation, recovery and magic-link continuation variants from the Auth guide. Preserve the existing Supabase project/provider callback. Add app-origin callbacks in enabled Google Calendar, Google Drive and Google/Microsoft sender OAuth registrations. Existing sessions remain on the old host; users sign in again on the app host. Drain in-flight OAuth/signup sessions before root cutover; resending verification/recovery from the app replaces old-host links.
3. Update the existing Stripe webhook endpoint's URL to `https://app.fundlane.io/api/webhooks/stripe`, preserving its endpoint ID, signing secret, API version and existing event set; include `checkout.session.completed`. The runtime verifies one `STRIPE_BILLING_WEBHOOK_SECRET`, so do not register a second endpoint with a different secret against the same runtime. Keep the old hostname serving during verification/retry draining, confirm signed delivery and reconciliation on the app hostname, and replay failed events before retiring root routing. Rollback restores the same endpoint's old URL. Update API/webhook clients directly; never create a blanket `/api/*` redirect.
4. Verify signup/card setup, explicit trial activation, login/logout, verification, recovery, MFA, invitations, workspace permissions, Checkout/Portal returns, and enabled OAuth/messaging integrations on the app origin. Validate host-only cookies and no extra customer/workspace/subscription creation.

## Framer publication and DNS

Enable Framer's native redirects after separately approving the required hosting upgrade. Preserve any existing rules. For each prefix below, create an exact redirect to `https://app.fundlane.io<prefix>` and a nested wildcard `<prefix>/*` to `https://app.fundlane.io<prefix>/:1`. Framer uses permanent 308 redirects. Before DNS changes, verify path/query preservation using the Framer base URL, including invitation tokens and `/pipeline?deal=...`; a discarded query blocks cutover. Do not redirect `/`, `/changelog`, or `/api/*`.

```text
/sign-in /sign-up /login /register /get-started /activate
/signup-return /signup-resume /forgot-password /reset-password
/accept-invite /verify-company /account-security /onboarding
/privacy /terms /help /status /roadmap
/dashboard /dashboard-2 /home /deals /pipeline /calendar /intake
/applications /assistant /sms /mail /submissions /offers /advances
/renewals /funders /payments /reports /settings /review /platform
/admin /apply /merchant-upload
```

Publish and verify the prepared Framer site only after app acceptance and redirects. Configure apex as the primary domain, with `www` redirecting to it. At cutover, use the current Framer-provided DNS values (observed: apex A `31.43.160.6` and `31.43.161.6`; `www` CNAME `sites.framer.app`). Remove only conflicting web records/old Vercel root aliases as necessary. Keep the explicit app CNAME, nameservers, MX, SPF, DKIM, DMARC and unrelated subdomains intact.

Check root/`www`/app HTTPS, primary-domain redirects, CMS list/detail links, desktop/mobile CTAs, keyboard focus, and representative old links. Record DNS and project-domain settings before changes. For rollback, restore the prior root/`www` Vercel routing and last working deployment; leave the app subdomain available and reconcile any signup/billing effects before changing billing configuration. Permanent redirects can remain cached, so app destinations must remain available during rollback.

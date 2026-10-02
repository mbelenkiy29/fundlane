# Get Started acquisition CTA follow-on

The existing Next.js landing page and public navigation use **Get Started** to open the reviewed subscription Checkout directly. Login remains a separate `/sign-in` link. The root domain is retained. This change does not activate hosted enrollment, apply migrations or adopt PR #238.

## Scope

- Shared desktop header, mobile menu and footer on every MarketingShell page.
- Homepage hero, five workflow stages, team section, FAQ and closing CTA.
- Features intro, eleven repeated feature sections and closing CTA; changelog closing CTA.
- Demo-led homepage FAQ text now explains the card-required 14-day trial, USD 399/month first user, Checkout discounts/tax, verified access and optional setup.

Every acquisition control reuses `TrialCheckoutStart`: HttpOnly browser binding, Web Locks serialization, a shared pending promise, the existing creation gate and HTTPS navigation. The pricing-page button keeps its original label and availability explanations. Unavailable marketing controls stay disabled, with an accessible explanation and tooltip; they do not fall back to account or company registration. Mobile keyboard wrapping includes enabled buttons; the menu stays open on Checkout failure so the error is visible and focused.

The saved `/demo` route/form and invite-only compatibility copy are preserved for existing inbound links; they are not acquisition CTAs on the landing/navigation pages.

## Cloud evidence and limitations (2026-10-02)

Remote main was `d0225e51e2659c59b87b71db3ec092cb2e827f35`, containing PR #239 and PR #237. The source snapshot was reconstructed through the authorized GitHub connector because cloud Git fetch returned proxy 403. All 163 changed non-generated source files matched their exact Git blob SHA before materialization. The remote follow-on uses the real main tree and parent; the local snapshot commit is not published.

TS/TSX syntax parsing with the installed Playwright Babel parser and `node --check` pass. `git diff --check` passes. Source audit finds no demo destination or demo CTA in the five acquisition components/pages.

Functional verification is **pending**: `pnpm install --frozen-lockfile` cannot download dependencies because the npm registry returns CONNECT proxy 403. The scoped test command for `onboarding-navigation.test.ts`, `public-pricing.test.ts` and `marketing-site.test.ts` exits 1 before test execution (`ERR_MODULE_NOT_FOUND: tsx`); this is not a passing test run or an observed behavioral regression. Typecheck, lint, Next build and the synthetic browser suite must run after cloud dependency access is restored. Existing tests were updated for direct Checkout, visible disabled controls and removal of every repeated demo CTA; browser cases cover multiple CTA instances sharing one purchase and mobile direct navigation. The runner now accepts cloud Playwright/Chromium paths instead of requiring Mac paths.

PR #239's earlier 2,197 passing tests apply to its reviewed head, not this follow-on. Deployment builds alone do not prove hosted Auth, Stripe, delivery or trial acceptance. Hosted end-to-end acceptance remains gated by reviewed migration-history reconciliation, approved target configuration and explicit test identity/recipient/financial terms. FUNDLANETESTER eligibility and duration remain unverified; no Checkout, subscription or external message was created during this change.

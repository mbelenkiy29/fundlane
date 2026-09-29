# Fundlane marketing site

## Launch pricing and support

Set `MCA_PUBLIC_PRICING_ENABLED=true` to publish `/pricing`, its marketing navigation link, sitemap entry, and robots allowance. Unset or any value other than exactly `true` keeps the existing authenticated `/pricing` redirect to Plans & Billing. The page reads amounts and trial length from `src/lib/mca/billing-catalog.ts`. Approve its copy before enabling it. Enable `MCA_TRIAL_REQUIRES_CARD=true` and verify the configured Stripe Checkout trial before publishing the card-required claim.

Publication review must confirm that pricing copy matches `MCA_STRIPE_TAX_BEHAVIOR`. Blank or unset deliberately preserves today's `Sales tax is added where applicable.` sentence; `exclusive` displays the same sentence, and `inclusive` displays `Prices include applicable sales tax.` only after the approved Price/catalog cutover. An invalid nonblank value omits the tax sentence without taking the public page down; billing Price verification still rejects that configuration. Review the activation and inclusive-cutover requirements in `docs/supabase-billing.md`; `MCA_STRIPE_TAX_ENABLED` and the separate readiness flag both default to false.

## Public roadmap

`MCA_PUBLIC_ROADMAP_ENABLED` defaults to off; only the exact value `true` publishes `/roadmap` and its internal navigation, Help, sitemap, and robots entries, and opens `/platform/roadmap` to MFA-verified platform administrators. When off, `/roadmap` and the editor/API return 404, and existing validated `NEXT_PUBLIC_ROADMAP_URL` links remain in the footer and Help page. When on, internal links take precedence.

Apply reviewed migration `0066_public_roadmap` before enabling the switch. It adds two global tables for items and independent audit history; it does not seed content or change customer records. In the platform editor, create an unpublished item, edit its title, summary, status, and sort order, then publish it. The editor shows publication state and confirms deletion. Every change writes an audit row in the same transaction; stale edits require a reload. Keep titles and summaries free of customer data and do not promise dates. The public page shows only published text, ordered Planned, In progress, Shipped. Its published query is cached for 60 seconds; tag invalidation after an edit can briefly show the previous state during refresh.

Release acceptance: review the page and operator copy with Michael, apply the migration to the approved nonproduction database, enable the flag in a preview backed by synthetic records, and verify creation, editing, publication, unpublication, deletion, audit history, and link precedence. Confirm a public browser sees only published rows and cannot reach operator endpoints. Review and apply the migration before production activation. Help-center and status-page work remain separate.

Set `MCA_MARKETING_TRIAL_CTA_ENABLED=true` with `MCA_SIGNUP_MODE=open` to show “Start free trial” in the marketing navigation. Unset or any value other than exactly `true` keeps the current CTAs. Set `MCA_SHOW_MIGRATED_ACCOUNT_NOTICE=false` to hide the sign-in migration message.

Set `MCA_SUPPORT_EMAIL=mike@sentineltechsolutions.io` for the launch contact. The existing validated support setting shows the address in the marketing footer, on pricing when published, and in the signed-in footer. Unset or invalid email shows no address. Confirm the mailbox is monitored before launch.

## Marketing polish rollout

Set `MCA_MARKETING_POLISH_ENABLED=true` in the Vercel environment and redeploy to enable the footer contact block, FAQ structured data, reduced marketing fonts, internal demo links without external-link arrows, and the visible sign-up heading. Unset or any other value preserves the current presentation, including the root layout's preloads for all three marketing fonts. The root layout retains Inter for application and authentication screens. With polish enabled, the root layout skips those marketing fonts; marketing loads only Geist Mono without a preload and uses Inter for headings and metrics. Redeploy after changing the flag so static pages use the selected presentation.

Set `NEXT_PUBLIC_MCA_COMPANY_LEGAL_NAME` to the verified legal entity name to show it in the marketing footer. It is blank by default; no company name is inferred from the brand or privacy notice. The existing server-only `MCA_SUPPORT_EMAIL` supplies the contact email in that block and elsewhere on the site. Invalid or unset email and blank legal name are omitted. Confirm the legal name and monitored support address with the owner before configuring them. No phone number, postal address, prices, customer claims, or new sales provider is implied. The demo request integration and publication gate remain as described below.

Organization, WebSite, SoftwareApplication and WebPage structured data, the distinct demo meta description, and the dated sitemap entries are already present. The opt-in FAQPage node uses the same seven question and answer strings shown on the homepage. Update the sitemap content date only when published marketing content changes; do not use the build time as `lastmod`.

The public homepage is `/`; `/landing` permanently redirects to it. `/demo` hosts the sales-assisted request flow. Authentication and `/dashboard` retain their existing routes. PWA registration/update prompts mount only in the authenticated dashboard layout. The global loading boundary was removed so public pages render without hydration; the dashboard retains its existing loading skeleton. Marketing pages use a scoped black palette with blue and green accents without changing the saved application theme. The homepage tells the five-stage application-to-renewal story; `/features` covers all eleven product categories with stable anchors, and `/demo` retains the existing sales-assisted form. The shared shell also styles the published privacy notice and draft legal pages when enabled.

## Legal pages

`MCA_LEGAL_DRAFT_PAGES_ENABLED=true` is a server-only, strict opt-in for the `/terms` and `/privacy` pages, footer and sign-up links, and robots/sitemap entries. Unset or any other value keeps the original behavior: `/terms` redirects to sign-in, `/privacy` serves the existing gated website/demo notice only when `MCA_MARKETING_PRIVACY_URL=https://fundlane.io/privacy`, and no legal links or index entries appear. Michael Belenkiy approved publication on September 28, 2026 (19:20 ET) until an attorney reviews the documents. The banner reads **These terms were prepared without attorney review and will be updated after legal review.** The effective date is September 28, 2026. The pages identify Sentinel Tech Solutions LLC, 7 Holly Hill Road, Marlboro, NJ 07746, and mike@sentineltechsolutions.io. No migration is needed. See [the evidence and attorney-review checklist](legal-drafts.md).

The demo form still requires `MCA_MARKETING_PRIVACY_URL` as its separate approval gate. When the draft flag is on, the demo gate rejects any configured URL whose path is `/privacy` (on any host, including preview domains), so it cannot treat this app's draft route as the approved notice. A separately approved notice at another path may still be configured. Do not use draft content for demo activation, OAuth consent, or SMS registration until reviewed.

## Enable demo requests

Direct database delivery is available after migration `0056_marketing_demo_submissions.sql`.
Set `MCA_DEMO_DB_SUBMISSIONS_ENABLED=true` and configure
`MCA_MARKETING_PRIVACY_URL` to an approved HTTPS privacy notice to accept requests
into the private `marketing_demo_submissions` table. The flag defaults to `false`,
retaining the existing webhook route until the migration is released. The privacy
URL remains a publication gate in both delivery modes. When enabled, the page
checks database availability before enabling the form. A successful API response
means the row was stored; email notification is best effort. Repeated request IDs
with identical normalized fields are accepted without creating another row. With
`MCA_DEMO_VISIBILITY_ENABLED=true`, newly tracked unsent notifications may be retried using
the same provider idempotency key. Contact details, including team size and message, are encrypted
as one payload with the existing `MCA_DATA_ENCRYPTION_KEY` and bound to the opaque
request ID. Plaintext columns contain only that ID, a keyed retry digest, and
creation time, and delivery metadata; no raw IP address is stored. Preserve the encryption key when
retaining or moving these rows.

Set `MCA_DEMO_NOTIFY_EMAIL` to the monitored sales inbox. Notifications use
the selected system email transport: useSend with `MCA_USESEND_API_KEY` and
`MCA_USESEND_FROM` by default, or Resend with `MCA_SYSTEM_EMAIL_PROVIDER=resend`,
`MCA_RESEND_API_KEY`, and `MCA_RESEND_FROM` (falling back to `MCA_USESEND_FROM`). Missing
configuration or provider failure emits a `marketing_demo_notification_skipped`
or `marketing_demo_notification_failed` metric and does not reject a stored lead.
Monitor notification delivery and verify it with a synthetic submission before
relying on the inbox. The private table holds encrypted contact details;
database access alone shows only ciphertext and metadata.
The platform-admin-only `/platform/demo-requests` list and private
`scripts/marketing/inbox.ts list` command read stored submissions even before
migration `0064_demo_notification_status.sql`. `show <request-id>` decrypts a
request in a private deployment shell. Platform access requires MFA. The list
shows a warning whenever any submission has unknown or unsent notification
history, including requests outside the newest 100 shown. Before 0064, fresh
submissions retain the original best-effort email send and emit structured
warnings on missing configuration or failure. The migration leaves older rows
marked `unknown` because their delivery history cannot be reconstructed.
Only requests inserted after 0064 receive tracked notification status and can
be retried. The status column stores only `not_configured` or
`delivery_failed`, never provider errors or contact details.

`MCA_DEMO_VISIBILITY_ENABLED=true` enables email retries for duplicate requests
and the private `scripts/marketing/inbox.ts retry` command. It defaults to
`false`; read-only visibility, warnings, and initial notification delivery are
always active. The retry command sends at most ten tracked unsent requests per
run. The database lease and stable provider idempotency key prevent concurrent
retry sends. No hosted cron schedule is required. Review unknown historical
rows manually before deciding whether another email is appropriate. Keep
`MCA_DATA_ENCRYPTION_KEY` identical to the key used for existing rows. Verify
notification delivery with a synthetic request and a platform-admin login after
applying the reviewed migration to the intended host. No provider callback URL
or cron schedule is needed.

`MCA_SUPPORT_EMAIL`, already used by the help center,
provides the `/demo` mailto fallback when storage is unavailable. If it is
unset, the page shows a neutral unavailable message without an invented address.

The database path retains the existing same-origin, JSON/body-size, validation,
honeypot, and shared rate-limit checks. The new table has RLS enabled and no
grants to `anon` or `authenticated`; only the server role has table access.
Apply the migration to the intended deployment through the reviewed release
process. Verify hosted database access and a synthetic notification before
enabling retries in production. No hosted migration or provider send is part of
the local test suite.

The legacy webhook path remains available when the flag is unset:

Configure these server-only values in the intended deployment:

- `MCA_DEMO_WEBHOOK_URL`: dedicated HTTPS sales receiver URL. Redirects and embedded URL credentials are rejected.
- `MCA_DEMO_WEBHOOK_TOKEN`: bearer credential for that receiver.
- `MCA_MARKETING_PRIVACY_URL`: HTTPS URL of the approved privacy notice. Do not point this at a placeholder page.

All three must be valid before the legacy webhook path accepts requests. With missing privacy configuration in either mode, the form is visibly unavailable and its API returns 503. There is no preview-success mode. The homepage privacy link is rendered at build time; rebuild after configuring it. `/demo` reads configuration at request time.

The existing Postgres `request_rate_windows` table provides shared limits across application instances: five attempts per client address per minute and 120 total attempts per minute. Configure the ingress to overwrite forwarded client-address headers. Rate-store outages fail closed. No separate rate-limit migration is needed. The endpoint also validates same-origin browser requests, content type, an actual 12 KB streamed body limit, allowed fields, and a honeypot. Do not reuse this anonymous endpoint for authenticated merchant intake.

## Sales receiver contract

`POST /api/marketing/demo` accepts JSON with `requestId` (client-generated UUID), `name`, `email`, `brokerage`, `teamSize` (`1`, `2–5`, `6–15`, `16–50`, `51+`), optional `message`, and empty `website` honeypot.

The server sends the receiver:

```json
{
  "type": "fundlane.demo_requested",
  "version": 1,
  "requestId": "opaque-server-generated-deduplication-key",
  "name": "Alex Morgan",
  "email": "alex@example.test",
  "brokerage": "Synthetic Capital",
  "teamSize": "2–5",
  "message": "Follow-ups"
}
```

Headers: `Authorization: Bearer <token>`, `Content-Type: application/json`, and `Idempotency-Key: <requestId>`.

**The receiver must atomically deduplicate Idempotency-Key before persisting a lead or notifying sales**, return 2xx only after durable acceptance, and return a successful response on identical retries. Store the key for at least seven days. Application replicas and timeout retries deliberately send the same key; the bundled receiver stores encrypted demo contact details in a separate global sales inbox. The request ID is bound to normalized form contents with HMAC so edited submissions become distinct operations. Rotating the webhook token also changes deduplication keys; avoid rotation during an active retry incident.

The client retains its ID and values during retries in the open page, locks concurrent submits, and generates a new ID when values change. Reloading the page starts a new request. The receiver may additionally deduplicate business leads by email according to sales policy.

The server has a 10-second delivery deadline and the client waits 15 seconds. Failures return 502 and retain form contents; no raw receiver error is sent to the visitor. Success returns 202 with `{ "accepted": true, "requestId": "..." }`. Validation returns 400 plus field messages; oversized bodies 413; unsupported content 415; untrusted origins 403; rate limits 429 with Retry-After; missing configuration/storage failure 503.

## Measurement and launch

Structured logs contain only `marketing_demo_accepted` or `marketing_demo_delivery_failed` and the opaque request ID. Count unique accepted IDs for conversions; retries can repeat an accepted log. Alert on sustained delivery failures and verify a controlled synthetic request reaches the sales destination before launch. Do not log bodies, contact fields, or tokens. No third-party tracking/cookies were added. Compare conversion only after establishing a real traffic baseline.

The draft replaces the rendered website-only Privacy content only when `MCA_LEGAL_DRAFT_PAGES_ENABLED=true`; otherwise the approved notice remains behind its existing publication gate. The dedicated production receiver is `/api/marketing/receiver`. Production billing, integration activation, and release acceptance remain separate work; this site does not advertise integration counts, pricing, customer endorsements, certifications, or guaranteed outcomes.

## Product images

Captures use the actual application with synthetic records. New captures use the Supabase HTTP auth fixture and a disposable local Postgres database; the six original captures predate the Supabase migration. No production data or live providers are used. Generate that environment with:

```sh
MCA_TEST_DATABASE_ADMIN_URL=postgresql://USER@127.0.0.1:PORT/postgres \
MCA_MARKETING_PREVIEW=true MCA_TEAM_PREVIEW=true MCA_SUBMISSIONS_PREVIEW=true \
node --conditions=react-server --import tsx tests/helpers/supabase-preview.mjs
```

The harness prints a synthetic development login for `http://localhost:3010`. Use the browser to capture the pipeline, application, underwriting, submissions, offers, reports, renewals, and team screens. The pipeline capture uses the eight MCA-21xx deals, with synthetic contact details and a 100% owner completed through the existing deal-edit API before capture; the earlier application capture intentionally shows a partial intake record. `scripts/marketing/seed-preview.mjs` refuses non-test database names. Stop the harness with SIGTERM/SIGINT to close its local auth fixture and drop its disposable database. Image assets live in `public/marketing/`; the visible captions identify illustrative data.

## Verification

```sh
node --conditions=react-server --import tsx --test tests/marketing-demo.test.ts
node --experimental-test-module-mocks --conditions=react-server --import tsx --test tests/marketing-demo-form.test.ts tests/marketing-demo-storage.test.ts tests/migration-branch-merge.test.mjs
pnpm typecheck
pnpm lint
pnpm build
```

The demo tests cover database persistence, duplicate request IDs, best-effort notification with a mocked UseSend API, fallback copy, accepted webhook delivery, normalized payloads, receiver deduplication and ambiguous retries, validation, honeypot, body limits, rate rejection, cross-origin requests, failed configuration/storage, provider errors and aborts. Browser checks cover desktop/tablet/390px, keyboard workflow controls, no-JavaScript navigation/FAQ, demo states, redirects and metadata. Test external sales acceptance only with a controlled synthetic address. No live sales message is sent by the test suite.


## Bundled receiver and private sales inbox

Migration `0023_marketing_demo_requests` adds a global inbox separate from tenant deals. `POST /api/marketing/receiver` requires the demo bearer token, validates the envelope and matching idempotency header, and encrypts contact details using the existing application encryption key with the request ID as authenticated context. PostgreSQL atomically deduplicates concurrent deliveries; conflicting payloads fail closed. A deleted inquiry keeps a deduplication tombstone, so retries do not restore contact details. Neither endpoint logs contact details. There are no automated sales messages, customer-workspace imports, or CRM triggers.

Authorized operators review the inbox from Render’s private service shell:

```sh
node marketing-inbox.cjs list
node marketing-inbox.cjs show <opaque-request-id>
node marketing-inbox.cjs delete <opaque-request-id>
```

`list` displays only IDs and timestamps. `show` decrypts contact data: use it only in the private shell and do not copy its output to shared logs or tickets. `delete` removes the encrypted contact payload and preserves the retry tombstone. Operators should review new inquiries and delete contact details when no longer needed. Outbound contact requires a separate operator decision; intake itself sends nothing.

The demo receiver uses `MCA_DEMO_WEBHOOK_URL`, `MCA_DEMO_WEBHOOK_TOKEN`, and `MCA_MARKETING_PRIVACY_URL`. The receiver and sender share the generated token. `/privacy` serves the draft only with the draft flag; otherwise the existing approved-notice publication gate applies. The demo form remains disabled until all three values are configured and the configured notice is eligible.


## Luro design adaptation (September 13, 2026)

The supplied Luro AI template guides the centered hero, violet glow, framed product preview, rounded feature grid, and dark surfaces. Fundlane retains its logo and Manrope heading font. The template’s authentication, database, paid plans, customer logos, testimonials, and social-media content were not imported. Reused design attribution is in `licenses/luro-ai-MIT.txt` (Shreyas Sihasane, 2024).

`src/components/marketing/catalog.ts` is the shared typed feature catalog. All eleven homepage cards link to stable anchors on `/features`; all eleven categories have benefit copy, capabilities, and either an actual synthetic capture or a labeled illustrative workflow. `FeatureVisual` renders these as ordinary server-rendered figures and definition lists, not live controls or fabricated assistant outputs. Images are lazy below the hero, have full-size links, and carry descriptive alt text. Native radio controls, anchor navigation, and FAQ details remain usable without JavaScript. The public routes do not mount PWA controls or change the application’s saved theme.

### Copy evidence and availability

| Category | Source of implementation evidence |
| --- | --- |
| Pipeline / intake | `src/lib/mca/deals/`, `intake/`, `imports/`, `documents/` |
| Underwriting / matching | `src/lib/mca/underwriting/`, `funders/` |
| Submissions / automation | `src/lib/mca/submissions/`, `underwriting/analysis.ts`; current Linear MIC-148 and its MIC-164/MIC-163/MIC-166 dependencies |
| Offers / closing / renewals | `src/lib/mca/closing/`, `offers/`, `renewals/` |
| Communication | `src/lib/mca/comms/`, `sms/`, `senders/` |
| Assistant | `src/lib/mca/assistant/operations.ts`, `experience.ts`, `hosted-tools.ts`; assistant capability flags and credits apply |
| Reporting / team | `src/lib/mca/reports/`, `accounting/`, memberships and financial visibility policy |

Production integration readiness is separate from code presence; current Linear MIC-96 remains a release acceptance gate. Copy explicitly qualifies automatic sending, signature delivery, SMS activation, AI capabilities/credits, and financial permissions. Matching is not an approval prediction. No public prices, approval guarantees, customer endorsements, or certification claims were added.

### Additional captures

`offers.png` shows Northside Kitchen (MCA-2103) with a local manual offer added through the real UI: Example Capital, Working capital, $60,000, factor 1.30, buy rate 1.20, 6 months, $600 daily, $6,000 commission, zero fee, and two illustrative stipulations (signed application and voided business check). This is synthetic illustrative data, not an advertised financing offer. The capture includes the offer panel, not browser chrome or the test account identity. No offer was sent or selected for funding.

`reporting.png` shows the real rep-funnel report for the same disposable fixture. It deliberately retains the application’s incomplete-period, unknown-value, and restricted-financial-visibility labels. It does not imply actual customer results. Communication, matching, and assistant details remain labeled illustrations rather than screenshots of unactivated services.

### Redesign verification

PR validation against the latest main passes typecheck, production build, full-repository lint (existing warnings only), and all seven marketing demo API tests.

Browser verification covers desktop (1440px), tablet (768px), mobile (390px), feature anchors, all five workflow stages via keyboard, mobile navigation, FAQ keyboard expansion, and demo unavailable/validation/failure/retry/success states. Form success/failure checks use a temporary local fixture and mock receiver; no live sales request is sent. Homepage workflow/FAQ and feature navigation were also exercised with a `script-src 'none'` response policy. The temporary fixture and proxy are not shipped. The signed-in dashboard retains its existing light theme after visiting dark marketing pages.


## Dark marketing redesign (September 14, 2026)

The homepage uses a full-height architectural hero, square white “Book a demo” links, an illustrative selectable deal-activity table, all eleven feature categories, and a four-cell product-count grid. The first three feature cards illustrate document review, funder criteria, and offer revisions. Existing five-stage workflow controls and FAQ remain native HTML. Features, Demo, and the published Privacy page share the same black palette, borders, and typography. Demo links still open the request form; there is no calendar booking integration.

Marketing fonts are self-hosted in `public/fonts/marketing/`: Inter Display Medium, Geist Regular, and Geist Mono Regular, with their SIL licenses. Inter body typography continues to use the app's existing font. Marketing font variables and styles live on `.fundlane`; dashboard theme state is untouched. Status pills have 100px corners; buttons have zero-radius corners. Blue is `#52a8ff`, positive green is `#62c073`, and other surfaces/text use the specified neutrals.

`ActivityStream` contains synthetic records and illustrative minute-based timings, not measured processing performance or a live deal feed. Selecting a record changes the status and timeline; selecting a step highlights its bar. The table scrolls horizontally within its own region on small screens. Metrics describe product structure (11 categories, 5 stages, 3 submission modes, 1 workspace), not customer outcomes. Provider and permission qualifications remain in the feature cards.

`MobileNav` progressively enhances native details with Escape handling, keyboard focus wrap/restoration, scroll locking, and desktop-resize cleanup. Without JavaScript, the full-screen menu still opens and its ordinary links navigate; workflow radio controls and FAQ details remain usable. Demo requests continue to require JavaScript and retain the existing API contract.

### Hero asset provenance

`public/marketing/architecture-hero.png` was generated with the built-in image-generation tool. Final prompt:

> Use case: ads-marketing. Asset type: full-bleed website hero background for Fundlane, an MCA brokerage workspace. Create a sophisticated photoreal architectural abstraction: monumental brushed black metal and charcoal concrete fins forming a precise ascending corridor, dramatic oblique perspective, refined financial-district architecture, deep black shadows, fine metallic edges. Wide landscape composition, architecture concentrated in upper and right portions, lower left quiet and dark for white headline overlay. Monochrome black/gray/white with restrained blue #52a8ff light on a few edges. Premium editorial architectural photograph, crisp material detail, no people, no text, no logos, no watermark. 16:9 landscape.

The decorative image uses Next Image with preload, cover sizing, the specified bottom scrim, and a supplemental top gradient for header contrast. Product captures retain their synthetic-data captions.

### Verification for this redesign

Targeted marketing ESLint, typecheck, production build, and all seven marketing demo API tests pass. Browser checks cover 1440px desktop, 768px tablet, and 390px mobile: eleven cards, feature anchor navigation, contained table overflow, deal selection and step highlighting, square CTAs, pill status indicators, and menu focus wrap/Escape/scroll restoration. An isolated local bundle of the existing DemoForm verified field validation, delivery failure, retained values, successful retry, and reuse of the same request ID. No request reached a sales receiver. A local proxy with `script-src 'none'` verified the native mobile menu, workflow selection, and FAQ expansion.

Final production-preview checks also verified the published Privacy page with its existing public URL gate, all five workflow stages by keyboard, and 720×450 CSS-pixel reflow (equivalent to 200% zoom on 1440×900). The hero grows beyond the viewport height and the page remains horizontally contained. Dashboard isolation was reviewed through marketing-only font/style scoping and absence of theme-state writes; no authenticated dashboard session was used for this redesign.

Merge validation on a clean branch from main (September 15, 2026): typecheck, production build, all seven marketing demo API tests, and full-repository lint pass (16 existing warnings, zero errors). Refreshed the graph and HTML from this isolated checkout.
# Help and public status release switches

`MCA_HELP_CENTER_EXPANDED_ENABLED=true` adds the team seats and billing guides to `/help` and its sitemap. It also shows the approved onboarding email prompt when `MCA_SUPPORT_EMAIL` is a valid address. Unset or any other value preserves the four existing guides and copy.

`MCA_PUBLIC_STATUS_PAGE_ENABLED=true` publishes `/status`, makes the footer and Help “System status” links point there, and adds the exact route to the anonymous page gate, sitemap, and robots allowance. Unset or any other value returns 404 for `/status`. If `NEXT_PUBLIC_STATUS_PAGE_URL` is configured, its existing footer and Help links remain as they are while the new flag is off. When the flag is on, the validated external URL appears as an optional link on `/status`.

The public page says the served website page is available and checks database reachability with a bounded application-pool query. The database result and check time are cached for 60 seconds. These checks do not provide historical uptime or measure workers, Stripe, email, or complete transactions. No external status service, incident publishing, phone support, or outbound messaging is included. Flag enablement, copy approval, and hosted preview acceptance are later release decisions.

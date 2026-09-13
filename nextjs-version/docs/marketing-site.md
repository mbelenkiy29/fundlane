# Fundlane marketing site

The public homepage is `/`; `/landing` permanently redirects to it. `/demo` hosts the sales-assisted request flow. Authentication and `/dashboard` retain their existing routes. PWA registration/update prompts mount only in the authenticated dashboard layout. The global loading boundary was removed so public pages render without hydration; the dashboard retains its existing loading skeleton. Marketing pages use a scoped dark violet palette without changing the saved application theme. The homepage tells the five-stage application-to-renewal story; `/features` covers all eleven product categories with stable anchors, and `/demo` retains the existing sales-assisted form. The shared shell also styles the published privacy notice.

## Enable demo requests

Configure these server-only values in the intended deployment:

- `MCA_DEMO_WEBHOOK_URL`: dedicated HTTPS sales receiver URL. Redirects and embedded URL credentials are rejected.
- `MCA_DEMO_WEBHOOK_TOKEN`: bearer credential for that receiver.
- `MCA_MARKETING_PRIVACY_URL`: HTTPS URL of the approved privacy notice. Do not point this at a placeholder page.

All three must be valid before the form accepts requests. With missing configuration, the form is visibly unavailable and its API returns 503. There is no preview-success mode. The homepage privacy link is rendered at build time; rebuild after configuring it. `/demo` reads configuration at request time.

The existing Neon `request_rate_windows` table provides shared limits across application instances: five attempts per client address per minute and 120 total attempts per minute. Configure the ingress to overwrite forwarded client-address headers. Rate-store outages fail closed. No new migration is needed. The endpoint also validates same-origin browser requests, content type, an actual 12 KB streamed body limit, allowed fields, and a honeypot. Do not reuse this anonymous endpoint for authenticated merchant intake.

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

The approved website/demo privacy notice is published at `/privacy` for Sentinel Tech Solutions LLC, with privacy contact `ben@sentineltechsolutions.io`. The operator approved the notice on September 11, 2026. The dedicated production receiver is `/api/marketing/receiver`. Production billing, integration activation, and release acceptance remain separate work; this site does not advertise integration counts, pricing, customer endorsements, certifications, or guaranteed outcomes.

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
pnpm typecheck
pnpm lint
pnpm build
```

The demo tests cover accepted delivery, normalized payloads, receiver deduplication and ambiguous retries, validation, honeypot, body limits, rate rejection, cross-origin requests, failed configuration/storage, provider errors and aborts. Browser checks cover desktop/tablet/390px, keyboard workflow controls, no-JavaScript navigation/FAQ, demo states, redirects and metadata. Test external sales acceptance only with a controlled synthetic address. No live sales message is sent by the test suite.


## Bundled receiver and private sales inbox

Migration `0023_marketing_demo_requests` adds a global inbox separate from tenant deals. `POST /api/marketing/receiver` requires the demo bearer token, validates the envelope and matching idempotency header, and encrypts contact details using the existing application encryption key with the request ID as authenticated context. PostgreSQL atomically deduplicates concurrent deliveries; conflicting payloads fail closed. A deleted inquiry keeps a deduplication tombstone, so retries do not restore contact details. Neither endpoint logs contact details. There are no automated sales messages, customer-workspace imports, or CRM triggers.

Authorized operators review the inbox from Render’s private service shell:

```sh
node marketing-inbox.cjs list
node marketing-inbox.cjs show <opaque-request-id>
node marketing-inbox.cjs delete <opaque-request-id>
```

`list` displays only IDs and timestamps. `show` decrypts contact data: use it only in the private shell and do not copy its output to shared logs or tickets. `delete` removes the encrypted contact payload and preserves the retry tombstone. Operators should review new inquiries and delete contact details when no longer needed. Outbound contact requires a separate operator decision; intake itself sends nothing.

Render stores `MCA_DEMO_WEBHOOK_URL`, `MCA_DEMO_WEBHOOK_TOKEN`, and `MCA_MARKETING_PRIVACY_URL`. The receiver and sender share the generated token. The Docker build explicitly accepts the non-secret privacy URL so the static homepage footer includes it; tokens are runtime-only. `/privacy` remains unpublished unless the configured privacy URL points to it.


## Luro design adaptation (September 13, 2026)

The supplied Luro AI template guides the centered hero, violet glow, framed product preview, rounded feature grid, and dark surfaces. Fundlane retains its logo and Manrope heading font. The template’s authentication, database, paid plans, customer logos, testimonials, and social-media content were not imported. Reused design attribution is in `licenses/luro-ai-MIT.txt` (Shreyas Sihasane, 2024).

`src/components/marketing/catalog.ts` is the shared typed feature catalog. The six homepage cards link to stable anchors on `/features`; all eleven categories have benefit copy, capabilities, and either an actual synthetic capture or a labeled illustrative workflow. `FeatureVisual` renders these as ordinary server-rendered figures and definition lists, not live controls or fabricated assistant outputs. Images are lazy below the hero, have full-size links, and carry descriptive alt text. Native radio controls, anchor navigation, and FAQ details remain usable without JavaScript. The public routes do not mount PWA controls or change the application’s saved theme.

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

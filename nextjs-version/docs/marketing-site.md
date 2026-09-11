# Fundlane marketing site

The public homepage is `/`; `/landing` permanently redirects to it. `/demo` hosts the sales-assisted request flow. Authentication and `/dashboard` retain their existing routes. PWA registration/update prompts mount only in the authenticated dashboard layout. The global loading boundary was removed so public pages render without hydration; the dashboard retains its existing loading skeleton. Marketing pages use their own light palette without changing the saved application theme.

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

**The receiver must atomically deduplicate Idempotency-Key before persisting a lead or notifying sales**, return 2xx only after durable acceptance, and return a successful response on identical retries. Store the key for at least seven days. Application replicas and timeout retries deliberately send the same key; this application does not store lead/contact data or own a sales queue. The request ID is bound to normalized form contents with HMAC so edited submissions become distinct operations. Rotating the webhook token also changes deduplication keys; avoid rotation during an active retry incident.

The client retains its ID and values during retries in the open page, locks concurrent submits, and generates a new ID when values change. Reloading the page starts a new request. The receiver may additionally deduplicate business leads by email according to sales policy.

The server has a 10-second delivery deadline and the client waits 15 seconds. Failures return 502 and retain form contents; no raw receiver error is sent to the visitor. Success returns 202 with `{ "accepted": true, "requestId": "..." }`. Validation returns 400 plus field messages; oversized bodies 413; unsupported content 415; untrusted origins 403; rate limits 429 with Retry-After; missing configuration/storage failure 503.

## Measurement and launch

Structured logs contain only `marketing_demo_accepted` or `marketing_demo_delivery_failed` and the opaque request ID. Count unique accepted IDs for conversions; retries can repeat an accepted log. Alert on sustained delivery failures and verify a controlled synthetic request reaches the sales destination before launch. Do not log bodies, contact fields, or tokens. No third-party tracking/cookies were added. Compare conversion only after establishing a real traffic baseline.

Approved privacy information and the production sales destination are external launch inputs. Production billing, integration activation, and release acceptance remain separate work; this site does not advertise integration counts, pricing, customer endorsements, certifications, or guaranteed outcomes.

## Product images

Captures use the actual application in a disposable Neon database and Clerk development workspace with synthetic records. Generate that environment with:

```sh
MCA_MARKETING_PREVIEW=true MCA_TEAM_PREVIEW=true MCA_SUBMISSIONS_PREVIEW=true node --env-file=.env.local --conditions=react-server --import tsx tests/helpers/clerk-preview.mjs
```

The harness prints a synthetic development login for `http://localhost:3010`. Use the Playwright CLI to capture the pipeline, application, underwriting, submissions, renewals, and team screens. The pipeline capture uses the eight MCA-21xx deals, with synthetic contact details and a 100% owner completed through the existing deal-edit API before capture; the earlier application capture intentionally shows a partial intake record. `scripts/marketing/seed-preview.mjs` refuses non-test database names. Stop the harness with SIGTERM/SIGINT to delete its temporary Clerk user/organization and disposable database. Image assets live in `public/marketing/`; the visible captions identify illustrative data.

## Verification

```sh
node --conditions=react-server --import tsx --test tests/marketing-demo.test.ts
pnpm typecheck
pnpm lint
pnpm build
```

The demo tests cover accepted delivery, normalized payloads, receiver deduplication and ambiguous retries, validation, honeypot, body limits, rate rejection, cross-origin requests, failed configuration/storage, provider errors and aborts. Browser checks cover desktop/tablet/390px, keyboard workflow controls, no-JavaScript navigation/FAQ, demo states, redirects and metadata. Test external sales acceptance only with a controlled synthetic address. No live sales message is sent by the test suite.

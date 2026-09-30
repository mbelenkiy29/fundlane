# AI Assistant and company credits

The sidebar **AI Assistant** tab (`/assistant`) is the read-only ChatKit workspace (same engine as the header drawer). The write-capable Deal Assistant remains above the tabs in each selected deal. Deal-sheet conversations can search permitted deals, summarize the visible pipeline, select a deal, create a draft, and update approved business/contact fields with optimistic version checks. Each request may mutate one deal; owner identity fields and assignments are excluded. It reads authorized deal sections, checks completeness, analyzes statements without replacing reviewed corrections, runs funder matching in `analyze_only` mode, and saves requested notes. Private conversations are bound to their user and company. Optional deal conversations retain their original history. Access to every referenced deal is rechecked before history display, model context, tools, and approvals.

Merchant SMS, funder reminder email, and funder submissions use the existing MCA services. The agent prepares a preview and pauses through the OpenAI Agents SDK. Only an explicit confirmation in the application approves the stored action. A new recipient, sender, content, document set, or preflight outcome invalidates the preview. Unsupported channels receive drafts; there are no tools for deletion, financial decisions, administration, bulk operations, or code execution.

## Configuration and release

Existing assistant tables and credit accounting are already in the checked Drizzle migration chain. Follow the Supabase migration release procedure in the app README for an approved environment. This runtime change adds no migration. Historical requests are never charged.

Configure these variables in the app's ignored local environment or deployment secret store:

| Variable | Behavior |
| --- | --- |
| `MCA_ASSISTANT_ENABLED` | Exactly `true` enables the assistant. Default: disabled. |
| `OPENAI_API_KEY` | Server-only OpenAI project key. Never expose through a public environment variable. |
| `MCA_ASSISTANT_MODEL` | Explicit Responses-compatible model with function calling. No implicit model fallback. |
| `MCA_DATA_ENCRYPTION_KEY` | Existing workspace encryption key, mandatory in production. |
| `MCA_STRIPE_BILLING_ENABLED` | Uses server-verified Stripe company entitlements when exactly `true`. Disabled billing receives Free allowances; provider verification errors never grant paid credits. |
| `MCA_AI_CREDIT_PURCHASES_ENABLED` | Only exactly `true` enables new credit-pack Checkout when all required settings are present. Unset, `false`, and other values default to off; balance, usage, and alerts remain available. Test with Stripe test credentials before activation. |
| `STRIPE_SECRET_KEY` | Server-only Stripe key shared with company billing for credit Checkout and existing-purchase reconciliation. Keep configured after disabling purchases while sessions, refunds, or disputes may remain. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for `/api/webhooks/stripe-credits`; keep it configured when the flag is off to verify and process already-paid sessions, refunds, and disputes. |
| `MCA_APP_ORIGIN` | Canonical application origin required for Checkout returns and credit-alert links. |
| `MCA_EMAIL_WEBHOOK_URL` / `MCA_EMAIL_WEBHOOK_TOKEN` | Existing transactional email adapter, extended for `ai_credit_alert`. |

Statement analysis separately retains `MCA_DOCUMENT_AI_PROVIDER` and `MCA_DOCUMENT_AI_MODEL`. SMS and email retain their current provider readiness, sender assignment, consent, and preflight requirements. Configuring chat alone does not enable those providers.

Before rollout, run the isolated tests below and a live synthetic deal scenario with the chosen model: summarize, check documents, analyze matches, save a note, and prepare/reject a send. Only send to controlled test destinations when verifying delivery. Fixture success does not establish live model quality or provider readiness. Turn the feature flag off to prevent new agent operations; already accepted delivery jobs keep their normal lifecycle.

## HTTP contract

- `GET /api/mca/assistant`: session-protected availability/configuration status, no secrets.
- `GET /api/mca/assistant/conversations`: private accessible conversation list.
- `POST /api/mca/assistant/conversations` with `{ dealId }`: opens the caller's conversation for an accessible deal; omitted or null `dealId` creates a workspace chat.
- `GET /api/mca/assistant/credits`: own balance, recent ledger and purchase availability.
- `GET/PATCH /api/mca/assistant/credits/admin`: admin-only team consumption, balances and alert settings. No chat content is included.
- `POST /api/mca/assistant/credits/checkout`: when purchases are enabled, an admin supplies selected active recipient and request UUID. The server fixes the pack at 100 credits for $10 USD, binds company/buyer/recipient, and returns hosted Checkout. With the flag off or incomplete configuration it returns 503 `purchases_disabled` before constructing a Stripe client.
- `POST /api/mca/assistant/credits/reconcile`: admin-only reconciliation of an existing purchase in the current company, including after new purchases are disabled. Return query parameters never grant credits by themselves.
- `GET/POST /api/mca/assistant/notifications`: current admin inbox/unread count and mark-as-read by ID. Reads and updates are scoped to the recipient and current company.
- `POST /api/webhooks/stripe-credits`: signed Stripe events are verified and existing purchases are reconciled even when new purchases are disabled. This prevents paid sessions from being lost after a flag rollback. With missing Stripe key or signing secret, the webhook returns 503; invalid signatures return 400.
- `GET /api/mca/assistant?conversationId=…`: returns up to 100 messages, latest run status, and its approval cards/outcomes. No serialized SDK state or tool credentials are returned.
- `POST /api/mca/assistant` accepts strict Zod commands: `{ action: "message", conversationId, requestId, message }`, `{ action: "decision", conversationId, approvalId, approve }`, or `{ action: "cancel", conversationId }`. Message and decision responses stream newline-delimited JSON events (`delta`, `progress`, `error`, `state`). Cancel returns saved state as JSON.

Requests enforce session authentication, trusted origins, current workspace/deal visibility, and conversation ownership. Each tool rechecks membership and deal access; messaging tools also use their existing permission gates. The client never supplies an actor or an action payload at approval time.

## Runtime and recovery

One active run per conversation is enforced in Postgres. Legacy invocations retain a 175-second deadline. Version 2 requests have five minutes of cumulative active execution time across all resumptions, excluding time waiting for a user. Both versions enforce 12 model turns per paid request and a 3,000-token main-answer cap. Limits are 12 requests per user and 60 per workspace per minute. Pending approvals and clarification questions expire after 24 hours. Closing, navigating away, or stopping aborts the active stream and prevents subsequent tool calls. Statement processing checks cancellation between documents and before persisting.

Completed operations remain saved if later operations fail. Interrupted answers are marked as partial. An external action is atomically claimed before delivery; duplicate clicks or resumes cannot execute it again. Actions left `executing` after a process loss and actions recorded `uncertain` must be investigated in the domain delivery records. They are never automatically retried. Identical previously attempted previews are blocked from being prepared again; intentional repeat sends use the existing manual workflow.

Messages, tool results, approval payloads, previews, and serialized SDK state use workspace-bound AES-GCM encryption. SDK tracing is disabled and OpenAI requests set `store: false`. Local usage totals are kept on runs; errors omit provider response bodies. History currently follows the database backup/retention lifecycle; this release adds no automatic history deletion job. Cancellation does not delete history.

## Verification

From `nextjs-version/`, with a disposable local PostgreSQL test database configured:

```sh
node --experimental-test-module-mocks --conditions=react-server --import tsx --test --test-concurrency=1 tests/assistant.test.ts tests/assistant-credits.test.ts tests/billing.test.ts tests/billing-http.test.mjs tests/submissions-email.test.ts
pnpm typecheck
pnpm lint
pnpm build
```

Assistant tests run the real SDK loop and approval serialization with a scripted model and isolated database. They cover private history, rep/manager visibility, encrypted storage, exact previews, rejected and duplicate decisions, stale recipients/payloads, cancellation, revoked membership, uncertain delivery, internal analysis, submissions, reminders, HTTP boundaries, and partial provider failure. The scripted source-instruction scenario checks tool boundaries; live prompt-injection resilience still requires testing with the configured model.

## Credit accounting

Each active member has a separate company account. Free provides 10, Starter 100 and Team 250 monthly credits, according to verified Stripe company entitlements. Included allowances reset at the first of each calendar month, 00:00 UTC; lazy month creation uses that boundary and never rolls unused included credits over. Removing/rejoining retains the same account. Purchased credits carry forward and are spent after included credits.

One accepted user request reserves one credit under an account row lock. The first model invocation charges it once. History, polling, alerts, and paid approval continuations do not reserve another credit. Pre-execution failures release the reservation; definitive first-call HTTP rejection refunds once. Cancellation or uncertain transport after execution begins consumes the credit. Expired unstarted reservations are released by maintenance. Included credit use is capped by the current effective Stripe allowance. A monthly high-water grant and retained consumption prevent upgrade/downgrade cycles from refilling spent credits. Existing paid resumptions can finish at zero balance. Token counts are recorded separately on runs.

Stripe Checkout fixes the pack's currency, price, quantity, buyer, recipient and workspace on the server. Only fresh, verified successful payment state grants credits. Signed events and checkout returns reconcile under a purchase lock, making replay and delayed events idempotent. Partial refunds reverse a proportional number of credits rounded up; active/lost disputes reverse the pack. Won disputes restore the valid grant. Reversals of spent purchased credits create debt; later packs first offset that debt. Failed and expired checkouts grant nothing. No agent tool can initiate purchases.

## Admin alerts and durable email

All active company admins and super-admins receive private in-app warnings and exhausted alerts. The default warning threshold is 20% of monthly allowance remaining, configurable as a percentage or fixed number on `/assistant/credits`. The threshold is compared to usable included plus purchased credits. Credit balance events snapshot the threshold in the same transaction as each balance change. An ordered durable outbox preserves every warning, exhaustion and recovery episode, even when multiple requests or purchases complete before notifications are processed. Reservations alone do not produce premature warnings. A reset, purchase or upgrade above the threshold rearms the next episode.

In-app notifications and email jobs are generated without a model call. Notification or email failures cannot change a committed credit charge. The notification bell provides unread counts, persistent alert history and per-admin mark-as-read. Emails recheck both local admin membership and current verified Supabase user and local company membership immediately before delivery. Payloads contain only user name, company, allowance, remaining balances, reset date and a link with the company and recipient selected; no prompts or deal contents.

On Vercel Node, set `MCA_ASSISTANT_MAINTENANCE_ENABLED=true` only after staging acceptance, configure `CRON_SECRET`, and schedule one authenticated `GET /api/cron/assistant` each minute. The flag defaults off. This route releases expired reservations, performs experience cleanup when separately enabled, processes alert events, and then delivers queued email outside the single-consumer database lock. See [chatkit-assistant.md](chatkit-assistant.md) and [background-job-runtime.md](background-job-runtime.md) for hosted setup and rollback. The historical `scripts/assistant/worker.ts` remains for local proof or rollback; do not run it alongside the cron schedule.

The web process also attempts maintenance after responses; the worker provides recovery when no browser is open. This is account maintenance, not background delegation or recurring business automation. Monitor `mca_credit_alert_emails` states `queued`, `sending`, `sent`, `retry`, `failed`, `skipped` and `uncertain`. Known rejections and pre-delivery verification failures retry up to three attempts with backoff. Interrupted or uncertain sends are never automatically resent; investigate with the stable notification/delivery ID first. Missing email configuration leaves jobs queued and in-app alerts available. Exact-true transactional system-provider fallback with complete selected-provider credentials can claim these jobs without a webhook; definitive rejection retries and uncertain delivery never retries automatically.

The transactional webhook must support the `ai_credit_alert` template. Its JSON contract is `{ recipient, template, actionUrl, expiresAt, data }`, where `data` contains `workspaceId`, `userId`, `userName`, `companyName`, `included`, `purchased`, `total`, `allowance`, `resetAt` and `kind` (`low` or `exhausted`). Escape values in the email template. Honor the stable `idempotency-key` and `x-correlation-id` headers; return 2xx only when delivery has been accepted. Explicit 4xx rejection may be retried; network failure and 5xx are treated as uncertain. Never include authentication tokens or conversation data in these emails.

## Independent provider verification

Database/fixture success does not establish Stripe or email readiness. Before enabling live packs, configure Stripe test keys and signed test webhooks, run a hosted Checkout payment, delayed payment, replay, refund and dispute cycle, and verify the purchased ledger. Subscribe to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`, and `charge.dispute.created/updated/closed`. Verify the transactional email template separately with controlled admin addresses, including rejection and uncertain outcomes. Keep live purchases disabled until test-mode verification succeeds.

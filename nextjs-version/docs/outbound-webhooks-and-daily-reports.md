# Outbound webhooks and daily report email

GitHub issue #77. Workspace admins configure signed HTTPS workflow webhooks and opt in to a daily deal-activity email. The existing Milestone 6 tables and HMAC outbox remain the source of truth. This change wires writers, makes remove and the delivery log visible, and adds a runtime-agnostic scheduler contract.

## Webhooks

Admins manage endpoints on Settings → Connections (`WebhookConsole`).

Supported events:

- `offer.created` — offer writers call `emitOfferCreatedWebhook` after a successful insert
- `deal.transitioned` — labeled **Deal status updated** in the UI; fired from `transitionDeal`, bulk status updates, offer selection that moves a deal to `offer`, and funding confirm/reverse
- `deal.assigned` and `submission.created` remain available from assignment and submission writers

Deliveries:

- Durable enqueue is `mca_workflow_webhook_outbox` with unique `(workspace_id, endpoint_id, event_id)`
- HMAC `x-mca-webhook-signature: v1=<hex>` over `{unix_timestamp}.{body}`
- Automatic retries stop at five attempts; the delivery log is `mca_workflow_webhook_deliveries`
- Test POSTs do not mark workflow outbox rows delivered
- DELETE removes the endpoint and fails its pending outbox rows; historical deliveries stay visible

No schema migration is required. Tables already exist from `drizzle/0012_furry_ultimatum.sql`.

## Daily report email

Profile → Daily deal activity digest (`DigestSettings`) is the opt-in. Members choose timezone and local send hour (default 6:00 in the workspace timezone). Content is role-appropriate: administrators and API-key actors see workspace-wide deals they can access; reps and managers are filtered by `canActorAccessDeal`.

Replay of the same `(workspace, membership, window_start)` does not send twice.

## Scheduler contract (issue #35 still open)

Durable work is already stored. A stored outbox or digest subscription is **not** an independently scheduled worker.

`GET /api/cron/comms` uses the same `Authorization: Bearer ${CRON_SECRET}` contract as billing. It processes pending webhook outbox rows and due digest subscriptions across companies. Admins can also run `POST /api/mca/comms/jobs/run` for the current workspace.

What still depends on the background-runtime choice in #35:

- Who invokes `/api/cron/comms` on a clock (Vercel Cron, Supabase `pg_net` + `pg_cron`, or another host). This repo does **not** add a Render cron or worker for communications.
- Live mailbox delivery still needs `MCA_EMAIL_WEBHOOK_URL` (or a verified sender) in the selected environment.
- Reachable customer HTTPS destinations and stored signing secrets.

Do not treat the document worker on Render as the permanent comms runtime. Webhook HTTP is kicked with Next.js `after()` when a request context exists; retries and daily reports still need the chosen scheduler to call the cron route.

# SMS and email conversations

Users can text or email the primary contact saved on any deal they can access, including imported leads. Text and Email actions open the deal's Messages section; the merchant sheet has the same channels. `/sms` retains the existing SMS inbox. `/mail` is the real email inbox and replaces the template's demo data.

## Connect a work account

Open **Email inbox → Connect your work email**. Enter the exact Gmail or Microsoft account address, sender name and optional plain-text signature. Authorize that same account. Personal accounts are owned by the creating membership; only the owner can authorize or reconnect them. Administrators can share a sender and change company defaults in Settings → Connections. Shared members cannot replace credentials or grant themselves additional access.

Email conversation access requires both an active membership with current deal access and permission to use the selected merchant sender. Delivery workers rebuild those permissions from current database state immediately before dispatch. Removed assignments, revoked senders, inactive memberships and a changed saved recipient block queued messages. Replies stay attached to their original deal and recipient; changing a contact address requires starting a new conversation.

Google connections request `gmail.send`, `gmail.readonly` and the existing email identity scope. Microsoft connections request delegated `Mail.Send`, `Mail.Read`, `User.Read` and offline access. Existing grants without read scope show reconnect-required. The callback binds a single-use state to the initiating user and workspace, and rejects an account whose address differs from the saved sender.

Only individual plain-text conversations started in Fundlane and their replies are stored. Historical mailbox imports, unrelated messages, attachments, CC/BCC and bulk campaigns are not included. Personal mailbox deletes and read states are not changed. Fundlane unread markers are per member. Original SMTP/SendGrid, funder submission, transactional mail and SMS workflows retain their own delivery adapters.

## Storage and APIs

Migration `0036_email_conversations.sql` adds sender ownership, user-bound OAuth state, email conversations, encrypted messages, per-member read markers and sender worker leases. Conversation foreign keys include workspace identity. Message bodies, authors, recipients, subjects and OAuth credentials are encrypted using the existing workspace encryption key. Metadata, provider IDs, message references and worker timestamps remain queryable; logs contain operational counters rather than message content.

- `GET /api/mca/email/context?dealId=…`: saved recipient and authorized sender readiness.
- `GET /api/mca/email/conversations?dealId=…&cursor=…`: 25 authorized conversations per page, ordered by recent activity. `dealId` is optional.
- `POST /api/mca/email/messages`: `dealId`, `senderId`, `recipient`, `subject`, `body`, `idempotencyKey`; returns HTTP 202 with message ID, conversation ID and queued state.
- `GET /api/mca/email/conversations/:id?before=…`: latest 50 messages, with an older-history cursor.
- `POST /api/mca/email/conversations/:id`: reply body and idempotency key; the server derives sender, recipient, subject and thread references.
- `POST /api/mca/email/messages/:id/retry`: the original member can explicitly retry a definitive failure with the same message identity; unknown outcomes cannot be retried.
- `PATCH /api/mca/email/conversations/:id`: `{sequence}` marks only messages through the last rendered sequence as read.

Send requests are serialized for idempotency admission within the workspace; reusing a key with different content is a conflict. Delivery fields on message rows are the durable send queue. Conversation sync fields are durable recurring jobs. Leases serialize work per sender across multiple worker instances, with token-fenced writes and renewal before each provider request. A crashed `sending` row becomes `unknown` on recovery, never a fresh outbound attempt.

The sender's signature is pinned into each queued body. Successful Gmail/Graph send requests become `accepted`; reconciliation in Sent mail advances them to `sent`. Neither state promises recipient delivery or an open/read receipt. Unknown results are searched by unique RFC message ID or the app correlation header in Sent mail. A missing search result is not proof of non-delivery, so unknown messages are never blindly resent. Replies remain blocked in that conversation until the outcome is confirmed.

Inbound messages are fetched from known provider threads and must reference an already associated message with matching participants. A matching email address or provider thread ID alone is insufficient. This avoids importing older Gmail auto-grouped mail and unrelated mailbox content. Provider HTML is reduced to text and rendered as React text, never injected as HTML.

## Worker and deployment

Use the current Supabase/Postgres runtime. Apply all preceding checked migrations in order before migration 0036, then run the existing `db:secure` release command to grant the restricted `mca_app` role access to the new tables and sequence. The browser Supabase roles have no direct table access. Do not rotate the existing encryption key.

Required on both the web application and messaging worker:

- `DATABASE_URL`: restricted application role, same Supabase project.
- `MCA_DATA_ENCRYPTION_KEY`: same existing key.
- `MCA_APP_ORIGIN`: canonical HTTPS application origin.
- `MCA_GOOGLE_SENDER_CLIENT_ID` and `MCA_GOOGLE_SENDER_CLIENT_SECRET` for Google.
- `MCA_MICROSOFT_SENDER_CLIENT_ID` and `MCA_MICROSOFT_SENDER_CLIENT_SECRET` for Microsoft.
- OAuth callback: `${MCA_APP_ORIGIN}/api/mca/senders/oauth/callback`.

Register each OAuth application, configure the exact callback and complete provider consent/verification before broad use. Google's mailbox read scope is restricted; see [Gmail scope requirements](https://developers.google.com/workspace/gmail/api/auth/scopes). Reconnect a controlled pilot account with the required grants. Provider secrets belong in Vercel/Render secret configuration, not browser variables or source files.

Run `pnpm messaging:worker`; `--once` runs one bounded sender batch. `pnpm messaging:worker:build` bundles the production worker. `Dockerfile.messaging` builds an independent non-root Node 24 worker; `render.yaml` includes `fundlane-messaging-worker` with automatic deployment initially off. Use the reviewed application release commit for the web app and worker. This worker does not need an HTTP ingress, Redis, Supabase service-role key or document-scanning dependencies.

Normal reply polling is every 60 seconds; the UI refreshes visible conversation data every 15 seconds. Provider throttling honors Retry-After with bounded backoff. Rejected credentials mark the sender expired, retain queued work, and expose reconnection. SIGTERM stops claiming new conversations and drains the current operation; a hard interruption is recovered through leases and reconciliation.

Worker logs include queued/accepted/unknown/blocked, sync-failure, unsynced-conversation and expired-sender counts and oldest queued/synced timestamps. Monitor worker failures, queue age, missing or stale sync timestamps, expired sender connections, and unknown sends. A stopped worker leaves messages visibly queued. Operations can investigate provider Sent mail using the persisted correlation ID; do not turn an unknown message back into a queued message without conclusive evidence it was never sent.

## Verification and rollout status

Automated provider tests are synthetic and use the real application services against a newly created disposable PostgreSQL database. Run:

```sh
node --experimental-test-module-mocks --conditions=react-server --import tsx --test --test-concurrency=1 tests/email-conversations.test.ts tests/senders.test.ts tests/milestone06-sms-composer.test.ts tests/milestone05-sms.test.ts tests/sms-onboarding.test.ts tests/sms-adapters/twilio.test.ts
pnpm typecheck
pnpm lint
pnpm build
pnpm messaging:worker:build
```

Set `MCA_TEST_DATABASE_ADMIN_URL` to an isolated disposable cluster; never use the application database for tests. Tests cover two email providers, replies and deduplication, current permissions, signature snapshots, encrypted storage, unread markers, pagination, ownership, OAuth replay/address mismatch, refreshed tokens, throttling and uncertain-send recovery. Existing SMS tests cover consent, signed callbacks, number assignments and STOP.

Implementation verification passed all 67 targeted tests and the bundled worker's single-run smoke check against disposable PostgreSQL databases. Desktop and 390px mobile browser checks used synthetic contacts and confirmed conversation history, unread updates and queued replies; no live message was sent.

A live pilot additionally needs approved company SMS registration/number, explicitly opted-in test recipients, configured email OAuth clients and a running worker. Send email, verify its reply and original threading, then text, receive a reply, send STOP from the test recipient and verify suppression. Check failures/reconnect and worker restart recovery before enabling general use.

Release targets are GitHub `main`, the Vercel `fundlane` project at `https://fundlane.io`, and Supabase project `drubsfvhlggmtyiigwxy`. Predecessor migrations 0033–0035 were verified against their deployed Supabase hashes. Apply 0036 with server-role policies and sequence grants before deploying the web release. OAuth client setup and the messaging worker remain required for live sending and reply polling; local tests and browser fixtures do not prove live email/carrier delivery.

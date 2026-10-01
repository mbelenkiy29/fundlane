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

Use the current Vercel and Supabase runtime. Migration 0036 creates the conversation tables; apply additive migration `0063_email_conversation_runtime.sql` with the checked migration history and run `db:secure` as a reviewed release step. The browser Supabase roles have no direct table access. Do not rotate the existing encryption key.

Required on the Vercel web application and scheduled consumer:

- `DATABASE_URL`: restricted application role, same Supabase project.
- `MCA_DATA_ENCRYPTION_KEY`: same existing key.
- `MCA_APP_ORIGIN`: canonical HTTPS application origin.
- `SUPABASE_URL` and `SUPABASE_SECRET_KEY`: server-only credentials for the same Supabase project; retain `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` for browser Auth.
- `CRON_SECRET`: server-only bearer secret used by Vercel cron.
- `MCA_EMAIL_CONVERSATIONS_RUNTIME=vercel_cron`: enable the consumer only after pilot approval; unset or any other value returns `{enabled:false}` and performs no work.
- `MCA_GOOGLE_SENDER_CLIENT_ID` and `MCA_GOOGLE_SENDER_CLIENT_SECRET` for Google.
- `MCA_MICROSOFT_SENDER_CLIENT_ID` and `MCA_MICROSOFT_SENDER_CLIENT_SECRET` for Microsoft.
- OAuth callback: `${MCA_APP_ORIGIN}/api/mca/senders/oauth/callback`.

Before hosted setup, operators can run the deterministic offline configuration check with `MCA_EMAIL_SENDER_READINESS_ENABLED=true pnpm email-sender:readiness`. The command is guarded by `MCA_EMAIL_SENDER_READINESS_ENABLED`, which defaults off and must be exactly `true`; unset, `false`, and other spellings refuse execution before configuration is inspected or printed. It requires the runtime value `vercel_cron`, a canonical root-only HTTPS `MCA_APP_ORIGIN`, a nonblank `CRON_SECRET`, and a complete client-ID/client-secret pair for at least one provider. Any partially configured provider fails the check, even if the other provider is ready. Each provider reports `ready`, `not configured`, or `partial (missing ID or secret)`. It derives the exact callback `${MCA_APP_ORIGIN}/api/mca/senders/oauth/callback` from the production callback constant. The report exits nonzero for missing or invalid configuration and prints only readiness states plus the non-secret derived callback, never client IDs, client secrets, `CRON_SECRET`, database URLs, or encryption keys.

A passing report proves only local syntax and presence. It does **not** prove provider application registration, consent, mailbox access, migration or grant state, Vercel scheduling, or delivery. Google Cloud and Microsoft Entra setup, secret provisioning, migration review/application, schedule installation, pilot mailbox connection, and all hosted acceptance remain human-owned rollout steps.

In Google Cloud Console, register an OAuth web application with the exact authorized redirect URI `${MCA_APP_ORIGIN}/api/mca/senders/oauth/callback`, configure the consent screen and approve `gmail.send`, `gmail.readonly`, identity and offline access. Google's mailbox read scope is restricted; see [Gmail scope requirements](https://developers.google.com/workspace/gmail/api/auth/scopes). In Microsoft Entra, register a web redirect at the same URI and grant delegated `Mail.Send`, `Mail.Read`, `User.Read` and `offline_access`, then complete required tenant consent. Configure the corresponding client IDs and secrets in Vercel's server-only environment. Reconnect a controlled pilot account with the new read grants. Do not place provider secrets in browser variables or source files.

On an approved synthetic staging project, apply migration 0063 and verify the restricted role's grants. Deploy the reviewed revision to Vercel with the flag unset. Install exactly one Vercel cron schedule for `GET /api/cron/email-conversations` every five minutes (`*/5 * * * *`), using Vercel's `CRON_SECRET` bearer authentication; no `vercel.json` entry is committed. Set `MCA_EMAIL_CONVERSATIONS_RUNTIME=vercel_cron` only after checking that the historical Render worker, Supabase Messaging Edge schedule, and any manual `messaging:worker` process are stopped. Never overlap consumers during cutover. `Dockerfile.messaging`, `render.yaml`, and `pnpm messaging:worker` are historical/manual tools, not the active hosted schedule.

Normal reply polling is every 60 seconds; the UI refreshes visible conversation data every 15 seconds. Provider throttling honors Retry-After with bounded backoff. Rejected credentials mark the sender expired, retain queued work, and expose reconnection. SIGTERM stops claiming new conversations and drains the current operation; a hard interruption is recovered through leases and reconciliation.

The owner `/admin/status` page shows queued count/age, expired and revoked senders, sync failures, conversations not synced in five minutes, and the last completed cron tick. A missing tick or one older than ten minutes is marked stale. Monitor unknown sends separately. A stopped worker leaves messages visibly queued. Operations can investigate provider Sent mail using the persisted correlation ID; do not turn an unknown message back into a queued message without conclusive evidence it was never sent. Roll back by unsetting `MCA_EMAIL_CONVERSATIONS_RUNTIME` or removing the schedule; retain rows and inspect provider receipts before any manual replay.

For the hosted pilot, record the deployment revision and a dedicated Google/Microsoft test account identifier without message bodies or secrets. Connect or reconnect the sender, send a synthetic conversation, confirm Sent-mail reconciliation, receive a reply in `/mail`, revoke access and confirm the sender expires, then repeat through a worker restart and duplicate tick. Confirm queued, accepted, unknown and company-pause states. These provider and Vercel checks require hosted accounts and cannot be established by local mocks.

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


## Onboarding mailbox contract

`GET /api/mca/senders/readiness` is session-only and returns `cache-control: no-store`. `getMailboxReadiness(actor)` and `CompanyMailboxConnections({onChanged?})` are the reusable service and onboarding component; the main onboarding checklist owns its navigation. The service counts only authorized merchant Google/Microsoft senders, not submission or SMTP senders. `senders[].connection` is `connected`, `connect_required`, `reconnect_required`, or `disconnected`. Provider configuration and consumer state (`disabled`, `missing`, `stale`, `healthy`) are separate. A completed tick must be within ten minutes for consumer health; overall `ready` requires a locally usable grant, configured provider, and healthy consumer. This is configuration/connection readiness, not provider delivery acceptance or per-conversation success. No other company's counts or message data are returned.

Disconnect from the work-email component clears the local OAuth credential and pending authorization links while retaining conversation history and message identities. A callback already exchanging a token cannot restore a changed connection, and a cached Mailbox checks current credentials before each provider request. An already dispatched request may still complete; unknown outcomes retain Sent reconciliation identity and are never automatically resent. Disconnect does not revoke the consent grant at Google/Microsoft; account owners can additionally remove that grant in their provider account. Reconnect explicitly to resume sync.

These mailboxes use authenticated cron polling, not Gmail push/Graph webhook callbacks. Existing provider mocks verify both providers, Sent/reply association, duplicates, refresh/rejection, role/tenant access, uncertain recovery and disconnect races. Issue #38 still requires schedule activation and a real synthetic mailbox pilot. Issue #39 is the separate private intake/receipt/invitation provider activation path; no live setup, send or webhook admission was performed here.

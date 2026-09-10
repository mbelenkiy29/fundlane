# MIC-156 support for MIC-168: SMS routing and provider transport

Verified on 2026-09-08 against the live MIC-156 and MIC-168 requirements. This module supplies the SMS account, consent, routing, and transport boundary used by Closing. It does not claim that a production Twilio account is active.

## Implemented behavior

- Workspace administrators can register a Twilio phone number or Messaging Service by symbolic credential reference, assign it to one or more active members, select one workspace default, or revoke it. Revoking a default atomically clears its default flag, including when it is the only sender. Sender values are encrypted at rest and masked in API/UI responses. Credentials are never accepted by the API or stored in application tables.
- `MCA_SMS_TWILIO_ACCOUNTS_JSON` resolves by exact workspace ID and credential reference, and each entry declares its allowed sender identities. A matching reference in another workspace cannot reuse those credentials.
- Representatives can resolve and send only through assigned active accounts. The selected account and assignment are checked again while the account row is locked, which serializes sends with account revocation and reassignment.
- The recipient must match the deal's saved mobile number. Every initial attempt requires an append-only current opt-in. Manual opt-in/opt-out and signed Twilio Advanced Opt-Out `STOP`/`START` events are supported. `HELP` produces no consent change.
- The delivery row owns a stable workspace idempotency key and content hash. An accepted result requires a valid Twilio `SM` or `MM` identity. Provider 4xx responses become sanitized failures. 5xx, timeouts, malformed success responses, and response loss remain `unknown`.
- Closing calls `deliveryMode: "never_attempted"` for the first durable attempt and `deliveryMode: "reconcile_only"` after an uncertain/pending retry. Reconciliation is lookup-only and never creates or sends. A missing record returns `unknown` without a message ID, preventing a process crash from becoming a blind resend.
- Status callbacks use the configured HTTPS base URL and stable local message ID. Signatures follow Twilio's documented form algorithm, including bytewise key ordering and sorted unique duplicate values. Callback `AccountSid`, `MessageSid`, recipient, and sender are validated. The message is locked while the event and transition are written. Delayed `queued`/`sent` callbacks cannot regress `sent`/`delivered`; a verified `delivered` callback may resolve an earlier failure.
- Settings → Connections provides loading, empty, validation failure, success, account readiness, masked identity, default/revoke, and member assignment states. “Credentials absent” accounts fail closed. The panel provides no real-send control.

## Verification

`node --conditions=react-server --import tsx --test --test-concurrency=1 tests/milestone05-sms.test.ts`

- 9 tests passed using `tests/helpers/postgres-test-db.mjs` and a disposable Neon/Postgres database.
- Test coverage includes the official Twilio signature fixture, duplicate form parameters, exact outbound form data, sanitized 4xx errors, unknown transport outcomes, workspace-bound secrets, assigned/default routing, direct non-admin API denial, consent/opt-out, stable retry identity, reconcile-only absence, early callback binding, callback account/message/recipient identity, replay dedupe, delayed-state monotonicity, and concurrent callback processing.
- Scoped ESLint passed for `src/lib/mca/sms`, `src/app/api/mca/sms`, `src/components/mca/sms`, and `tests/milestone05-sms.test.ts`.
- Repository-wide TypeScript verification passed after the Closing integration was updated.

## Provider evidence and operational limits

Implementation follows Twilio's [Message resource](https://www.twilio.com/docs/messaging/api/message-resource), [API authentication](https://www.twilio.com/docs/usage/requests-to-twilio), [webhook signature validation](https://www.twilio.com/docs/usage/webhooks/webhooks-security), and [Advanced Opt-Out](https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out) documentation.

All provider calls in tests use injected synthetic transports. No real SMS was sent, no real credentials were present, and this lane did not apply a migration or mutate production rows. The release owner separately reports that `drizzle/0011_perfect_mandarin.sql` is applied in production.

## Activation contract

1. Set `MCA_SMS_PROVIDER=twilio` and `MCA_SMS_PUBLIC_BASE_URL` to the application's clean public HTTPS origin. User information, paths, query strings, fragments, and HTTP origins are rejected.
2. Store `MCA_SMS_TWILIO_ACCOUNTS_JSON` in the deployment secret store. Its shape is `{ "workspace-id": { "REFERENCE": { "accountSid": "AC…", "apiKeySid": "SK…", "apiKeySecret": "…", "authToken": "…", "allowedSenders": ["+12125551212", "MG…"] } } }`. Both the REST API key and webhook Auth Token are required.
3. In Settings → Connections, create the account with the same reference and one exact allowed sender, assign active members, and select a default where appropriate.
4. Configure Twilio's signed status callback and Advanced Opt-Out for the sender, then run a controlled provider smoke test with an authorized recipient. Confirm the stored Twilio message identity and callback progression before declaring the account active.

Missing or malformed credentials, a sender outside `allowedSenders`, or a non-origin callback base URL leaves the account marked **Credentials absent** and every attempted delivery fails closed without network access.

# MIC-156 report — SMS account routing and direct merchant texting

Completed remaining M6 scope on 2026-09-08. M5 Twilio routing, consent, status callbacks, Settings Connections, and `POST /api/mca/sms/messages` were left in place.

## Shipped

- Deal-level composer UI in `src/components/mca/sms/composer-panel.tsx`: loading, empty (no mobile / no assigned account), consent gate, assigned-account picker, exact preview, send, success/failure banners, and recent thread. Retries reuse the same idempotency key until an accepted result rotates it.
- `GET /api/mca/sms/messages?dealId=` now returns composer context (recipient, consent, assigned accounts, thread with bodies) on the deals page, not Settings → Connections. `POST` still sends; `preview: true` validates the exact payload without inserting or calling a provider.
- Outbound persistence writes `provider` from the selected account row. Sends go through `getSmsAdapter(provider)`. Twilio still resolves `MCA_SMS_TWILIO_ACCOUNTS_JSON` by workspace + credential reference + allowed sender. Injected Twilio transports remain for M5 tests and Closing.
- Rep send/preview through an unassigned account is `403 sms_account_not_assigned`. Opt-out is `409 sms_recipient_opted_out`. Recipient must match the deal mobile number.

## Verification

`node --conditions=react-server --import tsx --test --test-concurrency=1 tests/milestone06-sms-composer.test.ts tests/milestone05-sms.test.ts`

No live SMS. Secrets are env-bound and excluded from composer JSON.

## Remaining gate

Live Twilio / handset. Mock adapter success is not production delivery.

## Handoff

Conductor must mount `SmsComposerPanel` on the deal workspace. Do not edit `deals-workspace.tsx` from this ticket.

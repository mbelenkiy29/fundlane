# MIC-190 report — Twilio SMS provider adapter

**Linear:** https://linear.app/michael-belenkiy/issue/MIC-190/twilio-sms-provider-adapter
**Status:** implemented locally with synthetic fixtures. Conductor registers the adapter; do not mark Linear Done from this agent.

## What shipped

Extracted the M5 Twilio transport and form-signature helper behind `SmsAdapter` in `src/lib/mca/sms/adapters/twilio`. `src/lib/mca/sms/twilio.ts` is a compatibility re-export so existing M5 imports keep compiling.

- `validate` returns field errors for Account SID, API key SID, API key secret, and at least one sender identity (E.164 sending number or Messaging Service SID `MG…`).
- `send` uses fixture outcomes for the synthetic Account SID and the extracted Messages API client when a fetch implementation is injected. Missing API credentials are `twilio_unconfigured`. Correlation id retries reuse the first result and do not invent a second `SM`/`MM` identity.
- `parseStatus` maps Twilio status callbacks (`MessageSid`, `MessageStatus`, `ErrorCode`, `To`, `From`) to a stable `eventKey`. Replay of the same payload is the same key.
- `parseInbound` maps Advanced Opt-Out `STOP`/`START` and ignores `HELP`.
- Signature validation remains the documented HMAC-SHA1 form algorithm, including sorted unique duplicate parameters. The official Twilio security fixture still verifies.
- Capabilities: `send`, `statusCallbacks`, `inbound`, `optOut` are all true.

Did not edit `sms/adapters/registry.ts` or `sms/service.ts`.

## Files

- `src/lib/mca/sms/adapters/twilio/index.ts`
- `src/lib/mca/sms/adapters/twilio/mapping.ts`
- `src/lib/mca/sms/adapters/twilio/fixtures.ts`
- `src/lib/mca/sms/twilio.ts` (re-export shim)
- `tests/sms-adapters/twilio.test.ts`
- `docs/milestone-06/MIC-190-report.md`
- `docs/milestone-06/MIC-190-acceptance.md`

## Checks

```bash
cd nextjs-version && node --conditions=react-server --import tsx --test --test-concurrency=1 tests/sms-adapters/twilio.test.ts tests/milestone05-sms.test.ts
```

8 adapter tests and 9 M5 SMS tests passed. ESLint clean on exclusive files. No live SMS. Fixtures and injected fetch only. Secrets are not copied into delivery results or sanitized 4xx messages.

## Remaining gate

Live Twilio account, sender registration, and handset delivery. Fixture acceptance is not production integration readiness.

## Handoff

Import `twilioSmsAdapter` in `src/lib/mca/sms/adapters/registry.ts` and replace the inline legacy adapter. Keep `sms/twilio.ts` until M5 imports are switched to `sms/adapters/twilio`.

# SMS adapter ticket template (MIC-185, MIC-187–MIC-191)

Each adapter ticket is the same shape. Implement only `src/lib/mca/sms/adapters/<slug>/**` and `tests/sms-adapters/<slug>.test.ts` plus your report/acceptance docs.

Twilio (MIC-190) is the gold template. Copy its file layout, then change mapping, fixtures, and capability flags.

## Locked rules

- Implement `SmsAdapter` from `src/lib/mca/sms/contracts.ts`.
- Do not edit `registry.ts`. The conductor registers the slug after review.
- Do not call live provider APIs. Use synthetic fixtures in `fixtures.ts`.
- Do not copy MCA Pilot endpoints, IPs, or sample credentials. Use public provider docs only.
- Capability flags must be honest. If delivery webhooks are undocumented, `statusCallbacks: false`.
- `validate` returns field errors for the credential fields listed on the Linear ticket.
- `send` is idempotent on the caller’s message identity. Timeouts and repeated fixtures must not invent a second external id.
- Secrets passed in `SmsAdapterSendInput.credentials` are never logged.
- Remaining gate: commercial provider sandbox access. Mock success is not production verified.

## Files

```
src/lib/mca/sms/adapters/<slug>/index.ts
src/lib/mca/sms/adapters/<slug>/mapping.ts
src/lib/mca/sms/adapters/<slug>/fixtures.ts
tests/sms-adapters/<slug>.test.ts
docs/milestone-06/<MIC>-report.md
docs/milestone-06/<MIC>-acceptance.md
```

## Tests

- required-field rejection
- accepted send
- rejected-number
- timeout / unconfigured credential
- retried status callback updates the existing message without a duplicate row (skip if `statusCallbacks` is false and document why)
- capability flags match what you implemented

## Credential fields (from Linear)

| Slug | Ticket | Fields |
| --- | --- | --- |
| entrance | MIC-185 | customer login email, API secret/password |
| texttorrent | MIC-187 | API key, secret, sending number |
| textus | MIC-188 | account email, API key |
| openphone | MIC-189 | API key, user, sending number |
| twilio | MIC-190 | API credentials, Messaging Service SID, sending number |
| gohighlevel | MIC-191 | Private Integration Token, Location ID |

# MIC-154 report — Manual funder reminders in the original email thread

**Status:** DONE locally with synthetic fixtures. Live mailbox send remains an external gate.

## Contract

`RemindFunder` lists unanswered **email** submission jobs on a deal. API, portal, and webhook jobs are returned with `remindControl: "hidden"` and `eligible: false`. Preview and send reject those transports with `409 reminder_unsupported_transport`. A matched/processed/pending_review funder reply hides the control (`409 reminder_already_responded`).

Preview (`POST /api/mca/comms/reminders/preview`, `deals:read`) prefills `DEFAULT_REMINDER_BODY`, original To/CC/from, and `Re:` subject. When the stored attempt has Message-ID / thread metadata (MIC-153 `external_ref`), the reminder is a reply (`In-Reply-To` + `References`). When metadata is missing, `thread.mode` is `fallback` and `THREAD_FALLBACK_DISCLOSURE` is returned.

Send (`POST /api/mca/comms/reminders`, `deals:write`) records `mca_funder_reminders` separately from the submission job. Accepted delivery (`sent` or non-production `preview`) sets `state = sent` and `last_reminded_at`. Failed transport sets `state = failed` and leaves `last_reminded_at` null. Submission `mca_submission_jobs.state` is never updated. Retry of the same `reminderId` after failure reuses `id` / `correlation_id`. Replay of an already-sent row does not send again.

Delivery injects `setReminderTransportForTests` or `setReminderDeliveryFetchForTests`. Without a webhook in non-production, delivery is the existing sender-style `preview` fixture. Production without a webhook fails. Webhook payloads use `template: "funder_reminder"` and omit credentials and file bytes.

Permissions: GET/preview `deals:read`; POST send `deals:write` + `assertTrustedMutation`. Same on session UI and API keys. Deal visibility matches the vault (`getDealForDocument`).

## Tests

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/milestone06-reminders.test.ts
```

3/3 passed.

Covered: original thread headers and recipients; status unchanged after send; last-reminded recorded on `mca_funder_reminders` only; API/portal/webhook 409 and hidden control; fallback disclosure; failed send is not a reminder and retry keeps identity; matched reply blocks a second send; `deals:read` preview 200 / send 403; `deals:write` send 200 / list 403; intake 403; cross-workspace 404; empty body 422; UI loading/empty/validation/success/failure copy; secrets omitted.

## Files

- `src/lib/mca/comms/reminders.ts`
- `src/app/api/mca/comms/reminders/route.ts`
- `src/app/api/mca/comms/reminders/preview/route.ts`
- `src/components/mca/comms/remind-funder.tsx`
- `tests/milestone06-reminders.test.ts`
- `docs/milestone-06/MIC-154-report.md`
- `docs/milestone-06/MIC-154-acceptance.md`

Did not edit submission jobs, `email-templates.ts`, `deals-workspace.tsx`, or schema.

## Remaining gates

Live SMTP / Google / Microsoft sending (`MCA_EMAIL_WEBHOOK_URL` or a real mailbox). Injected transport and fixture `delivery: "preview"` are not production sending readiness. Workspace reminder template persistence is the in-code default (editable per send); a settings-backed template would need a schema column.

## Handoff

Mount `RemindFunder` on the submissions deal panel. Pass `dealId`. The panel already hides the Remind Funder button unless `eligible && remindControl === "remind"`.

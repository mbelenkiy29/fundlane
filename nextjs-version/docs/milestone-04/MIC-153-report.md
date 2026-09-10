# MIC-153 report — Submission email templates, signatures, prefixes and rep CC

**Status:** DONE locally with synthetic fixtures. Live SMTP / Google / Microsoft mailbox send remains an external gate.

## Contract

`sendSubmissionEmail` in `src/lib/mca/submissions/email-templates.ts` replaces the Wave 0 `provider_unavailable` stub. Per-funder subject/body render from `mca_submission_templates` plus deal fields (`{{legalName}}`, `{{displayId}}`, `{{requestedAmount}}`, …), the workspace prefix (null `funder_id` row), the funder prefix, and the sender signature. Originator/closer CC flags live on the template and never copy the merchant contact.

Preview (`POST /api/mca/submissions/email/preview`) returns To, CC, reply-to, subject, body, and attachment metadata without calling SMTP or `MCA_EMAIL_WEBHOOK_URL`. Confirming email jobs stores an immutable snapshot plus Message-ID / thread metadata on `mca_submission_attempts.external_ref`. Changing a prefix or sender signature does not rewrite prior attempts.

Two funders are addressed independently: each attempt’s To/CC excludes the other funder’s recipients. `assertSenderUsable` is imported from `src/lib/mca/senders/service.ts` and runs when a `senderId` is supplied. Forged or unauthorized sender ids are 403.

Without `MCA_EMAIL_WEBHOOK_URL`, non-production delivery is `preview` and the job is `sent` with a Message-ID. Production without a webhook is `email_delivery_unconfigured`. Webhook payloads omit credentials and file bytes.

Permissions: template GET/PUT require an interactive admin/super_admin session. Preview is `deals:read` (same deal visibility as the vault). `intake:write` is 403. Direct API matches the UI.

## Tests

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/submissions-email.test.ts
```

3/3 passed.

Covered: two funders, distinct To/CC, originator vs closer flags, merchant contact excluded; preview does not hit the webhook; prefix/signature change leaves stored `external_ref` snapshot and Message-ID unchanged while new previews pick up the change; unauthorized sender id 403; missing sender 403; cross-workspace deal 404; intake 403; `deals:read` preview 200; template writes admin-only; secrets omitted.

## Files

- `src/lib/mca/submissions/email-templates.ts`
- `src/app/api/mca/submissions/email/route.ts`
- `src/app/api/mca/submissions/email/preview/route.ts`
- `src/components/mca/submissions/email-preview.tsx`
- `tests/submissions-email.test.ts`
- `docs/milestone-04/MIC-153-report.md`
- `docs/milestone-04/MIC-153-acceptance.md`

Did not edit `deliver.ts`, `queue.ts`, `schema.ts`, `senders/service.ts`, or `deals-workspace.tsx`.

## Remaining gates

Live SMTP / Google / Microsoft sending (`MCA_EMAIL_WEBHOOK_URL` or a real mailbox). Fixture `delivery: "preview"` is not production sending readiness. Reply ingestion (MIC-149) and in-thread reminders (MIC-154) consume the stored Message-ID.

## Handoff

Mount `EmailPreview` on the deal Submissions tab or settings. Pass `dealId` for per-funder recipient/CC/reply-to/attachment preview; omit it for workspace template editing only.

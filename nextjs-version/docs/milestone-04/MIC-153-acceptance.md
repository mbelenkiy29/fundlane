# MIC-153 acceptance — Submission email templates, signatures, prefixes and rep CC

Executed September 8, 2026. Scope: per-funder subject/body with deal fields, workspace prefix, funder prefix, sender signature, originator/closer CC flags, preview of recipient/CC/reply-to/attachments, immutable sent content on the attempt, and separately addressed multi-funder packages. Live mailbox send is out of scope.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| Two funders receive separately addressed packages without cross-exposing recipients | Passed | `tests/submissions-email.test.ts` — Alpha To `alpha@funders.example.test` / CC originator; Beta To `beta@funders.example.test` / CC closer; neither package includes the other funder’s address; merchant contact is not CC’d |
| Prefix or signature change only affects new submissions | Passed | After send, updating the Alpha prefix and sender signature leaves `external_ref` snapshot, subject, body, and Message-ID unchanged; a new preview shows `NEWALPHA` and the updated signature |
| Preview without live SMTP | Passed | `POST /preview` and queue delivery with `MCA_EMAIL_WEBHOOK_URL` unset; captured webhook count unchanged; `delivery: "preview"` |
| Unauthorized sender id 403 | Passed | Rep forging the workspace sender and admin using `missing-sender` both return `403 permission_denied` via `assertSenderUsable` |
| Loading / empty / validation / success / failure UI | Passed | `EmailPreview` loading copy, empty email-funders dashed state, client subject/body validation, saved-template success, and request-error alert |
| Direct API permissions match UI; secrets excluded | Passed | `deals:read` preview 200; intake and `deals:read` template GET 403; `deals:write` template PUT 403; admin PUT/GET 200; cross-workspace deal 404; responses omit SMTP password / `credentialCipher` |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/submissions-email.test.ts
```

3/3 passed.

## Behavior

- Workspace default template: `mca_submission_templates` row with `funder_id` null (prefix = workspace prefix, default subject/body, default CC flags).
- Per-funder row overrides subject/body, supplies the funder prefix, and owns originator/closer CC flags. Merchant follow-up CC is not applied.
- Rendered subject is `[workspacePrefix] [funderPrefix] <template>`. Body appends the current sender signature. Deal tokens include `legalName`, `displayId`, `requestedAmount`, `monthlyRevenue`, `industry`, `funderName`.
- Sent content is frozen on `mca_submission_attempts.external_ref` as JSON `{ messageId, threadId, references, delivery, snapshot }`. Retries of the same attempt keep that identity.
- `sendSubmissionEmail(job)` is the email transport for `deliverSubmission`. Non-production without a webhook stores a preview Message-ID and marks the job `sent`.
- GET/PUT `/api/mca/submissions/email`: interactive admin/super_admin, `assertTrustedMutation` on PUT, `cache-control: no-store`, `runtime = "nodejs"`.
- POST `/api/mca/submissions/email/preview`: `deals:read`, same deal visibility as the vault. Does not send.

## UI

`EmailPreview` covers loading, empty (no email funders), validation (blank subject/body), success (saved template / per-funder To, CC, reply-to, attachments), and failure (request error). Conductor mounts it on the deal Submissions tab or settings.

## Local vs live gates

Local Postgres fixtures prove per-funder addressing, CC flags, immutable snapshots, preview-without-SMTP, and ACL. There is no live SMTP/OAuth send. Fixture success is not production sending readiness.

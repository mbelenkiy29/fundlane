# Client invitations and employee outreach

## Private delivery activation (#39)

`MCA_APPLICATION_INVITATION_EMAIL_ENABLED=false` remains the invitation gate. Set `MCA_EMAIL_SENDER_VERIFIED=true` only after every transactional and receipt receiver From domain is verified in its email provider console, then configure `MCA_EMAIL_WEBHOOK_URL` and `MCA_EMAIL_WEBHOOK_TOKEN` on web and cron runtime. The receiver must authenticate that bearer token, accept the `application_invitation` and `application_invitation_reminder` templates, and durably deduplicate the `idempotency-key` header before sending. A lost response, worker crash, or admin **Retry email** reuses the delivery ID as the same key. A deliberate resend creates a new delivery ID. The Applications page keeps sending unavailable until both flags and an authenticated receiver are configured in production. Default values of both flags are `false`.

The optional `GET /api/cron/private-email` route consumes only invitation email/reminder jobs and intake receipts. Set `MCA_PRIVATE_EMAIL_CRON_ENABLED=true` and `CRON_SECRET` on the Vercel runtime after a synthetic receiver round trip; install one `*/5 * * * *` schedule for that route in Vercel. It is independent of `/api/cron/jobs` and has no `vercel.json` entry. Review failed delivery rows in the Applications activity history and retry there. Keep this cron flag off until the receiver's durable deduplication is verified. Configure the receiver sender domain with SPF/DKIM/DMARC in its provider console; company-domain DNS is owned by #53. No provider account, DNS record, hosted schedule, or live send is installed by this code change.

Employees use `/applications` to create a client invitation, send or resend an email, or copy a client link. Each invitation retains its original employee and Jotform binding. The admin report in `/reports` joins that attribution to existing deal outcome calculations; reassigning a deal does not transfer acquisition credit.

## Behavior and access

- Reps and managers see only their own invitations. Admins and super admins see their company's invitations. Creating, copying, and sending require the existing `createDeal` permission and Deals page access. Employee reporting requires the existing admin Reports permission; funded amounts require company financial visibility.
- Client links use `/apply/{formId}?mca_invite={opaqueToken}`. No client login is required. Tokens expire after 30 days; creating a replacement preserves earlier history. Disabled forms, changed form bindings, revoked invitations, and deactivated employees cannot receive new applications through their old links.
- Tokens and client emails are encrypted with the existing workspace encryption key; only token hashes are used for lookup. Tokens are returned only by the authorized copy-link action and to the configured email adapter. Invitation list/report responses do not return them. Public pages use `noindex` and `no-referrer`.
- The first browser observation sets **Opened**. Clicking **Start application** sets **Started** and displays Jotform. Starts imply opens when requests arrive out of order. Neither event reads partial Jotform answers. Automated link scanners can generate visits.
- **Received** is recorded only after authenticated webhook ingestion succeeds. The claim and resulting intake/deal link commit atomically. A retry with the same provider event reconciles the same record, including after link expiry. A different submission claiming an already consumed invitation is placed in intake review. Legacy `mca_rep` links keep their existing behavior and do not acquire fictional outreach records.
- **Emailed** means the delivery adapter accepted at least one email, not confirmed inbox delivery. Copies and development previews never increment this metric. Every resend has a separate delivery attempt; a failed/uncertain attempt can retry using its original provider idempotency key only after provider reconciliation on the Vercel runtime. An already accepted attempt is never sent again by the worker.
- Reports default to invitations created during the last 30 company-local calendar days, with subsequent outcomes through now. Counts reconcile to the client detail filter. Stage conversions count invitations observed in both stages divided by invitations in the starting stage. This keeps copied-link completions out of the email denominator. A zero denominator yields an unavailable rate. Resends and multiple funder submissions do not inflate unique invitation/deal counts.

## Deployment and email contract

1. Apply `0035_application_outreach.sql` through the normal migration command, then run `db:secure` so the existing restricted server role can use the three new tables. Both commands require the expected destination project reference described in the README. The new tables enable RLS and deny browser-role access.
2. Configure an enabled Jotform integration. Add a hidden short-text field whose unique name is **`mca_invite`**, and ensure the existing authenticated Workflow webhook forwards that value inside `rawRequest` (or at the top level) alongside `formID` and `submissionID`. Keep the existing business fields, validation, bank statement uploads, and attachment mapping. A form can retain `mca_rep` for legacy personal links.
3. Configure the existing `MCA_EMAIL_WEBHOOK_URL` and `MCA_EMAIL_WEBHOOK_TOKEN` on web and worker. Its receiver must support the new `application_invitation` template and must durably deduplicate the `idempotency-key` header before contacting the email transport. Use a verified company/platform sender; the employee name is attribution, not an arbitrary From address.
4. Run the existing background worker (`pnpm documents:worker`, or `node --conditions=react-server --import tsx scripts/workers/run.ts`). The new job kind is `application_invitation_email`; it uses the existing database lease, retry, and current-session authorization checks. It does not send directly from the HTTP request. Keep the worker's app origin and encryption key aligned with the web app.
5. Keep `MCA_APPLICATION_INVITATION_EMAIL_ENABLED=false` in production until the staging round trip below passes. Set it to `true` on **both web and worker** only after verification. Disabling it stops new sends; employees can still copy valid links. Existing queued jobs surface a setup error and can be retried after activation.

The email webhook receives:

```json
{
  "recipient": "client@example.test",
  "template": "application_invitation",
  "actionUrl": "https://your-app.example/apply/FORM_ID?mca_invite=OPAQUE_TOKEN",
  "expiresAt": "2026-10-13T14:30:00.000Z",
  "data": {
    "clientName": "Harbor Bakery",
    "employeeName": "Ada Chen",
    "formName": "Business funding application"
  }
}
```

Recommended template: subject **Complete your business funding application**; body **Hi {clientName}, {employeeName} invited you to complete your business funding application. Have your business details and recent bank statements ready.** CTA **Start application** links to `actionUrl`; display the expiry date. HTML-escape names, validate the action URL against your app origin, and never log the complete token or message payload.

## Verification and operations

Use `MCA_TEST_DATABASE_ADMIN_URL` pointing at a disposable local Postgres cluster, then run:

```sh
node --experimental-test-module-mocks --conditions=react-server --import tsx --test --test-concurrency=1 tests/application-outreach.test.ts tests/intake-core.test.ts tests/milestone06-rep-funnel.test.ts
pnpm typecheck
pnpm lint
pnpm build
```

Tests use randomly named databases and drop them afterward. The focused fixtures cover concurrent claims, immutable acquisition credit, scoped HTTP authorization, timestamps and deduplication, copy/preview exclusion, uncertain email retries, report reconciliation, financial visibility, and legacy-link compatibility.

Before production activation, use synthetic recipients in a staging company to send two invitations from different employees through the real receiver. Open one and leave it incomplete; submit the other through the real Jotform including a statement upload. Confirm the hidden token survives, one deal is created for the correct original employee, the document processing flow works, and report totals/drilldowns agree. Re-deliver the same webhook and retry the same email key to verify deduplication. Retain sanitized provider acceptance evidence. Local fixtures do not establish live email or Jotform readiness.

The Applications activity history displays delivery attempts, preview-only delivery, and failed jobs. With the Vercel job runtime, a failed send that may have reached the provider shows **Review delivery**. A company admin checks the email provider using the displayed delivery ID, records the provider receipt or lookup reference, then selects **accepted** or **not sent**. Accepted marks that delivery sent without another email; confirmed absence requeues the same delivery ID and idempotency key under the admin's current authority. The decision and evidence are audited. A failed attempt known to have been paused before sending can use **Retry** after recovery. Admins review rejected intake deliveries on Application Intake; processing errors linked to an invitation also appear on its row. Inactive or completed invitations cannot be resent; create a replacement for a new application. Native Fundlane Forms save partial answers and send finish-your-application reminder emails. Jotform invitations still cannot restore field progress. No SMS sending is included.

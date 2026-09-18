# Fundlane Forms

Workspaces send a first-party application funnel instead of requiring Jotform. `/applications` auto-provisions one enabled `fundlane` intake integration. Jotform, GoHighLevel, and Zoho remain optional inbound connectors.

## Merchant path

`/apply/fundlane?mca_invite={token}` opens the native funnel. Answers are encrypted on the invitation until submit. Files are staged and scanned under the invitation, then promoted onto the deal. Leaving the page keeps progress; the same link resumes the last step.

Submit calls the existing intake pipeline (`provider: "fundlane"`), generates an application PDF, and lets the document worker run completeness and funder matching. Intake still does not auto-submit to funders.

## Reminders

The document worker schedules up to three emails (`application_invitation_reminder`) at 2 hours, 24 hours, and 72 hours after last activity when the merchant started or drafted but did not submit. The same resume link is used. Production still requires `MCA_APPLICATION_INVITATION_EMAIL_ENABLED=true`.

## Broker library

`/applications` is a live table (15s refresh): business name, email, amount requested, status, dates sent/opened/started/completed, employee. Administrators can edit welcome copy and optional steps.

## Verification

```sh
node --experimental-test-module-mocks --conditions=react-server --import tsx --test --test-concurrency=1 tests/application-forms.test.ts tests/application-outreach.test.ts
pnpm typecheck
```

# Company SMS onboarding

## Implemented flow

`/sign-up` creates a workspace administrator and an unverified SMS company profile. Existing users must already be authenticated to reuse their email. The verification email uses template `company_email_verification`, a hashed single-use token and a 24-hour expiry. The link opens `/verify-company`; clicking Verify consumes it. No token is returned from signup or resend APIs. If email delivery fails, the company is retained and the owner can resend from Settings → Connections.

Settings → Connections contains business review, registration status, number search, paid purchase confirmation, assignments, explicit release and usage export. Existing manually configured SMS senders remain in a separate expandable section. `/sms` provides the inbox; each deal's Messages tab includes its conversations. Unmatched or ambiguous replies require administrator association with a matching deal. Both number assignment and current deal access control inbox visibility.

Platform operators use `/settings/sms-review`. Operator authorization is an exact server-configured user-ID allowlist, independent of all workspace roles. Never add client-controlled membership fields to this allowlist.

## Deployment prerequisites

Before hosted acceptance, an operator can opt in to the offline, read-only configuration report from `nextjs-version/`:

```sh
MCA_SMS_READINESS_TOOL_ENABLED=true pnpm sms:readiness -- --env-file .env.local --workspace-id '<workspace-id>' --account-id '<account-id>'
```

`MCA_SMS_READINESS_TOOL_ENABLED` is `false` by default and only the exact value `true` enables validation. The environment file is read locally and explicit process environment variables take precedence. The optional identifiers produce URL-encoded console values for the inbound/Advanced Opt-Out callback and Event Streams number-registration callback. The report intentionally does not emit a static delivery-status URL because the application generates that callback per message; Twilio supplies the signed `bodySHA256` query parameter for Event Streams, so the report does not append it.

The command writes deterministic JSON containing the enabled/ready state, fixed redacted check codes and messages, and callback URL results. It never prints auth tokens or API-key secrets. Exit code `0` means either that the tool is disabled or that the enabled structural checks passed; an enabled invalid report exits nonzero. A passing report proves configuration shape only. It does **not** prove Twilio or carrier approval, deployed secrets or routes, signature acceptance, Advanced Opt-Out state, schedule ownership, or live delivery. Those items still require the controlled hosted acceptance below. No database migration or hosted mutation is performed by this command.

1. Apply the checked Drizzle migrations through the controlled Supabase release process. Migration `0065_sms_refresh_cursor` adds a company refresh cursor, leaving the operator review timestamp unchanged by routine refresh attempts.
2. Configure `MCA_APP_ORIGIN` / `MCA_SMS_PUBLIC_BASE_URL` as a clean public HTTPS origin and the existing workspace encryption key. Configure the email delivery webhook to accept `company_email_verification`. A development email preview is not evidence of delivery; use an email capture webhook during development.
3. Configure `MCA_PLATFORM_OPERATOR_USER_IDS` with trusted user IDs, not email addresses or workspace roles.
4. Complete Twilio's primary-profile ISV setup and obtain an eligibility decision for the actual MCA application-update traffic. The observed account was Direct, with no submitted A2P campaigns. Record that decision in `MCA_SMS_ELIGIBILITY_REFERENCE`, set the approved primary profile SID in `MCA_TWILIO_PRIMARY_PROFILE_SID`, and only then set `MCA_SMS_ISV_APPROVED=true`.
5. Set parent account SID/auth token, platform compliance email, a current conservative registration estimate and per-segment estimate in the new `.env.example` variables. Parent credentials create subaccounts; encrypted customer credentials are used within each customer's account. Sending uses customer API keys. Credentials are never exposed to clients.
6. Approve the individual company and explicitly set registration, monthly and number allowances. All default to zero. The current pilot collects privately held US EIN-bearing businesses; public-company stock data and international registrations are not supported.
7. On approved nonproduction Vercel, set `MCA_SMS_CRON_ENABLED=true`, `CRON_SECRET`, the restricted pooled `DATABASE_URL`, and the Twilio settings below. Install exactly one five-minute `GET /api/cron/sms` schedule in the Vercel console after acceptance. Vercel sends `Authorization: Bearer <CRON_SECRET>`. The route is off by default; no schedule is declared in `vercel.json`. Remove the historical `scripts/railway/sms-jobs.mjs` schedule before enabling the Vercel schedule, so there is one owner. While the new flag is enabled, the old `MCA_SMS_JOB_TOKEN` maintenance endpoint returns 409 to prevent a second scheduled consumer.
8. Enable Advanced Opt-Out in each generated Messaging Service's Twilio Console and record confirmation through the platform review UI. Twilio currently has no API to configure Advanced Opt-Out. Application keyword suppression is also implemented; sending stays gated until operator confirmation.
9. Set Twilio inbound and Advanced Opt-Out callbacks to `https://<public-origin>/api/mca/sms/webhooks/twilio/<accountId>/inbound`; delivery status callbacks use `https://<public-origin>/api/mca/sms/webhooks/twilio/<accountId>/status?messageId=<localMessageId>`. Set the Event Streams number-registration subscription to `https://<public-origin>/api/mca/sms/webhooks/registration/<workspaceId>` with the Twilio `bodySHA256` query parameter. Use the exact generated URLs from the app; the placeholders above are not literal provider settings. Verify the subscription delivers number-registration events. Campaign approval and sender-pool attachment alone do not mark a number active. Event signatures validate both the JSON body hash and the canonical public URL; events are deduplicated and ordered by provider time.

The cron response exposes `ready`, `running`, `operations`, `companies`, `failedWorkspaces`, `operationStates`, and `durationMs`. `running=true` means another tick holds the single-consumer lock. `ready=false` means platform eligibility or parent credentials are missing; no provider work runs. Inspect `needs_review` counts and failed workspaces; a successful HTTP response alone does not prove delivery. Each tick handles at most one operation and two company refreshes under a 240-second deadline. Check queue age and schedule frequency during the pilot.

For hosted setup, confirm with Twilio that the actual MCA application-update traffic is eligible, complete the primary ISV profile, approve each company's A2P 10DLC brand and campaign, and provision only after approval and explicit operator allowances. Configure the parent SID/token, per-company API keys, compliance email, cost estimates, public callback origin, signature validation, and Advanced Opt-Out in each Messaging Service console. Record operator confirmation in `/settings/sms-review`. Use an opted-in controlled recipient in a nonproduction pilot; reconcile send, inbound reply, delivery, unread and usage, then send STOP and verify both inbox and deal send paths suppress further traffic. Inspect uncertain purchases in Twilio before any operator recovery.

## Recovery and accounting

Provisioning records encrypted step results before proceeding. A lost mutation response or expired worker lease transitions to `needs_review`; no blind retries create paid resources. Operators can reconcile subaccount creation and number purchases by their deterministic remote identity, and recover/retry sender-pool attachment after a verified remote lookup. Other uncertain Trust Hub/API-key results require inspection in Twilio and controlled backend recovery; never clear a checkpoint unless the provider outcome is proven. API-key secrets cannot be retrieved again after a lost response.

A purchased number is persisted before attaching it to the service, so a partial failure remains visible. Numbers are not released when employees leave. Suspension blocks application sending immediately while preserving inbound and delivery callback validation. Parent/subaccount closure is not automatic.

Reservations are serialized against the company row. Costs use a conservative UTF-16 multipart bound; carrier estimates must include carrier fees. Reconciled provider costs and outstanding estimates are conservatively both counted for admission, so an operator may need to adjust an allowance after reconciliation. These are application spending controls, not a guarantee of the final Twilio invoice: inbound messages and number rental continue accruing at Twilio. CSV exports identify estimates, provider totals and component categories; component categories can overlap, so do not sum them into the provider total again. No Stripe billing is installed.

No numbers are moved from legacy accounts; no brands/campaigns are shared across companies. Managed numbers cannot be reassigned or revoked through the legacy account endpoint.

## Verification

Run from `nextjs-version/`:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/sms-onboarding.test.ts tests/milestone05-sms.test.ts tests/milestone06-sms-composer.test.ts tests/sms-adapters/twilio.test.ts
pnpm typecheck
pnpm lint
pnpm build
```

The suite creates uniquely named databases on disposable local PostgreSQL and drops them after testing. Provider traffic is injected/synthetic, never a live send or purchase. Coverage includes email expiry/replay, owner identity, operator isolation, zero allowances and spending races, number provisioning/recovery, sender identity, signed callbacks after suspension, duplicate/out-of-order registration events, pre-deal suppression and START replay, and employee deactivation.

Implementation verification on September 9, 2026: all 37 targeted tests passed; typecheck and production build passed; lint completed with zero errors and 16 existing warnings outside the new onboarding modules. A browser check with a synthetic owner verified that sign-in resumes company setup and renders the separate onboarding statuses and zero-default allowances. The temporary preview database was removed afterward. Production data and Twilio resources were not changed.

Before production rollout, run one authorized pilot with an approved company/campaign/number: send to an opted-in test recipient, receive a reply, verify delivery status and unread state, send STOP from that recipient and verify all send paths block. Confirm usage against Twilio. Actual carrier approval and live SMS delivery remain external activation steps.

Official references: [ISV API onboarding](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv-api), [Event Streams](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/event-streams-setup), [Advanced Opt-Out](https://help.twilio.com/articles/360034798533), [loan-marketing restrictions](https://www.twilio.com/docs/api/errors/30862).

# Company SMS onboarding

## Implemented flow

`/sign-up` creates a workspace administrator and an unverified SMS company profile. Existing users must already be authenticated to reuse their email. The verification email uses template `company_email_verification`, a hashed single-use token and a 24-hour expiry. The link opens `/verify-company`; clicking Verify consumes it. No token is returned from signup or resend APIs. If email delivery fails, the company is retained and the owner can resend from Settings → Connections.

Settings → Connections contains business review, registration status, number search, paid purchase confirmation, assignments, explicit release and usage export. Existing manually configured SMS senders remain in a separate expandable section. `/sms` provides the inbox; each deal's Messages tab includes its conversations. Unmatched or ambiguous replies require administrator association with a matching deal. Both number assignment and current deal access control inbox visibility.

Platform operators use `/settings/sms-review`. Operator authorization is an exact server-configured user-ID allowlist, independent of all workspace roles. Never add client-controlled membership fields to this allowlist.

## Deployment prerequisites

1. Apply checked migrations `0015`–`0017` using the documented Neon migration workflow before deploying this code. No production migration was applied during implementation.
2. Configure `MCA_APP_ORIGIN` / `MCA_SMS_PUBLIC_BASE_URL` as a clean public HTTPS origin and the existing workspace encryption key. Configure the email delivery webhook to accept `company_email_verification`. A development email preview is not evidence of delivery; use an email capture webhook during development.
3. Configure `MCA_PLATFORM_OPERATOR_USER_IDS` with trusted user IDs, not email addresses or workspace roles.
4. Complete Twilio's primary-profile ISV setup and obtain an eligibility decision for the actual MCA application-update traffic. The observed account was Direct, with no submitted A2P campaigns. Record that decision in `MCA_SMS_ELIGIBILITY_REFERENCE`, set the approved primary profile SID in `MCA_TWILIO_PRIMARY_PROFILE_SID`, and only then set `MCA_SMS_ISV_APPROVED=true`.
5. Set parent account SID/auth token, platform compliance email, a current conservative registration estimate and per-segment estimate in the new `.env.example` variables. Parent credentials create subaccounts; encrypted customer credentials are used within each customer's account. Sending uses customer API keys. Credentials are never exposed to clients.
6. Approve the individual company and explicitly set registration, monthly and number allowances. All default to zero. The current pilot collects privately held US EIN-bearing businesses; public-company stock data and international registrations are not supported.
7. Run `node scripts/railway/sms-jobs.mjs` on a five-minute deployment schedule with `MCA_SMS_JOB_TOKEN` and `MCA_APP_ORIGIN`. The authenticated worker resumes durable operations, refreshes campaign status and records usage. The Settings refresh action can run a company's queued operation manually. This repository change does not install a production schedule.
8. Enable Advanced Opt-Out in each generated Messaging Service's Twilio Console and record confirmation through the platform review UI. Twilio currently has no API to configure Advanced Opt-Out. Application keyword suppression is also implemented; sending stays gated until operator confirmation.
9. Verify the Event Streams webhook subscription delivers number-registration events. Campaign approval and sender-pool attachment alone do not mark a number active. Event signatures validate both the JSON body hash and the canonical public URL; events are deduplicated and ordered by provider time.

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

The suite creates uniquely named databases on the protected Neon verification branch and drops them after testing. Provider traffic is injected/synthetic, never a live send or purchase. Coverage includes email expiry/replay, owner identity, operator isolation, zero allowances and spending races, number provisioning/recovery, sender identity, signed callbacks after suspension, duplicate/out-of-order registration events, pre-deal suppression and START replay, and employee deactivation.

Implementation verification on September 9, 2026: all 37 targeted tests passed; typecheck and production build passed; lint completed with zero errors and 16 existing warnings outside the new onboarding modules. A browser check with a synthetic owner verified that sign-in resumes company setup and renders the separate onboarding statuses and zero-default allowances. The temporary preview database was removed afterward. Production data and Twilio resources were not changed.

Before production rollout, run one authorized pilot with an approved company/campaign/number: send to an opted-in test recipient, receive a reply, verify delivery status and unread state, send STOP from that recipient and verify all send paths block. Confirm usage against Twilio. Actual carrier approval and live SMS delivery remain external activation steps.

Official references: [ISV API onboarding](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv-api), [Event Streams](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/event-streams-setup), [Advanced Opt-Out](https://help.twilio.com/articles/360034798533), [loan-marketing restrictions](https://www.twilio.com/docs/api/errors/30862).

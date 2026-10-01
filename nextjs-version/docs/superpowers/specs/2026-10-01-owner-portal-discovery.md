# Fundlane owner portal — discovery and interview record

Status: historical discovery/interview record, supplemented by the [review design brief](2026-10-01-owner-portal-design.md) and [implementation plan](2026-10-01-owner-portal-plan.md). Neither is approved for execution.

## Scope and authority

Plan the owner-level Super Admin Portal for Mike and Ben, above customer company administration. Planning and read-only discovery only. No product code, deployments, production data/configuration changes, credential creation/transmission, or implementation PRs. No existing checkout or branch was changed. This artifact is isolated in `task-3/planning`.

Original workflow: finish the focused interview; compare approaches; review design sections; write a specification after design agreement; obtain written-spec approval; then write the implementation plan. Mike subsequently explicitly requested the design/plan be drafted now for review, with unresolved choices kept as task-specific decision gates. That authorizes the linked drafts but not implementation. Implementation still requires a subsequent explicit instruction from Mike.

Requested guidance read:

- [Ponytail 4.10.0](/Users/mbele/.codex/plugins/cache/ponytail/ponytail/4.10.0/skills/ponytail/SKILL.md): reuse existing capabilities and minimize new abstractions without removing security requirements.
- [Superpowers brainstorming 6.4.2](/Users/mbele/.codex/plugins/cache/openai-curated-remote/superpowers/6.4.2/skills/brainstorming/SKILL.md): architectural path, one question at a time, design/spec approval gates.
- [Superpowers writing-plans 6.4.2](/Users/mbele/.codex/plugins/cache/openai-curated-remote/superpowers/6.4.2/skills/writing-plans/SKILL.md): read as requested; implementation planning has not begun.
- Twilio compliance-onboarding, ISV SMS best practices, and security-api-auth skills. Current official documentation takes precedence over unverified generalizations in skill prose.

## Confirmed by Mike in this interview

| Decision | Confirmed requirement |
| --- | --- |
| Owner roles | Mike and Ben have equal platform-level super dev admin permissions and oversee all companies. |
| Tenancy | Customers sign up their own companies. Company admins add employees within their purchased seat allocation. |
| SMS geography/use | V1: US only; updates and conversations about an existing application. |
| Customer experience | Customers pay and submit company information through Fundlane; Mike or Ben reviews it; Fundlane manages a Twilio subaccount for the company; customers buy phone numbers and SMS credits within Fundlane. |
| Pending review | Paid companies can use CRM/application tools while review is pending. Number purchasing and SMS remain locked. |
| Provider submission | Internal approval is separate from an explicit Submit to Twilio action showing the registration charge first. |
| Number inventory | V1 supports multiple local US numbers, including employee assignments. The existing one-live-managed-number restriction must change through a separately reviewed design. |
| SMS commercial unit | Customers buy packs of SMS segments; show credits required before sending. Pack quantities/prices and debit/reversal policies are not yet decided. |
| Credit ownership | One company-wide purchased segment balance, shared across employees and numbers. |
| Support visibility | Operational details by default; private deals/documents/message content only through an explicit audited support-access action. Exact support capabilities, duration and consent rules remain to be reviewed. |

Mike delegated the account architecture recommendation. Recommended: Fundlane parent account with one subaccount per company, matching the implemented flow. Actual hosted setup and Twilio eligibility remain unverified. Equal owner permissions do not by themselves decide credential visibility, support impersonation, or which sensitive customer records owners should access.

## Evidence baseline and coordination

Read-only checkout: `/Users/mbele/Documents/Codex/2026-10-01/task-2/fundlane-coordinator`. Clean detached HEAD at `594679dad98c5c28af9794787c476ccf496e2c6c` during inspection. Its AGENTS.md, WORKSPACE_NAVIGATION.md, active README and runtime documentation were read; Graphify was queried first for source navigation, followed by actual source inspection.

GitHub read confirmed main at the same revision. [PR #222](https://github.com/mbelenkiy29/fundlane/pull/222), super-admin/TOTP/append-only audit, was merged at `bd3222c4fd73f120db18c1091f03161d44f88229`; main subsequently advanced through #209. Source presence does not prove migrations, flags, schedules or providers are active in production.

Open PR inventory at discovery: #208 mailbox readiness, #210 SMS readiness, #211 isolated acceptance foundation, #212 notification foundation, #213 browser voice, #214 reports, #215 lender fit, #216 merchant application funnel, #217 reviewed lender sends (based on #208 branch), #219 document notifications (based on #212 branch). Recheck before the final spec and any later worktree/PR plan; overlapping source may change.

Release coordination task `01a0f7c6-cc11-756a-9d5f-df93f2ad00f0` owns unrelated release-risk fixes. Its auth work includes preventing cross-company invitations from overwriting existing users' shared name/phone before acceptance. New portal UI/schema are excluded from that batch. This task must not modify its worktrees.

The local Codex memories directory contained an unrelated project-bird summary, so it was not used as Fundlane context. Checkout `.agents/skills` contained Graphify; installed Superpowers was found in the plugin cache.

## Current-state architecture map

All paths below are relative to `nextjs-version/` at the pinned baseline. Active stack: Next.js 16/React 19 on Vercel; Supabase Auth/Postgres/private Storage; Drizzle migrations and mostly `pg` runtime SQL. Render/Clerk/Neon references are historical.

| Area | Existing implementation and practical limit | Code evidence |
| --- | --- | --- |
| Platform entry and company administration | `/platform` overview, companies/detail, payments, audit, demo requests, conditional roadmap. Existing company actions include pause/extension, billing reconciliation, missing-owner assignment, notification retry/resend, missing billing-state resolution. | `src/app/platform/layout.tsx`, `src/lib/mca/platform-console.ts`, `src/app/api/platform/companies/[id]/route.ts` |
| Platform identity | Live confirmed Supabase identity + unrevoked local `platform_admin_grants` + same-session AAL2 or app TOTP. Email allowlist limits an existing grant; it does not create a grant. Defaults include Mike and Ben. API keys cannot grant owner access. | `src/lib/mca/platform-auth.ts:23`, `:47` |
| SMS approval asymmetry | `requireSmsApprover` defaults to Mike only. Approval/rejection require fresh app TOTP. This differs from equal permissions confirmed in this interview. Suspension/resume/allowance changes do not use the same step-up branch. | `src/lib/mca/platform-auth.ts:75`, `src/lib/mca/sms/onboarding.ts:405` |
| Step-up and audit | Default ten-minute session-bound fresh app-TOTP window. Append-only platform audit, transactional local mutation/audit writes, hashed IP/user agent, audit viewer and step-up-gated CSV export. External provider effects are not rolled back by DB transactions. | `src/lib/mca/platform-step-up.ts`, `src/lib/mca/platform-audit.ts`, `drizzle/0070_platform_super_admin.sql` |
| Customer roles and tenancy | Workspace membership and company owner records are separate from platform grants. Customer role vocabulary itself includes `super_admin`; that role does not grant platform access. Workspace resolution, seat capacity, paused-company and TOTP gates exist. | `src/lib/mca/supabase-auth.ts`, `auth.ts:66`, `policy.ts`, `memberships.ts`, `company-access.ts` |
| Signup/company creation | Confirmed Supabase user creates workspace, admin membership, company-owner row, subscription/trial state and SMS-company row. Current signup path differs from older SMS onboarding documentation. | `src/lib/mca/supabase-auth.ts:109` (`completeCompanyOnboarding`) |
| SMS review form | US EIN/address/contact, HTTPS website/privacy/terms, purpose, 2–5 message samples, consent evidence text, application-updates-only acknowledgement. Encrypted profile; operator projection masks EIN. No dedicated uploaded-business-document review flow was found in the inspected SMS form. | `src/lib/mca/sms/onboarding.ts:34`, `:348`, `:482` |
| Internal review | `/settings/sms-review` displays email, internal review, carrier status, suspension, allowances and opt-out confirmation. Note required; queue is capped at 100 without the richer filtering/ownership workflow under discussion. | `src/app/(dashboard)/settings/sms-review/page.tsx`, `/api/mca/sms/operator`, `onboarding.ts:388` |
| Twilio provisioning | Company subaccount, dedicated API key, Secondary Customer Profile, address/supporting-resource metadata, TrustProduct, brand, Messaging Service, campaign and number registration. Parent SID/token performs account creation; company secrets encrypted at rest. Sender uses company API key. | `src/lib/mca/sms/provisioning.ts:357`, `onboarding.ts:89`, `managed.ts:17` |
| Provisioning recovery | Encrypted checkpoints; running operation with uncertain outcome becomes `needs_review`. Remote lookup recovery exists for some steps. Lost key creation response and other uncertain compliance mutations require controlled investigation. No blind paid-resource creation retry. | `src/lib/mca/sms/provisioning.ts`, `maintenance.ts:144` |
| Number purchasing | US local number search; carrier registration must be approved before search/purchase. Current managed flow enforces one live shared company number even though operator allowance accepts larger values. Rental amount confirmation and usage reservations exist. | `src/lib/mca/sms/provisioning.ts:171`, `:288`, `src/lib/mca/db/sms-onboarding.ts` |
| Send readiness | Separate verified owner email, internal approval, provider approval, platform eligibility, opt-out configuration, non-suspension and active number/account checks. Recipient suppression and budget reservation before send. | `src/lib/mca/sms/managed.ts:37`, `:86` |
| Provider callbacks | Inbound/delivery callbacks plus Event Streams number-registration route. Registration handler verifies body SHA256, signature/canonical URL, account and service ownership, deduplicates events and orders by provider time. It handles number-registration events, not a complete separate profile/brand/campaign lifecycle. | `src/lib/mca/sms/registration-events.ts`, `src/app/api/mca/sms/webhooks/` |
| Subscription/financial controls | Stripe company subscription and seat flows, invoices/payments/refunds/disputes projections, reconciliation, time-based access gates and notifications. No evidence that source configuration proves live payment activation. | `src/lib/mca/billing*.ts`, `/api/billing/*`, `/api/webhooks/stripe`, `platform-console.ts` |
| SMS credits | SMS usage estimates/provider totals/allowances exist; prepaid SMS checkout and customer credit ledger are a gap. AI credits have separate per-user reservation/ledger/Stripe purchase/reversal code that can inform design; do not silently reuse AI units or balances for SMS. | `src/lib/mca/sms/maintenance.ts`, `provisioning.ts:137`, `src/lib/mca/assistant/{credits,purchases}.ts` |
| Existing SMS schema foundation | Migration 0069 already adds profile content/version/attestation/submission fields, detailed provisioning states, `sms_registrations` with kind/attempt/provider status/rejection and fee fields, number type/TFV fields, message segments, `sms_meter_events` and `sms_usage_periods`. The inspected runtime SMS directory has no references to the new registration/meter tables. Schema presence is not a completed workflow; recheck all callers before proposing new schema. | `drizzle/0069_sms_company_provisioning.sql`, `src/lib/mca/db/sms-onboarding.ts:201` |
| Number activation caveat | `refreshCompany` can insert an `assumed:` active registration event after campaign approval plus an elapsed interval (default six hours) without a provider number-registration event, subject to checks. Older docs describe event-only activation. Preserve this discrepancy as an explicit design/release question; an assumed status must not be represented as provider-confirmed approval. | `src/lib/mca/sms/provisioning.ts:835` |
| Existing error monitoring | `/admin/status` plus status/errors APIs; `mca_private.ops_errors/health/incidents/alert_attempts/activity`. Minimal safe event metadata; API 5xx native logs with optional deferred persistence. No Sentry references found in searched active source/package.json. | `src/lib/mca/operations/{telemetry,status,monitor}.ts`, `errors.ts`, `src/app/admin/status/page.tsx` |
| Monitoring permission mismatch | Status routes use `requirePlatformOwner`, matching a single `MCA_PLATFORM_OWNER_USER_ID`, separate from the grant/MFA super-admin check. This needs convergence for equal owner access; do not infer it already has identical protections. | `src/lib/mca/operations/access.ts`, `src/app/api/admin/status/{route.ts,errors/route.ts}` |
| Health/alerts | Website/DB samples, due queue age, leases, document heartbeat, email ambiguity/reconnect/failures, optional billing/calendar/job/assistant metrics. Stale samples display unavailable. Alert transport/monitor activation gated. Monitor config has one recipient. Full Supabase outage can disable custom checks and alerts. | `src/lib/mca/operations/{monitor,status}.ts`, `docs/platform-status.md` |
| Recovery | Company-scoped failed jobs API, rate-limited/audited decisions, small replay allowlist. External-effect decisions retain failed record and do not send. Evidence/reason collection needs review before richer UI is specified. | `src/lib/mca/operations/job-recovery.ts`, `src/app/api/platform/companies/[id]/failed-jobs/route.ts` |
| Retention/support | Telemetry cleanup after 30 days when monitor runs. Retention holds have separate default-off API and limited cleanup coverage. Existing platform docs explicitly exclude impersonation/customer session creation. New support access is a consequential decision. | `operations/monitor.ts`, `docs/background-job-runtime.md`, `docs/platform-super-admin.md` |

Source anchors: [platform auth](https://github.com/mbelenkiy29/fundlane/blob/594679dad98c5c28af9794787c476ccf496e2c6c/nextjs-version/src/lib/mca/platform-auth.ts), [SMS onboarding](https://github.com/mbelenkiy29/fundlane/blob/594679dad98c5c28af9794787c476ccf496e2c6c/nextjs-version/src/lib/mca/sms/onboarding.ts), [provisioning](https://github.com/mbelenkiy29/fundlane/blob/594679dad98c5c28af9794787c476ccf496e2c6c/nextjs-version/src/lib/mca/sms/provisioning.ts), [monitoring access](https://github.com/mbelenkiy29/fundlane/blob/594679dad98c5c28af9794787c476ccf496e2c6c/nextjs-version/src/lib/mca/operations/access.ts), [monitor](https://github.com/mbelenkiy29/fundlane/blob/594679dad98c5c28af9794787c476ccf496e2c6c/nextjs-version/src/lib/mca/operations/monitor.ts).

Documentation cautions: older company-onboarding prose describes a user-ID-only operator allowlist and says no Stripe billing is installed. Current source has super-admin grant/MFA/email restrictions and company/AI Stripe billing; SMS prepaid billing remains absent. Read source and distinguish each billing subsystem. Several runtime docs explicitly say hosted status is unverified. Treat old deployment statements as historical evidence.

## Twilio requirements checked against official sources

1. **Internal approval** is Fundlane's business decision. It cannot set provider approval or guarantee carrier acceptance.
2. **Trust Hub profiles and A2P** are separate steps. The official ISV guide requires an approved parent Primary Business Profile, then customer information/Secondary Customer Profile, TrustProduct, brand registration, campaign and sender association. The portal should preserve resource identities/statuses so a rejected profile is distinguishable from a rejected campaign. [Official ISV onboarding](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv-api).
3. **Toll-free** has its own verification workflow, status and rejection/resubmission rules. A2P 10DLC approval is not toll-free approval. Whether toll-free belongs in this v1 is still undecided. [Official toll-free onboarding](https://www.twilio.com/docs/messaging/compliance/toll-free/console-onboarding).
4. **Geographic number requirements** can involve number-type-specific identity/address/regulatory bundles. V1 is US-only; an international workflow is not silently included. [Twilio regulatory FAQ](https://www.twilio.com/docs/phone-numbers/regulatory/faq).
5. **Financial use eligibility** needs evidence for the actual customer/business use. Twilio's US/Canada policy lists high-risk financial services and third-party loans; limitations may depend on business type, not just message wording. Existing-application updates alone do not establish eligibility. Existing source already requires platform ISV eligibility configuration/reference. No hosted approval has been verified. [Official prohibited categories](https://help.twilio.com/articles/360045004974-Forbidden-Message-Categories-for-SMS-and-MMS-in-the-US-and-Canada).
6. **Subaccounts isolate resources, not the parent balance.** Twilio bills subaccount usage to the parent; suspension of the parent affects subaccounts. Fundlane must maintain its own customer credit/accounting controls and monitor parent balance/exposure. [Official subaccounts documentation](https://www.twilio.com/docs/iam/api/subaccounts).
7. **Credentials/signatures.** Keep provider secrets server-side; choose API key scope per endpoint, with subaccount-specific credentials. Auth tokens are still needed for webhook signature validation. Do not repeat the skill's blanket claim that token rotation invalidates all API keys without evidence. No credentials were read/created/transmitted. [API keys](https://www.twilio.com/docs/iam/api-keys), [webhook security](https://www.twilio.com/docs/usage/security).
8. **SMS pricing unit.** Long or Unicode text can consume multiple billable segments. Credit-pack semantics, inbound charges, carrier fees and number rental need explicit business decisions before pricing is specified. [Twilio segment explanation](https://www.twilio.com/docs/glossary/what-sms-character-limit).

## Candidate direction — proposals, not approvals

Prefer extending `/platform` and reusing current auth/audit/monitoring/provisioning services. Compare this with a minimal links-only owner landing page and a separate admin application during design review. A separate application would introduce extra deployment/auth/data-access surfaces; evidence so far does not establish a need.

Candidate v1 work areas for discussion:

- Equal owner access and clear separation of platform owner versus company role terminology.
- One owner navigation surface for companies, pending reviews, SMS/provider status, incidents/errors, financial controls and audit.
- Actionable company queues: waiting for internal review, ready for provider submission, provider rejected/correction required, stalled/unknown operation, approved but number/opt-out not ready.
- Provider status with last checked time and explicit unknown/stale states; bounded reconciliation and safe recovery using current operation identities.
- Number inventory, allowances and customer SMS credit accounting. Treat prepaid billing as its own sub-project, dependent on agreed pricing/refund/cost rules.
- Scoped support actions and sensitive-data projections; reason/step-up/audit for material changes.
- Incident ownership/escalation, alert delivery visibility, tenant/provider health and a plan for monitoring-system outages.

Potential later work, subject to Mike's priorities: international/toll-free, advanced incident assignment/ticket integration, extra staff roles, broad impersonation or custom analytics. Multiple local numbers with employee assignments are now confirmed v1 scope. Other candidates are not silently excluded or approved yet.

## Unresolved interview topics

Ask one focused question at a time; do not resolve these by defaults:

- Rules for assigning/reassigning company-owned numbers and access when employees leave; whether toll-free is a later requirement.
- Who triggers provider submission and who pays its charge; whether a trial/card-on-file satisfies the payment prerequisite.
- SMS segment-pack quantities/pricing, inbound/outbound fees, rental payment, top-up behavior, refunds/chargebacks and zero-balance policy.
- Evidence/documents beyond the current form, who can see sensitive values, correction requests, immutable submitted versions and provider rejection/resubmission.
- Actual parent account setup and provider eligibility evidence. Do not request secrets in chat.
- Monitoring events/thresholds, both owners' delivery destinations, urgency/on-call expectations and customer-visible communications.
- Details of audited support access: read-only versus mutations, reason/step-up/duration/customer consent, and any impersonation expectations. Default operational visibility and gated sensitive-content access are confirmed.
- Retention periods, audit visibility, emergency suspension/resumption and additional owner-grant controls.
- Final v1 priority and acceptable manual provider-console steps.

## Acceptance topics to turn into exact tests after decisions

Equal owner access; denied tenant-admin/API-key access; revoked grants/sessions; MFA and fresh step-up; trusted mutation origin; explicit workspace/resource binding; audit rollback on local mutation failure; sensitive data/secret redaction; duplicate approval/submission/payment events; concurrent spending/number purchases; provider timeout and reconciliation without duplicate charges/resources; rejected/corrected submissions; delayed/duplicate/out-of-order callbacks; STOP suppression; paused/zero-credit send behavior; stale/unavailable health data; alert delivery failure; staged rollback without losing balances, audit or pending operations.

No tests were run because this task has changed no implementation. Existing test filenames and source behavior are evidence to plan from, not a claim that the current build or hosted operation passed.

## Remaining gates

The interview is not complete and no design/spec has been approved. The subsequently requested draft design and implementation plan include proposed schema, permissions, acceptance criteria and task/worktree/PR sequence, with affected tasks blocked on D1–D9 rather than guessed answers. Main was refreshed to `4bc1894f37080be5f0230f10921b34c7d463eea0`; see the plan for #210/#223/#224 and other overlap. Use fresh isolated worktrees only when later implementation is explicitly authorized. No implementation instruction has been given.

# Issue #42: outbound SMS suppression audit

Audited 2026-10-01 in the isolated task worktree. GitHub was not accessed; the supplied issue #42 step 4 is the task scope. Live Linear MIC-156 still requires opted-out merchants to be blocked from scheduled outreach (dependencies MIC-97 and MIC-91). Hosted Twilio eligibility and pilot acceptance remain Michael's responsibility.

## Dispatch inventory and verdict

Searches covered `src/` and `scripts/`: `deliverClosingSms`, `getSmsAdapter`, `create*SmsTransport`, `sendSms`/`sendSMS`, `.send(`, `Messages.json`, SMS webhook settings, `send_sms`, SMS notification channels and job dispatchers. Graphify was used for initial navigation; source determines this inventory.

| Path | Dispatch chain | Verdict |
| --- | --- | --- |
| Deal composer/direct application-update text | `app/api/mca/sms/messages/route.ts` → `sms/service.ts:deliverClosingSms` | Existing consent/reservation checks covered STOP before send. Fixed the post-reservation gap at final dispatch; HTTP preview → STOP → send/retry tested. |
| Inbox reply and concurrent retry reservation | Same route, with `inbox.ts:assertConversationReply` | Same final-dispatch fix. Existing thread/account/recipient binding and retry identity retained; HTTP reply and retry after STOP tested. |
| Merchant offer text, including Home offer actions and audited recipient override | `closing/service.ts:sendMerchantOfferPreview` → `closing/offer-sms.ts` → `deliverClosingSms` | Shared fix. Saved preview → STOP → send/retry produces no provider call or pitch. Reconciliation only reads the prior result. |
| Assistant approved SMS action | `assistant/operations.ts:executeAction` → `deliverClosingSms` | Already revalidates saved approval; shared dispatch gap fixed. Added Postgres test for STOP between approval and execution, including retry. |
| Notification foundation/runtime: document, renewal, missed-call SMS | `notifications/worker.ts:runScheduledNotifications` → `transport.ts:defaultNotificationTransport` → `deliverClosingSms` | Already rechecks consent when claiming queued/retry work and before transport; shared dispatch gap fixed. All three kinds tested in both queued and retry states after STOP, using the production worker/transport and fake provider HTTP. |
| Document reminder/automation producer | `documents/notification-service.ts`, `notification-discovery.ts`, `notification-automation.ts` → notification queue | Same notification consumer and checks. No separate SMS transport. |
| Managed company SMS | Shared service → `reserveManagedSend`/`managedReady` → same adapter | Reservation already checks STOP, company/carrier/number readiness and cost budget. Fixed final readiness recheck after reservation. Tested STOP, suspension after reservation, missing eligibility and missing credentials. |
| Manually configured sender under company SMS suspension | Shared service | Fixed company-wide SMS suspension check at dispatch; switching to a manual sender cannot bypass it. Billing/company pause was already checked repeatedly and is regression-tested after reservation. |
| Twilio, Entrance, TextTorrent, TextUs, OpenPhone, GoHighLevel adapters | Only runtime registry send call is in `sms/service.ts:dispatchOutboundSms` | All share the final consent recheck under the recipient lock. Table-driven tests enumerate `SMS_PROVIDERS` and assert zero adapter calls if STOP is committed after reservation. Twilio injected transport is tested separately. Credential validation remains in the existing adapters; missing Twilio credentials result in zero HTTP calls. |
| Legacy stipulation/request SMS webhook | `closing/service.ts:sendRequestPreview` → `closing/delivery.ts` → configured SMS webhook | **Gap fixed by disabling legacy SMS webhook dispatch.** This transport had no SMS consent/readiness checks. It now returns blocked, even with a configured endpoint/token. Postgres preview → STOP → send/retry test asserts zero HTTP calls. No new stipulation SMS provider path was enabled. |
| Scheduled merchant follow-ups | `comms/followups.ts:defaultTransport` | Already non-sending for SMS: production returns failed; development returns preview. Evaluation also checks current SMS consent. No SMS HTTP dispatch exists here. |
| Application invitations/outreach and invitation reminders | `applications/`, invitation job kinds in `jobs/worker.ts` | Email-only; no outbound SMS provider path. Manual application-update texts use the composer or assistant above. |
| Submission reminders/workflows, outbound workflow webhooks | `comms/reminders.ts`, `comms/workflow-events.ts`, job dispatcher | Email or business-event webhooks, not an SMS delivery transport. No separate SMS send job kind. |
| SMS maintenance/cron/provisioning | `sms/scheduler.ts`, `maintenance.ts`, `provisioning.ts` | Registration/number/usage operations; no outbound merchant message dispatch. |
| Inactive SMS credit ledger/reservations | `sms/credits.ts` | Pure ledger operations; no provider dispatch or activation. Existing managed usage reservation is accounted for above. |
| DocuSeal signatures | `closing/docuseal-provider.ts` | Explicit `send_sms:false`; not an outbound SMS path. |

## Callback and consent changes

- Keyword STOP variants and signed Twilio Advanced Opt-Out STOP retain workspace/recipient-wide suppression. HELP and ordinary messages do not clear it. Existing signature, account and receiving-number/service checks remain intact.
- Inbound processing acquires the existing recipient advisory lock **before** checking duplicate provider IDs. Concurrent callbacks cannot both pass duplicate detection and apply consent changes twice.
- Subscriber-initiated START/YES/UNSTOP and signed Advanced Opt-Out START restore consent and clear suppression as before. Replayed provider IDs remain deduplicated and cannot undo a later STOP. Manual opt-in evidence retains its existing timestamp/replay checks.
- Manual opt-out now writes the existing workspace/recipient suppression as well as the deal consent event. Another deal with the same phone cannot bypass it.
- Twilio synchronous `21610` responses record suppression after the provider call, in a separate short transaction. Signed asynchronous `21610` status callbacks now also suppress; duplicate status callbacks are idempotent and late ordinary status updates do not clear suppression.
- The final send recheck takes the same recipient advisory transaction lock as inbound/manual consent changes, verifies suppression, current consent, active account, company SMS suspension, managed readiness and outbound approval, then commits. Provider I/O runs outside that transaction. A STOP visible at this recheck blocks the call; a STOP arriving after commit can race with dispatch, and an initiated HTTP request cannot be recalled. Provider Advanced Opt-Out remains part of hosted acceptance. Recheck failures return a failed result without dispatch; errors after calling the provider propagate and retain the existing no-blind-retry behavior.

## Verification

All provider calls are fake/simulated, all records synthetic, and all SQL runs against disposable databases created with `MCA_TEST_DATABASE_ADMIN_URL`. A test-only Postgres trigger commits suppression/suspension during `rememberOutbound`, after message reservation and before dispatch, to reproduce the former gap deterministically. No trigger is installed outside a test database.

Use Node 24.21.0 and pnpm 11.1.2 from `nextjs-version/`:

```sh
pnpm typecheck
pnpm lint
node --experimental-test-module-mocks --conditions=react-server --import tsx --test --test-concurrency=1 \
  tests/sms-stop-suppression.test.ts tests/sms-onboarding.test.ts \
  tests/milestone05-sms.test.ts tests/milestone06-sms-composer.test.ts tests/assistant.test.ts
```

Revision verification: 107/107 targeted tests passed; `pnpm typecheck` passed; `pnpm lint` completed with zero errors and the same 16 existing warnings (none in changed files). Typecheck and lint initially exited 137 when run concurrently with other checks; each passed when rerun separately with a 3 GiB Node heap limit. The original 28-case regression file produced 14 failures against the original production files, then passed with the initial fixes. Added coverage verifies provider I/O runs after transaction commit/lock release for both adapter and injected transport, and provider exceptions do not become never-sent failures. Onboarding tests again expect START/YES/UNSTOP to restore consent. The full suite was not run.

The current `effectiveAt` values in `milestone05-sms.test.ts` and `milestone06-sms-composer.test.ts` are retained: both fixtures call `recordSmsConsent` for manual opt-out, which now writes suppression with the current timestamp. Their subsequent manual opt-in must be current to pass the existing suppression timestamp check; the old September evidence is backdated. Neither fixture uses inbound START to restore consent, so these changes are independent of the reverted START semantics.

No migration, runtime flag activation, environment file, Vercel schedule, Twilio setting, Stripe setting, hosted database, deployment, push or PR is part of this change.

Hosted question for Michael: On the approved nonproduction Twilio company/campaign/number, can you record the eligibility decision and pilot evidence for signed STOP/HELP/START handling, zero subsequent sends from composer, inbox, offers, assistant and queued/retry notifications, and restoration after subscriber START or fresh manual consent, before enabling production SMS?

Open product/compliance question for Michael: should a delayed, previously unseen START be ignored after a newer STOP, and how should reliable event ordering be established? This revision preserves the existing START behavior and does not make that policy decision.

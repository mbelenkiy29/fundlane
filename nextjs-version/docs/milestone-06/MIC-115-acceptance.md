# MIC-115 acceptance — Scheduled merchant follow-ups by deal status

Executed locally with synthetic Postgres fixtures. Scope: status/channel/local schedule/template/retry policies, idempotent occurrences, recheck status/consent/recipient before send, stage-change skip, missing-doc / approval / renewal / past-approval scenarios, test/preview mode. Live merchant email/SMS is out of scope.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| Moving a deal out of the target stage before delivery suppresses the message | Passed | `tests/milestone06-followups.test.ts` — pending occurrence for an `offer` policy against a deal now in `funded` is `skipped` with `stage_changed`; transport is not called |
| A repeated scheduler execution cannot send twice for the same scheduled occurrence | Passed | Second `runFollowups` / `POST .../jobs/run` with the same `nowIso` does not call transport again; unique `(workspace_id, policy_id, deal_id, occurrence_key)` keeps one row |
| Demonstrate every implementation requirement with a realistic synthetic scenario | Passed | Missing-documents email with `{{business_name}}` / `{{missing_docs}}` / upload URL; approval SMS only with opt-in; renewal email; past-approval skip; daily/weekly/monthly occurrence keys at America/New_York 6 AM |
| Loading, empty, validation, success and failure states; retries preserve identity | Passed | `FollowupPanel` copy for loading, empty catalog, status/template/timezone, saved/enabled/paused, `role="alert"`. Failed transport `state = failed` with `send_failed:N`; retry reuses `id` / `correlation_id` |
| Direct API requests enforce the same permissions as the UI; secrets excluded | Passed | Admin session list/create/preview/test; rep and `deals:read` / `deals:write` / `intake:write` keys 403; other-workspace session cannot see this workspace’s policies. SMTP password and webhook token omitted from JSON and webhook bodies |

Command:

```
cd nextjs-version && node --conditions=react-server --import tsx --test --test-concurrency=1 tests/milestone06-followups.test.ts
```

3/3 passed.

## Behavior

- Policy: exact `deal_status`, `email | sms`, local schedule JSON, published `template_id` (merchant/followup/request_info, matching channel), `enabled`, retry `{ maxAttempts, backoffMinutes }`.
- Occurrence key: `daily:YYYY-MM-DD` / `weekly:YYYY-MM-DD` / `monthly:YYYY-MM-DD` in the policy timezone. Due when `now >= scheduled_for`.
- Recheck immediately before send: current status must still match; email uses contact/primary-owner address; SMS uses deal mobile and latest `mca_sms_consent_events` (`opted_in` required, `opted_out` skips).
- Claim uses `INSERT ... ON CONFLICT DO NOTHING` plus `FOR UPDATE`. `sent` / `skipped` are terminal for that key. Failed rows retry after backoff until `maxAttempts`.
- Preview lists matching deals without writing rows. Test send uses transport `mode: "test"` and does not consume the live occurrence.
- Accepted live delivery is `sent` or non-production `preview`. Failed transport is not a successful follow-up.
- `runtime = "nodejs"`, `cache-control: no-store`, `assertTrustedMutation` on POST/PATCH/test.

## UI

`FollowupPanel` lists policies, creates/updates status + channel + schedule + template + enabled + retry, previews matching deals, and sends a test message. Conductor mounts it in settings.

## Local vs live gates

Local fixtures prove policy CRUD, occurrence uniqueness, stage-change skip, consent gates, preview/test isolation, retry identity, permissions, and injected transport. There is no live merchant email or SMS. Fixture success is not production sending readiness.

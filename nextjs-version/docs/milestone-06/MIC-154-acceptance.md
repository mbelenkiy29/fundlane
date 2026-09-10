# MIC-154 acceptance — Manual funder reminders in the original email thread

Executed September 9, 2026. Scope: Remind Funder on unanswered email submissions, original thread headers with disclosed fallback, last-reminded without changing submission status, no reminder control on API/portal/webhook jobs. Live mailbox send is out of scope.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| An API submission has no unsupported email-thread reminder button | Passed | `tests/milestone06-reminders.test.ts` — API / portal / webhook jobs return `remindControl: "hidden"` and `eligible: false`; preview/send return `409 reminder_unsupported_transport`; `RemindFunder` only renders **Remind Funder** when `job.eligible && job.remindControl === "remind"` |
| A reminder preserves submission status and records delivery separately | Passed | Email job stays `sent` after preview, accepted send, failed send, and retry; `mca_funder_reminders.state` / `last_reminded_at` / `correlation_id` hold the delivery record |
| Synthetic scenario: thread reply, fallback, no-response gate | Passed | Stored Message-ID used as `In-Reply-To` / `References` / thread id; null `external_ref` returns `THREAD_FALLBACK_DISCLOSURE` and sends without `inReplyTo`; matched reply → `409 reminder_already_responded` and hidden control |
| Loading / empty / validation / success / failure UI; retries preserve identity | Passed | Component copy for loading, empty, blank body, success, `role="alert"` failure; failed send keeps `reminderId` / `correlation_id`; replay of a sent row does not send a second message |
| Direct API permissions match UI; secrets excluded | Passed | `deals:read` GET/preview 200, send 403; `deals:write` send 200, GET 403; intake 403; cross-workspace deal 404; empty body 422; SMTP password, webhook token, and `credentialCipher` omitted from JSON and injected payloads |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/milestone06-reminders.test.ts
```

3/3 passed.

## Behavior

- Eligible: `routeKind === "email"`, job `sent`, no matched/processed/pending_review `mca_funder_replies` row for the job.
- GET `/api/mca/comms/reminders?dealId=` (`deals:read`) returns per-job `eligible`, `remindControl`, `submissionState`, `lastRemindedAt`, and `defaultBody`.
- POST `/api/mca/comms/reminders/preview` (`deals:read`) persists `state = previewed` and does not call transport or set `last_reminded_at`.
- POST `/api/mca/comms/reminders` (`deals:write`) sends from the original submission sender to original To/CC. Accepted send sets `last_reminded_at`. Failed send does not.
- Thread mode `reply` when MIC-153 attempt metadata is present; `fallback` (new email + disclosure) when it is missing.
- `runtime = "nodejs"`, `cache-control: no-store`, `assertTrustedMutation` on send.

## UI

`RemindFunder({ dealId })` covers loading, empty (no unanswered email jobs), validation (blank body), success (status unchanged), and failure (provider / request error). API/portal/webhook jobs never get a Remind Funder button. Conductor mounts it on the deal Submissions tab.

## Local vs live gates

Local Postgres fixtures prove eligibility, thread headers, fallback disclosure, separate delivery rows, permissions, and injected transport. There is no live funder email. Fixture success is not production sending readiness.

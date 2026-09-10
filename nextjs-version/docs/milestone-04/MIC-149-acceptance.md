# MIC-149 acceptance — Read-only funder reply ingestion

Executed September 8, 2026. Scope: opt-in read-only mailbox ingest, cursor checkpoints, 15-minute interval constant, Message-ID/thread then `funder.domains` correlation, pending-review queue, and idempotent `provider_message_id` replay. Live mailbox OAuth is out of scope.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| Separate-thread reply linked with reviewable evidence | Passed | `tests/submissions-replies.test.ts` — From `@alpha-replies.example.test` (funder.domains), different thread id, no In-Reply-To; state `matched`; evidence `method: "domain"`, `flagsUnchanged: true`, notes that Message-ID/thread did not hit, alias + displayId subject hits; `matchedJobId` is the sent job |
| Replay creates no duplicate; mailbox flags unchanged | Passed | Second `POST /run` `createdCount: 0`, `replayedCount: 1`, same id; one `mca_funder_replies` row for that `provider_message_id`; fixture spy `mutations` empty (`markRead` / labels / delete unused) |
| Ambiguous / unrecognized → `pending_review` | Passed | Two Alpha jobs + generic subject → `ambiguous` with both deal ids; unknown From domain → `unrecognized` and omitted from the first deal queue |
| Direct API permissions match UI; secrets excluded | Passed | `intake:write` GET/POST 403; `deals:read` GET 200; `deals:read` PATCH 403; `deals:write` ignore 200; other workspace deal 404; JSON omits SMTP password, `credentialCipher`, `body_cipher` |
| Loading / empty / validation / success / failure UI | Passed | `ReplyQueue` loading copy, dashed empty state, job-required validation before link, success copy after link/ignore/ingest, 503/request-error alert |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/submissions-replies.test.ts
```

2/2 passed.

## Behavior

- Opt-in: admin `POST /api/mca/submissions/replies/run` `{ senderId, enabled: true }`. Unopted senders are 422.
- Worker: `POST /api/mca/submissions/replies/run` (optional `senderId`). `REPLY_INGEST_INTERVAL_MS = 900000`. No in-process cron.
- Mailbox adapter `listMessages` only. Cursor stored on a reserved processed checkpoint row per sender.
- Correlation: stored attempt Message-ID / thread (`external_ref` from MIC-153) before `funder.domains` and subject/display-id fuzzy match.
- Unique domain+job or unique subject score → `matched` with evidence. Else `pending_review`.
- Unique key `(workspace_id, sender_id, provider_message_id)` makes ingest replay identity-preserving.
- GET `/api/mca/submissions/replies?dealId=` is `deals:read`. PATCH review is `deals:write`. `intake:write` is 403.
- Missing live mailbox → `503 mailbox_oauth_not_configured`. Tests inject a fixture mailbox.

## UI

`ReplyQueue` covers loading, empty (no replies), validation (link without a job), success (ingest counts / linked / ignored), and failure (request or live-OAuth gate). Conductor mounts it on the deal Submissions tab.

## Local vs live gates

Local Postgres fixtures prove correlation, idempotent replay, unchanged mailbox flags, ACL, and encrypted bodies. There is no live Gmail/Graph read. Fixture success is not production mailbox integration readiness.

# MIC-150 acceptance — Review email and secure selection

Executed September 8, 2026. Scope: funder-analysis review email, 5-minute HMAC review links, and snapshot-bound confirmation. MIC-121 sender-connection UI is out of scope.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| Review core + HTTP | 6/6 passed | `tests/underwriting-review.test.ts` |
| Recipients | Passed | Active membership emails for configured roles plus workspace CC; deactivated and unconfigured roles omitted |
| Template + TTL | Passed | `funder_analysis_review` via `deliverEmail`; token expires at now + 5 minutes |
| Expired / forwarded link | Passed | Expired, tampered, and foreign-workspace tokens return 404 `review_link_invalid` and cannot confirm |
| Revalidation | Passed | Confirm requires completeness ready and current scores for that snapshot (`deal_not_ready` / `scores_stale`) |
| Snapshot binding | Passed | Approval id stays on the original run/snapshot; a later analysis run gets its own approval |
| Retry identity | Passed | Same snapshot + same selected funders returns the same approval id |
| DQ / empty selection | Passed | 422 `selectedFunderIds` for empty or disqualified funders |
| Permissions | Passed | `deals:read` GET; `deals:write` send/confirm; `intake:write` 403; settings POST needs admin session; foreign workspace 404 |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/underwriting-review.test.ts
```

## Behavior

- Recipients resolve from workspace review settings: default roles `admin`, `manager`, `super_admin`, plus configured CC emails. No sender-connection picker.
- Send issues a 5-minute HMAC token bound to workspace, deal, analysis run, and score snapshot. The email uses the existing `MCA_EMAIL_WEBHOOK_URL` contract with template `funder_analysis_review`. Missing webhook in non-production is preview delivery.
- `/review/[token]` is an authenticated dashboard page. Confirm still requires a current `deals:write` actor in the token workspace.
- Confirm rechecks permissions, completeness `ready`, and score freshness. Approval writes `mca_review_approvals` and sets that run to `approved` for that snapshot only.
- Later reruns create a new snapshot/run and do not mutate the prior approval.
- Reads: `deals:read`. Send/confirm: `deals:write`. Settings writes: interactive admin session. `intake:write` is 403. Cross-workspace tokens and deals are 404.

## UI

`ReviewPanel({ token })` is the email-link form (loading, empty, validation, success, expired/stale/not-ready). `ReviewPanel({ dealId })` is the in-app fallback with send + confirm. Conductor mounts the `/review/[token]` route; the deal-tab panel is exported and not mounted here.

## Local vs live gates

Local/fixture Postgres plus synthetic memberships, completeness, and scores prove recipient resolution, HMAC expiry, foreign-workspace denial, revalidation, snapshot binding, and permission envelopes. Production Gmail/OAuth sender connections are MIC-121 and remain an external gate. Webhook/preview mail is the allowed local completion path.

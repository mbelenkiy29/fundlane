# MIC-148 acceptance — Analysis modes

Executed September 8, 2026. Scope: workspace defaults and run-level overrides for analyze-only, review-first, and automatic-send. Sending is fail-closed through `queueSubmissions`.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| Analysis core + HTTP | 6/6 passed | `tests/underwriting-analysis.test.ts` |
| Default mode | Passed | Workspace default is `review_first`, top N 5, notify `both`, automatic send off |
| Analyze-only | Passed | Never calls `queueSubmissions`; `selectedFunderIds` stays `[]` |
| Review-first | Passed | State `review_pending`; DQ funders blocked; `email_only` does not pre-select |
| Automatic send | Passed | Requires admin enablement; snapshots settings; calls `queueSubmissions`; state `submission_unavailable` |
| Override vs defaults | Passed | Run override leaves workspace settings untouched |
| Retry / duplicate send | Passed | Same snapshot + settings returns the same run id and does not queue twice |
| No-qualified-funder | Passed | First-class `blocked` / `no_qualified_funder` |
| Readiness trigger | Passed | Runs after completeness ready; unchanged completeness version does not emit another run |
| Permissions | Passed | `deals:read` GET empty then `deals:write` POST; `intake:write` 403; settings POST needs admin session; foreign workspace 404 |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/underwriting-analysis.test.ts
```

## Behavior

- Workspace defaults: mode, top-N (1–25), review notification channel (`select_only` | `email_only` | `both`), automatic-send enablement. Default mode is `review_first`.
- Run-level override applies to one run and is snapshotted on that run. Workspace defaults are not mutated.
- `analyze_only` scores funders, records destinations, never changes selection, never calls `queueSubmissions`. State `scored`.
- `review_first` selects top-N auto-selectable funders unless channel is `email_only`. State `review_pending`. DQ / ineligible funders are `blocked`.
- `automatic_send` requires admin enablement. Enabled runs call `queueSubmissions` from `submission-port.ts` (always `submission_unavailable` today) and persist that state. Disabled runs are `blocked` with `automatic_send_disabled` and do not queue.
- Each destination is recorded as selected, excluded, or blocked with a reason. No-qualified-funder is first-class.
- Trigger after completeness `ready` (`runAnalysisIfReady`) or manual run. A run already stored for that completeness version is not duplicated.
- Reads: `deals:read`. Runs: `deals:write`. Settings writes: interactive admin session. `intake:write` is 403. Cross-workspace deals are 404.

## UI

`AnalysisPanel({ dealId })` covers loading, empty, validation (top N / automatic send disabled), success, blocked/no-qualified, and `submission_unavailable`. Conductor mounts it on the deal Underwriting tab.

## Local vs live gates

Local/fixture Postgres plus synthetic deal/funder/completeness inputs prove modes, destination reasons, readiness de-dupe, retry identity, and permission envelopes. `automatic_send` is fail-closed: MIC-166 sending is an external gate. Fixture `submission_unavailable` is not production send readiness.

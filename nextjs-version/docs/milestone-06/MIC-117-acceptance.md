# MIC-117 acceptance — Follow-up sender fallback, CC and BCC settings

Executed locally with synthetic Postgres fixtures. Scope: workspace-shared vs originator merchant sender, verified fallback used once, template CC and fallback BCC independent from submission rep-copy, visible failure when neither sender is available. Live merchant email is out of scope.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| Disconnecting an originator chooses the configured fallback exactly once | Passed | `tests/milestone06-sender-fallback.test.ts` — expire originator merchant sender; three resolves return the same verified fallback id with `usedFallback: true` and `fallbackAttempts: 1`; submission sender is never selected |
| No available sender yields a visible failure rather than a false success | Passed | Expire fallback as well; `ok`, `success`, and `wouldSend` are `false`, `reason` is `sender_unavailable`, `sender` is omitted; preview HTTP 200 still carries `success: false`. Gate phase is `failure` |
| Demonstrate every implementation requirement with a realistic synthetic scenario | Passed | Harbor Bakery: workspace-shared sends from `fallback@example.test`; originator mode sends from `originator@example.test`; CC `ops-copy@` / `compliance@`; BCC fallback address; submission `cc_originator=1` / `cc_closer=1` emails absent |
| Loading, empty, validation, success and failure states; retries preserve identity | Passed | `senderFallbackGate` / `SENDER_FALLBACK_COPY` for loading, empty, invalid mode/CC, saved, `senderUnavailable`. Second PATCH keeps the same settings `id` |
| Direct API requests enforce the same permissions as the UI; secrets excluded | Passed | Admin session GET/PATCH/preview; rep and `deals:read` / `deals:write` / `intake:write` keys 403; other-workspace session cannot see this workspace’s settings or senders. SMTP password and `credentialCipher` omitted |

Command:

```
cd nextjs-version && node --conditions=react-server --import tsx --test --test-concurrency=1 tests/milestone06-sender-fallback.test.ts
```

3/3 passed.

## Behavior

- Sender mode: `originator` (default) or `workspace_shared`.
- Originator merchant sender: `purpose = merchant` assigned to the deal’s originator membership, `state = verified`, credential present.
- Fallback: `purpose = fallback`, verified, used once when originator sending is unavailable. Not used as a chain through submission senders.
- Template CC: per-template addresses, max 25, independent from submission rep-copy.
- Fallback BCC: optional copy to the fallback `fromAddress`.
- Preview returns the chosen sender. Failure is explicit (`success: false`), never a successful send.
- `runtime = "nodejs"`, `cache-control: no-store`, `assertTrustedMutation` on PATCH.

## UI

No exclusive panel file. `SENDER_FALLBACK_COPY` and `senderFallbackGate` cover loading, empty, validation, success, and failure. GET catalog includes `copy` for a future Settings mount.

## Local vs live gates

Local fixtures prove mode selection, one-shot fallback, CC/BCC isolation, permissions, and identity. There is no live merchant email. Fixture success is not production sending readiness.

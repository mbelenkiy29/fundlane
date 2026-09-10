# MIC-106 acceptance — Stipulation tasks and secure merchant upload requests

Executed 2026-09-09. Scope: independent software re-verification of Linear MIC-106. No code change. Exclusive module `stipulation-activation.ts` remains a documented no-op.

Verdict: **REVIEW_PASS**.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| Upload token cannot retrieve other documents | Pass | Public inspect omits document IDs (`service.ts` 234–237). Vault/download/artifact routes need session/API auth or a different signed token (`documents/http.ts` 8–12; `documents/download/[token]/route.ts` 8–9; `closing/artifacts/[token]/route.ts` 6–10). Upload token regex rejects dotted artifact tokens (`service.ts` 228). |
| Upload token cannot change deal ID | Pass | Token HMAC is `workspaceId:stipulationId:key` (`195–197`). Store uses link `deal_id` (`252–253`). Replay rejects deal/category mismatch (`245–248`). Public JSON does not contain `dealId` (`tests/milestone05-closing.test.ts` 60–62). |
| New upload resolves the correct request only after validation | Pass | Magic/MIME validation before consume (`documents/service.ts` 36–56). Invalid PDF keeps status `open` (`closing.test.ts` 63–64). Valid PDF marks only the linked open task `received` (`service.ts` 257–259; test 65–66). `verified` requires clean + matching category (`151–158`). |
| Idempotent replay after response loss | Pass | Prior document is returned before consumed-link 404 (`244–248`; test 67). Inspect then fails (`68`). |
| Workspace isolation | Pass | Other-workspace `updateStipulation` is `stipulation_not_found` (test 70). |
| Request Info preview identity | Pass | Preview persists encrypted subject/body/hash (`275–284`, `332–348`). Send decrypts the saved body and refuses hash mismatch (`407–410`). Merchant purpose sender required (`404`). |
| Loading / empty / validation / success / failure | Pass | Public page `merchant-upload-panel.tsx` 8–22. Closing panel `closing-panel.tsx` 88–92, 139, 143. |
| Direct API permissions match UI | Pass | `requireClosingActor` (`http.ts` 10–16). Read key GET 200, write 403, deals-page-off session 403 (test 213–221). |
| Logs exclude secrets and document bytes | Pass | Audit metadata IDs/hashes/flags (`service.ts` 147, 183, 265, 328). Recipients ciphertext. Postmark error text not persisted (`delivery.ts` 117–124). |
| Focused closing suite | 7/7 pass | Command below, 2026-09-09. |
| Live Postmark Request Info | Not performed | Remaining provider gate. |

Command:

```
cd nextjs-version
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/milestone05-closing.test.ts
```

```
✔ MIC-106 opaque merchant upload is deal scoped, validates content, resolves once, and replays after response loss (16463.807875ms)
✔ MIC-108 requests preserve blockers, attach pinned clean documents, never imply signature, and require evidence (8251.343709ms)
✔ MIC-157 encrypts PSF details, failed transport stays failed, one provider identity is reused, and signed webhook replay is idempotent (3767.249292ms)
✔ MIC-168 pins preview revisions, excludes commissions, never pitches failed sends, and logs every successful or phone revision separately (3788.218584ms)
✔ MIC-168 text delivery pins an assigned sender, requires consent, sends the exact preview, and records provider acknowledgement (7069.534709ms)
✔ closing delivery fences concurrent attempt keys and reconciles a crash-pending reservation without resending (3684.856167ms)
✔ closing HTTP routes enforce read/write scopes, session page visibility, and workspace isolation (1029.87925ms)
ℹ tests 7
ℹ pass 7
ℹ fail 0
duration_ms 44780.363625
```

## Linear AC mapping

| Linear AC | Result |
| --- | --- |
| An upload token cannot retrieve other documents or change a deal ID | Pass — citations above |
| A new upload resolves the correct request only after validation | Pass |
| Demonstrate every implementation requirement with a realistic synthetic scenario | Pass — MIC-106 test + Request Info/link/stipulation source |
| Loading, empty, validation, success and failure states are usable; retries preserve record identity | Pass |
| Direct API requests enforce the same permissions as the UI. Logs exclude secrets and full sensitive document contents | Pass |

Proposed implementation items (document type/owner/due date, expiring links, Request Info and DL/VC, duplicate-key protection, human review of category mismatch) are present in `createStipulation`, `createMerchantUploadLink`, `previewStipulationRequest`, `updateStipulation`, and `closing-panel.tsx` 143.

## Local vs live gates

Synthetic transport and a disposable Neon database prove application behavior. They do not prove Postmark delivery. Production has a pending merchant sender and Railway `MCA_CLOSING_POSTMARK_CONNECTIONS_JSON` bindings. No recipient is authorized. This review did not send email.

## Activation checklist (later; do not send now)

1. Named authorized merchant recipient.
2. Pending merchant sender in Settings → Connections, purpose `merchant`.
3. Exact workspace/sender/From/server-token binding in `MCA_CLOSING_POSTMARK_CONNECTIONS_JSON`.
4. **Test sender** to that recipient; verify only on Postmark `ErrorCode: 0` + `MessageID`.
5. One Request Info send of the saved immutable preview.
6. Confirm delivery `MessageID` and one upload URL resolving only the matching open task.

## Remaining gate

Authorized merchant recipient + real Postmark Request Info delivery.

Do not mark Linear Done from this agent.

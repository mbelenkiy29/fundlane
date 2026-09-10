# MIC-108 acceptance — Contract request, acceptance, repricing, and signature tracking

Date: 2026-09-09
Agent: A3
Linear: [MIC-108](https://linear.app/michael-belenkiy/issue/MIC-108) remains **In Progress**. Software re-verified. **Not Done.**

**Verdict: `REVIEW_PASS`**

Exclusive `contract-activation.ts` was left as a documented no-op. No software gap was proven that can be fixed in that file. No live funder email. No Linear state change.

## Verification this session

Disposable Neon database via `tests/helpers/postgres-test-db.mjs`. Synthetic closing transport only.

```text
cd nextjs-version
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/milestone05-closing.test.ts

tests 7
pass 7
fail 0
duration_ms 48629.068833
```

MIC-108 case: `MIC-108 requests preserve blockers, attach pinned clean documents, never imply signature, and require evidence` (8019ms).

## Linear acceptance criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| A request does not mark contracts signed | Pass | Insert `accepted` with null `signed_at` (`service.ts` 354–357). Preview writes `contract_requested` / `repricing_requested` (`376–389`). Send may set `contract_sent` only from `contract_requested` (`421`). Test after send: state `contract_sent` (`tests/milestone05-closing.test.ts` 79–83). Signed is a later evidence call (88–89). |
| Absent DL/voided check remains a visible blocker or explicit exception | Pass | `validatedClosingDocuments` requires clean DL+VC or trimmed exception (`service.ts` 364–383). Missing contract request throws `closing_documents_missing` with per-category field errors. Test 76. UI: Contracts description, empty “No clean DL or voided check”, exception inputs, outstanding-stip banner (`closing-panel.tsx` 45, 97, 144, 153). |
| Realistic synthetic scenario with expected output | Pass | Focused MIC-108 test: accept → blocked preview → pin DL/VC → request/send `contract_sent` → redeem original PDF bytes → repricing reason required then saved → external id alone fails → clean closing document signs → late send stays signed → final review → later send stays `final_review` (test 73–94). |
| Loading, empty, validation, success, failure usable; retries preserve identity | Pass | Panel loading/empty/error/success (`closing-panel.tsx` 30, 88–91, 139–144). Preview idempotency + hash (`service.ts` 275–284; schema unique `mca_closing_previews_idempotency_key`). Workflow unique revision + idempotency (`milestone05-closing.ts` 64–65). Delivery attempt unique + fence (`49`; `service.ts` 297–313). Send cannot regress signed/final-review (`421`; test 90–94). |
| Direct API permissions match UI; logs exclude secrets and document bytes | Pass | `requireClosingActor` enforces Deals visibility and `deals:read`/`deals:write`; signature/final-review session-only (`closing/http.ts` 10–16). HTTP test 213–221. Audit uses `externalIdPresent`, hashes, record ids (`service.ts` 323, 328, 437). Recipients encrypted. |

## Lane C / brief proofs

| Requirement | Result | Evidence |
| --- | --- | --- |
| Repricing requires a reason | Pass | API `superRefine` (`contracts/[id]/preview/route.ts` 8); service `repricing_reason_required` (`385`); UI disabled without reason (`closing-panel.tsx` 144, 153); test 84–86. Delivery is a second action on the saved preview. |
| External signature id alone is not signed evidence | Pass | External requires id **and** clean same-deal `closing_document` (`service.ts` 429–433). Id-only → `validation_failed` (test 87). Manual source stores reason only, not provider id (`434–436`; panel 153). Final review requires signed state + source (`445–447`). |
| Retries preserve identity; send cannot regress signed/final-review | Pass | Unique keys + content-hash replay (`service.ts` 275–284, 297–313, 357–358). Send `UPDATE … AND state='contract_requested'` (`421`). Test 90–94. |
| Verified submission sender required for contract/repricing preview | Pass | `assertSenderUsable(…, "submission")` at preview and send (`378`, 402–405). UI `submissionSenders` (`closing-panel.tsx` 95, 144). Not live-verified. |

## Remaining gate

Verified **submission** sender + live contract delivery/evidence.

Do **not** treat this review, the synthetic transport, or a Postmark account token as production send readiness. Pending Railway submission-sender binding exists; no authorized recipient; no Test-sender verification (`docs/milestone-05/provider-activation.md`, `postmark-closing.md`).

Activation (future, named recipient required): Test sender → `ErrorCode: 0` + `MessageID` → one contract-request send of the saved preview with pinned attachments → signature only with provider id **and** clean closing document.

## Out of scope this session

- Live funder/contract email
- Marking Linear Done
- Edits to `closing/service.ts`, `closing-panel.tsx`, schema, drizzle
- Conductor residual: unguarded preview UPDATE after signed (`service.ts` 389) is not a Wave 1 exclusive-file gap

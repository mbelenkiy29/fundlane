# MIC-106 report — Stipulation tasks and secure merchant upload requests

Status: **REVIEW_PASS**. Linear remains In Progress. Do not mark Done.

Independent re-read of live Linear MIC-106 (`e22425c7-9232-4065-b5cd-be799642fe88`, In Progress), `lane-c-acceptance.md`, `provider-activation.md`, `postmark-closing.md`, `closing/service.ts`, public merchant-upload, closing panel, and `tests/milestone05-closing.test.ts`.

Software is already implemented. `src/lib/mca/closing/stipulation-activation.ts` stays a documented no-op. No remaining software gap was proven that can be fixed in the exclusive module. `closing/service.ts`, `closing-panel.tsx`, `merchant-upload-panel.tsx`, schema, drizzle, and Linear were not edited.

## Linear acceptance criteria

### An upload token cannot retrieve other documents or change a deal ID

- Public inspect returns only `{ requestLabel, destinationCategory, expiresAt, remainingUploads }`. Deal, workspace, stipulation, and document identifiers are omitted (`service.ts` 234–237). Lookup is by `hashOpaqueToken(token)` with workspace-scoped join (`227–232`).
- Upload HMAC is `workspaceId:stipulationId:idempotencyKey` (`195–197`). The client cannot supply a deal ID. `uploadMerchantDocument` stores with `dealId` from the hashed link row (`252–253`). Replay rejects a prior document on a different deal (`245–248`).
- The upload token is not a download capability. Vault list/get/download require `requireDocumentActor` (`documents/http.ts` 8–12; `documents/route.ts` 10–16; `documents/download/[token]/route.ts` 8–9). Artifact redeem uses a different `payload.signature` token and `MCA_CLOSING_ARTIFACT_TOKEN_SECRET` (`service.ts` 206–225; `artifacts/[token]/route.ts`). Upload tokens fail the artifact/download shape (`^[A-Za-z0-9_-]{30,200}$` has no `.`).
- Focused test: public JSON keys are only those four fields, `dealId` is absent, and a foreign-workspace stipulation update is `stipulation_not_found` (`tests/milestone05-closing.test.ts` 56–71).

### A new upload resolves the correct request only after validation

- MIME/magic/size validation runs in `storeDocument` before the link is consumed (`documents/service.ts` 36–56, 100–103). Invalid bytes throw `document_content_mismatch`; the outer transaction rolls back (`service.ts` 240–253). Nested `withImmediateTransaction` joins the same ALS transaction (`db.ts` 159–177).
- After a clean store, only `WHERE workspace_id=? AND id=? AND status='open'` is marked `received` (`257–263`). Unrelated open tasks are not updated.
- Human `verified` rechecks `processingState === "clean"` and `document.category === row.document_category` (`151–159`). Recategorization therefore blocks verification.
- Replay checks the prior document before the consumed-link check and returns the original `{ documentId, processingState, stipulationStatus }` (`244–248`). A second inspect after max-use is `upload_link_invalid` (`68`).

### Demonstrate every implementation requirement with a realistic synthetic scenario

Covered by the MIC-106 focused test plus source:

1. Request items persist document type, related offer/funder, owner, due date, received/verified (`createStipulation` 134–148; schema `milestone05-closing.ts` 4–14; snapshot mapping 44–55).
2. Deal-scoped expiring links store token hash, deal, task, category, expiry, upload limit, and idempotency key (`166–185`; schema 16–26). Plaintext token exists only in the response URL.
3. Request Info builds an immutable preview whose body contains per-task expiring URLs (`332–348`). Send reloads that body and verifies `contentHash` (`396–419`). DL/VC shortcuts and copy/open link controls are in the panel (`closing-panel.tsx` 143).
4. Duplicate task/link/preview/upload writes use stable idempotency keys (`140–146`, `171–176`, `275–284`, `244–248`). Misclassified documents fail `verified` until category matches (`157–158`).

### Loading, empty, validation, success, and failure; retries preserve identity

Public page (`merchant-upload-panel.tsx` 8–22):

- Loading: “Validating this secure link…”
- Invalid/expired GET: `role="alert"` error
- Empty file: “Choose a PDF, PNG, or JPEG file.”
- Busy: “Uploading…”
- Success: `role="status"` clean vs pending-scan copy
- Failure: upload error, “You can retry safely.”
- Client `idempotencyKey` is a `useRef` UUID reused across retries (14, 19)

Closing panel (`closing-panel.tsx` 29–30, 88–92, 139, 143):

- Loading: “Loading closing state…”
- Empty: “No stipulations yet.”
- Validation: disabled Add/Preview without label/recipient/merchant sender; server field errors via `role="alert"`
- Success: `role="status"` notice; issued link with copy/open/expiry
- Failure: load/action error
- `retryKey(scope)` is kept until success, then rotated

### Direct API requests enforce the same permissions as the UI. Logs exclude secrets

- Session/API closing reads require `deals:read`; writes require `deals:write` plus `assertTrustedMutation`; session also requires Deals page visibility (`closing/http.ts` 10–16).
- Snapshot GET with `deals:read` is 200; stipulation POST with the same read key is 403; session with `deals: false` is 403 (`tests/milestone05-closing.test.ts` 213–221).
- Public upload is token-gated and rate-limited, not session-gated (`merchant-upload/[token]/route.ts` 6–13).
- Request Info send requires a verified **merchant** sender (`service.ts` 402–405, `assertSenderUsable` `senders/service.ts` 520–534).
- Audit metadata uses IDs, categories, hashes, correlation IDs, and `externalIdPresent` — not tokens, recipient plaintext, document bytes, or provider secrets (`service.ts` 147, 183, 265, 328; `db.ts` 202–223). Recipients are AES-GCM ciphertext in previews (`279–281`). Postmark failures persist bounded codes, not provider error text (`delivery.ts` 117–124). Public API errors do not echo deal IDs (`errors.ts` 16–27).

## Hunt result (no remaining software gap)

Checked token isolation, Request Info preview identity (saved body + hash, not a live rebuild), public upload page, validation-before-resolve, idempotent replay, HTTP scopes, and audit redaction. Nothing remaining can be fixed in `stipulation-activation.ts` without editing conductor-owned `closing/service.ts`.

Residual observations (not AC failures, not exclusive-file fixes):

- `createStipulation` accepts any `actor.activeMembershipIds` owner; the UI lists `permittedAssignmentIds` only. Direct API still needs `deals:write` and deal access.
- An unused link is not revoked on waive; a later upload can store a document but the `status='open'` update does not reopen a closed task.

## Files changed

- `docs/milestone-05/MIC-106-report.md` (this file)
- `docs/milestone-05/MIC-106-acceptance.md`

Unchanged exclusive no-op: `src/lib/mca/closing/stipulation-activation.ts`.

Did not edit: `closing/service.ts`, `closing-panel.tsx`, `merchant-upload-panel.tsx`, schema, drizzle, Linear. No focused `tests/milestone05-mic-106.test.ts` — existing MIC-106 scenario already covers the AC.

## Tests

```
cd nextjs-version
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/milestone05-closing.test.ts
```

```
✔ MIC-106 opaque merchant upload is deal scoped, validates content, resolves once, and replays after response loss
✔ MIC-108 …
✔ MIC-157 …
✔ MIC-168 …
✔ MIC-168 text delivery …
✔ closing delivery fences …
✔ closing HTTP routes enforce read/write scopes, session page visibility, and workspace isolation
ℹ tests 7
ℹ pass 7
ℹ fail 0
duration_ms 44780.363625
```

No live Postmark, SMS, or merchant email was sent.

## Activation checklist (do not execute live send)

Pending merchant sender and Railway Postmark bindings already exist (`provider-activation.md`, `postmark-closing.md`). No recipient has been authorized. **Do not send live email in this wave.**

When a named recipient is later authorized:

1. Confirm production `MCA_CLOSING_EMAIL_PROVIDER=postmark` and `MCA_CLOSING_POSTMARK_CONNECTIONS_JSON` binds this workspace ID, the pending **merchant** sender record ID, provider-confirmed From address, and server-level send token (never `POSTMARK_ACCOUNT_TOKEN`).
2. Confirm `MCA_UPLOAD_TOKEN_SECRET`, `MCA_CLOSING_ARTIFACT_TOKEN_SECRET`, `MCA_APP_ORIGIN=https://fundlane.io`, and `MCA_DATA_ENCRYPTION_KEY`.
3. In **Settings → Connections**, open the pending merchant SMTP sender (`smtp.postmarkapp.com`, documented TLS port, Postmark server credential, confirmed From).
4. **Test sender** to the explicitly authorized recipient. Accept only Postmark `ErrorCode: 0` plus nonempty `MessageID` (`senders/delivery.ts` 42–59; `senders/service.ts` 420–452). Preview, account read, timeout, HTTP 5xx, or malformed success must not verify.
5. After verification, on a synthetic deal: add open stipulation(s) → Preview Request Info (immutable body with per-task URLs) → Send this exact preview through the verified merchant sender.
6. Confirm Postmark `MessageID` on the closing delivery row, then redeem one upload URL and check only that task becomes `received`.

## Remaining gate

Authorized merchant recipient + real Postmark Request Info delivery.

Mock/synthetic transport success is not production send readiness.

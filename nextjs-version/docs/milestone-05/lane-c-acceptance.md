# Milestone 05 lane C acceptance

Date: 2026-09-08

Scope: MIC-106, MIC-108, MIC-157, and MIC-168. The implementation is in `src/lib/mca/closing`, `src/components/mca/closing`, `src/app/api/mca/closing`, `src/app/merchant-upload`, and `src/lib/mca/db/milestone05-closing.ts`.

## Verification result

The focused closing suite ran against a fresh disposable Neon database created by `tests/helpers/postgres-test-db.mjs`:

```text
node --import tsx --conditions=react-server --test --test-concurrency=1 tests/milestone05-closing.test.ts

tests 7
pass 7
fail 0
duration_ms 42735.626417
```

The isolated Postmark transport and sender-verification suite in `tests/milestone05-closing-postmark.test.ts` covers exact content/attachments, scoped credentials, provider IDs, explicit rejection redaction, HTTP 5xx/network/malformed-success reconciliation, mismatched reconciliation evidence, and real-provider-test acknowledgement without making network calls.

Targeted ESLint passed for the closing library, schema fragment, API routes, UI, public upload page, and focused test. Targeted TypeScript output contained no closing, merchant-upload, or milestone05-closing errors.

Browser verification covered the offer revision selector, phone pitch action, text consent opt-in/opt-out controls, assigned sender status, DL and voided-check shortcuts, named stipulation owner/due date controls, Request Info flow, visible secure upload URL with copy/open/expiry controls, and the public upload page. Uploading a synthetic PDF changed only the matching DL task to `received`; unrelated statement and voided-check tasks remained open. Verification correctly remained blocked while the document scan was pending. Repricing and final-review controls are present in the per-deal closing panel; the latter appears only for a workflow with genuine signed state.

## MIC-106 — Stipulation tasks and secure merchant upload requests

| Requirement | Evidence |
| --- | --- |
| Document type, related offer/funder, named owner, due date, received and verified state | `mca_closing_stipulations`, the closing snapshot, and the per-deal UI retain these fields. The owner selector contains only assignment-permitted active workspace members. |
| Deal-scoped expiring links and specific destinations | Links store an opaque token hash, deal, task, category, expiry, upload limit, and stable idempotency key. The plaintext token exists only in the response/client state. The public response omits deal and workspace identifiers. |
| Request Info and DL/VC actions | The panel creates DL/voided-check tasks, renders an immutable Request Info preview containing per-task expiring links, and sends only that saved body through a verified merchant sender. A direct link can also be copied or opened without a configured sender. |
| Correct task resolves only after validation | MIME/content validation runs before storage. Uploading marks only the linked open task `received`; a human `verified` transition rechecks both `clean` processing state and the current document category. Recategorization therefore invalidates an otherwise clean mismatch. |
| Duplicate and response-loss behavior | Task, link, preview, and upload writes use stable idempotency keys. An upload replay checks the prior document before the consumed-link check and returns the original document identity. |
| Token isolation | The focused test proves an opaque token exposes no deal identifier, cannot operate across workspaces, and cannot retrieve arbitrary documents. |

## MIC-108 — Contract request, acceptance, repricing, and signature tracking

| Requirement | Evidence |
| --- | --- |
| Acceptance binds exact terms | Acceptance resolves an authorized immutable offer revision and stores offer/revision identifiers, revision number, funder snapshot, actor, and timestamps. A selected superseded revision remains usable only through its exact retained selection; withdrawn/funded revisions are rejected. |
| Contract request and blockers | Preview requires a verified submission sender. Driver license and voided check must be attached as clean same-deal documents or have an explicit per-category exception. Outstanding open/received stipulations are captured in the workflow and shown in the UI. |
| Authorized attachments remain exact | Preview identity includes attachment `{id, version, checksum}` references. Delivery revalidates these references and issues five-minute signed private artifact URLs. The test transport redeemed an artifact and received the original PDF bytes. |
| Repricing | The UI and API require a reason. The reason, exact offer revision, attachments, and outstanding stipulations are saved in an immutable `repricing_request` preview. Delivery requires a second action on that exact preview. |
| Requested, sent, signed, final review | Separate timestamps and explicit workflow states are persisted. A request/send never implies signature. Late delivery retries update only eligible requested state and cannot regress signed/final-review history. |
| Signature evidence | External signature capture requires both a provider external ID and a clean same-deal `closing_document`. Manual stage capture is stored separately with a required reason and never claims provider evidence. Final review requires persisted signed state and signature source. |
| Acceptance criteria | The focused scenario proves missing attachments block, a sent request is not signed, repricing requires a reason, external ID alone fails, clean evidence permits signing, and later send replays cannot regress signed or final-review state. |

## MIC-157 — PSF document request and webhook-to-signature workflow

| Requirement | Evidence |
| --- | --- |
| Permissioned configuration and visibility | Only admin/super-admin interactive sessions can configure PSF. Rep/manager visibility requires `visible_to_reps = 1`; absent configuration defaults false. API keys cannot read PSF records or submit bank details. The UI hides configuration and actions according to snapshot capabilities. |
| Secure form and storage | Amount, bank, routing/account, business, and contact fields are validated server-side. Bank, routing/account, business, and contact values use workspace-bound AES-GCM encryption. Responses expose masked bank/last-four data only; UI password fields avoid redisplay. |
| Safe provider destination | An enabled workspace destination must be HTTPS without credentials or nonstandard ports. Literal loopback/private/link-local addresses and DNS answers resolving to private/link-local ranges, including IPv6 ULA, are rejected. Fetch uses `redirect: "error"`. |
| Truthful delivery/signature | HTTP success is accepted as delivered only with a stable provider request ID. Failure stays failed. Signed state requires an HMAC-authenticated webhook matched to that ID. No generic HTTP 200, entered value, or preview can create signed state. |
| Retry identity | Request and delivery attempts have distinct idempotency keys and correlation IDs. Confirmation reuses one external request identity after delivery. Signed webhook replay returns the existing signed record, and later confirmation cannot redeliver or reset it. |
| Acceptance criteria | The focused scenario verifies encrypted-at-rest values, failed transport state, one external request ID, signed webhook replay, signed-state preservation, and API-key exclusion from PSF reads and writes. |

## MIC-168 — Merchant offer preview, email/text, and pitch

| Requirement | Evidence |
| --- | --- |
| Selected/all/highest rendering | The revision selector is populated from the deal offer API and labels funder, version, amount, and selection. A sole selected revision is chosen automatically. All/highest modes include eligible active unselected offers; explicitly selected retained revisions can remain pinned. |
| Email/text UI path | The panel exposes an explicit Email/Text message selector and preserves separate deal-prefilled merchant email and mobile values when switching or reloading. Email preview requires a verified merchant sender. Text mode lists only assigned accounts, pins the chosen account to the preview, shows provider readiness and current consent, and records explicit opt-in/opt-out evidence. Preview requires current opt-in and a configured route; delivery rechecks both. |
| Immutable, merchant-safe preview | Every included revision ID is stored with the encrypted subject/body and content hash. Delivery reloads the saved preview and verifies the hash. Merchant rendering includes visible terms and excludes internal commission. |
| Pitch truth | Failed or unavailable delivery creates a failed/blocked delivery and no pitch. Successful delivery records a separate pitch event for every included revision. Phone pitch is an explicit separate event tied to one exact revision and actor. |
| Retry behavior | Preview, delivery, and phone actions retain their idempotency keys across client errors and response loss. A changed payload with a reused key conflicts instead of overwriting history. |
| Acceptance criteria | The focused scenarios verify an all-offers preview contains both exact revisions, excludes commission, sends the exact saved body/hash, records both bindings only after success, records no pitch on failure, and supports an explicit phone pitch. The SMS integration test verifies the assigned account, normalized merchant phone, consent, exact preview body, encrypted message body, Twilio acknowledgement ID, and pitch. An unknown result remains unpitched, and a different-key retry performs reconciliation without another transport call. |

## Authorization, audit, and review follow-ups

- Session API entry points enforce workspace role/scope and the configured Deals page visibility. API keys require explicit `deals:read` or `deals:write`; PSF remains session-only.
- Database reads and writes include workspace and deal constraints. Public upload and artifact routes operate only through scoped, expiring, signed/hashed capability tokens.
- Audit and delivery records contain record IDs, categories, states, hashes, correlation IDs, and external-ID presence. They exclude bank credentials, recipient plaintext, document bytes, provider secrets, and full sensitive payloads.
- Delivery SQL parameter counts are exercised by every successful focused transport scenario.
- Record-level PostgreSQL advisory locks fence every immutable delivery record across different attempt keys. A concurrent or crash-left `pending` row and every `provider_outcome_unknown` row are reconciliation-only; a new attempt never blindly resends them. The focused test proves two concurrent keys execute one transport send and a crash-pending row recovers its provider ID without a send call.
- All/highest offer previews retain every revision and create a separate pitch binding for each only after transport success.
- PSF `signed` webhook replay and contract delivery retries are state-monotonic.
- Schema is supplied as the lane-owned fragment. Root-generated migrations `0008_chief_squadron_sinister.sql` and `0009_material_kid_colt.sql` include the closing tables and pinned attachment-reference column. Only disposable databases were migrated.

## Production dependencies and limits

No real merchant message, contract request, document-signing request, PSF workflow request, or transfer was sent during acceptance. Synthetic transports establish application behavior but do not establish provider readiness.

- Merchant email needs a verified sender with purpose `merchant`, `MCA_MERCHANT_EMAIL_WEBHOOK_URL`, and the provider bearer token when required.
- Contract, repricing, and stipulation email needs a verified sender with the matching purpose and `MCA_CLOSING_EMAIL_WEBHOOK_URL`; the production integration must consume the exact body/hash and authorized attachment references.
- A real Postmark send adapter is available when `MCA_CLOSING_EMAIL_PROVIDER=postmark` and `MCA_CLOSING_POSTMARK_CONNECTIONS_JSON` contains a deployment-secret entry binding one server-level send token to the exact workspace ID, verified sender record ID, and provider-confirmed From address. This prevents one workspace from selecting another identity through a shared token. `POSTMARK_ACCOUNT_TOKEN` is account-management access and is never used for message delivery. Each entry can select a message stream; `MCA_CLOSING_POSTMARK_MESSAGE_STREAM` is the fallback and defaults to `outbound`.
- The Postmark adapter sends the exact saved subject/plain-text body and embeds each authorized pinned attachment as its exact bytes with filename and MIME type. It retains Postmark `MessageID` as the external delivery identity. An explicit provider rejection is failed; a timeout or malformed success is reconciled by `mca_delivery_id` metadata. An unresolved outcome is blocked as `provider_outcome_unknown`, and later attempts reconcile that record rather than blindly sending a duplicate.
- Merchant SMS uses the MIC-156 Twilio routing and consent boundary. A route must be active, assigned to the actor, pinned in the immutable preview, and backed by an exact workspace/credential-reference entry in `MCA_SMS_TWILIO_ACCOUNTS_JSON`; `MCA_SMS_PROVIDER=twilio` and an exact public HTTPS `MCA_SMS_PUBLIC_BASE_URL` are also required. Current merchant opt-in is required at preview and rechecked before provider delivery. Only a valid Twilio `SM`/`MM` acknowledgement becomes sent and permits pitch evidence. Unknown outcomes remain fenced and reconciliation-only. Synthetic tests do not validate the deployed Twilio account, sender registration, carrier routing, consent policy, or delivery to a real handset.
- PSF needs admin-saved encrypted workspace destination and signing secret, a public HTTPS endpoint, provider mapping from MIC-158, a stable provider request ID acknowledgment, and signed status callbacks. The application does not infer DocuSeal readiness from configuration alone.
- Production token issuance requires `MCA_UPLOAD_TOKEN_SECRET`, `MCA_CLOSING_ARTIFACT_TOKEN_SECRET`, and `MCA_APP_ORIGIN`. Sensitive-field encryption requires `MCA_DATA_ENCRYPTION_KEY` under the existing application crypto contract.
- No configured sender/provider was available for a real browser delivery test. UI validation, immutable preview construction, fail-closed states, and synthetic provider success/failure paths were verified.
- The available Postmark account token and account/server discovery do not establish send readiness. Deployment still needs an encrypted/secret-store connection entry containing the server-level token and an exact workspace/sender/From binding matching a permissioned, verified MCA sender connection. No Postmark send request was made during development or testing.
- Supported activation path: an administrator opens **Settings → Connections**, creates an SMTP sender for the appropriate merchant or submission purpose using `smtp.postmarkapp.com`, the documented TLS port, and the Postmark server credential, selects the provider-confirmed From address, and grants only the intended members. Before testing, the deployer adds the exact workspace/sender/From binding to `MCA_CLOSING_POSTMARK_CONNECTIONS_JSON`. The administrator then uses **Test sender** with an explicitly authorized recipient. When Postmark mode is selected, this test calls the real Postmark API through that exact binding and marks the sender verified only after an `ErrorCode: 0` response with a `MessageID`; it never treats a local preview, account read, timeout, HTTP 5xx, or malformed response as verification. Production has pending merchant and submission sender rows with exact Railway secret bindings. No recipient has been authorized; a real test and verification remain outstanding.

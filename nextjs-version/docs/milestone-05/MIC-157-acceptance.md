# MIC-157 acceptance — PSF document request and webhook-to-signature workflow

Date: 2026-09-09  
Linear: [MIC-157](https://linear.app/michael-belenkiy/issue/MIC-157) remains **In Progress**. Conductor owns Linear Done.

Software: **REVIEW_PASS**. Focused suite `tests/milestone05-mic-157.test.ts` **3/3 pass** against a disposable Neon database (`m05_mic157`, 21194 ms). Production code was not changed. `psf-activation.ts` remains a no-op.

No live DocuSeal request. No template invented. No API token pasted.

## Linear acceptance criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| A failed webhook remains pending/failed rather than signed | Pass | Failed transport → `state=failed`, `external_request_id` null (`service.ts:545-546`). HMAC signed event for a forged id → `psf_request_not_found`; row still `failed` (`service.ts:564-567`, `tests/milestone05-mic-157.test.ts:176-180`). HTTP 200 without provider id → `provider_ack_missing` / still `failed` (`service.ts:541-543`, test `182-188`). Signed requires delivered + matching id (`service.ts:553-568`). |
| Repeated confirmation uses one external document request identity | Pass | Unique `(workspace, deal, offer_revision)` (`milestone05-closing.ts:88`). Same request id from fail → deliver → replay; one `sent` external id `psf-request-1`; later confirm does not redeliver (`service.ts:526-532`, test `190-201`). After sign, confirm stays `signed` (test `203-209`). |
| Realistic synthetic scenario with expected output | Pass | Workspace + selected offer, encrypted bank payload, synthetic failing then acknowledging webhook, HMAC callback. Expected: failed stays failed; one request row; masked `S•••` / `7890`; signed only after matching delivered id. Test `149-217` plus `tests/milestone05-closing.test.ts:97-114`. |
| Loading, empty, validation, success, failure UI; retries preserve identity | Pass (software) | Loading/error/notice: `closing-panel.tsx:139`. Empty stip/contract copy and PSF list map on `146`. Validation: amount/routing/account/email (`service.ts:519-523`); destination HTTPS/private (`454-473`). Success/failure badges and `lastErrorMessage` on `146`. Retry: request `idempotencyKey` vs delivery `attemptKey` (`service.ts:525`, `540`; panel `146` uses `retryKey("psf-save")` and `retryKey("psf-deliver")`). Browser not re-run this session; UI is conductor-owned. |
| Direct API enforces the same permissions as the UI; logs exclude secrets | Pass | UI gated by `capabilities.psfVisible` / `psfAdmin` (`closing-panel.tsx:70-73`, `146`). Snapshot omits PSF for API keys (`service.ts:102-106`, `121`). PSF config/submit routes are `sessionOnly` (`psf-config/route.ts:9-10`, `psf/route.ts:9`, `http.ts:10-12`, `auth.ts:85-86`). Audit metadata has no bank/routing/account/secret (test `211-216`; `service.ts:497`, `571`). |

## Required proofs (this wave)

| Proof | Result | File:line |
| --- | --- | --- |
| Failed webhook remains failed, not signed | Pass | `service.ts:541-546`, `553-568`; `psf-docuseal-service.ts:219-223`, `240-245`; `tests/milestone05-mic-157.test.ts:153-188` |
| Repeated confirmation uses one external document request identity | Pass | `milestone05-closing.ts:88`; `service.ts:526-532`; test `184-201` |
| Bank / routing / account encrypted at rest and masked in UI/logs | Pass | `crypto.ts:42-47`; `service.ts:86-89`, `526-528`; `milestone05-closing.ts:80-82`; `closing-panel.tsx:146`; test `154-174`, `211-216` |
| API keys cannot read PSF records or submit bank details | Pass | `service.ts:102-106`, `501-502`; `psf/route.ts:9`; test `113-147` |
| Private / loopback destinations rejected | Pass | `service.ts:454-473`; `delivery.ts:189` (`redirect: "error"`); test `81-110` |

## Lane C MIC-157 table (re-verified)

Matches `docs/milestone-05/lane-c-acceptance.md` MIC-157 section:

- Permissioned configuration and visibility: admin/super-admin session only; reps need `visible_to_reps`; API keys excluded (`service.ts:450-451`, `101-102`, `501-502`).
- Secure form and storage: server-side amount/bank/routing/account/business/contact validation; AES-GCM cipher columns; masked API; password inputs.
- Safe provider destination: HTTPS, no credentials, no nonstandard port; private/loopback/link-local/ULA rejected; DNS private answers rejected; fetch `redirect: "error"`.
- Truthful delivery/signature: no generic HTTP 200, entered value, or preview creates signed state.
- Retry identity: distinct attempt keys; one external request id after delivery; signed webhook replay returns the existing signed record (`service.ts:568`).

DocuSeal-specific reservation, one-submission identity, and artifact-gated signed state remain covered by `tests/milestone05-closing-docuseal.test.ts`, `milestone05-closing-docuseal-service.test.ts`, and `milestone05-closing-docuseal-db.test.ts` (unchanged this session).

## Authorization and logging

- PSF config GET/PATCH and PSF POST require an interactive session (`session_required` for API keys), then admin for configuration and visibility rules for confirm.
- Snapshot GET allows `deals:read` API keys for other closing data but returns `psfRequests: []` and `psfVisible: false`.
- Webhook route `/api/mca/closing/psf/webhook/[workspaceId]` authenticates the provider (generic `x-mca-signature` or DocuSeal `X-Docuseal-Signature`), not an API key (`src/app/api/mca/closing/psf/webhook/[workspaceId]/route.ts:8-12`).
- Logs/audit: payload hash, correlation id, external-id presence, error codes. No bank credentials, routing, account, signing secret, or DocuSeal API token.

## Remaining gate (activation, not software)

Do **not** mark Linear Done until a later authorized activation wave.

1. **Environment:** exactly one `MCA_DOCUSEAL_PSF_CONNECTIONS_JSON` object per enabled workspace, as documented in `docs/milestone-05/docuseal-psf-activation.md`. Use the approved PSF template’s exact field names and signer role. Do not invent bindings.
2. **Webhook:** DocuSeal callback `https://YOUR_APP_HOST/api/mca/closing/psf/webhook/WORKSPACE_ID` with `X-Docuseal-Signature`.
3. **Workspace:** administrator enables PSF delivery after the server reports DocuSeal connected. Existing generic webhook requests stay pinned to webhook; DocuSeal requests stay pinned to DocuSeal (`selectPsfDeliveryProvider` in `psf-docuseal-service.ts:128-144`).
4. **Controlled signing run:** authorized test signer completes the approved template; signed PDF and audit log download from allowed hosts, store with request-derived keys, and scan clean before `signed`.

Until step 1 exists, `productionGates.psfDelivery` is “available after an administrator connects and validates the PSF provider” (`service.ts:129`). Mock/synthetic transport success is not production integration readiness.

## Activation checklist (no send this session)

- [ ] Approved PSF template id, signer role, and field bindings supplied by product (not invented here)
- [ ] API-enabled DocuSeal token and webhook secret (≥ 32 characters) stored only in Railway/deployment secrets
- [ ] `MCA_DOCUSEAL_PSF_CONNECTIONS_JSON` bound to the exact workspace id
- [ ] DocuSeal webhook registered to this app’s workspace callback URL
- [ ] Administrator enables PSF in the closing workspace
- [ ] Controlled test submission completed by an authorized test signer
- [ ] Clean signed PDF + audit log visible as closing documents
- [ ] User authorizes the named signer/run before any live request

## Not claimed

- Production DocuSeal readiness
- Live signing, live webhook delivery to a merchant automation, or live email/SMS
- Linear Done

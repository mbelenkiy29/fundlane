# MIC-157 report — PSF document request and webhook-to-signature workflow

Date: 2026-09-09  
Agent: A4  
Linear: [MIC-157](https://linear.app/michael-belenkiy/issue/MIC-157) (`c70f4cfa-655c-4564-a0d2-52360e7ae56d`) — left **In Progress**. Not marked Done.

## Verdict

**REVIEW_PASS.** No remaining software gap was proven in exclusive production files. `src/lib/mca/closing/psf-activation.ts` stays the documented no-op. No `NEEDS_CONDUCTOR`.

Software already implements permissioned PSF configuration, encrypted bank-field storage, generic HTTPS webhook delivery, HMAC signed-status callbacks, and the DocuSeal provider path. MIC-158 outbound workflow webhooks are Done in Milestone 6; this ticket did not rewrite `src/lib/mca/comms/webhooks.ts`.

Remaining production gate is provider activation, not application code: `MCA_DOCUSEAL_PSF_CONNECTIONS_JSON` plus an approved PSF template/bindings and a controlled signing run. No live DocuSeal request was sent. No template field names or API tokens were invented or pasted.

## Exclusive files

| Path | Action |
| --- | --- |
| `src/lib/mca/closing/psf-activation.ts` | Unchanged no-op |
| `tests/milestone05-mic-157.test.ts` | Added focused proofs |
| `docs/milestone-05/MIC-157-report.md` | This report |
| `docs/milestone-05/MIC-157-acceptance.md` | Acceptance evidence |

Not edited: `closing/service.ts`, `psf-docuseal-service.ts`, `comms/webhooks.ts`, schema, Linear, `closing-panel.tsx`.

## Software review (no gap)

Hunted Linear AC, `lane-c-acceptance.md`, `docuseal-psf-activation.md`, graphify (`confirmPsfRequest` → `psfConfigForUse` → `safeWebhookUrl`), API routes, UI, generic webhook fetch, and DocuSeal reservation/sign paths. Existing synthetic coverage in `tests/milestone05-closing.test.ts` and the DocuSeal suites still matches the code. The only missing proofs were literal private/loopback rejection, routing ciphertext, a signed webhook against a failed request, HTTP 200 without a provider id, API-key configuration denial, and audit redaction. Those are now in `tests/milestone05-mic-157.test.ts`. None required a production change.

## Proofs (file:line)

### Failed webhook remains failed, not signed

- Delivery only advances the request when the transport is `sent` **and** returns an external id. HTTP success without an id is rewritten to `failed` / `provider_ack_missing`. Failed writes set `external_request_id` to null. `src/lib/mca/closing/service.ts:541-546`
- Confirm/deliver only runs while state is `pending` or `failed`. Delivered and signed requests are not re-sent. `src/lib/mca/closing/service.ts:532`
- Signed webhook requires HMAC, `status: "signed"`, a matching `external_request_id`, a `psf_request` delivery in `sent` with that same id, and request state `delivered` or `signed`. `src/lib/mca/closing/service.ts:553-568`
- DocuSeal failure cannot mark signed: `markFailed` only updates pending/failed rows with a null external id; `markSigned` requires `state='delivered'`. `src/lib/mca/closing/psf-docuseal-service.ts:219-223` and `240-245`
- Focused test: failed transport stays `failed` with no external id; a valid HMAC “signed” webhook for a forged id is `psf_request_not_found` and the row remains `failed`; HTTP 200 without an id stays `failed` / `provider_ack_missing`. `tests/milestone05-mic-157.test.ts:149-188`
- Prior suite: `tests/milestone05-closing.test.ts:97-101`

### Repeated confirmation uses one external document request identity

- Unique `(workspace_id, deal_id, offer_revision_id)` keeps one PSF row. `src/lib/mca/db/milestone05-closing.ts:88`
- Retry after failure reuses that row (`ON CONFLICT … DO NOTHING`, then reload). A different payload conflicts. `src/lib/mca/closing/service.ts:526-530`
- After `delivered`, further confirmation skips transport (`replay.delivery === undefined`) and keeps the same `externalRequestId`. Attempt keys are distinct from the request idempotency key. `src/lib/mca/closing/service.ts:287-301`, `532-550`
- Focused test: same request id from failed → missing-ack → delivered → replay; only one `sent` delivery external id (`psf-request-1`); post-sign confirmation stays `signed`. `tests/milestone05-mic-157.test.ts:182-209`
- Prior suite: `tests/milestone05-closing.test.ts:105-110`

### Bank / routing / account encrypted at rest and masked in UI / logs

- Insert encrypts bank, routing, account, business, and contact with workspace-bound AES-GCM. `src/lib/mca/closing/service.ts:526-528` and `src/lib/mca/crypto.ts:42-47`
- Schema stores `*_cipher` columns only. `src/lib/mca/db/milestone05-closing.ts:80-82`
- API summary exposes `bankNameMasked` and `accountLast4` only — no routing, no full account, no bank name. `src/lib/mca/closing/service.ts:86-89` and `src/lib/mca/closing/contracts.ts:44-48`
- UI: routing/account/signing-secret inputs are `type="password"`; saved rows render `bankNameMasked · account ••••{accountLast4}`. Configuration is not reloaded from the server into those fields. `src/components/mca/closing/closing-panel.tsx:70-73`, `146`
- Audit metadata records flags and id presence, not bank values or the signing secret. `src/lib/mca/closing/service.ts:497`, `328`, `571`
- Focused test: ciphertext is `v1.` AES-GCM, plaintext absent from the row JSON and from `audit_events`; decrypt round-trip recovers bank/routing/account; summary is `S•••` / `7890`. `tests/milestone05-mic-157.test.ts:154-174`, `211-216`

### API keys cannot read PSF records or submit bank details

- Snapshot hides PSF unless an interactive admin/super-admin (or rep/manager with `visible_to_reps`). API keys never qualify. `src/lib/mca/closing/service.ts:101-106`, `121`
- Submit/confirm throws `psf_permission_denied` for `source === "api_key"`. `src/lib/mca/closing/service.ts:501-502`, `516`
- HTTP: `POST /api/mca/closing/psf` is session-only. `src/app/api/mca/closing/psf/route.ts:9` via `src/lib/mca/closing/http.ts:10-12` and `src/lib/mca/auth.ts:85-86`
- Focused test: service snapshot empty; HTTP `deals:read` snapshot `psfVisible=false` / `psfRequests=[]`; write-key POST is `403 session_required`. `tests/milestone05-mic-157.test.ts:113-147`
- Prior suite: `tests/milestone05-closing.test.ts:111-113`

API keys also cannot configure PSF (`psf_configuration_denied` plus session-only `GET`/`PATCH /api/mca/closing/psf-config`). `src/lib/mca/closing/service.ts:450-451`, `src/app/api/mca/closing/psf-config/route.ts:9-10`, `tests/milestone05-mic-157.test.ts:128-143`

### Private / loopback destinations rejected

- Literal localhost, `.local`, metadata host, private/link-local IPv4, IPv6 loopback/ULA (`fc`/`fd`), then DNS answers in those ranges, are rejected. HTTPS, no credentials, no nonstandard port. Re-checked at delivery. `src/lib/mca/closing/service.ts:454-473`, `509-512`
- Generic webhook fetch uses `redirect: "error"`. `src/lib/mca/closing/delivery.ts:174-189`
- DocuSeal artifact/API URLs independently reject private answers against an allowlist. `src/lib/mca/closing/docuseal-provider.ts:317-337`
- Focused test: `127.0.0.1`, `localhost`, `10.0.0.8`, `192.168.1.20`, `169.254.169.254`, `[::1]`, ULA `[fd12:3456:789a:1::1]`, `metadata.google.internal` → `psf_destination_private`; http / embedded credentials / port 8443 → `psf_destination_invalid`; no config row is stored. `tests/milestone05-mic-157.test.ts:81-110`

## Tests run (this session)

From `nextjs-version/`:

```text
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/milestone05-mic-157.test.ts

✔ MIC-157 rejects private and loopback PSF destinations (13979.342542ms)
✔ MIC-157 API keys cannot read PSF records, submit bank details, or configure PSF (2160.757708ms)
✔ MIC-157 failed webhook stays failed, confirmation reuses one external identity, and bank fields stay encrypted and masked (4262.901625ms)
tests 3
pass 3
fail 0
duration_ms 21194.188167
```

Disposable database `createPostgresTestDatabase("m05_mic157")` only. `MCA_DOCUSEAL_PSF_CONNECTIONS_JSON` was unset so the generic webhook path was exercised. No DocuSeal Cloud/self-hosted call.

## Remaining gate (do not treat as Done)

1. Deployer supplies exactly one `MCA_DOCUSEAL_PSF_CONNECTIONS_JSON` entry per enabled workspace (API base URL, API-enabled token, webhook secret ≥ 32 characters, approved `templateId`, exact signer role, exact field bindings, explicit `sendEmail` / `requireEmail2fa`, artifact hosts). See `docs/milestone-05/docuseal-psf-activation.md`.
2. Administrator enables PSF delivery in the closing workspace after that environment connection is present.
3. Controlled signing run: authorized test signer completes the approved template; signed PDF and audit log store as clean closing documents.

Until those exist, `docuSealPsfConnectionConfigured` is false and `productionGates.psfDelivery` stays “available after an administrator connects and validates the PSF provider” (`src/lib/mca/closing/service.ts:129`). Synthetic webhook success is not production DocuSeal readiness.

## Out of scope / not done

- No Linear status change
- No live DocuSeal, merchant webhook, email, or SMS
- No invented template field names or pasted tokens
- MIC-158 mapping cited only; `comms/webhooks.ts` unread for rewrite

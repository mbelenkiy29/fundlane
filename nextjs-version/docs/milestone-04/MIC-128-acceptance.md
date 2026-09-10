# MIC-128 acceptance — Offer-link extraction with manual fallback

Executed September 8, 2026. Scope: SSRF-safe offer-link fetch after MIC-122 email extraction; prefer email financial terms; incomplete manual-review offers when a portal cannot be read. Live funder portals are out of scope.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| Private-network URL rejected before fetch | Passed | `tests/submissions-offer-links.test.ts` — `http://127.0.0.1/` and `https://127.0.0.1/` return `blocked` with `fetched: false`; metadata `169.254.169.254` / `metadata.google.internal`, IPv6 `::1` / `fd00::1`, `http://` scheme, and DNS to `10.0.0.1` never call fetch; redirect `Location: http://127.0.0.1/internal` is not retrieved; HTTP persist of a loopback link stays `blocked` with zero offer-link fetches |
| Inaccessible portal produces a manual-review offer rather than an invented amount | Passed | Login-wall HTML containing `$9,999,999` and HTTP 401 bodies persist `termsUnknown: true`, `amount/rate/term` null, `source = link`, original HTTPS `offer_link`, status `received`; JSON has no `9999999` or invented `25000` |
| Email terms skip fetch | Passed | Approval with `$25,000`, factor `1.35`, `10 months`, and a portal URL returns `skipped`, `fetched: false`, `source = email`; fetch log stays empty |
| Loading / empty / validation / success / failure usable | Passed | GET before MIC-122 extract `empty`; GET after extract and before fetch `empty`; missing `replyId`/`dealId` 422; invalid JSON 400; blocked SSRF `blocked`; login/401 `incomplete`; labeled HTML/JSON `success`; deal list `empty` then `ready` |
| Direct API matches UI permissions; secrets omitted | Passed | `intake:write` GET/POST 403; `deals:read` GET 200; `deals:read` POST 403; `deals:write` persist 200; other workspace deal 404; JSON omits SMTP password, `credentialCipher`, `body_cipher` |
| Retries preserve record identity | Passed | Second skip, inaccessible, and success POSTs return the original MIC-122 email offer id (`created: false`, `replayed: true`); one `deal_offers` row per deal; complete portal terms skip the second fetch |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/submissions-offer-links.test.ts
```

3/3 passed. Offer-link fetch and DNS were injected; `globalThis.fetch` was stubbed.

## Behavior

- `POST /api/mca/submissions/extract/links` `{ replyId }` follows a classified approval link only when amount+rate+term are incomplete. `GET ?replyId=` returns the stored snapshot without fetching. `GET ?dealId=` lists link extractions (`empty` or `ready`).
- Safety: HTTPS only, no embedded credentials, private/link-local/metadata/loopback rejected before fetch, DNS answers re-checked, max 3 redirects with `redirect: "manual"`.
- Offers: update the existing email offer id. Portal success → `source = link`, `presented` when terms are complete. Inaccessible → `source = link`, `terms_unknown = 1`, source URL kept. Blocked URLs do not invent amounts.
- Reads: `deals:read`. Writes: `deals:write` with `assertTrustedMutation`. `cache-control: no-store`, `runtime = "nodejs"`.
- Tests inject `setOfferLinkNetworkForTests`. Production uses `fetch` + `dns.promises.lookup`.

## UI

No exclusive UI file. GET `empty`/`ready`, POST `skipped`/`success`/`incomplete`/`blocked`/`unmatched`, and HTTP 400/403/404/422 cover loading, empty, validation, success, and failure for a conductor-mounted reply-queue action.

## Local vs live gates

Local Postgres fixtures prove SSRF rejection before fetch, email-term short-circuit, inaccessible-portal manual review without invented amounts, ACL, and identity-preserving retries. Live funder portals, login sessions, and anti-bot pages are not production-verified. Mock success is not production integration readiness.

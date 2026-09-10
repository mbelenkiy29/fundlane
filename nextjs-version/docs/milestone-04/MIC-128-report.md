# MIC-128 report — Offer-link extraction with manual fallback

**Status:** DONE locally with injected fetch/DNS fixtures. Live funder-portal HTML and anti-bot pages remain an external gate.

## Contract

`src/lib/mca/submissions/offer-links.ts` follows an offer URL only after MIC-122 has classified an approval. Email financial terms win: if amount, rate, and term are already known (from the email snapshot or a previously stored offer), the portal is not fetched.

Otherwise the URL is checked **before** fetch. Non-HTTPS, embedded credentials, localhost, private/link-local/ULA/CGNAT/benchmark IPv4, IPv6 loopback/link-local/ULA/multicast, `metadata.google.internal`, `*.internal` / `*.local`, and DNS answers that resolve to those ranges are `blocked` with `fetched: false`. Redirects are followed with `redirect: "manual"`, at most three hops, HTTPS only, and the same safety checks on every `Location`. Suspicious downloads (PDF/zip/octet-stream/media) and oversize bodies are not parsed.

A readable HTML or JSON page is parsed only from labeled fields (`Amount`, `Factor`/`Rate`, `Term`, `data-amount`, or a JSON object). Login walls, 401/403, timeouts, and unreadable layouts become an **incomplete** offer: `terms_unknown = 1`, amount/rate/term left null unless the email already had them, source link retained, **no invented amount**. Successful portal terms use `deal_offers.source = link` and fill only unknown email fields.

Retries reuse the MIC-122 email offer id. A later complete offer skips fetch. Audit metadata records host and flags, not query strings or page HTML. JSON omits credentials, `body_cipher`, and full bodies.

HTTP: `GET/POST /api/mca/submissions/extract/links`. Reads `deals:read`. Writes `deals:write` with `assertTrustedMutation`. `intake:write` is 403.

## Tests

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/submissions-offer-links.test.ts
```

3/3 passed. `globalThis.fetch` is stubbed and offer-link I/O is injected, so a missed fixture cannot hit the public internet.

Covered: `http://127.0.0.1/` and `https://127.0.0.1/` rejected before fetch and before DNS; metadata IP/host and IPv6 ULA/loopback blocked; plain `http://` blocked; DNS to `10.0.0.1` blocked; redirect to loopback not fetched; fourth redirect stops without inventing terms; email `$25,000` / `1.35` / `10 months` skips fetch and keeps `source = email`; inaccessible login wall and 401 keep `terms_unknown` with the source HTTPS link and omit lure amounts `9999999` / `25000`; replay keeps the same offer id; portal HTML/JSON fill terms; email amount `$20,000` is preferred over a portal `$25,000`; empty/422/400; `intake:write` 403; `deals:read` GET 200 and POST 403; `deals:write` POST 200; cross-workspace 404; SMTP password / `credentialCipher` / `body_cipher` omitted.

## Files

- `src/lib/mca/submissions/offer-links.ts`
- `src/app/api/mca/submissions/extract/links/route.ts`
- `tests/submissions-offer-links.test.ts`
- `docs/milestone-04/MIC-128-report.md`
- `docs/milestone-04/MIC-128-acceptance.md`

Did not edit `extract-outcomes.ts`, `replies.ts`, `schema.ts`, drizzle, or deal UI.

## Remaining gates

Live funder offer-page HTML, authenticated portals, and anti-bot/CAPTCHA layouts. Fixture fetch is not production integration readiness. Offer comparison UI is M5.

## Handoff

Mount `GET/POST /api/mca/submissions/extract/links` (`replyId` or `dealId`) on the reply queue after MIC-122 persist. MIC-122 may later import `extractOfferLink`. Do not invent amounts when the link is blocked or the portal is inaccessible.

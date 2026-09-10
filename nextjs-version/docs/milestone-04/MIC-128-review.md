# MIC-128 review — Offer-link extraction with manual fallback

**Spec:** PASS
**Quality:** Approved (Minor)

Live funder-portal HTML, authenticated sessions, and anti-bot pages remain an external gate. Injected fetch/DNS is not production integration readiness. Do not mark Linear Done from this review.

## Spec

| Requirement | Result | Evidence |
| --- | --- | --- |
| Private-network URL rejected before fetch | Pass | `assertSafeOfferUrl` runs before any `fetchImpl` (`offer-links.ts:342-374`, `548-557`): non-HTTPS, credentials, loopback/private/link-local/ULA/CGNAT/metadata/`*.internal`/`*.local`, and DNS answers in those ranges return `blocked` with `fetched: false`. Redirects use `redirect: "manual"`, max 3, HTTPS + the same checks on `Location` (`562-623`). Tests: `http://127.0.0.1/` and `https://127.0.0.1/` blocked, `lookupCalls` omits `127.0.0.1`, redirect to loopback never fetched, HTTP persist of a loopback link is `blocked` with zero offer-link fetches (`tests/submissions-offer-links.test.ts:402-489`). |
| Inaccessible portal is a manual-review offer, not an invented amount | Pass | Login wall / 401 / timeout / unreadable body → `incompleteResolution` with email terms only (`380-386`, `625-719`). Persist: `terms_unknown = 1`, null amount/rate/term unless email already had them, `source = link`, original HTTPS `offer_link`, status `received` (`884-930`). Login-wall HTML `$9,999,999` and 401 bodies omit `9999999` / `25000` (`531-582`, `721-747`). |
| Email terms skip fetch | Pass | `offerLinkTermsComplete` (amount+rate+term) returns `skipped` / `fetched: false` before lookup or fetch (`203-205`, `532-534`, `297-311`). Approval `$25,000` / `1.35` / `10 months` keeps `source = email` and empty fetch log (`492-520`). Partial email `$20,000` still fetches and prefers the email amount over portal `$25,000` (`640-663`). |
| Tests inject fake fetch; no public internet | Pass | `setOfferLinkNetworkForTests` supplies `fetchImpl` / `lookupImpl` (`164-167`, `173-188`). `globalThis.fetch` throws “network disabled in MIC-128 tests”; `globalFetchCalls` stays `0` (`239-242`, `458-460`, `672`, `757`). Missed fixture throws `unexpected offer-link fetch` instead of dialing out (`184-186`). |
| Redirects, ACL, identity, secrets | Pass | Max 3 redirects (`18`, `572-582`, `449-456`). GET `deals:read`, POST `deals:write` via `requireExtractRead`/`requireExtractWrite` + `assertTrustedMutation` (`extract/links/route.ts`; `extract-outcomes.ts:522-524`). Intake 403; read GET 200 / POST 403; write POST 200; other workspace 404 (`722-756`). Retries keep MIC-122 offer id (`522-528`, `584-595`, `630-638`). JSON omits SMTP password / `credentialCipher` / `body_cipher` (`312-318`). |

Exclusive files match the brief plus the optional HTTP trigger: `src/lib/mca/submissions/offer-links.ts`, `src/app/api/mca/submissions/extract/links/route.ts`, `tests/submissions-offer-links.test.ts`, report, acceptance. No exclusive UI; GET `empty`/`ready` and POST `skipped`/`success`/`incomplete`/`blocked` plus 400/403/404/422 cover conductor-mounted states.

## Quality

Approved. Minor only:

1. `extractOfferLink` runs `resolveOfferLink` (DNS + up to 10s fetches, three redirects) inside `withImmediateTransaction` (`1134-1149`). A slow or hung portal holds a Postgres transaction for the network budget.
2. Safety checks resolve DNS then `fetch` the hostname (`363-373`, `563-570`) without pinning the looked-up address. A rebind between lookup and connect is not covered; the brief’s pre-fetch allowlist is still enforced.
3. Incomplete/blocked replays re-enter fetch when terms stay unknown. Only a later **complete** stored offer short-circuits (`1139-1149`). Spec requires identity reuse, not a second-fetch skip; the login-wall replay does not assert `fetchCalls`.
4. `listOfferLinkExtractions.canWrite` is `actor.source === "user"` (`1089`) while API-key `deals:write` can still POST (tested). Same list-vs-write split as MIC-122.
5. `http://127.0.0.1/` is classified `insecure_scheme` before the private-network host check. Still rejected with `fetched: false`; `https://127.0.0.1/` is `private_network`.

No Critical defects on the exclusive surface. Item 1 is the main operational residual.

## Unverified claims

- **3/3 passed:** three `test("MIC-128:…")` cases match the report/acceptance; this review did not re-execute Postgres.
- **Did not edit `extract-outcomes.ts`, `replies.ts`, `schema.ts`, drizzle, or deal UI:** current `requireExtractWrite` and `terms_unknown` usage match the report; the repo has no git, so in-place rewrites cannot be proven.
- **Live funder portals / CAPTCHA / authenticated HTML:** not production-verified (documented remaining gate). Fixture success is not production integration readiness.

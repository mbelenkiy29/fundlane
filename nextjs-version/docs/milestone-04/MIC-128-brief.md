# MIC-128 brief — Offer-link extraction with manual fallback

**Linear:** https://linear.app/michael-belenkiy/issue/MIC-128
**Depends on:** MIC-122

## Exclusive files

- `src/lib/mca/submissions/offer-links.ts`
- `tests/submissions-offer-links.test.ts`
- `docs/milestone-04/MIC-128-report.md`
- `docs/milestone-04/MIC-128-acceptance.md`

Optional: `src/app/api/mca/submissions/extract/links/route.ts` if you need an HTTP trigger; otherwise MIC-122 can import `extractOfferLink`.

## Rules

- Prefer email financial terms. Fetch portal link only if necessary and authorized.
- Reject private-network / link-local / metadata IPs and non-https before fetch (SSRF).
- Restrict redirects (max 3, https only, same allowlist).
- Inaccessible portal → incomplete offer with source link, **not** an invented amount.
- Tests never hit the public internet; inject a fake fetch.

## Tests

`http://127.0.0.1/` rejected before fetch. Inaccessible fixture → manual-review offer. Terms on the email skip fetch.

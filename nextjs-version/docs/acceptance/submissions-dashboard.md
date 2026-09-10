# Submissions dashboard acceptance

Implemented `/submissions` with MCA's existing theme and deal visibility rules. The sidebar and dashboard guard use the existing Deals page permission. No migrations or provider sending changes were introduced.

## Interfaces

- `GET /api/mca/submissions`: `q`, `delivery`, `response`, `funder`, `rep`, `from`, `to`, `page`. Returns rows, total, clamped page, pageSize 25, and filter choices from all visible records. Dates are inclusive UTC calendar dates; unknown dates do not match date filters. Sort is newest first, missing dates last, with stable record-ID ties.
- `GET /api/mca/submissions/records/[recordId]`: source-qualified `automated:`, `legacy:`, or `manual:` IDs. Returns the permitted summary plus delivery attempts and safe recovery guidance. No raw provider errors, financial terms, documents, or credentials are returned.
- `/deals?deal=<id>&tab=submissions|offers`: allowlisted initial detail tab. Existing document-upload links retain their priority.

Automated jobs are joined to their cache records without duplicating them. Unlinked legacy rows preserve unknown dates. Manual/historical rows remain restricted to administrator user sessions. Delivery cache states do not imply a funder response. Existing deal access policy is applied before counts, filters, pagination, and detail disclosure. The read service loads only deal/assignment roster columns, not decrypted owner or financial data. Filtering/pagination happen on the server; no full roster is sent to the browser.

## Automated verification

32 tests passed using isolated Neon databases:

```sh
node --experimental-test-module-mocks --conditions=react-server --import tsx --test --test-concurrency=1 tests/submissions-dashboard-view.test.ts tests/submissions-core.test.ts tests/submissions-duplicates.test.ts tests/submissions-status.test.ts tests/clerk-auth.test.ts src/lib/mca/deals/acceptance.test.ts
```

Coverage includes combined filters, stable pagination, missing dates, invalid dates/ranges/pages, safe links, delivery history, job/cache deduplication, administrator/rep/manager visibility, other tenants, administrator-only manual records, financial/provider redaction, and JSON API authorization with existing API keys.

## Browser verification

The existing disposable preview helper supports `MCA_SUBMISSIONS_PREVIEW=true`. It creates a development Clerk owner/company and isolated Neon database with 28 synthetic submission records; it never queues an outbox job or sends to a funder. Stop the helper with SIGTERM to delete its company, owner, and database.

Verified:

- Desktop table and mobile cards; full-width 390 × 844 detail sheet; no mobile horizontal overflow.
- Search/no-match/reset, failed-delivery filter, 25-row pagination, and page restoration after reload.
- Selected record restoration after reload; unavailable-record state; failed delivery guidance/history; legacy unknown timestamps.
- Escape closure and focus restored to the originating row.
- A simulated 503 retains rows; retry restores the list.
- Searchable deal picker opens the existing Submissions tab; Open offers opens the Offers tab.
- Preview uses test authentication only. No real funder submissions or production deployment.

Screenshots: [Desktop](submissions-dashboard/submissions-desktop.png), [Mobile detail](submissions-dashboard/submissions-mobile.png).

Typecheck and build passed. Lint has no errors and 16 existing unrelated warnings. Graphify is refreshed after implementation.

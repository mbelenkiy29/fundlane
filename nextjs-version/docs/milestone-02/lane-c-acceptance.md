# Milestone 02 Lane C acceptance

Validated 2026-09-08 against the frozen contracts in `implementation-plan.md` for MIC-119, MIC-165, MIC-155, MIC-173, and MIC-167.

## Acceptance matrix

| Ticket | Delivered behavior | Verification |
| --- | --- | --- |
| MIC-119 | Admin-only CSV, TSV, XLSX, and XLS staging; encoding and header detection; heuristic, manual, optional AI, and saved-profile mapping; source values retained for review; 1,000-row support; required-field errors; possible-duplicate create/skip decisions; preview revisions; cancellation; partial results CSV; retry-safe row checkpoints. | Core fixtures parse all four formats and stage 1,000 rows. HTTP coverage creates a source/batch, reviews a duplicate decision, commits a mixed-validity file, retrieves status/results, and verifies replay identity. Expiring commit leases and per-attempt tokens prevent a reclaimed worker from writing row or final state. |
| MIC-165 | Multiple ZIP inventory; exact, ambiguous, and unmatched merchant-folder review; explicit row assignment; editable destination category; blank-only enrichment with provenance; immutable document storage; per-file recoverable results. | Fixtures reject traversal, nested archives, symlinks/encrypted entries, file-count/size/ratio violations, and a declared expansion bomb before content allocation. ZIP and Drive categories are runtime validated at the route and service boundaries. |
| MIC-155 | Durable import sources and lead batches; deterministic round robin; explicit source originator precedence; saved external-value mappings; unresolved-value admin review; active-membership revalidation at commit. | Core coverage proves explicit originators do not advance the round-robin cursor. HTTP and core fixtures persist and apply per-row originator resolution and retain source/batch provenance. |
| MIC-173 | Separate CSV/TSV update wizard; editable header mapping; deal ID and expected-version requirements; actual before/after/clear review; blanks as no-op; explicit durable clears; status and assignment support; owner/offer/payment rejection; results and failed-row retry. | Cross-workspace and blank IDs fail, stale versions fail without changing the deal, and field plus lifecycle changes produce one version. The deal mutation and import-row checkpoint share one `BEGIN IMMEDIATE` transaction; the reclaimed-worker regression proves a stale token rolls back both name and version changes. Completed replay does not increment the version again. |
| MIC-167 | Google web-server OAuth start/callback with hashed one-time state, offline refresh token, verified `drive.readonly` scope, granted-folder verification, refresh and revoke; Drive v3 paginated traversal and streamed bounded downloads; explicit match/category confirmation; stable document idempotency; durable per-file results. | Fixtures cover state replay, scope, refresh, folder parsing, pagination, denied files, timeout/size ceilings, and invalid categories. Downloaded checkpoints are immutable and returned before credential lookup/listing/download; the resume regression passes after removing the connection and records zero fetches. |

## Security and recovery evidence

- Every import service and route is restricted to an authenticated workspace administrator. Direct HTTP tests cover unauthenticated `401`, API-key/session-only `403`, cross-site mutation `403`, cross-workspace access, invalid category `422`, create/update mutation, status, and replay.
- Application rows, unmapped source values, update payloads, external-originator values, access tokens, and refresh tokens are encrypted at rest with workspace-bound associated data. Plaintext external-originator names are not copied into staged warnings.
- ZIP handling uses lazy entry iteration and streamed decompression ceilings. It rejects unsafe paths, nested archives, symlinks, encrypted entries, excessive counts, oversized entries/totals, and suspicious compression ratios.
- Drive network reads keep the abort timeout active through body consumption, stream into a bounded buffer, constrain folder IDs, paginate with a fixed item ceiling, and preserve completed transfer checkpoints.
- Import commits use expiring leases, attempt tokens, row checkpoints, compare-and-set finalization, and stable row idempotency. Update deal writes and their success checkpoints commit atomically.

## Automated validation

```text
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/imports-core.test.ts tests/imports-http.test.mjs
15 tests passed, 0 failed

pnpm test
51 tests passed, 0 failed

pnpm typecheck
passed

pnpm lint
0 errors; 3 existing React Compiler/TanStack Table warnings

NEXT_DIST_DIR=.next-browser-release pnpm build
passed; 70 static/dynamic application entries generated
```

All automated tests used temporary SQLite databases and temporary document directories. They did not read or mutate the demo database.

## Production browser acceptance

A production build ran against a new temporary SQLite database and document directory on `127.0.0.1:4789`. The browser flow signed in as a temporary bootstrap administrator and verified the mounted Connections and Import Center UI after the final recovery changes.

The full interaction pass also:

1. Created a source and lead batch.
2. Uploaded a CSV with two valid rows and one missing-name row.
3. Reviewed mapping confidence, assignments, and row errors, then committed two deals and downloaded the partial result.
4. Opened an imported deal and verified the mounted document vault and application scan surfaces.
5. Previewed an update with editable mapping and the visible value transition `Harbor Coffee LLC` to `Harbor Coffee Roasters LLC`, plus `lead` to `new_application`.
6. Committed the update and confirmed one atomic version increment through the deal API.
7. Verified the mobile Import Center at 390 by 844 CSS pixels and the Google OAuth authorization request parameters.

Artifacts:

- `output/playwright/milestone-02-import-preview.png`
- `output/playwright/milestone-02-import-committed.png`
- `output/playwright/milestone-02-update-preview.png`
- `output/playwright/milestone-02-document-panel.png`
- `output/playwright/milestone-02-import-mobile.png`
- `output/playwright/milestone-02-final-import-smoke.png`

The only browser console error was the existing global header prefetch of the unavailable `/deals/new` page. The imports, documents, intake, and connections surfaces produced no runtime exception.

## External production gate

No customer Google Cloud OAuth client or customer folder grant was available. The real Google APIs, OAuth exchange, refresh, folder listing, streamed download, and revoke paths are implemented, while their live customer-credential pass remains an external production-readiness check. The local browser verified OAuth URL generation with offline access, state, callback URL, and `drive.readonly`; mock HTTP fixtures verified the remaining protocol and recovery behavior.

The implementation follows Google's [web-server OAuth flow](https://developers.google.com/identity/protocols/oauth2/web-server), [Drive scope guidance](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), [file search and pagination](https://developers.google.com/workspace/drive/api/guides/search-files), and [download guidance](https://developers.google.com/workspace/drive/api/guides/manage-downloads). Spreadsheet parsing uses SheetJS's maintained official `0.20.3` distribution per its [Node.js installation guidance](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/), rather than the stale npm registry release.

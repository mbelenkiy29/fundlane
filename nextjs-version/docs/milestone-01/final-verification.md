# Milestone 01 final verification

Verified locally on September 7, 2026 with Node.js 24.7.0 and pnpm 11.1.2. Tests used temporary SQLite databases and ephemeral Next.js output directories.

## Ticket evidence

| Ticket | Executable evidence |
| --- | --- |
| SEN-27 | Foundation HTTP/core tests cover authenticated workspace resolution, tenant-neutral cross-workspace failures, server-side settings policy, minimum occupied-seat validation, queued-resource tenant validation, and workspace-bound AES-256-GCM. |
| SEN-28 | Deal domain/HTTP tests cover Rep self assignment, Manager managed-originator access, closer-only exclusion, forbidden assignment escalation, immediate access changes after manager reassignment, Rep export denial, and scoped Admin/API-key export. Foundation HTTP covers role-filtered session permissions and separate page/action controls. |
| SEN-30 | Foundation HTTP covers configured bootstrap login, secure cookie sessions, same-origin mutation checks, invite/resend/accept, stable membership identity, sequential and concurrent seat enforcement, one-winner acceptance, enumeration-neutral recovery, expiry/single use, and session invalidation on recovery/deactivation. Invitation delivery URLs resolve to `/accept-invite`. |
| SEN-31 | Server layouts consume session permissions before rendering, deny disabled deep links, provide the MCA navigation shell, and expose only manifest/icons to the service-worker cache. Browser evidence is recorded in `shell-settings-auth-pwa.md`. |
| SEN-32 | Nine focused deal-domain cases plus the deal HTTP test cover partial drafts, field errors, idempotency, encrypted sensitive fields, masked detail/list payloads, assignment rules, optimistic concurrency, source attribution, and safe activity/audit metadata. |
| SEN-34 | Foundation HTTP covers one-time key display, hash-only persistence, masked summaries, rotation, expiry, revocation, endpoint scopes, tenant-neutral cross-workspace mutation, and atomic per-minute rate limits. Deal HTTP adds `intake:write`, `deals:read`, `deals:write`, and `deals:export` boundaries. |
| SEN-35 | Deal domain/HTTP tests cover URL-derived filters, inclusive UTC dates, reconciled table/Kanban totals, lifecycle validation and recovery edges, transition audit/activity, optimistic conflicts, and Funded responses with explicit false advance/commission side effects. |

## Commands and results

- `pnpm test` — 13 passed, 0 failed.
- `pnpm typecheck` — passed with no diagnostics.
- `pnpm lint` — passed with 0 errors and 3 React Compiler advisories for existing TanStack Table hooks.
- `NEXT_DIST_DIR=.next-release pnpm build` — passed; the production route manifest includes `/api/mca/deals/export`.
- `NEXT_DIST_DIR=.next-release pnpm start --hostname 127.0.0.1 --port 4988` with a temporary persistent-path SQLite database and production encryption key — ready in 241 ms.
- Production HTTP smoke — unauthenticated session 401 with JSON/no-store; bootstrap sign-in 200; authenticated dashboard 200 HTML; authenticated export 200 CSV/no-store with attachment disposition; manifest 200.

## Operational limits

- No cloud deployment or persistent volume was provisioned during local verification.
- Production invitation/recovery delivery requires a real `MCA_EMAIL_WEBHOOK_URL`; only the local checked webhook contract was exercised.
- Payments, commissions, company financial reports, submissions, offers, and advances belong to later milestones. Their pages are marked as planned and no operational totals are fabricated.
- Node.js 24.7.0 emits its upstream experimental warning for `node:sqlite`. The app pins Node 24 or later and the persistence acceptance suite passes against that runtime.

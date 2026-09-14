# Fundlane local release checks — 2026-09-13

Local lint, typecheck and production-build gates pass on `ft-home-dashboard`, base commit `b60fc32`, with the current uncommitted workspace changes. This verifies the working tree, not an immutable release commit or deployed environment. Hosted release acceptance remains subject to the [migration rehearsal gates](supabase-rehearsal-2026-09-13.md).

## Fixes

- `src/components/mca/deals/duplicate-merchant-dialog.tsx`: render registered dialog props from a state snapshot instead of reading refs during render. Update callback refs in a layout effect before registration/notification. Event handlers still resolve current callbacks; active-slot selection, busy state, host cleanup and the standalone fallback remain intact. No lint rules were suppressed.
- `.migration/verify-stage-auth.ts` and `.migration/verify-stage-auth-rehearsal-20260913.ts`: replace explicit `any` response payloads with a concrete optional verification response shape. Optional property access lets existing assertions reject missing identity, membership or workspace fields. These existing local helpers are intentionally git-ignored; their edits are local-only and are not part of a release checkout. They were linted, not executed against staging; the application typecheck does not include `.migration/`.

## Safe disk recovery

Initial available space was 2.1 GiB; the earlier rehearsal reported ENOSPC writing `.next/trace`. No Next dev/build process was running at inspection. Inspected directory contents and confirmed the targets were non-symlink, untracked Next.js outputs before removal.

Removed only these generated directories under `nextjs-version/`: `.next`, `.next-assistant-release`, `.next-browser-release`, `.next-build`, `.next-clerk-preview`, `.next-deals-visual`, `.next-foundation-76256`, `.next-marketing-verification`, `.next-release`, `.next-render-check`, `.next-stage-auth`, `.next-supabase-preview`, and `.next-test-chatkit`.

Available space rose to 5.1 GiB (about 3 GiB recovered), then measured 4.6 GiB after the successful build. Fresh `.next` output is 381 MiB. No user data, databases, uploads, environment files, migration evidence, dependencies, external application caches or source files were deleted. Future cleanup should inspect exact generated paths and running processes again; do not broadly delete the workspace or `.migration` directory.

## Fresh verification

Runtime: Node.js `v24.7.0`, pnpm `11.1.2`, Next.js `16.1.1` (Turbopack). Commands ran from `nextjs-version/` using the existing local environment; no provider configuration or deployment was changed.

| Check | Result | Evidence |
| --- | --- | --- |
| `pnpm lint` | Exit 0; 0 errors, 16 existing warnings (previously 5 errors) | [Lint output](release-checks-2026-09-13/lint.txt) |
| `pnpm build` | Exit 0; compiled in 8.9 seconds, TypeScript passed, all 200 static pages generated, optimization completed; no ENOSPC | [Build output](release-checks-2026-09-13/build.txt) |
| `pnpm typecheck` | Exit 0 | [Typecheck output](release-checks-2026-09-13/typecheck.txt) |
| `git diff --check` | Exit 0 | No whitespace errors |

Warnings remain in existing table compiler compatibility, unused symbols, and template-editor hook dependencies; they do not fail the configured lint gate. No full database suite, hosted migration script, browser interaction acceptance or production cutover was performed in this task. The previous rehearsal's protected Vercel access, Render/native scanning, transfer parity, delivery/provider and rollback gates are not cleared by these local results.

Graphify was refreshed from the workspace root with `graphify update .` and `GRAPHIFY_VIZ_NODE_LIMIT=12000 graphify cluster-only . --no-label`; the raised visualization limit accommodates the refreshed graph's 11,578 nodes.

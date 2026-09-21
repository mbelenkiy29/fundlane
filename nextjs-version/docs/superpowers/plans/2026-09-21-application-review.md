# Application review implementation

Approved specification: the user's “Application received → review → lender submission” plan in this task.

## Execution
- [x] Capture encrypted original answers, bind every form path to durable processing, generate unsigned application PDFs, support multiple native statements.
- [x] Add durable recipient notifications and a permission-checked review response.
- [x] Prepare immutable submission previews, validate current inputs at confirmation, reuse approved packages during delivery.
- [x] Build responsive review page and integrate application alerts into existing notification bell.
- [x] Run focused PostgreSQL tests, typecheck, lint, build, browser checks, independent review, Graphify refresh.

## Constraints and decisions
Reuse current Supabase persistence, private document storage, job queues, underwriting and delivery adapters. No new infrastructure/dependencies. New applications only; no historical backfill. In-app notices go to assigned members with admin fallback. Lenders start unchecked. Preparation never sends. Sending requires explicit confirmation with current permissions, current analysis and unchanged package. Preserve historical credit alerts. External production migrations/deployment and real lender sends are not part of local verification.

## Review focus
Custom answer privacy; changing assignment; absent/native application documents; stale preview and retry identity; every delivery channel's frozen content.

## Execution notes
The user explicitly requested implementation of the reviewed plan, so no repeated plan approval is needed. Independent intake capture and UI tasks run in parallel under Superpowers parallel-agent guidance; shared contracts and submission services are integrated here.

## Verification evidence (September 21, 2026)
- Broad isolated-PostgreSQL run: 204/206 pass across application forms, intake, submissions and underwriting. Both failures in `submissions-offer-links.test.ts` reproduce in a clean HEAD archive (1/3 pass); no changes made to those unrelated offer-link behaviors.
- Final review/preview/workflow/portal regression run: 26/26 pass, including actual ingress through analysis/matching and explicit portal handoff, immutable stamped-document downloads, independent failures and duplicate confirmation. Additional final privacy regression: 6/6 pass, including camelCase, opaque custom mappings, nested fields and changed mappings.
- Typecheck, changed-file ESLint, production build, document worker bundle and desktop/mobile browser smoke passed. Full ESLint remains blocked by existing generated Supabase runtime bundles (272 errors); those files are untracked and unchanged.
- Independent review found identity-masking and transformed portal-download defects; both fixed with regression coverage. Frozen delivery documents now reach API/webhook adapters as well as email/portal.
- Graphify refreshed after code changes; JSON sources with no extractable nodes are reported by the existing parser.
- No hosted migrations, deployment, staging-worker acceptance or real lender delivery performed. Apply `0046_application_review.sql` before web/worker rollout; verify current worker health and controlled delivery in staging before release.

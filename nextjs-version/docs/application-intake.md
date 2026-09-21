# Application Intake

`/intake` tracks applications from native links, Fundlane Forms, Jotform, Fillout, DocuSeal, GoHighLevel, Zoho, and custom webhooks through deal creation, document retrieval/scanning, statement analysis, and funder matching. New companies get a Fundlane form automatically; connecting Jotform is optional. Reps only see applications accessible under the existing deal policy. Administrators also have guided connection setup; existing rotation, personal-link, and advanced settings remain available.

## Configuration and routing

The guided flow selects a provider/form, credentials, active assignment members, field mappings, and a synthetic or real payload preview. One member designates a rep; multiple members form the stable distribution pool. Valid personal-link attribution wins, followed by validated provider-mapped attribution, then the configured pool. If no eligible member remains, the application is retained for administrator assignment on its existing deal.

New connections start at **New application** and enable automatic processing when activated. Migration `0046_application_review.sql` enables automatic processing for future submissions on currently enabled, approved form connections. Disabled connections and existing processing windows remain unchanged; no historical backlog is launched. Enabling starts the automatic processing window at that time; older applications can be explicitly retried. Saved configuration and last received delivery are shown separately. A preview is not proof of provider delivery or successful processing.

Provider authentication and attachment contracts remain in `src/lib/mca/intake/providers.ts`, `ingress.ts`, and `attachments.ts`. Jotform uses the configured form identity and existing ingress secret; HighLevel uses the existing signed-delivery contract; Zoho uses the supported JSON/Drive contract and configured private-file credentials; custom forms use the existing authenticated webhook. Advanced settings include allowed attachment hosts. Field mappings support `files:application` and `files:statement` for application and bank-statement upload fields in addition to merchant fields. Configure these to match real payload keys.

## Durable processing

Migration `0033_application_intake.sql` adds opt-in settings and durable checkpoints. Provider identity is scoped by workspace, integration, provider, and event ID. Historical generic-client identities keep their legacy replay behavior. Retries reuse the original intake and deal.

The document worker polls for attachment work and input changes, then executes leased `intake_process` jobs. Every processing stage rechecks the originating integration's authorization and uses authority restricted to that intake's deal. Existing user/API-key jobs retain their own authorization. Inputs include document versions, financial aggregates and corrections, deal/assignment state, funder criteria/profile versions, analysis settings, and the policy version. Changed inputs invalidate old readiness results; concurrent changes during matching schedule another pass. Reviewed financial values are preserved by the existing underwriting correction rules.

Clean scans must successfully promote objects into private clean storage before a document becomes usable. Failed promotion is retryable. Missing files, unavailable scanning/extraction, missing funder criteria, and zero matches are visible outcomes. The intake analysis always uses `review_first` and `select_only`, irrespective of workspace automatic-send settings. It prepares funder selection; the rep reviews and manually submits through existing preflight. Intake automation does not enqueue review emails or funder submissions.

## Worker and staging activation

The active runtime is Supabase Postgres, Auth, and private Storage. Apply additive migrations with the normal release process before starting the worker. `pnpm documents:worker` starts the durable loop; `pnpm documents:worker --once` executes one tick. `pnpm documents:worker:build` bundles the worker. `Dockerfile.worker` installs ClamAV and PDF tooling, refreshes signatures before startup, and runs without root privileges. The Render blueprint includes `fundlane-document-worker` with automatic deployment off.

Configure the same database, encryption key, Supabase service credentials, and storage buckets as the web app, plus OpenAI extraction credentials/model and the app origin. The worker image selects Supabase storage and ClamAV; missing provider or scanner configuration fails closed. Secrets are supplied through deployment environment settings, never connection activity responses.

Before marking a connection live, validate in staging with a real delivery from each configured provider: active-rep routing, private file authorization, scanning, statement extraction, completeness, funder selection, and manual rep review. Repeat delivery, rotate/expire credentials, disable the integration during processing, restart the worker, add a late statement, and correct a financial value. Confirm that matching refreshes and that no submission or review email was automatically sent. No production deployment or real-provider staging delivery was performed by this implementation.

## Verification

`tests/intake-workflow.test.ts` exercises connected providers with synthetic payloads, private-download fixtures, scanner/extraction fixtures, duplicate and concurrent events, integration-scoped identities, late documents, worker lease recovery, disabled integrations, inactive reps, corrections, and cross-workspace access. Existing intake, document, and underwriting tests cover the reused contracts. Document tests include clean-storage promotion failure and recovery.

Browser verification uses the real intake components with synthetic API responses for desktop/mobile, guided setup through activation, and the rep-only empty state. It does not establish live backend/provider connectivity.

Local verification on September 13, 2026: 89 focused intake/document/underwriting/funder/adapter tests passed. Typecheck, production build, the worker bundle, and an isolated-database worker `--once` smoke test passed. Lint finished with no errors and 16 existing warnings. The initial full suite had five failures: billing, legacy assistant authentication, payment receipts, and two local TLS fixtures. Billing's four HTTP tests and both TLS fixture tests passed on recheck with the disposable database certificate trusted. The legacy assistant callback test and payment receipt test still fail outside the intake changes. PostgreSQL tests used disposable databases only.

## Application review and explicit delivery

`/intake/[intakeId]` opens the permission-checked application review. New submissions retain encrypted original labels and answers; transport secrets are excluded and protected identity/contact fields are masked on reads. Historical submissions show available mapped fields with an explicit original-answer limitation. Native forms accept multiple statements, and late documents refresh processing. Missing application documents are generated as unsigned PDFs without inventing signatures or consent.

The existing notification bell includes one application notice per current recipient, with independent read state and live processing status. Assigned active members receive it; company administrators receive unassigned applications. Reassignment is checked on every read. Existing credit alerts remain available.

Lenders start unchecked. Prepare creates an encrypted, expiring preview of the actual destinations, transformed document versions and email content without sending. Explicit Send rechecks permissions, completeness, reviewed positions, current analysis and all preview inputs. Approved delivery jobs retain their frozen package; repeated confirmation does not duplicate sends. Independent failures remain visible per lender. Portal destinations require manual completion. Ambiguous interrupted deliveries fail closed for reconciliation instead of blindly resending.

Source: `src/lib/mca/intake/{review,notifications,submission-review}.ts`, review HTTP routes, `src/components/mca/intake/application-review.tsx`, and existing submission outbox/adapters. Migration `0046_application_review.sql` is required before deploying web/worker code. Apply through the normal release process. Resolve the documented worker deployment failures and verify document and delivery workers in staging with controlled destinations before release; local tests do not establish staging readiness.

The reusable desktop/mobile smoke check is `node scripts/intake/review-ui-smoke.mjs` (set `MCA_PLAYWRIGHT_MODULE` to an installed Playwright module if needed). It uses the actual component with synthetic responses, and writes screenshots under `output/application-review/`.

September 21 review-workflow verification: production and worker builds, typecheck, changed-file lint, desktop/mobile smoke and 26 final workflow regressions passed; the final privacy suite passed 6/6. A broader 206-test run passed 204; its two offer-link failures also reproduce in an unchanged HEAD archive. Full lint currently fails on pre-existing generated Supabase runtime bundles. These local results do not replace the staging activation checks above.

# MIC-184 local implementation and verification

The September 8 follow-up found gaps in the previously reviewed code: failed extraction could not replay because the saved empty application conflicted with the extracted payload; email bytes were not retained; duplicate callbacks reran extraction and assignment; receipt links targeted a nonexistent detail route; attachment failures and queue warnings were not consistently visible; and receipt transport failure could appear successful in the UI.

## Changes

- Persist normalized email and attachments using workspace-bound AES-GCM encryption, with immutable source checksums. Migration `0007_hesitant_proteus.sql` adds two nullable columns; existing records remain compatible. Old failures without retained source require original provider redelivery.
- Serialize processing by the intake row, recover extraction and attachment failures under the same intake ID, reject changed content/route identity, and preserve the first successful assignment. Concurrent callbacks create one deal and receipt.
- Validate inbound payloads, retain low-confidence extraction for administrator review, classify application/statement/check/license attachments, and ignore inline signature images.
- Accept unambiguous labelled business/contact text without an AI provider. Unstructured or multi-business text stays in review. Administrators can create a reviewed partial deal from the queue; this does not bypass sender rules.
- Persist attachment retry jobs and warnings. Review actions record an audit event without source contents.
- Receipt URLs target `/deals?deal=<id>` and `&addDocument=1`; sign-in preserves this constrained destination and server-side deal visibility still applies.
- Queue shows warnings and open-deal links; replay includes retained attachments. Delivery failures no longer report success. Form reset no longer dereferences React's expired event target.

## Verification

The focused intake suite passed 16/16 scenarios (53.6 seconds). The HTTP integration suite passed 1/1 (15.3 seconds), exercising missing webhook credentials, administrator-only manual review, malformed fields, same-ID replay, denied unauthenticated deal access, unavailable receipt transport, and preserved redirect destinations. TypeScript, scoped ESLint and the optimized Next.js production build passed. Synthetic database tests use disposable databases on the protected Neon verification branch, never application records. Browser verification uses a separate synthetic workspace and production Next.js build. Confirmed visible extraction failure, manual review creating a partial deal, retained attachment, warning text, receipt transport failure, deal deep link, direct Documents-tab navigation, and a signed-out receipt URL returning to the same Documents tab after successful sign-in.

Applied the additive migration to the database configured in `.env.local` (the production Neon branch). The migration script labels its output “verification” by default, but the environment URL takes precedence; the target was checked by comparing connection hosts. No application rows were modified by verification tests.

## Domain and production activation

`fundlane.io` was found as the newly purchased Vercel domain. Created and linked Vercel project `fundlane` (`prj_CfNSMe4XUy8ln3sGi60TD01fijVU`), attached the domain, and verified its DNS configuration successfully. Saved `MCA_APP_ORIGIN=https://fundlane.io` for Production. No production deployment has been published.

Authenticated Postmark account read succeeded and returned one existing server and one confirmed sender domain (`sentineltechsolutions.io`). No account token, server token, webhook secret or full email content appears in this evidence. No real email was sent.

Activation still requires a deployed runtime with durable private document storage and malware scanning (the current filesystem/ClamAV implementation is not suitable for Vercel serverless), configured PDF extraction credentials, an outbound receipt transport honoring the stable `Idempotency-Key`, and actual Postmark webhook provisioning plus inbound/outbound verification. A purchased web domain alone does not configure email reception. MIC-184 must remain In Progress until these live requirements are met.

## Reproduce

```sh
pnpm exec node --conditions=react-server --import tsx --test tests/intake-core.test.ts
pnpm exec node --import tsx --test tests/intake-http.test.mjs
pnpm exec tsc --noEmit --pretty false
pnpm exec eslint src/lib/mca/intake src/components/mca/intake src/app/api/mca/intake tests/intake-core.test.ts tests/intake-http.test.mjs 'src/app/(dashboard)/deals/components/deals-workspace.tsx' 'src/app/(dashboard)/layout.tsx' 'src/app/(auth)/sign-in/page.tsx' src/middleware.ts
pnpm build
```

The build reports the existing Next.js middleware-to-proxy deprecation warning. The workspace is not a Git checkout, so this delivery is local files and evidence rather than a commit or PR. No real inbound callback, live PDF extraction or outbound email has been verified.

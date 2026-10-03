# Cloudmersive scanner integration

The shared document scanner supports `MCA_DOCUMENT_SCANNER=cloudmersive` and the server-only `MCA_CLOUDMERSIVE_API_KEY`. This replaces the proposed Verisys provider; this synchronous endpoint requires no callback or webhook secret. The key is stored in Fundlane Supabase secrets and is never committed.

The adapter POSTs native multipart FormData to `https://api.cloudmersive.com/virus/scan/file`. It validates the result, records the exact input SHA-256 and size, and treats errors, malformed/contradictory receipts, exhausted credits, and timeouts as non-clean outcomes. Deal vault uploads invoke this shared scanner; they stay in quarantine until the scan returns `clean` and do not skip Cloudmersive or promote on content validation alone. Queued `document_scan` work has the gated Vercel API-scanner or native executor path in [background job runtime](background-job-runtime.md); Render is historical only. Application drafts use the same scanner independently of deal creation. The request has a 75-second timeout combined with the worker cancellation signal.

Hosted synthetic verification on Fundlane production is recorded in `verification/cloudmersive-hosted.json`. Clean and EICAR fixtures pass. A 25 MiB file is rejected by the provider with HTTP 400. A direct provider diagnostic explicitly reports that the key is on the free tier and requests an upgrade. Do not activate the production scanner until Basic is applied to this key and maximum-size hosted acceptance passes.

A custom streaming multipart implementation incorrectly returned a clean verdict for EICAR in the hosted runtime. Native FormData corrected the failure and is covered by the hosted EICAR test. This materializes a Blob copy of an individual file; maximum-size memory and CPU headroom remain acceptance requirements. This is not proof of resumable document-worker feasibility.

Activation: after upgrading, rerun the authenticated synthetic hosted scanner scenarios (clean, eicar, maximum), verify expected clean/infected/clean outcomes and resource headroom, then select the provider only in the approved Supabase execution path. Do not activate a consumer based on scanner tests alone; follow the current background runtime acceptance gates. Existing document limits remain unchanged.

Tests: `node --conditions=react-server --import tsx --test tests/cloudmersive.test.ts`; `pnpm typecheck`; targeted ESLint; `node scripts/supabase/build.mjs`.

## Free-plan limits

The free plan rejects files over 3.5 MB and allows one call per second. The adapter checks size before calling the provider. A file over 3,500,000 bytes gets scan status `error` with reason `file_too_large` and the message "File too large for virus scan (max 3.5 MB)", so the document is marked `scan_failed`. The worker then fails the job permanently with `scan_file_too_large` (HTTP 413) instead of retrying. Provider calls in one process are spaced at least one second apart.

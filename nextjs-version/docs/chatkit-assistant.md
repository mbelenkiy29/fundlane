# MCA ChatKit assistant

The global assistant reads accessible deals, pipeline counts and existing underwriting scores. It does not write business records, send communications, run underwriting, or upload documents. It is separate from the template `/chat` screen.

## Architecture

The dashboard mounts the ChatKit React panel once per user/workspace. The header opens it alongside the page; mobile uses a full-screen dialog. Selected-deal context is opt-in; the deal dialog also offers an Assistant button. Source links use the existing `/deals?deal=…` route. History is private to the user and company, with rename and deletion through ChatKit.

`POST /api/mca/chatkit` requires a Clerk session, validates browser origin, checks deal-page access, and proxies the protocol to the private Python service without buffering. Turn requests have a shared Neon limit of 10/minute/user/workspace and one in-flight turn; metadata requests allow 120/minute. Cancellation, completion, and a 120-second timeout invalidate the request capability.

The Python SDK connects ChatKit to the Agents SDK. Only four tools are registered: `search_deals`, `get_deal`, `summarize_pipeline`, and `get_underwriting`. Tools and the SDK Store call `POST /api/mca/chatkit/internal` with a short-lived signed delegation. The delegation binds user, membership, workspace, Clerk session, request ID, and the initial request's SHA-256 digest. The callback checks the live request, current local membership, Clerk session, verified account and provider organization membership before each operation. Browser requests cannot select a role or substitute a workspace-wide API key.

All business retrieval uses the existing TypeScript services. Tool responses explicitly select fields; sensitive owners, bank identifiers, raw documents and communications are never included. Financial amounts and detailed underwriting reasons require the company's effective financial permission. Pipeline totals are computed server-side across visible records. Search returns at most 20 deals; scores at most 10 funders. Missing/stale results are reported without generating a new analysis.

Migration `0024_chatkit` adds encrypted threads/items, record references, and ephemeral request leases. The Python service has no database or encryption credentials. MCA encrypts versioned JSON envelopes with the existing encryption key. Thread and item reads check user/workspace ownership and current access to every referenced deal. A changed role/permission configuration or inaccessible referenced deal blocks replay, including the model's context. History lists show a generic locked entry instead of its old title; it can still be deleted. Deleted threads cascade to their items/references. References are retained conservatively after message retries.

## Configuration and rollout

The feature defaults off. Existing production data and document storage are unaffected.

| Service | Variable | Value |
| --- | --- | --- |
| Next.js | `MCA_ASSISTANT_ENABLED` | `false` until verification is complete |
| Next.js | `MCA_ASSISTANT_DOMAIN_KEY` | ChatKit domain key registered for the frontend origin |
| Next.js | `MCA_ASSISTANT_SERVICE_URL` | Private hostname from the Blueprint (port 8000), or explicit `host:port`/full URL locally |
| Both | `MCA_ASSISTANT_SIGNING_SECRET` | Same generated secret, at least 32 bytes |
| Python | `OPENAI_API_KEY` | Reuse the existing approved OpenAI project key through the service secret store |
| Python | `MCA_ASSISTANT_MODEL` | Dedicated model ID; verification uses the configured `gpt-5-mini` |
| Python | `MCA_ASSISTANT_CALLBACK_URL` | `https://fundlane.io/api/mca/chatkit/internal` in production |

`render.yaml` defines `fundlane-chatkit` as a Docker private service in Ohio and wires its private address and generated signing secret into `fundlane`. The service binds port 8000. Its `/health` endpoint checks required configuration without exposing values. Supply the existing OpenAI key and model in Render; register the ChatKit frontend domain and supply its domain key. Apply the checked migration using the normal release process, deploy both services from the same revision, verify with synthetic records, and only then enable the feature. Production activation is not performed by tests.

Locally, install Python dependencies in a virtual environment with `pip install -r ../chatkit-service/requirements.txt`. Run `uvicorn app:app --host 127.0.0.1 --port 8000` from `chatkit-service/`, and point Next.js to that service. Provide Python's configuration via its environment; the service does not read or copy the app's secret file.

## Verification

From `nextjs-version/`:

- `node --experimental-test-module-mocks --conditions=react-server --import tsx --test tests/chatkit.test.ts`
- `pnpm typecheck`, `pnpm lint`, `pnpm build`
- `CHATKIT_PYTHON=/path/to/venv/bin/python node --conditions=react-server --import tsx scripts/chatkit/verify.mjs --live`

The end-to-end script creates and drops an isolated database using the protected Neon verification helper, runs a local Clerk protocol fixture, starts Next.js and Python, and exercises a synthetic model/tool/stream/history/delete round-trip. It reads the approved local OpenAI key into process memory and makes a paid model call only with `--live`. `--hold` keeps the synthetic fixture available for browser checks for ten minutes. It never uses the application's database for test records.

From `chatkit-service/`, install `pytest` and run `python -m pytest -q tests`. Tests cover request signatures/body binding, unsupported operations, attachment rejection, real SDK streaming/storage protocol, and sanitized failure responses. No API call occurs in Python unit tests.

Operational logs contain request IDs, durations, token counts and error categories. SDK tracing and SDK exception logs are disabled to keep conversation contents and credentials out of logs. Roll back by setting `MCA_ASSISTANT_ENABLED=false`; retain the additive tables for saved-history recovery.

## Implementation verification record

- Nine assistant tests passed against an isolated Neon database, including signatures, ownership, encryption, pagination, cascading deletion, revoked access, financial redaction, stale underwriting, streaming cancellation and concurrent-turn fencing.
- Twelve existing underwriting analysis/scoring tests passed.
- Six Python tests passed, including the real ChatKit protocol and the frontend's 9,999-entry history request (clamped to 100 entries with pagination).
- Typecheck and production build passed. Lint completed with zero errors and 16 existing warnings outside the assistant implementation.
- A live `gpt-5-mini` request against a synthetic workspace exercised tools, SSE, persisted history, reload and deletion using the approved existing key.
- Browser checks exercised a real ChatKit frame, history/reloaded response, the 440px desktop panel, 390px full-screen mobile layout, selected-deal context, and Escape/focus restoration. The synthetic Clerk fixture does not serve Clerk's frontend JS; its expected console errors are separate from the authenticated server-side fixture. Production domain registration still requires verification.
- The broad application suite was started but stopped after the active fixture completed; it is not claimed as a full-suite pass. The focused checks above completed independently.

These are historical local checks; see the release record below for current production status.

## Release procedure (September 11, 2026)

This release is integrated on current main; the existing conversational assistant and marketing site are retained. ChatKit's context module is `chatkit-context.ts` to avoid replacing the existing assistant's `context.ts`. Migration 0024 follows main's already-applied 0020–0023 migrations; never apply the old uncommitted 0020 ChatKit migration.

Run `node --import tsx scripts/chatkit/migrate.ts --target=production` from `nextjs-version/` to rehearse within a rolled-back transaction, then add `--apply` to commit. The script uses only protected connection metadata, checks every predecessor hash and timestamp, rejects partial schema, uses a migration-history lock and short lock/statement timeouts, and verifies four tables, six foreign keys and seven indexes. Retrying verifies the existing migration without reapplying it. Rollback is feature disablement, not dropping encrypted history.

For controlled production verification while the global flag is false, `MCA_ASSISTANT_VERIFICATION_SCOPE` may contain JSON with exact local `userId`, `workspaceId`, and ISO `expiresAt`. It permits only that synthetic account after normal Clerk authentication, live provider membership validation, and the existing record access checks. Malformed, expired, or greater-than-one-hour scopes fail closed. The dashboard, gateway and signed callback all enforce the same scope. Remove the variable and revoke the synthetic identity after verification; never use a customer account for this check.

OpenAI domain registration is prepared for exactly `fundlane.io` and `www.fundlane.io` at [Domain allowlist](https://platform.openai.com/settings/organization/security/domain-allowlist). The browser tool requires action-time approval to generate the persistent domain key. Do not substitute a localhost key in production. After approval, save the public key as `MCA_ASSISTANT_DOMAIN_KEY`, redeploy the same app revision, and verify the real ChatKit frame on the production origin before enabling the global flag.

## Production verification record

- Release code revision: `6696e568f5e8f14a4e8868a77a03840d7dccc95c`, based on main `eb524bf`. Release PR: [#3](https://github.com/mbelenkiy29/fundlane/pull/3).
- Confirmed Neon project `cool-pine-95841889`, production branch `br-aged-sun-aeqj80uv`, database `fundlane`. Render's configured database hostname matches the protected production connection. The migration rehearsal rolled back; the apply and idempotent repeat both passed. Migration SHA-256: `40a6dd8106d3b9efea88f622dd6ff5dcb59b95301dd89528547ca32f1f9c6406`.
- Private service `srv-dai0u267bikc73e3ed5g` (`fundlane-chatkit`, Ohio, starter) and Next.js service `srv-dahc3veq1p3s73eatung` both reached `live` on the same code revision. Python's private address is `fundlane-chatkit:8000`; it has no public domain, database key, or encryption key. Its initial deploy is `dep-dai0u2u7bikc73e3eh9g`; the Next.js synthetic verification deploy is `dep-dai101142hec73aslmgg`.
- Production verification passed at **2026-09-11 14:30:29 UTC** using a newly created, uniquely named synthetic company, one synthetic owner and one synthetic deal. Clerk authenticated the synthetic session using a one-time sign-in ticket; no customer identity was reused, and no email/SMS was sent.
- Successful checks: authenticated gateway/private callback, one live `gpt-5-mini` pipeline-tool call, SSE, encrypted stored history, history reload, rename, deletion and child-row cascade, unchanged synthetic deal, unauthenticated rejection, untrusted-origin rejection, and unsigned callback rejection. Request ID: `34b9de69-cbe6-4084-8520-693d983bb0db`. Python's sanitized usage event reports 4,162 input tokens and 1,319 output tokens; no conversation body or secret was logged.
- Cleanup passed at **2026-09-11 14:31:18 UTC**: removed the verification scope from Render, revoked the synthetic session, deleted its Clerk organization/user, and transactionally removed only the run's synthetic database records. Release deployments are refreshed after this removal. The global flag was never set to true.
- Public checks passed: `/`, `/sign-in`, and the ChatKit Inter font return 200; font CORS allows the embedded frame. `www.fundlane.io` redirects to the apex over HTTPS.
- Integrated local checks: 10 ChatKit tests, six Python tests, typecheck, lint, production build, blueprint validation and the isolated live model round-trip passed. GitHub PR validation passed. Graph/report/HTML were refreshed with a 15,000-node visualization limit; generated local backups are excluded from the release commit.

### Remaining provider approval and activation

The OpenAI **Generate key** form is prepared but unsubmitted for the two exact production domains. This is the only unfinished provider approval identified during this release. The browser tool's confirmation policy requires action-time approval for the persistent domain registration. No new OpenAI API credential or model upgrade is needed. After approval, configure the returned domain key on Next.js and verify the real production ChatKit frame, desktop/mobile loading, source links, history, and focus restoration using a fresh short-lived synthetic scope. Remove that scope and its fixture afterward. Until that browser check passes, keep `MCA_ASSISTANT_ENABLED=false`.

The private service is pinned to `codex/chatkit-release` with automatic deployment disabled while the PR awaits merge. After merge, sync the checked Blueprint to track main and restore checks-pass deployment behavior; inspect the sync plan and preserve the already-configured signing secret. Deploy both services at the same merged revision. Do not merge this PR or activate unrelated assistant capabilities implicitly. The existing conversational assistant also uses `MCA_ASSISTANT_ENABLED`, so setting it true is a shared activation change and its own provider prerequisites must be checked as well.

Final regression verification: the three existing assistant suites completed with **50 passed, zero failed, one intentionally skipped live-provider test**. After cleanup, both production ChatKit routes returned 404 `assistant_disabled`, Render reported the flag as `false` with no verification scope, and no synthetic workspace-scoped rows remained. The final release commit is deployed to both services; current deployment IDs and revision are recorded in the PR description.

Blueprint port correction: Render reports `fundlane-chatkit:10000` in its service URL metadata even though its detected open port is 8000. The Blueprint therefore references `property: host`; the gateway adds port 8000 for a bare private hostname and preserves explicit ports/full URLs. The streaming test verifies this resolution. This prevents a future Blueprint sync from replacing the verified service URL with the wrong port.

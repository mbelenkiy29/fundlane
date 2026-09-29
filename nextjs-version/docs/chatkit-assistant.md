# Global assistant runtime

The global `/assistant` page and header drawer read accessible deals, pipeline totals and existing underwriting. They use the current Supabase Auth session, application membership and workspace permissions. They do not write business records or send messages. Merchant message suggestions are drafts that require a separate user action in the messaging panel. Deal Assistant and its credit accounting are described in [deal-assistant.md](deal-assistant.md).

## Active code path

With `MCA_ASSISTANT_RUNTIME=vercel_node`, the Vercel Node `POST /api/mca/chatkit` gateway validates the browser origin, current Supabase membership, workspace/deal access, request rate and one active turn. It signs a short-lived request delegation and calls `nativeAssistant` in the same Node runtime. The native handler verifies the body digest, active request and live Supabase session before reading history or invoking tools. Tool calls recheck access. OpenAI Responses streaming is forwarded to the native chat UI; cancellation removes the active request and aborts the model call. History is encrypted and scoped to its user and workspace. Source links point to accessible deal pages. Financial fields and detailed underwriting reasons require the current financial permission.

The existing signed `/api/mca/chatkit/internal` callback remains in source for the legacy ChatKit service. `chatkit-service/`, `MCA_ASSISTANT_SERVICE_URL`, and its Python verification scripts are rollback-only references. They are not required for Vercel Node operation. Do not deploy or resume the suspended service for this rollout. The historical `MCA_ASSISTANT_RUNTIME=supabase` UI selection is not a deployed Supabase function. Keep it unused. There is no production Supabase assistant function to invoke.

The runtime selector is explicit: unset or any value other than `vercel_node` preserves the previous ChatKit gateway/UI path. `MCA_ASSISTANT_ENABLED` remains exactly-`true` to expose either assistant surface; unset is off. A short-lived `MCA_ASSISTANT_VERIFICATION_SCOPE` can permit one exact synthetic user/workspace while the global flag is off. It never bypasses Supabase identity, membership or record checks, and expires within one hour. Remove it after verification. The separate `MCA_ASSISTANT_MAINTENANCE_ENABLED` flag controls scheduled credit cleanup and alerts; it defaults off and does not expose the assistant.

## Offline readiness check

The readiness command is inert by default. After filling an untracked local environment with synthetic or approved nonproduction values, run:

```sh
MCA_ASSISTANT_READINESS_CHECK_ENABLED=true pnpm assistant:readiness
```

An unset flag, `false`, `TRUE`, or any value other than exactly `true` prints the disabled message and exits successfully. When enabled, the command exits successfully for a complete Vercel Node configuration and nonzero for an invalid one. It reports field names and statuses but never prints secret contents, key fragments, URLs, or signing-secret lengths. The check is side-effect-free: it makes no provider, database, Supabase, Stripe, email, or storage call, and it does not activate the assistant, document AI, or maintenance processing.

Model identifiers receive a local syntax-only check for empty, placeholder, whitespace/control-character, or excessively long values. A passing result does not establish provider access, model existence, Responses streaming/function-call support, or document structured-output support. The command does not replace the hosted staging checklist below: Michael must still use approved nonproduction credentials and synthetic records to confirm a controlled model request, streaming, tools, persistence, cancellation, permissions and workspace isolation, private files, document extraction, mobile behavior, usage, and failure monitoring before activation.

## Hosted setup for Michael

1. In the approved nonproduction Vercel environment, configure restricted Supabase `DATABASE_URL`, Supabase Auth variables, `MCA_DATA_ENCRYPTION_KEY`, `OPENAI_API_KEY`, and a Responses-compatible `MCA_ASSISTANT_MODEL` that supports function calls. Keep model credentials server-side. Use synthetic accounts and deals. No new migration is required by this runtime change.
2. Set `MCA_ASSISTANT_SIGNING_SECRET` to a generated secret of at least 32 bytes. Set `MCA_ASSISTANT_RUNTIME=vercel_node`. Leave `MCA_ASSISTANT_ENABLED=false` globally, and use a short-lived synthetic `MCA_ASSISTANT_VERIFICATION_SCOPE` for staging checks. The Node UI does not require a ChatKit domain key or an external callback URL; its browser endpoint is same-origin `https://<staging-origin>/api/mca/chatkit`. If retaining the legacy embedded ChatKit rollback path, register the exact frontend origin in the OpenAI domain allowlist and set `MCA_ASSISTANT_DOMAIN_KEY` for that origin. The legacy service callback is `https://<origin>/api/mca/chatkit/internal`. Do not use a localhost key on the production origin.
3. On the approved staging preview, verify streaming, saved history/reload/deletion, source links, cancellation, financial redaction after role change, revoked membership, cross-workspace isolation, and mobile keyboard/focus behavior. Confirm the configured model and API key with a controlled model call. Local tests mock the model and cannot establish hosted provider readiness.
4. After hosted checks, configure `CRON_SECRET` and `MCA_ASSISTANT_MAINTENANCE_ENABLED=true` on staging. Schedule one authenticated `GET /api/cron/assistant` invocation every minute (`Authorization: Bearer <CRON_SECRET>`). Do not schedule the historical assistant worker at the same time. Verify expired reservations clear after a restart, queued alerts process once, and response/error metrics remain healthy. The route uses a 240-second deadline under a 300-second Vercel limit. It returns `claimed:false` when another tick holds the PostgreSQL maintenance lock. No schedule is declared in `vercel.json`.
5. Keep the public flag off until a production-origin smoke test with a controlled account passes, including the correct model key and any domain key needed for the selected UI. Then set `MCA_ASSISTANT_ENABLED=true` only with product approval. Monitor request errors, model usage, cron `claimed`/duration, expired reservations and `mca_credit_alert_emails` states. Roll back by setting the public and maintenance flags to false; retain encrypted history and the existing tables.

No hosted deployment, provider setup, schedule or production-origin check was performed for this code change.

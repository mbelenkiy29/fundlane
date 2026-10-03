# Sentry error monitoring, replay and feedback

Fundlane reports errors, structured logs, traces, masked Session Replay and in-app user feedback to Sentry through `@sentry/nextjs`. Everything is inert until a DSN is configured: CI, tests, local development and any deployment without `NEXT_PUBLIC_SENTRY_DSN` load no Sentry code on the server and send nothing from the browser.

## What is captured

| Source | Entry point | What reaches Sentry |
| --- | --- | --- |
| Browser errors | `src/instrumentation-client.ts`, error boundaries (`src/app/global-error.tsx`, `(dashboard)/error.tsx`, `platform/error.tsx`) | Unhandled errors and rejections, boundary errors without a server digest. `RequestError` responses below 500 are dropped as expected validation/permission results. |
| Server rendering | `src/instrumentation.ts` `onRequestError` | Server Component, layout and route errors that escape a handler. |
| API routes | `apiError()` in `src/lib/mca/errors.ts` | Every 5xx: unexpected errors at `error`, `AppError` 5xx at `warning` grouped by code. Tags `correlation_id`, `error_code`. 4xx are not reported. |
| Background jobs and cron | `runNextBackgroundJob()` in `src/lib/mca/jobs/worker.ts` | Failed jobs other than 4xx `AppError`s, grouped by job kind and code. |
| User identity | `<SentrySession>` (browser) and `authenticateSupabaseSession()` / API-key auth (server) | Browser: user id, email and name, plus `workspace_id`, `role` and the company name. Server: user id, `workspace_id`, `role`, `auth_type`, `api_key_id`. No IP address is stored. |
| Logs | `consoleLoggingIntegration` | Server `console.info/warn/error` (the existing secret-free `{"event": ...}` operational logs) and browser `console.warn/error`. Browser `console.log` is never sent because template pages log raw form values. |
| Traces | Default Next.js tracing | 10% of requests by default. Trace headers are not added to outbound provider calls (`tracePropagationTargets: []`). |
| Session Replay | `src/components/observability/` | Signed-in workspace and `/platform` pages only (see privacy controls). |
| User feedback | Floating **Feedback** button (`feedback-button.tsx`), bottom-left beside the sidebar on workspace and `/platform` pages | "Report an issue" (`feedback_type:bug`), "Request a feature" (`feedback_type:feature_request`) and "Suggest an improvement" (`feedback_type:improvement`), each with name, email, message, optional screenshot and the buffered replay. Bottom-right is left to the Browser calls widget and toasts; on `/assistant` the button sits above the chat composer. |

Supabase Edge functions and the historical Render workers are out of scope. Shared server code reports through `src/lib/observability/bridge.ts`, which has no imports and does nothing unless `sentry-server.ts` registered a reporter, so those bundles never include Sentry.

## Privacy controls

- **Data collection.** `DATA_COLLECTION` in `src/lib/observability/sentry-options.ts` turns off v11's defaults for cookies, request and response bodies, query values, IP inference, AI prompts and outputs, database parameters, queue arguments and stack-frame variables. Request headers are allowlisted.
- **Scrubbing.** `src/lib/observability/scrub.ts` runs on every event, breadcrumb, log, span and replay frame. It reuses `redactDiagnosticText`, replaces access-token path segments (`/merchant-upload/`, `/apply/r/`, `/review/`, signed downloads) with `[token]`, filters every query value and drops URL fragments such as Supabase `#access_token`.
- **Replay scope.** Replay is never initialised on public pages. `<SentrySession>` adds it only on workspace and `/platform` paths (`replayAllowedPath`), and `onRouterTransitionStart` stops recording before navigating to any other path, including `/review/[token]` and `/account-security`. A different user on the same tab always starts a new replay.
- **Replay masking.** All text and inputs are masked and images, video and iframes blocked. Only the sidebar navigation, header actions and the platform breadcrumb carry `data-sentry-unmask`. MFA setup, recovery codes, API-key and webhook secrets also carry `data-sentry-block`. Network request and response details are not recorded.
- **Feedback screenshots.** A screenshot is a real, unmasked capture of the user's screen, taken only when the user chooses to add one. The form tells users to use **Hide** over merchant or banking details. `Permissions-Policy: display-capture=(self)` allows this page to request the capture.
- **Log hygiene exception.** Sentry receives stack traces, which native logs never do (see [Platform status](platform-status.md#log-hygiene-evidence)). Messages, URLs and headers are still scrubbed as above.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_SENTRY_DSN` | blank | Public project DSN. Blank disables Sentry everywhere. |
| `SENTRY_DSN` | blank | Optional server-only override; falls back to the public DSN. |
| `NEXT_PUBLIC_SENTRY_ENVIRONMENT` | blank | Overrides the environment name; otherwise the SDK uses the Vercel environment. |
| `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` | `0.1` | Share of requests traced. |
| `NEXT_PUBLIC_SENTRY_REPLAYS_SESSION_SAMPLE_RATE` | `0.1` | Share of signed-in sessions recorded in full. |
| `NEXT_PUBLIC_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE` | `1.0` | Share of other signed-in sessions buffered and sent with an error or feedback. |
| `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN` | blank | Build-time source-map upload only. Without a token no browser source maps are generated. Never expose the token as `NEXT_PUBLIC_*`. |

`NEXT_PUBLIC_*` values are inlined at build time, so changing them requires a redeploy. Browser events go to the same-origin `/monitoring` tunnel, which `src/proxy.ts` excludes from the maintenance gate and session refresh. No CSP change is needed.

## Hosted setup for Michael

1. Create a Sentry project for the Next.js platform, or install the Sentry integration in the Vercel `fundlane` project, which creates the project and sets `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` and `SENTRY_PROJECT`.
2. In Sentry organization and project settings, turn on server-side data scrubbing, **Prevent storing of IP addresses** and spike protection.
3. Set `NEXT_PUBLIC_SENTRY_DSN` (and the build variables if not set by the integration) for **Preview** first and redeploy.
4. On the preview, using synthetic accounts and records: trigger a browser error and an API 500 and confirm both carry the user and workspace; confirm a replay is masked and stops on `/review/...` and `/account-security`; confirm public `/apply` and `/merchant-upload` pages send no replay; use the floating Feedback button to send an issue report, a feature request and an improvement (one with a screenshot) and check each `feedback_type` tag; sign in as a second user on the same tab and confirm a new replay ID; confirm stack traces are de-minified.
5. Set the same variables for **Production**, then redeploy. The privacy policy wording for Sentry was approved by the owner on October 3, 2026 (see `docs/legal-drafts.md`).

Roll back by unsetting `NEXT_PUBLIC_SENTRY_DSN` and `SENTRY_DSN` and redeploying.

## Triage with the Sentry CLI

The [Sentry CLI](https://cli.sentry.dev/) works for people and coding agents. It is not a project dependency (the build plugin bundles its own copy for source-map upload). Run it from `nextjs-version/` so it detects the project from the DSN:

```sh
npx sentry@latest auth login                                  # once per machine
npx sentry@latest project create <org>/fundlane:javascript-nextjs  # if not using the Vercel integration
npx sentry@latest issue list
npx sentry@latest issue explain <ISSUE-ID>                     # Seer root-cause analysis
npx sentry@latest issue plan <ISSUE-ID>
npx sentry@latest feedback list --query "feedback_type:feature_request"
npx sentry@latest feedback list --query "feedback_type:improvement"
npx sentry@latest replay list
npx sentry@latest log list <org>/<project>
```

In the Sentry UI, User Feedback lists issue reports, feature requests and improvement suggestions; filter by `feedback_type:bug`, `feedback_type:feature_request` or `feedback_type:improvement`.

## Tests

`node --conditions=react-server --import tsx --test tests/observability.test.ts tests/security-headers.test.ts` covers scrubbing, replay paths, sample rates, the bridge, `apiError` reporting, the tunnel/proxy matcher and the Permissions-Policy. Also run `pnpm typecheck`, `pnpm lint` and `pnpm build`.

No Sentry project, hosted deployment or provider setup was created or verified for this code change.

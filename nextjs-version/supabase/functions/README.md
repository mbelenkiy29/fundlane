# Fundlane Edge Functions

Application code is bundled from `src/lib/mca` by `scripts/supabase/build.mjs`.
The generated ESM modules are deployment artifacts, not an independent copy of business logic.
Every scheduled endpoint performs its own constant-time worker credential verification.
The hosted feasibility endpoint is staging-only and requires a separate credential.

Render is historical only; retain `../../docs/render-deployment.md` as an audit.
The selected Vercel Cron + Supabase runtime and hosted staging acceptance gates are in
`../../docs/background-job-runtime.md`. Do not activate schedules before those gates pass.
The 2026-10-01 live inventory lists only stripe-setup, stripe-webhook and stripe-worker (v6)
as deployed; local platform-monitor is not deployed. Existing Stripe functions are outside
this deployment set. The build currently emits only mca-feasibility and mca-assistant;
the deployment script permits only staging mca-feasibility.

# Fundlane Edge Functions

Application code is bundled from `src/lib/mca` by `scripts/supabase/build.mjs`.
The generated ESM modules are deployment artifacts, not an independent copy of business logic.
Every scheduled endpoint performs its own constant-time worker credential verification.
The hosted feasibility endpoint is staging-only and requires a separate credential.

Do not activate schedules or retire Render until the hosted acceptance gates in
`../../docs/render-deployment.md` pass. Existing Stripe functions are outside this deployment set.

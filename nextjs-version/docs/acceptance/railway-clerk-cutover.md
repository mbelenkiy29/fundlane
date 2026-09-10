# Railway Clerk cutover — prepared, not deployed

The September 9 deployment request is pending the real email address for the existing administrator. Deployment `d04b4edb-54bd-4c84-8589-c8f30215cc37` still serves fundlane.io.

## Prepared

- Railway project `ebaeb3c7-36c9-4b29-926b-cdba0bf6f3d7`, environment `39c0ed1d-5e2e-46c9-91d7-b35ea51e7632`, service `b848140b-e16f-44f1-9e1d-569c56b37a54`.
- MCA production Clerk instance `ins_3J75PszzQSHjIKnVlAVwEkkEouR` for fundlane.io. Standard organization roles are used because cloning development custom roles required a different Clerk plan. Local MCA permissions remain authoritative; live billing is disabled.
- Email/password, verified email, email-code activation and Organizations enabled; automatic domain enrollment disabled. Five Clerk CNAMEs added in Vercel. DNS and mail verified; SSL still provisioning at last check.
- Webhook `ep_3J75rxrVs3TcIYe50jxQwFqlRTh` targets `https://fundlane.io/api/webhooks/clerk` with user, organization, organizationMembership and organizationInvitation lifecycle filters.
- Railway production keys and webhook secret configured with skip-deploys. `MCA_CLERK_BILLING_ENABLED=false`. Secrets are excluded from the clean deployment package.
- Neon pre-cutover snapshot `br-spring-rain-ae0y540i` (no compute) and validation branch `br-shiny-shape-aezvl5lo`, from production `br-aged-sun-aeqj80uv` in project `cool-pine-95841889`, database `fundlane`.
- Additive migrations passed on validation, then production: 20 migrations, one user/company/deal preserved. No Clerk identities imported yet.
- Dockerfile accepts the public Clerk key at build time. Migration failures now report only provider status/error codes. Typecheck passed.

## Resume after the owner supplies an email

The existing user `588a276c-6714-4144-b6bb-0ab236b58db9` has an `@mca.local` placeholder. Clerk rejected import with `form_param_format_invalid`. Do not infer ownership or silently change its email.

1. Check for conflicts and update only that user's email to the user-approved address, preserving all IDs and company data.
2. Load production runtime secrets securely from Railway. Run migration dry-run, apply with `--allow-production`, and reconcile counts and provider IDs. No password hashes or legacy sessions are imported.
3. Confirm Clerk DNS/SSL/mail readiness. The owner must verify email and set a password after cutover.
4. Upload the clean app to the explicit Railway target using the Dockerfile and existing volume. Keep test billing disabled. Exclude environment files, runtime data, tests and secrets.
5. Wait for SUCCESS; verify auth pages, Clerk assets, JSON API authorization, retired password issuance, invalid webhook signatures, and authenticated app access when the owner can verify. Record the deployment ID and results.

Retain the pre-cutover snapshot. Destructive database restore requires separate authorization.

# Fundlane deployment — September 10, 2026

The application is live on Render at https://fundlane.io. https://www.fundlane.io redirects to the apex. Vercel remains the domain registrar and DNS provider; Neon remains the production database.

## Resources

- GitHub: https://github.com/mbelenkiy29/fundlane
- Render workspace: `tea-da86hgegekts73ccou40` (Michael's workspace).
- Blueprint: `exs-dahc2u9t0dsc73ff9l70`.
- Web service: `srv-dahc3veq1p3s73eatung`, Ohio, Docker, `1c-2g` ($25/month).
- Persistent disk: `dsk-dahc3veq1p3s73eatvc0`, 10 GB mounted at `/data` ($2.50/month).
- Render origin: https://fundlane.onrender.com.
- Verified release: `dep-dahc6n7qj5pc73a43nvg`, commit `443d97b48e94245964327fd18a23da1cc6b345fa`, live.
- Neon project: `cool-pine-95841889`, production branch `br-aged-sun-aeqj80uv`, database `fundlane`.

The $27.50/month base estimate excludes usage-based charges and existing third-party services. The earlier Railway deployment was retained as a fallback; it was not deleted or suspended by this deployment.

## Configuration

The Blueprint uses `nextjs-version/Dockerfile`, Node 24, Next standalone output, and the checked ClamAV entrypoint. Document bytes and antivirus signatures persist in `/data/documents` and `/data/clamav`. Production credentials were transferred from the existing Railway environment through the dashboards without committing environment files. The original encryption key was preserved. A missing `MCA_DOCUMENT_TOKEN_SECRET` was generated in the Render secret store, and its presence was verified after redeployment.

Vercel's existing apex ALIAS and www CNAME now both point to `fundlane.onrender.com`. Clerk, email, CAA, nameserver, and other unrelated records were preserved. Render verified both custom domains. Normal HTTPS certificate validation succeeded for both hostnames.

## Verification

- Production build and local typecheck passed. Local lint and GitHub CI passed with existing warnings.
- Render release reached `live`; the running container connects to Neon with TLS verification enabled.
- Existing data preserved: one user, one company, one deal, zero document objects. All 20 schema migrations were already applied.
- Clerk migration reconciled the existing owner/company/membership; no business IDs or password hashes were replaced.
- Public sign-in and sign-up: HTTP 200. Unauthorized workspace API: 401. Retired password issuance: 410. Invalid Clerk webhook signature: 400.
- ClamAV executed as the application user: clean text returned 0; standard EICAR test bytes returned 1 with an infection detected. Temporary scanner files were removed.
- A test marker written as uid 1000 survived a redeployment on the persistent disk; it was then removed.
- https://fundlane.io/sign-in returns 200; www redirects to the apex. The browser loaded the custom-domain sign-in screen and Clerk activation control.

## Remaining user and provider steps

The migrated administrator must use the **Verify email / activate migrated account** flow, verify their own email, and set a password. Authenticated browser access was not verified on the user's behalf.

Provider-dependent features still require their real credentials/approvals and delivery verification. The existing Postmark bindings were preserved; pending senders were not marked verified. No real email, SMS, or signing request was sent during deployment. Development-only Clerk billing remains disabled. Scheduled provider jobs were not activated without their required provider configuration.

For implementation and environment guidance, see `nextjs-version/docs/render-deployment.md` and `nextjs-version/.env.example`. Earlier Railway cutover notes predate this completed Render release.

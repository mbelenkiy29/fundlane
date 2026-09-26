# Milestone 5 provider activation

## Current Vercel and Supabase closing activation (issue #41)

The active application runs on Vercel with Supabase. The Railway and Neon notes below are historical evidence, not current deployment instructions. No live provider was contacted for issue #41. Set `MCA_CLOSING_VERIFIED_FLOW_ENABLED=true` only after the controlled pilot is approved; unset or `false` preserves the existing behavior. The opt-in flow requires a sent contract request, a scan-clean signed closing document and explicit manual review before final review and live funding. A generic PSF `status=signed` callback cannot prove signing in this mode. Contract signature provider callbacks are **unavailable**: the app has no verified contract-signing callback integration. The external-signature button is disabled in verified mode; an operator can record a reviewed paper signature with a reason and scan-clean document. Do not treat an arbitrary uploaded PDF or mock callback as provider-signed evidence.

### Hosted setup for Michael

1. In Postmark, verify the sender domain and each From address. Create a transactional server and record its server token in `MCA_CLOSING_POSTMARK_CONNECTIONS_JSON`, binding the exact workspace ID, saved sender ID, From address and message stream. Set `MCA_CLOSING_EMAIL_PROVIDER=postmark`. Confirm the selected merchant and submission sender identities in Settings → Connections. Send only to approved pilot recipients. There is no email callback URL for this adapter; delivery reconciliation reads Postmark outbound activity by correlation metadata. If Postmark is unavailable, leave the channel visibly unavailable.
2. For merchant SMS, complete Twilio sender registration and webhook signing setup in [company SMS onboarding](../sms/company-onboarding.md). Set `MCA_SMS_PROVIDER=twilio`, `MCA_SMS_PUBLIC_BASE_URL=https://YOUR_APP_HOST`, and `MCA_SMS_TWILIO_ACCOUNTS_JSON` for the exact workspace and sender. The application supplies `https://YOUR_APP_HOST/api/mca/sms/webhooks/twilio/ACCOUNT_ID/status?messageId=LOCAL_MESSAGE_ID` as the per-message status callback. Configure the purchased number or Messaging Service inbound URL as `https://YOUR_APP_HOST/api/mca/sms/webhooks/twilio/ACCOUNT_ID/inbound`. Verify consent with an approved handset. Leave SMS unavailable until the account is active, assigned, and provider configured.
3. For PSF signatures, approve the DocuSeal template, signer role, all field mappings, signer email policy, signed-PDF host and audit-log host listed in [DocuSeal PSF activation](docuseal-psf-activation.md). Set `MCA_DOCUSEAL_PSF_CONNECTIONS_JSON` in the Vercel secret store and configure the signed callback URL `https://YOUR_APP_HOST/api/mca/closing/psf/webhook/WORKSPACE_ID` with `X-Docuseal-Signature`. Enable PSF delivery in the workspace only after the template is checked. In verified mode, a PSF request with prior generic webhook delivery history is blocked from further delivery and needs operator reconciliation. The provider response is independently fetched and signed documents and audit evidence must be scan-clean before `signed` is recorded. A callback lacking valid provider authentication or artifact evidence cannot establish signing.
4. A separate **contract** signature provider still needs a product-approved template and mapping to the exact offer revision, funder, merchant signer and signed document. There is no contract signature callback URL to configure yet; do not point a provider to the PSF callback. Until a reviewed contract-signing integration exists, use the documented manual evidence path and leave external contract signing unavailable.
5. Run the pilot in an approved nonproduction Supabase project with synthetic merchant data and approved recipients. Reconcile the offer revision, pitch, stipulation, contract delivery ID, private/ready signed document, final-review audit, single committed funding event, single advance, accounting payments/distributions, and renewal action. Repeat callbacks and funding requests; reconcile interrupted sends through provider activity before any retry with a new key. No cron schedule is required for this flow.

The verified-flow gate is deliberately opt-in. Existing live, manual and historical funding behavior remains in place while it is off. The pilot still needs real provider receipts, private Storage checks, UI/report reconciliation, and operator acceptance; local mocked tests do not establish those facts.

Follow-up requested September 8, 2026: complete the remaining closing tickets using Railway and Neon.

The verified release is live at **https://fundlane.io** and **https://www.fundlane.io**. Software, database, browser, scanner, and deployment checks are complete. The tickets below remain open for real provider evidence or the required product example.

## Infrastructure

- New Railway project `Fundlane`: `ebaeb3c7-36c9-4b29-926b-cdba0bf6f3d7`.
- Production environment: `39c0ed1d-5e2e-46c9-91d7-b35ea51e7632`; app service: `b848140b-e16f-44f1-9e1d-569c56b37a54`.
- Public service origin: `https://fundlane-production.up.railway.app`.
- Persistent volume `fundlane-documents`: `26f23357-1574-4428-a0e5-d7ef895f3f3f`, mounted at `/data`.
- Existing Fundlane Neon project `cool-pine-95841889`, production branch `br-aged-sun-aeqj80uv`, database `fundlane`.
- Created branch `br-still-brook-aebt5bxd` (`closing-release-verification`) from production. Applied all 11 checked Drizzle migrations successfully there, preserving the document count. Then applied the same migrations to production successfully. Production had zero document objects to transfer.
- Railway runtime secrets include pooled/direct database connections, the existing encryption key, freshly generated upload/artifact token secrets and public origin. Secret values are excluded from this report and deployment archives.
- Docker runtime uses Node 24, Next standalone output, a non-root application process and ClamAV. Antivirus signatures persist under `/data/clamav`; unavailable scanning never counts as clean.
- The older Open Mercato Railway demo is a different application and was preserved.

## Provider discovery

Postmark account access is valid. A live server and an existing confirmed sender are available; Fundlane's domain is not yet a verified Postmark sender domain. No SMS or signature-provider credentials are present in the application environment. The user has been asked for provider choices and controlled email/phone recipients for live verification; credentials should be configured through secret stores, not pasted into conversation.

## Verification

- Railway deployment `76662185-d297-46b6-b1e6-7580a1b67fb4` reached SUCCESS. The first deployment failed because an unanchored archive exclusion omitted source `data` directories; the exclusion now targets only root runtime data.
- Production smoke checks passed: public sign-in, unauthorized API rejection, existing administrator login/session, permission-consistent payment API response, Offers/Advances/Payments/Renewals page responses, and session revocation. Existing payment visibility settings were preserved.
- Actual Railway ClamAV verification: harmless clean text returned exit 0; standard EICAR test bytes returned exit 1 and `Eicar-Test-Signature FOUND`. Temporary verification files were removed.
- Two narrow typing repairs were needed in concurrently changed Kapitus/Headway adapters. Their focused suites passed 10/10. Local production build passed after repair.
- SMS migration `0011_perfect_mandarin.sql` adds five tables without dropping or altering existing tables; it passed on the release-verification branch before production application. All 12 migrations are now applied to production.

## Remaining provider evidence

Code and runtime verification is recorded below. A successful mock or generic webhook acknowledgment is not evidence of a real signature or delivered SMS.

MIC-111 still requires validation of its proposed recurring-distribution example before implementation. No schedule terms or financial document templates have been invented.

- Prepared two pending Postmark senders for merchant and submission purposes, using the existing confirmed identity. Exact per-workspace/sender bindings are stored in Railway secrets. No message was sent and neither sender was marked verified.
- Browser verification confirmed SMS account creation, required member assignment, masked identity, credential-absent state, and default selection in the disposable sandbox.

## Final local integration

- Direct DocuSeal PSF delivery is executable after exact workspace/template configuration. Durable provider history and a shared reservation lock prevent switching providers or duplicating requests on retries. Verified callbacks persist scan-clean signed documents and audit evidence before the signed transition.
- SMS settings, assigned sender routing, consent controls, immutable offer previews, and signed monotonic callbacks are connected. The final closing suite passed 7/7 after updating its synthetic Twilio credential fixture.
- Broad regression run: 245/246 passed. Its only failure was that fixture missing the newly mandatory webhook Auth Token; the corrected focused closing suite passed 7/7. See provider-full-tests.log and closing-integrated-final.log.
- Final schema generation reports no drift. The executable PSF integration adds no migration.
- Temporary browser databases and the task-created registered SSH key were removed. Provisioning files containing the temporary Postmark connection map were removed after the Railway secrets were saved.

- Final integrated verification: 55/55 focused tests passed across closing, Postmark, DocuSeal provider/orchestration/real Postgres, SMS, and sender connections. Production build and TypeScript passed. Lint passed with six warnings and no errors.
- Graphify refreshed the shared graph, report, and HTML: 7,703 nodes and 22,409 edges. Runtime secret directories are explicitly excluded.

## Verified Railway release

- Final deployment `8e354747-ea9a-4e43-ad2a-3d460d7543af` reached SUCCESS and supersedes the initial infrastructure release.
- Post-deployment smoke verification passed 12/12 checks at the Railway service origin, including email/SMS account APIs and the existing permission boundary.
- Canonical application origin is now `https://fundlane.io`; apex, www, and the Railway service origin are allowed for authenticated mutations. Both domains have verified Railway ownership and valid certificates. Authenticated application smoke checks passed 12/12 on each hostname using public DNS.

## Domain cutover

Vercel remains the registrar and DNS host. The prior Vercel project had no deployments and returned a 404; the apex was detached from that empty project only after Railway was serving it. Nameservers, CAA, default wildcard and mail-related records were preserved. No MX records existed.

- Apex ALIAS: `lslgwr28.up.railway.app`, record `rec_78231e0c32fb45af53d408ea`; ownership TXT record `rec_aa3e517b42d4baf85c642af0`.
- www CNAME: `wklgag5p.up.railway.app`, record `rec_d7df47ee565fa8286af65eec`; ownership TXT record `rec_ed5c91737e5747d83f30bb98`.
- Both Railway ownership checks are verified and certificates are VALID. Vercel flattens the apex ALIAS into A answers, so Railway's literal apex CNAME check still says requires-update. Authoritative DNS and Cloudflare/Google DNS resolve to Railway; HTTPS with normal hostname certificate validation succeeds.
- The workstation's cached resolver initially retained the old Vercel 404. The public-DNS smoke checks bypassed only that stale DNS cache, kept TLS verification enabled, and passed all 12 checks on both apex and www. Evidence preserves both the initial local-cache result and the successful public-DNS checks.

## Ticket status after verification

| Ticket | Status | Remaining requirement |
| --- | --- | --- |
| MIC-106 | In Progress | Authorized email recipient; verify the pending Postmark merchant sender and a real upload-request delivery. |
| MIC-108 | In Progress | Verify the pending submission sender and live contract delivery/evidence path. |
| MIC-157 | In Progress | Approved PSF template/bindings, API-enabled DocuSeal credentials and settings, and a controlled signing/evidence run. |
| MIC-168 | In Progress | Real email/SMS provider activation and controlled recipient/handset verification. |
| MIC-156 | In Progress | Live Twilio activation and remaining standalone composer scope beyond the verified offer-texting path. |
| MIC-111 | Backlog | Confirm or replace the proposed weekly-distribution example before implementing its schedule rules. |

Linear comments and the MIC-156 status were updated only after verification. Comment IDs are in `provider-linear-updates.json`. No real email, SMS, or signing request was sent during this work.

Local DNS follow-up: `dig` through the default resolver returns Railway, but macOS `getaddrinfo` still retains Vercel addresses. A nonprivileged cache flush did not clear them; refreshing mDNSResponder requires the local administrator password. No hosts-file or network settings were changed. Use the Railway service URL while that cache expires.

# Fundlane legal pages: evidence and attorney review

Prepared without attorney review. Michael Belenkiy approved publication on September 28, 2026 (19:20 ET) until a lawyer reviews them; production enables them with `MCA_LEGAL_DRAFT_PAGES_ENABLED=true`. Effective date: September 28, 2026. See [Issue #52](https://github.com/mbelenkiy29/fundlane/issues/52), [PR #175](https://github.com/mbelenkiy29/fundlane/pull/175) and superseded [PR #130](https://github.com/mbelenkiy29/fundlane/pull/130).

Operator: Sentinel Tech Solutions LLC, 7 Holly Hill Road, Marlboro, NJ 07746, mike@sentineltechsolutions.io.

## Ownership and scope

Draft copy lives in `src/lib/marketing/legal-drafts.ts`; presentation in `src/components/marketing/legal-draft.tsx`; gates and metadata in `src/app/terms/page.tsx` and `src/app/privacy/page.tsx`. `tests/legal-drafts.test.ts` verifies rendered routes. This note and `docs/marketing-site.md` complete the seven-file implementation scope. The existing `MCA_LEGAL_DRAFT_PAGES_ENABLED` accepts only `true`; unset is off. The flag-off approved website/demo notice is preserved.

## Practice-to-source evidence

| Practice | Source and drafting limit |
| --- | --- |
| Workspace access, roles and assignments | `src/lib/mca/supabase-auth.ts`, `policy.ts`; users see records according to membership and permissions. |
| Merchant and owner records | `src/lib/mca/deals/schema.ts`, `deals/repository.ts`; structured contact, identity, financing and notes fields are narrower than uploaded documents. |
| Submissions | `src/lib/mca/submissions/deliver.ts`, `submissions/outbox.ts`; customer-selected funders can receive packages by configured routes. |
| Subscriptions, seats and trials | `src/lib/mca/billing.ts`, `stripe-checkout-trial.ts`, `docs/supabase-billing.md`; Stripe Checkout, card or no-card trials, immediate paid increases and renewal reductions. |
| AI | `src/lib/mca/documents/extraction.ts`, `assistant/agent.ts`, `assistant/hosted-tools.ts`; OpenAI processing and conditional hosted tools do not establish provider retention or training terms. AI credit purchases are not currently offered. |
| Email, SMS and calendar | `src/lib/mca/senders/oauth.ts`, `sms/service.ts`, `sms/inbox.ts`, `calendar/google.ts`; connection and consent paths exist, but hosted HELP behavior needs verification. |
| Infrastructure and files | `src/lib/supabase/server.ts`, `src/lib/mca/db.ts`, `documents/storage.ts`, `closing/service.ts`; Supabase Auth/Postgres/private Storage and scoped merchant links. |
| Cookies and telemetry | `src/proxy.ts`, `supabase-auth.ts`, `src/components/ui/sidebar.tsx`, `src/components/theme-provider.tsx`, `operations/telemetry.ts`, `src/lib/observability/`, `src/components/observability/`; Sentry is inert without a DSN (see `docs/sentry-observability.md`); hosting-side analytics remain unconfirmed. |
| Exports, deletion and security | `src/lib/mca/exports/service.ts`, `assistant/store.ts`, `assistant/files.ts`, `crypto.ts`; scoped exports, selective deletion and selected-field encryption do not establish complete erasure or an archive. |
| Conditional providers | `documents/cloudmersive.ts`, `documents/verisys.ts`, `closing/docuseal-provider.ts`, `datamerch/client.ts`, `intake/providers.ts`; code paths do not prove deployment. |

## Section inventory

Terms: About these Terms; Eligibility and authority; The Fundlane service; Accounts, workspaces and authorized users; Customer data ownership and processing; Subscriptions, renewal and payment; Trials; Seats, proration and taxes; Email, SMS and calendar integrations; AI-assisted features; Acceptable use and broker compliance; Third-party services and funders; Suspension, termination and data export; Disclaimers; Limitation of liability; Governing law and venue; Changes and contact.

Privacy: Scope and contact; Our role and our customers’ role; Information we collect and its sources; How we use information; Merchant documents and upload links; Billing and payment information; AI and document analysis; Connected email and calendar accounts; SMS communications and choices; Recipients, service providers and subprocessors; Cookies, browser storage and analytics; Security and operational records; Retention, deletion and exports; US state privacy rights; US operations and children; Changes to this policy.

## Attorney review checklist

These items are not shown on the published pages; they are tracked here for counsel.

- [ ] Liability cap: published as fees paid in the 12 months before the event giving rise to the claim (common default chosen without counsel). Confirm cap amount, measurement period and carve-outs.
- [ ] [Attorney review: processor/service-provider contract terms and data processing addendum.]
- [ ] [Attorney review: federal jurisdiction, enforceability and mandatory-law exceptions.]
- [ ] [Attorney review: retention periods by data category, backup expiry and deletion procedures.]
- [ ] [Attorney review: post-termination export window, available formats and assistance process.]
- [ ] [Attorney review: deployed providers, contracting entities, processing locations and subprocessor roles.]
- [ ] [Attorney review: AI provider retention, training restrictions and applicable contractual settings.]
- [ ] [Attorney review: configured SMS HELP responses and hosted STOP/HELP verification.]
- [ ] [Attorney review: state-law applicability, request verification, response deadlines, authorized agents and appeals.]
- [ ] [Attorney review: sale, sharing, targeted advertising, sensitive-data uses and Global Privacy Control handling.]
- [ ] [Attorney review: hosting-side analytics and complete cookie/storage inventory.]
- [ ] [Attorney review: Sentry error monitoring, masked session replay and user feedback screenshots were added to "Recipients, service providers and subprocessors" and "Cookies, browser storage and analytics". Confirm the wording, Sentry's data processing terms and region, and whether the effective date or a change notice is required before enabling Sentry in production.]
- [ ] [Attorney review: material-change notice method and advance-notice period.]
- [ ] [Attorney review: proposed retention schedule — operational logs 30 days; assistant files 90 days; customer content deleted 90 days after account closure; billing, ledger and audit records 7 years; backups roll off within 30 days; legal holds suspend deletion.]

Core providers are Vercel, Supabase and Stripe. OpenAI, Twilio, useSend or a configured email receiver, Cloudmersive, Verisys and Sentry depend on configuration. Google and Microsoft mailboxes, Google Calendar/Drive, funders, DataMerch, DocuSeal, custom webhooks and intake providers can be customer-connected recipients. Supabase Auth SMTP, external webhook operators, legal entities, regions, contracts, hosting telemetry and actual deployed configuration remain unverified. Adapter presence alone is not evidence of activation.

The default billing mode pre-purchases seats. Removing a user leaves the paid count unchanged until an administrator reduces it; reductions take effect at renewal. Optional automatic seat assignment adds a paid seat when an accepted invitation exceeds purchased capacity. Paid additions are prorated and charged immediately; trial seat changes are free.

This change has no migration, provider activation or legal acceptance tracking.

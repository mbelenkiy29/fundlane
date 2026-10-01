# Owner portal release gates

This document covers the isolated owner-access, read-only queues/monitoring and inert SMS credit core batch. It is a release checklist, not deployment authorization. No production settings or grants have been changed.

## Reviewable scope

Existing platform grants, confirmed identity, same-session MFA and step-up remain authoritative. Mike and Ben have the same default email ceilings; a configured narrower ceiling requires a reviewed operator change. Legacy owner URLs must use the same guards even when redirecting. Tenant roles never create platform authority.

Read-only company and SMS queues return explicit operational fields. Sensitive documents, messages, deal contents, profile ciphertext and provider secrets stay outside the queue projection. Missing/stale monitoring must not read as healthy. No new notification recipients or scheduler are configured.

The SMS credit core activates no checkout, price, expiry/refund rule, number rental, send charging outcome, or incoming-message charge. Its storage remains independent of AI credits. Any additive migration requires separate review and controlled release; a code PR never applies it to a hosted database.

## Required before hosted activation

1. Record final commit, exact migrations and runtime grants; verify fresh and upgrade paths in disposable PostgreSQL.
2. Designate a nonproduction Supabase/Auth/Storage and Vercel target with synthetic owners and companies. Obtain explicit hosted-test authorization.
3. Verify Mike/Ben-equivalent synthetic identities, live grant revocation, same-session MFA, tenant/API-key denial, redirect behavior, and sensitive data exclusion through browser and direct API checks.
4. Inspect configured owner and SMS-approver ceilings without disclosing secrets; approve any needed configuration change separately. Never seed a grant automatically from email.
5. Verify narrow-screen and keyboard navigation, queue cursors/filters and monitoring request-failure/stale states in the authenticated preview.
6. Retain the independent review, local verification, exact-head CI status, and all skipped checks alongside the PR.

## Later gates

D1/D4 block provider registration/review changes; D2 blocks commercial SMS integration; D3 blocks multiple-number routing; D5/D8 block sensitive support and user mutations; D6 blocks new alerts; D7 blocks new purge schedules. Twilio eligibility and carrier approval require provider evidence, not internal approval. No unanswered question authorizes a default.

## Rollback and incident handling

Removing a navigation link must not restore weaker authorization on legacy URLs. Keep provider callbacks and existing safe recovery behavior intact. Additive credit records must not be deleted to revert code; do not automatically release numbers, close subaccounts, refund money or rewrite balances. New commercial endpoints are absent from this batch. Production incident actions continue through the existing reviewed runbooks.

## Migration coordination checkpoint

Main `b71f40b1c4dbb73fa48fba444e6b2c36e72ee422` contains notification foundation `0071`, browser voice `0072` (PR #213), and document notification discovery `0073` (PR #219). PR #225 adds no migration. Dependent draft PR #226 carries the ledger. Ledger `0074_sms_credit_ledger` follows that exact history at journal index 65 and timestamp `1790819000073`, after `0073` at index 64 / `1790819000072`. The upgrade test builds the baseline through `0073`, preserves seeded voice, document-notification, provider, audit and AI data, applies the ledger through Drizzle, and proves replay is a no-op. Fresh-schema and runtime-grant checks also run only against disposable PostgreSQL.

Before hosted application, compare the reviewed branch with the then-current main journal again; tags, indexes and timestamps must remain unique and strictly ordered. Preserve the shared runtime grant helper's notification, voice and SMS exceptions. A higher filename alone does not determine Drizzle execution order. No hosted migration or activation is authorized by this proof.

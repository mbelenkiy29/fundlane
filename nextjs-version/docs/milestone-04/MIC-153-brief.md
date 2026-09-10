# MIC-153 brief — Submission email templates

**Linear:** https://linear.app/michael-belenkiy/issue/MIC-153
**Depends on:** MIC-166, MIC-174

## Exclusive files

- `src/lib/mca/submissions/email-templates.ts`
- `src/app/api/mca/submissions/email/**`
- `src/components/mca/submissions/email-preview.tsx`
- `tests/submissions-email.test.ts`
- `docs/milestone-04/MIC-153-report.md`
- `docs/milestone-04/MIC-153-acceptance.md`

Table `mca_submission_templates` exists. Import `assertSenderUsable` from `src/lib/mca/senders/service.ts`.

## Rules

- Per-funder subject/body using deal fields, workspace prefix, funder prefix, sender signature.
- Preview recipient, CC, reply-to, attachments before send. Preserve Message-ID / thread metadata on the attempt row (`external_ref`).
- Originator/closer CC flags on the template, separate from merchant follow-up.
- Immutable sent content stored on the attempt (redact secrets). Signature/prefix changes do not rewrite old attempts.
- Two funders receive separately addressed packages with no cross-exposed recipients.

## Tests

Two funders, distinct To/CC. Prefix change does not alter stored prior attempt. Unauthorized sender id 403. Preview without live SMTP.

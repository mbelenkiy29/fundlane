# MIC-156 brief — SMS account routing and direct merchant texting

Read this first. Exact values are verbatim.

**Linear:** https://linear.app/michael-belenkiy/issue/MIC-156
**UUID:** `072db59d-6561-4bb8-9f10-b89fdf951496`
**Depends on:** MIC-97, MIC-91 (done)
**Status:** already In Progress. Complete remaining scope. Do not rewrite working Twilio routing.

## Exclusive files

- `src/lib/mca/sms/service.ts`
- `src/lib/mca/sms/http.ts`
- `src/components/mca/sms/composer-panel.tsx`
- `src/app/api/mca/sms/messages/**` (composer UX wiring only if needed)
- `tests/milestone06-sms-composer.test.ts`
- `docs/milestone-06/MIC-156-report.md`
- `docs/milestone-06/MIC-156-acceptance.md`

Do not edit `sms/contracts.ts`, `sms/adapters/registry.ts`, `sms/twilio.ts`, `schema.ts`, `deals-workspace.tsx`, `settings/connections/page.tsx`. No git. No subagents. Do not mark Linear Done.

## Frozen behavior

- Keep existing Twilio env JSON (`MCA_SMS_TWILIO_ACCOUNTS_JSON`) and `tests/milestone05-sms.test.ts` green.
- Persist `provider` from the account row (no longer hard-code `'twilio'` on every insert). Route sends through `getSmsAdapter(provider)` from `sms/adapters/registry`.
- Deal-level composer UI: preview, assigned-account picker, consent gate, recent thread. Loading/empty/validation/success/failure.
- A rep cannot send through an unassigned account (403 `sms_account_not_assigned`).
- An opted-out merchant is blocked from outreach.
- Recipient must still match the deal mobile number.
- Conductor mounts the composer on the deal panel after review.

## Acceptance

- Rep cannot send through an unassigned account.
- Opted-out merchant is blocked.
- Realistic synthetic composer scenario with expected output.
- Loading, empty, validation, success and failure states; retries preserve message identity.
- Direct API permissions match the UI. Logs exclude secrets.

Remaining gate: live Twilio / handset. Do not send real SMS.

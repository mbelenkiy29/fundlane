# MIC-154 brief — Manual funder reminders in the original email thread

**Linear:** https://linear.app/michael-belenkiy/issue/MIC-154
**UUID:** `27121a80-09fe-4074-83b3-bea51dc95037`
**Depends on:** MIC-153 (done)

## Exclusive files

- `src/lib/mca/comms/reminders.ts`
- `src/app/api/mca/comms/reminders/**`
- `src/components/mca/comms/remind-funder.tsx`
- `tests/milestone06-reminders.test.ts`
- `docs/milestone-06/MIC-154-report.md`
- `docs/milestone-06/MIC-154-acceptance.md`

Do not edit submission job status, `email-templates.ts`, or `deals-workspace.tsx`. Use `mca_funder_reminders`. No git. No subagents. Do not mark Linear Done.

## Frozen behavior

- Remind Funder only for eligible **email** submissions with no response.
- Prefill editable workspace reminder text and preview original recipients and sender.
- Use original thread headers when stored; disclose fallback when metadata is missing.
- Accepted send updates `last_reminded_at` and does **not** change submission status.
- API / portal / webhook jobs have no reminder control.

## Acceptance

- An API submission has no unsupported email-thread reminder button.
- A reminder preserves submission status and records delivery separately.
- Synthetic scenario, UI states, API permissions, no secrets in logs. No live funder email.

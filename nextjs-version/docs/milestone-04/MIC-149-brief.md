# MIC-149 brief — Read-only funder reply ingestion

**Linear:** https://linear.app/michael-belenkiy/issue/MIC-149
**Depends on:** MIC-121, MIC-153

## Exclusive files

- `src/lib/mca/submissions/replies.ts`
- `src/app/api/mca/submissions/replies/**`
- `src/components/mca/submissions/reply-queue.tsx`
- `tests/submissions-replies.test.ts`
- `docs/milestone-04/MIC-149-report.md`
- `docs/milestone-04/MIC-149-acceptance.md`

Table `mca_funder_replies` exists.

## Rules

- Opt-in mailbox ingestion. Cursor checkpoints. 15-minute fallback polling is a documented interval constant, not a live cron (expose `POST /api/mca/submissions/replies/run` for the worker).
- Read messages **without** changing unread/labels/deletion.
- Authorized reply-domain aliases per funder (funder.domains). Correlate Message-ID/thread before fuzzy match.
- Ambiguous / unrecognized → `pending_review`. Replay of provider_message_id is idempotent.
- Live mailbox OAuth is a remaining gate; tests inject a fixture mailbox.

## Tests

Separate-thread reply linked with evidence. Replay no duplicate. Flags unchanged (fixture spy). Intake 403.

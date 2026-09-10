# MIC-149 report — Read-only funder reply ingestion

**Status:** DONE locally with a fixture mailbox. Live Google/Microsoft mailbox OAuth is an external gate.

## Contract

Opt-in mailbox ingest lives in `src/lib/mca/submissions/replies.ts`. Workers call `POST /api/mca/submissions/replies/run`; `REPLY_INGEST_INTERVAL_MS` is `900000` (15 minutes) and is **not** a live cron.

Reads are mailbox-list only. The ingest path never calls mark-read, unread, label, move, archive, or delete. Tests inject `setReplyMailboxForTests` and spy those mutations.

Cursor checkpoints persist per sender on a reserved `mca_funder_replies` row (`provider_message_id = mca:mailbox-checkpoint:v1`), including `optedIn`, `cursor`, `lastRunAt`, and `lastError`. Replay of the same `(workspace_id, sender_id, provider_message_id)` returns the existing row and does not insert a duplicate.

Correlation order: Message-ID / In-Reply-To / References / thread id first, then authorized `funder.domains` aliases, then subject/display-id fuzzy match. Unique separate-thread domain matches store reviewable evidence (`method: "domain"`). Ambiguous or unrecognized mail is `pending_review`. Bodies are AES-GCM `body_cipher` with workspace AAD; list JSON returns `bodyPreview` only.

Permissions: GET `deals:read`. POST `/run` and PATCH review `deals:write`. Opt-in (`enabled`) is interactive admin. `intake:write` is 403. Cross-workspace deal ids are 404. JSON omits credentials and `body_cipher`.

`GET /api/mca/submissions/replies?dealId=` feeds `ReplyQueue`. PATCH `/api/mca/submissions/replies/[id]` links or ignores while preserving record identity.

## Tests

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/submissions-replies.test.ts
```

2/2 passed.

Covered: separate-thread reply linked with domain/subject evidence and stored Message-ID left unmatched; replay same `provider_message_id` keeps one row and the same id; fixture spy records zero flag mutations; ambiguous same-domain two-deal mail and unrecognized From → `pending_review`; manual link preserves id; intake GET/POST 403; `deals:read` GET 200; `deals:read` PATCH 403; `deals:write` ignore; cross-workspace 404; live mailbox 503 `mailbox_oauth_not_configured`; no SMTP password / `credentialCipher` / `body_cipher` in JSON.

## Files

- `src/lib/mca/submissions/replies.ts`
- `src/app/api/mca/submissions/replies/route.ts`
- `src/app/api/mca/submissions/replies/run/route.ts`
- `src/app/api/mca/submissions/replies/[id]/route.ts`
- `src/components/mca/submissions/reply-queue.tsx`
- `tests/submissions-replies.test.ts`
- `docs/milestone-04/MIC-149-acceptance.md`
- `docs/milestone-04/MIC-149-report.md`

Did not edit `senders/**`, `email-templates.ts`, `schema.ts`, drizzle, or `deals-workspace.tsx`.

## Remaining gates

Live mailbox OAuth. MIC-121 senders only request `gmail.send` / `Mail.Send`; this ticket does not add read scopes. Fixture `setReplyMailboxForTests` is not production inbox readiness. SMTP/SendGrid cannot host a mailbox.

## Handoff

Mount `ReplyQueue` on the deal Submissions tab. Pass `dealId`. MIC-122 should read matched replies via `getReply` / `listReplyQueue` (decrypted `body` on GET by id).

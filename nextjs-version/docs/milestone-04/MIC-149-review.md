# MIC-149 review — Read-only funder reply ingestion

**Spec:** PASS
**Quality:** Approved (Minor)

Live Google/Microsoft mailbox OAuth remains an external gate. Fixture `setReplyMailboxForTests` is not production inbox readiness. SMTP/SendGrid cannot host a mailbox. Do not mark Linear Done from this review.

## Spec

| Requirement | Result | Evidence |
| --- | --- | --- |
| Opt-in ingest; cursor checkpoints; 15-minute interval constant, not a live cron | Pass | `REPLY_INGEST_INTERVAL_MS = 900000` (`replies.ts:20-21`). Worker is `POST /api/mca/submissions/replies/run` (`run/route.ts`). Opt-in `{ senderId, enabled: true }` is admin (`1010-1036`); unopted sender is 422 (`1041`, test `305-309`). Checkpoint on reserved `provider_message_id = mca:mailbox-checkpoint:v1` (`23`, `424-446`). No in-process cron (`grep` only interval + `/run`). |
| Read-only mailbox: no unread / label / delete | Pass | `ingestSender` calls only `listMessages` (`837-844`). Mutation methods exist on the interface (`94-100`) and are never invoked. Fixture spy `mutations` stays `[]` after two runs (`tests/submissions-replies.test.ts:87-100`, `373-374`, `417`). Evidence `flagsUnchanged: true`. |
| Message-ID / thread before `funder.domains` fuzzy match | Pass | `correlate` returns on unique `threadHits` (In-Reply-To / References / thread id vs stored `external_ref`) before domain (`609-667`, `569-588`). Domain + unique job or unique subject score is `method: "domain"` (`688-741`). Separate-thread fixture: different `threadId`, no In-Reply-To; `matched` with `method: "domain"`, notes that Message-ID/thread missed then alias + `displayId` hit (`294-301`, `337-342`). |
| Ambiguous / unrecognized → `pending_review` | Pass | Multi-hit thread or non-unique domain+subject → `pending_review` / `ambiguous` (`648-665`, `744-761`). Unknown From domain → `unrecognized` (`670-685`). Test: two Alpha jobs + generic subject `pending_review` with both deal ids; `noreply@not-a-funder…` unrecognized and omitted from deal-scoped queue (`378-433`). |
| Replay of `provider_message_id` is idempotent | Pass | Unique `(workspace_id, sender_id, provider_message_id)` (`schema.ts:1497`; drizzle `0006`). `INSERT … ON CONFLICT DO NOTHING` returns the existing id (`801-825`). Second `POST /run`: `createdCount: 0`, `replayedCount: 1`, same id, one row (`357-372`). Manual link keeps id (`436-445`). |
| `intake:write` 403; GET `deals:read`; PATCH `deals:write`; secrets omitted | Pass | `requireReplyRead` / `requireReplyWrite` scopes (`246-262`). Intake GET/POST 403; `deals:read` GET 200 / PATCH 403; `deals:write` ignore 200; cross-workspace deal 404 (`453-480`). `assertNoSecret` forbids SMTP password / `credentialCipher` / `body_cipher`. List JSON is `bodyPreview` only; GET by id decrypts body (`374-395`, `344-345`, `351-355`). Bodies AES-GCM + workspace AAD (`crypto.ts:42-56`, `800`). |
| Loading / empty / validation / success / failure UI | Pass | Loading copy, dashed empty state, job-required link check, ingest/link/ignore success, request/503 alert (`reply-queue.tsx:118-174`, `196-250`). Conductor mounts `ReplyQueue` on the deal Submissions tab (`deals-workspace.tsx:255`). |

Exclusive files match the brief: `replies.ts`, `src/app/api/mca/submissions/replies/**`, `reply-queue.tsx`, `tests/submissions-replies.test.ts`, report, acceptance. Table `mca_funder_replies` already exists.

## Quality

Approved. Minor only:

1. Positive Message-ID / In-Reply-To / stored-thread hit is implemented (`threadHits` → `method: "message_id" \| "thread"`) but the fixtures only cover the miss-then-domain path. Order is asserted via notes, not a stored `rfcMessageId` round-trip.
2. A unique authorized domain with a single sent job auto-matches even with no subject/display-id hits (`690-713`). Documented; still aggressive once a funder has exactly one email job.
3. Checkpoints are `state: "processed"` rows on `mca_funder_replies`. List/get exclude the reserved id (`406-421`); MIC-122 must use `listReplyQueue` / `getReply`, not raw `processed` scans.
4. `flagsUnchanged` is a compile-time constant on evidence/run JSON, not a mailbox-adapter assertion. The test spy is the real proof.
5. `requireReplyAdmin` is unused. Opt-in is `deals:write` + `isAdmin` inside `runReplyIngest`; API keys have `role: null` so they cannot opt in (untested).
6. `getReply` maps `created: true`, so `replayed` is false on GET-by-id. After reload, list rows also omit the run-response replay flag (`374-392`, `918`).
7. Unscoped GET lists unmatched `pending_review` (including unrecognized From) to any `deals:read` actor (`893-895`, `921-925`). Deal-scoped queue correctly hides unrecognized.
8. Report “Did not edit `deals-workspace.tsx`” is consistent with exclusive files; `ReplyQueue` is already mounted (conductor).

No Critical or Important defects on the exclusive surface.

## Unverified claims

- **2/2 passed:** two `test("MIC-149:…")` cases match the report/acceptance; this review did not re-execute Postgres.
- **Did not edit `senders/**` / `email-templates.ts` / `schema.ts` / drizzle:** current `parseEmailAttemptRef`, unique constraint, and funder `domains` match the handoff; the repo has no git, so in-place rewrites cannot be proven.
- **Live mailbox OAuth / Gmail or Graph read:** not production-verified (documented remaining gate). MIC-121 send scopes (`gmail.send` / `Mail.Send`) are not read scopes.

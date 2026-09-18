# Conversational assistant (version 2)

The sidebar `/assistant` tab is the read-only ChatKit workspace. The embedded deal panel still uses this write-capable agent, with the same permissions, credits and approved delivery services. That deal-panel experience supports ordinary conversation, writing, real activity events, provider-supplied reasoning summaries, Markdown, public web citations, private profile preferences, file uploads, file generation and revisions. It does not expose raw chain of thought or simulate progress.

## Configuration and rollout

Apply `0022_assistant_experience` with the checked Drizzle runner before enabling:

```dotenv
MCA_ASSISTANT_ENABLED=true
MCA_ASSISTANT_EXPERIENCE_ENABLED=true
MCA_ASSISTANT_WEB_ENABLED=true
MCA_ASSISTANT_FILES_ENABLED=true
MCA_ASSISTANT_MODEL=gpt-5-mini
OPENAI_API_KEY=<server-side secret>
MCA_DOCUMENT_STORAGE_PATH=/data/documents
MCA_DOCUMENT_SCANNER=clamscan
MCA_DOCUMENT_SCANNER_COMMAND=/usr/local/bin/fundlane-scan
```

All new feature flags default to false. Keep the existing server-side OpenAI key/model; no browser key or new subscription is needed. For local development save configuration in the ignored `.env.local`. Production secrets belong in the hosting platform's environment settings. Scanning must work before uploads or generated downloads can be published. Scanner failure leaves the request's file unavailable; it never silently skips scanning.

Migration 0022 was rehearsed on production child `br-morning-poetry-aeddbdn4` and applied to `fundlane` on `br-aged-sun-aeqj80uv`, project `cool-pine-95841889`, September 10, 2026. Verified its Drizzle hash, nine additive tables, the unique active-run index including `awaiting_input`, and unchanged business-record counts. No historical requests receive credits or charges.

## Conversations, memory and questions

Conversations remain private to a user and company. Titles default to the first request and can be renamed. Search scans titles and the most recent 100 messages in each page of 50 permitted conversations; load more to search older pages. Message history loads 100 messages initially, then pages of 50. Deleting a conversation cancels its active work, clears its chat/state/preview content, disables recall of that source, tombstones learned preferences from it and queues file removal. Existing business activity remains in normal deal records. Database backups retain their configured retention lifecycle.

Each model request receives at most 20 recent messages within a 48,000-character budget, plus an encrypted extractive summary of older context (at most 8,000 characters). Cross-chat recall searches the 50 most recent accessible conversations, returning at most five bounded excerpts. These excerpts are historical evidence; the agent must read current deal records again. Deal provenance is carried into conversations and files, and current access is rechecked on reads, recall, tools, approvals and downloads.

Memory stores one editable preference per category: writing style, format, terminology and workflow. Learning requires an exact quote from the current user's request, rejects sensitive data, and cannot learn from document or web instructions. Settings changes increment a version so an in-flight request cannot recreate removed preferences. Deletion tombstones stop automatic relearning for that category until the user adds a preference manually. Disabling memory also disables cross-conversation recall; it does not erase chat history. Admin usage reports do not expose these preferences or chats.

`ask_user` uses SDK interruptions with a separate persisted question record. The answer endpoint claims the pending question atomically, binds the exact run/call, stores the user's answers, and resumes with `RunState.addInput`. Only that question interruption is approved. It never approves an outbound message or submission. Replies continue the original paid request at zero balance and incur no additional credit. A later independent request or file revision costs a new credit. Duplicate answers are rejected without execution or another charge.

## Files and research

Supported inputs are PDF, DOCX, XLSX, CSV, PPTX, Markdown, TXT, PNG and JPEG. Supported generated documents are PDF, DOCX, XLSX, CSV, PPTX, Markdown and TXT. Every file has a private preview/download card; Office previews show extracted text or tables rather than a full layout renderer. The original file remains downloadable. Revisions create a new immutable version with a parent reference.

The file tool uses an isolated OpenAI Code Interpreter container with 1 GB memory and network access disabled. It receives only the selected files and authorized task data. App credentials, database connections and business mutation tools are unavailable inside that container. Outputs are retrieved using the Responses container-content API, downloaded under a hard byte limit (even when provider metadata omits size), format-validated, scanned, encrypted with workspace utilities and saved on the app's durable volume before a download card is emitted. Local storage uses random immutable keys; filenames cannot control paths.

Limits per paid request are 12 total model calls, four public research call slots, eight Code Interpreter call slots, five minutes of active execution, five inputs (25 MB each / 50 MB combined) and ten outputs. Each hosted provider response reserves its maximum call budget before execution: one for research or up to four for file work. Unused slots are conservatively consumed, including on cancellation, to prevent retries exceeding the limit. Hosted responses have an 8,000-token output cap and bounded returned text. Included and purchased credits remain request-based; provider tokens are recorded separately.

Each user/company has a 500 MB logical file quota, reserved under a membership row lock. Every upload and output expires after 90 days; the chat and expired-file card remain. Expired or deleted files cannot be reattached, previewed or downloaded. Quota errors, partial generation and scan failures preserve previously saved valid outputs. Office validation rejects macros, external relationships, unsafe archives and active embedded content. Research uses public-only queries, excludes common private identifiers and secrets, and requires returned source citations before presenting research as verified.

## APIs and recovery

Existing message commands accept optional `attachmentIds`. New commands use `{ action: "answer", conversationId, questionId, requestId, answers }`. New routes:

- `GET/PATCH/DELETE /api/mca/assistant/conversations/[id]` and `GET .../[id]/messages?before=...`.
- `GET /api/mca/assistant/events?conversationId=...&runId=...&after=...` replays up to 500 persisted events with monotonic per-run sequence numbers.
- `GET/PATCH /api/mca/assistant/memory` manages private preferences.
- `GET/POST /api/mca/assistant/files` lists private recent files or uploads a bounded multipart file.
- `GET/DELETE /api/mca/assistant/files/[id]`; `?preview=1` returns safe preview data.

Mutations use trusted-origin checks, strict schemas and current Clerk/Neon authorization. Streams persist deltas, activity and file events before emission; saved status reconstructs interrupted output. Polling and history reads are free. Closing a panel, navigation, page close or cancellation stops subsequent tool work; already accepted delivery jobs keep their existing lifecycle. Uncertain external delivery is never automatically retried.

The durable maintenance worker expires paused requests, releases unused reservations, handles account alerts, deletes expired files, and cleans up orphaned OpenAI containers. Cleanup operations use database leases and up to eight bounded retries; monitor `mca_assistant_cleanup.state='failed'` for operator intervention. Local command: `pnpm assistant:worker`. Docker builds a standalone worker bundle and supervises it with the web process on the same persistent volume. If either exits unexpectedly, the container exits for platform restart. This is maintenance, not background conversational delegation. Other deployment environments must supervise the worker and mount the same storage; `after()` alone is insufficient.

## Verification

```sh
node --experimental-test-module-mocks --conditions=react-server --import tsx --test --test-concurrency=1 tests/assistant.test.ts tests/assistant-credits.test.ts tests/assistant-experience.test.ts
pnpm typecheck
pnpm lint
pnpm build
node scripts/assistant/build-worker.mjs
pnpm exec 21st review src/components/mca/assistant src/components/ui/ai-agent-response.tsx
```

An opt-in live test uses a disposable Neon fixture database, synthetic content and the existing configured model. Configure a real scanner, then run with `MCA_ASSISTANT_LIVE_SMOKE=true`, Node's `--env-file=.env.local`, and `--test-name-pattern='live synthetic provider'`. `MCA_ASSISTANT_LIVE_SCOPE=general|research|files|uploads` selects a capability. It makes real provider requests and deletes its fixture database and local files afterward.

Live checks on September 10 passed for ordinary chat, saved writing preferences, cited web research, seven scanned document formats, and an uploaded instruction-injection fixture that caused no business changes, preference writes or delivery. Fixture checks cover question resumption at zero, duplicate answers, budgets, encryption, memory deletion, tenant access, source recall, quotas, scanner failure, active Office content, expiry, event replay and cancellation. Stripe and account-email readiness remain separate from these OpenAI checks; see [the original assistant guide](./deal-assistant.md).

The combined regression run finished with 50 passed, zero failed, and one opt-in live test skipped; the live capabilities above were executed separately. Typecheck, production build and worker bundling passed. Repository lint reported zero errors and 16 existing warnings outside the assistant; the 21st UI review reported zero findings. Graphify's graph, community report and HTML were refreshed.

The signed-in demo also passed a real attachment → follow-up question → DOCX flow using keyboard submission. Its answer continued the same paid request, reducing the balance from nine to eight credits only once. The generated “Demo Weekly Plan.docx” preview contained the requested title and original synthetic plan, and its download returned a valid 36,729-byte DOCX. Renaming the saved chat and reloading its history worked. Desktop and 390-pixel mobile checks showed no horizontal overflow or browser errors. No business records, merchant messages or submissions were changed by that demo.

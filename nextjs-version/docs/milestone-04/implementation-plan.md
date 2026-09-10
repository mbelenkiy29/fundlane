# Milestone 04 — Submissions and integrations

> **For agentic workers:** REQUIRED: one implementer subagent per Linear ticket, dispatched in dependency waves. This session is the senior conductor: it freezes contracts, owns shared files, reviews each wave, independently verifies, then marks Linear **Done**. Do not start 33 editors at once.

**Goal:** Deliver all **33** Linear tickets in milestone **04 Submissions and integrations** on the MCA Next.js app, then verify and mark each issue Done with honest remaining gates.

**Architecture:** A shared submission ledger plus four transports (email, funder API, manual portal, custom webhook), outgoing-document transforms, reply ingestion, and 20 isolated funder adapters. Ticket agents own exclusive files. The conductor owns schema/migrations, frozen ports, shared mounts (`deals-workspace.tsx`, settings connections, `/submissions` route, adapter registry, `package.json`).

**Tech stack:** Next.js App Router, Neon Postgres + Drizzle, existing `DealActor` / document vault / funder directory / underwriting analysis, `pdf-lib`, AES-GCM secrets (`encryptSensitive`), pnpm, `node:test`.

**Spec:** Live Linear issues on project [MCA](https://linear.app/michael-belenkiy/project/mca-1e94b0617388), milestone `04 Submissions and integrations` (`62ffece6-c771-417f-99d1-13fa28a01240`). Local pattern: `nextjs-version/docs/milestone-03/implementation-plan.md`.

**Workspace:** `/Users/mbele/Desktop/mca` is **not a git repository**. Isolation is exclusive file ownership, not worktrees.

---

## Scan result (Linear, 2026-09-08)

Milestone progress is **0%**. All 33 issues are **Backlog**, team **Michael Belenkiy** (`MIC`), medium priority.

### Platform (13)

| ID | Title | Blocked by | Blocks |
| --- | --- | --- | --- |
| [MIC-121](https://linear.app/michael-belenkiy/issue/MIC-121) | Email sender connections, verification and reconnect | MIC-97 (done) | MIC-166, MIC-149, plus M5/M6 mail tickets |
| [MIC-166](https://linear.app/michael-belenkiy/issue/MIC-166) | Multi-funder selection, preflight and independent jobs | MIC-121, MIC-192, MIC-169, MIC-91 | MIC-174, MIC-178, MIC-171, MIC-153, MIC-124 |
| [MIC-174](https://linear.app/michael-belenkiy/issue/MIC-174) | Duplicate blocking and controlled retry (2 min / 24 h) | MIC-166 | MIC-124, MIC-153 |
| [MIC-178](https://linear.app/michael-belenkiy/issue/MIC-178) | Manual portal tasks and custom webhook submission | MIC-166 | — |
| [MIC-171](https://linear.app/michael-belenkiy/issue/MIC-171) | Destination funder stamps on outgoing statements | MIC-166, MIC-169 | MIC-162 |
| [MIC-162](https://linear.app/michael-belenkiy/issue/MIC-162) | Broker logo watermarks | MIC-171 | MIC-160 |
| [MIC-153](https://linear.app/michael-belenkiy/issue/MIC-153) | Submission email templates, signatures, prefixes, rep CC | MIC-166, MIC-174 | MIC-149, MIC-160 |
| [MIC-124](https://linear.app/michael-belenkiy/issue/MIC-124) | Funder API adapter framework and credential environments | MIC-166, MIC-174 | MIC-113 + all 20 adapters |
| [MIC-113](https://linear.app/michael-belenkiy/issue/MIC-113) | API status polling, webhook ingestion, offer reconciliation | MIC-124 | all 20 adapters |
| [MIC-149](https://linear.app/michael-belenkiy/issue/MIC-149) | Read-only funder reply ingestion and sender-domain mapping | MIC-121, MIC-153 | MIC-122 |
| [MIC-160](https://linear.app/michael-belenkiy/issue/MIC-160) | Manual/automatic PDF compression with size gates | MIC-153, MIC-162 | — |
| [MIC-122](https://linear.app/michael-belenkiy/issue/MIC-122) | AI approval, decline, and stipulation extraction | MIC-149 | MIC-128 |
| [MIC-128](https://linear.app/michael-belenkiy/issue/MIC-128) | Offer-link extraction with manual fallback | MIC-122 | — |

### Direct funder adapters (20) — all blocked by MIC-124 **and** MIC-113

MIC-123 Expansion Capital Group · MIC-126 Kapitus · MIC-127 Fintegra · MIC-129 Quantum Lends · MIC-130 Channel Partners Capital · MIC-131 Forward Financing · MIC-132 Fundomate · MIC-133 Rapid Finance · MIC-134 Headway Capital · MIC-135 Plexe · MIC-136 Fora Financial · MIC-137 Idea Financial · MIC-138 PEAC Solutions · MIC-139 CAN Capital · MIC-140 Bitty Advance · MIC-141 Lendini · MIC-142 Lendr · MIC-143 Everest Business Funding · MIC-144 OnDeck · MIC-145 Credibly

### Current code (starting point)

- `queueSubmissions` in `src/lib/mca/underwriting/submission-port.ts` always returns `{ ok: false, code: "submission_unavailable" }`. MIC-148 `automatic_send` is fail-closed on that port.
- Funder routes already exist: `email | api | manual_portal | custom_webhook` (`src/lib/mca/funders/contracts.ts`).
- `deal_submissions` / `deal_offers` are display stubs (`id, workspace_id, deal_id, funder_name, status`). New matching uses **funder IDs**.
- Email today is webhook/preview only (`MCA_EMAIL_WEBHOOK_URL`). No Google/Microsoft/SMTP sender store.
- `/submissions` is a placeholder. Settings → Connections has intake/import/Data Merch only.
- DB is **Neon Postgres**. Schema changes go through Drizzle (`pnpm db:generate` / `pnpm db:migrate`). Conductor owns migrations.
- Existing MIC-148 tests assert `submission_unavailable`. After MIC-166, conductor updates analysis state mapping and those tests.

```
MIC-97 ✓ ──► MIC-121 senders
MIC-192 ✓, MIC-169 ✓, MIC-91 ✓, MIC-121
                 └──► MIC-166 jobs
                          ├──► MIC-174 duplicates ──► MIC-124 framework ──► MIC-113 poll/webhooks
                          │                                              └──► 20 adapters
                          ├──► MIC-153 email templates ──► MIC-149 replies ──► MIC-122 extract ──► MIC-128 links
                          ├──► MIC-178 portal + webhook
                          └──► MIC-171 stamps ──► MIC-162 watermarks
MIC-153 + MIC-162 ──► MIC-160 compression
MIC-148 ✓ already calls queueSubmissions (conductor remounts success path)
```

---

## Why not 33 agents at once

Tickets share schema, the submit path, package transforms, and Linear honesty rules. Parallel editors on `schema.ts`, `submission-port.ts`, or `deals-workspace.tsx` will collide. Milestone 03 succeeded with exclusive paths and waves. This plan keeps **one implementer per ticket** and runs them in **seven waves** so dependents consume frozen APIs.

Max parallel implementers: **3** on platform waves, **5** on adapter waves (disjoint `adapters/<slug>/` trees).

Ticket agents **never** spawn reviewers or sibling implementers. Reviewers are read-only.

---

## Team

| Agent | Role |
| --- | --- |
| **Conductor (this session)** | Senior engineer. Wave 0 contracts + migration. Exclusive-file audit. Shared mounts. Wave review. Full `pnpm test && pnpm typecheck && pnpm lint`. Browser verification. Linear In Progress / comments / Done. |
| **Implementer MIC-\*** | One `general-purpose` subagent per ticket. Isolation `none`. Exclusive files only. Writes `docs/milestone-04/<id>-brief.md` is conductor-owned; agent writes `<id>-report.md` + `<id>-acceptance.md`. |
| **Reviewer MIC-\*** | Fresh read-only `explore` (or general-purpose read-only) after implementer DONE. Spec + quality on that ticket’s diff only. |

---

## Rulings (frozen before dispatch)

1. **Follow the Linear DAG.** MIC-121 is in M4 (M3 docs that called it M6 are stale). MIC-166 does not start until MIC-121 is review-clean, because email is a first-class transport.
2. **Local fixture success can be Linear Done** when the only remaining gap is commercial provider access or live OAuth, **if** the Linear comment lists the gate in the same words as M2/M3 (Zoho / Data Merch honesty). Mock HTTP that claims a live funder accepted a merchant application is forbidden.
3. **No live merchant submissions, no provider outreach, no copying MCA Pilot endpoints or sample credentials.** Adapters implement the shared contract against **synthetic fixtures** derived from public docs. Capability flags stay honest (`submit`, `status_poll`, `webhooks`, `offers`).
4. **One rejected destination does not stop valid destinations.** Jobs are independent. Outbox + unique attempt keys. Replay of the same confirmation creates no second external request.
5. **Duplicate policy is atomic** across UI, API, and background senders: 2-minute error-retry block, 24-hour active-submission block, privileged reasoned retry. Clock is injectable (`nowIso` test hook). Concurrent submits → one accepted attempt.
6. **Opening a portal URL does not mark submitted.** Manual work stays `pending_portal` until a rep confirms. Webhook failure ≠ portal complete.
7. **Document pipeline order:** original (immutable) → destination stamp (MIC-171) → watermark (MIC-162) → compression (MIC-160). Funder exclusions skip a stage and still send an allowed derivative. Original checksum never changes.
8. **Unknown is not invented.** Approval without terms does not fabricate amounts. Unknown API statuses stay visible with the raw provider value. Inaccessible offer links become manual-review offers. Private-network / SSRF URLs are rejected before fetch.
9. **Mailbox ingestion is read-only.** No read/unread, label, or delete mutations. Replay is idempotent.
10. **Secrets:** AES-GCM via existing `encryptSensitive`, workspace-scoped, never logged. Dev and production credential slots are isolated; production cannot fall back to test endpoints or another tenant.
11. **Permissions:** sender/adapter/template config = `admin` / `super_admin`. Submit, retry, portal confirm, reply review = `deals:write`. Reads = same as the deal (`deals:read`). Direct API matches UI. `intake:write` is 403 on these routes.
12. **`deal_submissions.funder_name` remains a display cache.** New rows also store `funder_id`. Analysis `automatic_send` must call the real queue after MIC-166; conductor updates MIC-148 tests from `submission_unavailable` to queued/independent-job outcomes.
13. **Offers in M4 are persistence + reconciliation only.** Full offer comparison UI is M5 (MIC-109). MIC-113/122 may insert `deal_offers` when financial terms exist; they must not invent a comparison workspace.
14. **Conductor owns `src/lib/mca/db/schema.ts`, `drizzle/**`, adapter `registry.ts`, and shared mounts.** Agents that need a schema column report `NEEDS_CONTEXT` instead of editing the migration.
15. **Do not mark Linear Done from an implementer.** Only the conductor marks Done, after reviewer pass + conductor verification.

---

## Wave 0 — conductor (before any ticket agent)

Write `nextjs-version/docs/milestone-04/implementation-plan.md` (this design, copied into the repo) and freeze compileable contracts + one Drizzle migration.

### Migration `0006` (conductor only)

New tables (names locked):

- `mca_email_senders` — provider (`google` \| `microsoft` \| `smtp` \| `sendgrid`), encrypted credentials, from-name, signature, verification, connection state, purpose (`merchant` \| `submission` \| `fallback`)
- `mca_email_sender_members` — permitted memberships
- `mca_submission_jobs` — deal, funder_id, route snapshot, package checksums, state, attempt_key, analysis_run_id, frozen deal/document versions
- `mca_submission_attempts` — unique `(job_id, attempt_key)`, transport, correlation_id, external_ref, error
- `mca_submission_outbox` — transactional outbox
- `mca_adapter_credentials` — funder_id, environment (`development` \| `production`), encrypted fields, capability flags
- `mca_outgoing_derivatives` — original_document_id, funder_id, stage (`stamp` \| `watermark` \| `compress`), checksums, template_version
- `mca_funder_replies` — sender mailbox, provider message id, matched job/deal, processing state
- Expand `deal_submissions` with nullable `funder_id`, `job_id`, `route_kind` (keep `funder_name` cache)
- Expand `deal_offers` with nullable term fields + `source` (`api` \| `email` \| `link` \| `manual`) + `raw_status`

### Frozen ports (verbatim for implementers)

```ts
// src/lib/mca/submissions/contracts.ts
export const JOB_STATES = [
  "preflight_failed", "queued", "sending", "sent", "failed",
  "skipped", "pending_portal", "blocked_duplicate",
] as const
export type JobState = (typeof JOB_STATES)[number]

export interface QueueSubmissionsInput {
  actor: DealActor
  dealId: string
  funderIds: string[]
  analysisRunId?: string
  confirmationKey: string
}
export interface QueueSubmissionsResult {
  ok: true
  jobs: Array<{ jobId: string; funderId: string; state: JobState; reason?: string }>
}

export interface DuplicateDecision {
  allowed: boolean
  code?: "retry_too_soon" | "active_duplicate" | "privileged_retry"
  eligibleAt?: string
}

export interface FunderAdapter {
  slug: string
  validate(input: unknown): { ok: true } | { ok: false; fields: Record<string, string> }
  submit(job: SubmissionJob): Promise<AdapterSubmitResult>
  getStatus?(job: SubmissionJob): Promise<AdapterStatusResult>
  parseWebhook?(headers: Record<string, string>, body: unknown): Promise<AdapterStatusResult>
  capabilities: { submit: true; statusPoll: boolean; webhooks: boolean; offers: boolean }
}
```

Wave 0 stubs: `assertDuplicatePolicy` allows; `prepareOutgoingPackage` returns originals; `deliverSubmission` routes by `FunderRoute.kind` to unimplemented transports that return `provider_unavailable` with correlation IDs — except the job ledger itself, which MIC-166 fills.

Linear: leave tickets Backlog until their wave starts.

---

## Exclusive files (locked)

Shared (conductor only): `src/lib/mca/db/schema.ts`, `drizzle/**`, `src/lib/mca/submissions/adapters/registry.ts`, `src/app/(dashboard)/deals/components/deals-workspace.tsx`, `src/app/(dashboard)/settings/connections/page.tsx`, `src/app/(dashboard)/[section]/page.tsx`, `src/app/(dashboard)/submissions/page.tsx`, `package.json`, `src/lib/mca/underwriting/analysis.ts` (state mapping after 166), `tests/underwriting-analysis.test.ts` (same).

| Ticket | Exclusive paths |
| --- | --- |
| MIC-121 | `src/lib/mca/senders/**`, `src/app/api/mca/senders/**`, `src/components/mca/senders/**`, `tests/senders.test.ts` |
| MIC-166 | `src/lib/mca/submissions/{jobs,preflight,outbox,queue,repository}.ts`, `src/lib/mca/underwriting/submission-port.ts`, `src/app/api/mca/submissions/**`, `src/components/mca/submissions/selection-panel.tsx`, `tests/submissions-core.test.ts` |
| MIC-174 | `src/lib/mca/submissions/duplicate-policy.ts`, `tests/submissions-duplicates.test.ts` |
| MIC-178 | `src/lib/mca/submissions/{portal,webhook}.ts`, `src/app/api/mca/submissions/portal/**`, `src/components/mca/submissions/portal-panel.tsx`, `tests/submissions-portal.test.ts` |
| MIC-171 | `src/lib/mca/submissions/stamps.ts`, `src/app/api/mca/submissions/stamps/**`, `tests/submissions-stamps.test.ts` |
| MIC-162 | `src/lib/mca/submissions/watermarks.ts`, `src/app/api/mca/submissions/watermarks/**`, `tests/submissions-watermarks.test.ts` |
| MIC-153 | `src/lib/mca/submissions/email-templates.ts`, `src/app/api/mca/submissions/email/**`, `src/components/mca/submissions/email-preview.tsx`, `tests/submissions-email.test.ts` |
| MIC-124 | `src/lib/mca/submissions/adapters/{contracts,framework,credentials}.ts`, `src/app/api/mca/adapters/**`, `src/components/mca/submissions/adapter-credentials-panel.tsx`, `tests/adapters-framework.test.ts` |
| MIC-113 | `src/lib/mca/submissions/{poll,webhooks,reconciliation}.ts`, `src/app/api/mca/submissions/webhooks/**`, `tests/submissions-status.test.ts` |
| MIC-149 | `src/lib/mca/submissions/replies.ts`, `src/app/api/mca/submissions/replies/**`, `src/components/mca/submissions/reply-queue.tsx`, `tests/submissions-replies.test.ts` |
| MIC-160 | `src/lib/mca/submissions/compress.ts`, `src/app/api/mca/submissions/compress/**`, `tests/submissions-compress.test.ts` |
| MIC-122 | `src/lib/mca/submissions/extract-outcomes.ts`, `src/app/api/mca/submissions/extract/**`, `tests/submissions-extract.test.ts` |
| MIC-128 | `src/lib/mca/submissions/offer-links.ts`, `tests/submissions-offer-links.test.ts` |
| Each adapter `MIC-123`…`MIC-145` | `src/lib/mca/submissions/adapters/<slug>/**`, `tests/adapters/<slug>.test.ts` |

Every ticket also owns `docs/milestone-04/<id>-report.md` and `docs/milestone-04/<id>-acceptance.md`.

If an agent needs a shared-file change: stop, `NEEDS_CONTEXT`. Do not edit outside the exclusive list.

---

## Waves

### Wave 1 — MIC-121 (1 agent)

Google / Microsoft OAuth + encrypted SMTP/SendGrid. Purpose slots, member ACL, test-send, expired → reconnect without dropping queued work. Unauthorized rep cannot forge another sender id. Live OAuth is a **gate**; fixtures prove the path.

### Wave 2 — MIC-166 (1 agent)

Selection UI, per-funder route/checklist/preflight, freeze deal+document versions, one job per funder, transactional outbox, unique attempt keys. Replace `queueSubmissions` with a real queue. One failed destination does not fail others. Repeated confirmation is idempotent. Conductor then remounts analysis success path.

### Wave 3 — MIC-174, MIC-178, MIC-171 (3 parallel)

Duplicates, portal/webhook, stamps. Disjoint files.

### Wave 4 — MIC-124, MIC-153, MIC-162 (3 parallel)

Adapter framework, email templates, watermarks.

### Wave 5 — MIC-113, MIC-149, MIC-160 (3 parallel)

Poll/webhooks/reconciliation, reply ingestion, compression.

### Wave 6 — MIC-122 + adapter batch A (max 5 adapters)

First adapter **MIC-123 (Expansion Capital Group)** is the gold template (public guide exists). Remaining adapters copy the template with slug-specific fixtures/mappings. Conductor appends registry imports after the batch.

Adapter batches (after 124+113 review-clean):

- A: 123, 126, 127, 129, 130
- B: 131, 132, 133, 134, 135
- C: 136, 137, 138, 139, 140
- D: 141, 142, 143, 144, 145

### Wave 7 — MIC-128 + remaining adapter batches

Offer-link SSRF protections + leftover adapters. MIC-128 may run in parallel with adapter batches.

---

## Per-ticket agent protocol

Each implementer prompt includes: ticket id/url, full Linear description, these rulings, exclusive file list, frozen types, acceptance criteria, “do not spawn subagents”, “do not mark Linear Done”.

Report envelope:

```text
TICKET_WORKER_DONE
ticket: MIC-xxx
summary: <one line>
files: <paths>
checks: <commands and pass/fail>
gates: <remaining provider/OAuth gates or none>
handoff: <what conductor must mount>
```

or `TICKET_WORKER_BLOCKED` / `NEEDS_CONTEXT`.

After DONE: conductor exclusive-file audit → reviewer on that diff → conductor runs ticket tests → only then next dependent.

---

## Verification (required before any Linear Done)

| Check | Owner |
| --- | --- |
| Per-ticket synthetic acceptance (Linear boxes) | Implementer |
| Exclusive-file audit | Conductor after each agent |
| Reviewer spec + quality | Reviewer |
| `pnpm test && pnpm typecheck && pnpm lint` | Conductor after each wave |
| Production `pnpm build` | Conductor after Wave 7 |
| Browser: settings senders, deal submit (one fail / one success), `/submissions`, portal pending, duplicate block copy, stamp preview | Conductor after Waves 2, 5, 7 |
| Linear comment + Done | Conductor only |

Browser: exercise like a user (click/type/submit), desktop and mobile for new panels. No single screenshot as proof.

Honest Done comment template:

> Implemented locally with synthetic fixtures. Remaining gate: \<live Google OAuth / provider sandbox credentials / none\>. Mock success is not production integration readiness.

---

## Linear status protocol

1. Wave start → `state: "In Progress"` on those issues.
2. Implementer + reviewer + conductor checks green → comment with tests, files, gates.
3. `state: "Done"` only from conductor.
4. If a gate is **product-blocking** (missing schema decision that was not frozen), leave **In Progress** and surface it — do not fake Done.

Expected: all 13 platform tickets Done (MIC-121/149 may keep OAuth/mailbox gates in the comment). All 20 adapters Done with **provider-access remaining** unless a public contract is too thin to even fixture — then In Progress + comment, not silent skip.

---

## Out of scope

- M5 offer comparison / funding / commissions (MIC-109 and later)
- M6 SMS providers, daily digest, onboarding checklist
- Billing
- Changing M1–M3 behavior except the MIC-148 `queueSubmissions` success mapping

---

## Success

33 Linear issues have an implementer, a reviewer pass, a conductor verification, and a Linear comment. `queueSubmissions` no longer hard-fails. Existing M1–M3 tests still pass (analysis tests updated for real queue). No live merchant data leaves the workspace.

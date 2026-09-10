# Milestone 06 — Communications and reporting

> **For agentic workers:** REQUIRED: one implementer subagent per Linear ticket, dispatched in dependency waves. This session is the senior conductor: it freezes contracts, owns shared files, reviews each wave, independently verifies, then marks Linear **Done**. Do not start 20 editors at once.

**Goal:** Deliver all **20** Linear tickets in milestone **06 Communications and reporting** on the MCA Next.js app, then verify and mark each issue Done with honest remaining gates.

**Architecture:** Four product surfaces share frozen ports: (1) SMS accounts + six provider adapters, (2) merchant templates / scheduled follow-ups / digest / funder reminders / workflow webhooks, (3) Home Needs Action, (4) role-scoped exports and admin reports. Ticket agents own exclusive files. The conductor owns schema/migrations, frozen ports, and shared mounts (dashboard home, `/reports`, settings connections, SMS adapter registry, `deals-workspace.tsx`, `package.json`).

**Tech stack:** Next.js App Router 16, Neon Postgres + Drizzle, existing `DealActor` / senders / SMS Twilio boundary / import batches / accounting ledger / submission jobs, AES-GCM (`encryptSensitive`), pnpm, `node:test`.

**Spec:** Live Linear issues on project [MCA](https://linear.app/michael-belenkiy/project/mca-1e94b0617388) (`b223a780-3987-440c-8e04-41516a97e69b`), milestone `06 Communications and reporting` (`7b9fb1b9-03db-48ce-9285-4e43a152ceb2`). Local pattern: `nextjs-version/docs/milestone-04/implementation-plan.md` and `docs/milestone-05/execution-plan.md`.

**Workspace:** `/Users/mbele/Desktop/mca` is **not a git repository**. Isolation is exclusive file ownership, not worktrees. Work only in `nextjs-version/`.

---

## Scan result (Linear, 2026-09-08)

Milestone progress is **1.25%**. **19 Backlog**, **1 In Progress** (MIC-156). Team **Michael Belenkiy** (`MIC`), medium priority.

### Communications (13)

| ID | Title | Status | Blocked by | Blocks |
| --- | --- | --- | --- | --- |
| [MIC-156](https://linear.app/michael-belenkiy/issue/MIC-156) | SMS account routing and direct merchant texting | In Progress | MIC-97 ✓, MIC-91 ✓ | MIC-147, MIC-168, six SMS adapters |
| [MIC-147](https://linear.app/michael-belenkiy/issue/MIC-147) | Personalized message templates and offer/document variables | Backlog | MIC-156, MIC-109 ✓, MIC-121 ✓, MIC-106 (local contracts exist) | MIC-115 |
| [MIC-115](https://linear.app/michael-belenkiy/issue/MIC-115) | Scheduled merchant follow-ups by deal status | Backlog | MIC-147 | MIC-117 |
| [MIC-117](https://linear.app/michael-belenkiy/issue/MIC-117) | Follow-up sender fallback, CC and BCC settings | Backlog | MIC-115 | — |
| [MIC-146](https://linear.app/michael-belenkiy/issue/MIC-146) | Opt-in daily deal activity email digest | Backlog | MIC-121 ✓, MIC-118 ✓, MIC-93 ✓ | — |
| [MIC-154](https://linear.app/michael-belenkiy/issue/MIC-154) | Manual funder reminders in the original email thread | Backlog | MIC-153 ✓ | — |
| [MIC-158](https://linear.app/michael-belenkiy/issue/MIC-158) | Outbound workflow webhooks and assignment notifications | Backlog | MIC-109 ✓, MIC-91 ✓, MIC-121 ✓, MIC-166 ✓ | MIC-157 (M5, already coded) |
| [MIC-185](https://linear.app/michael-belenkiy/issue/MIC-185) | Entrance SMS provider adapter | Backlog | MIC-156 | — |
| [MIC-187](https://linear.app/michael-belenkiy/issue/MIC-187) | TextTorrent SMS provider adapter | Backlog | MIC-156 | — |
| [MIC-188](https://linear.app/michael-belenkiy/issue/MIC-188) | TextUs SMS provider adapter | Backlog | MIC-156 | — |
| [MIC-189](https://linear.app/michael-belenkiy/issue/MIC-189) | OpenPhone SMS provider adapter | Backlog | MIC-156 | — |
| [MIC-190](https://linear.app/michael-belenkiy/issue/MIC-190) | Twilio SMS provider adapter | Backlog | MIC-156 | — |
| [MIC-191](https://linear.app/michael-belenkiy/issue/MIC-191) | GoHighLevel SMS provider adapter | Backlog | MIC-156 | — |

### Reporting and Home (7)

| ID | Title | Status | Blocked by | Blocks |
| --- | --- | --- | --- | --- |
| [MIC-100](https://linear.app/michael-belenkiy/issue/MIC-100) | Role-scoped deal/offer CSV and admin workspace exports | Backlog | MIC-91 ✓, MIC-109 ✓, MIC-94 ✓ | MIC-96 (M7) |
| [MIC-102](https://linear.app/michael-belenkiy/issue/MIC-102) | Home Needs Action queue and in-place deal panel | Backlog | MIC-93 ✓, MIC-105 ✓, MIC-109 ✓, MIC-106/108 (local contracts exist) | MIC-96 |
| [MIC-104](https://linear.app/michael-belenkiy/issue/MIC-104) | Rep performance funnel and funding report | Backlog | MIC-93 ✓, MIC-112 ✓, MIC-94 ✓ | MIC-101 |
| [MIC-101](https://linear.app/michael-belenkiy/issue/MIC-101) | Team performance, distributions and company profit report | Backlog | MIC-104, MIC-103 ✓ | — |
| [MIC-110](https://linear.app/michael-belenkiy/issue/MIC-110) | Lead providers, purchase batches and cost attribution | Backlog | MIC-91 ✓, MIC-155 ✓ | MIC-116 |
| [MIC-114](https://linear.app/michael-belenkiy/issue/MIC-114) | Funder analytics and commission performance | Backlog | MIC-112 ✓, MIC-113 ✓ | — |
| [MIC-116](https://linear.app/michael-belenkiy/issue/MIC-116) | Lead source and batch conversion, CAC and ROI analytics | Backlog | MIC-110, MIC-112 ✓ | — |

```
MIC-156 (SMS routing, already partial)
   ├──► MIC-147 templates ──► MIC-115 follow-ups ──► MIC-117 fallback
   └──► MIC-190 Twilio (gold) + MIC-185/187/188/189/191 adapters

MIC-110 cost ──► MIC-116 CAC/ROI
MIC-104 funnel ──► MIC-101 team profit
MIC-100 exports          (independent)
MIC-114 funder analytics (independent)
MIC-146 digest           (independent)
MIC-154 reminders        (independent)
MIC-158 webhooks         (independent)
MIC-102 home queue       (uses existing M5 closing/offer/renewal contracts)
```

---

## Current code (starting point)

**Already real (do not rewrite):**

- SMS accounts, member ACL, consent/opt-out, Twilio transport, status callbacks, Settings → Connections panel, `POST /api/mca/sms/messages` API. Schema `provider = 'twilio'` only. Docs: `docs/milestone-05/sms-routing-acceptance.md`. Linear MIC-156 remains In Progress because of **live Twilio** and **standalone composer UI**.
- Email senders (MIC-121): Google / Microsoft / SMTP / SendGrid, purposes `merchant | submission | fallback`.
- Submission email templates + thread ids (MIC-153) and reply correlation (MIC-149) — MIC-154 can attach reminders to stored thread headers.
- Import `import_sources` + `lead_batches` (MIC-155) — **no purchase cost**.
- Accounting ledger, splits, advances, funding events (M5).
- Admin-only deal CSV at `GET /api/mca/deals/export` with formula-prefix escaping. No offers export, no async jobs, reps cannot export.
- `/dashboard` is a placeholder (hardcoded “Monday, September 7”, blank metrics). `/reports` is the `[section]` construction card.

**Not built:** message-template catalog, scheduled follow-ups, daily digest, workflow webhooks, Home queue, reports pages, lead cost/CAC, five non-Twilio SMS adapters, Twilio adapter extracted behind a shared `SmsAdapter` port.

**M5 tickets still In Progress (provider gates, local code exists):** MIC-106, MIC-108, MIC-157, MIC-168. Home/templates consume those **contracts**, not live Postmark/DocuSeal/Twilio. Do not wait and do not mark those M5 tickets Done from this milestone.

---

## Why not 20 agents at once

Tickets share schema, the SMS provider union, `/reports` and Home mounts, and Linear honesty rules. Parallel editors on `schema.ts`, `sms/contracts.ts`, `dashboard/page.tsx`, or `settings/connections/page.tsx` will collide. Milestone 04 succeeded with exclusive paths and waves. This plan keeps **one implementer per ticket** and runs them in **four waves** so dependents consume frozen APIs.

Max parallel implementers: **5**.

Ticket agents **never** spawn reviewers or sibling implementers. Reviewers are read-only.

---

## Team

| Agent | Role |
| --- | --- |
| **Conductor (this session)** | Senior engineer. Wave 0 contracts + migration. Exclusive-file audit. Shared mounts. Wave review. Full `pnpm test && pnpm typecheck && pnpm lint`. Browser verification. Linear In Progress / comments / Done. |
| **Implementer MIC-\*** | One `general-purpose` subagent per ticket. Isolation `none`. Exclusive files only. Writes `docs/milestone-06/<id>-report.md` and `<id>-acceptance.md`. |
| **Reviewer MIC-\*** | Fresh read-only `explore` after implementer DONE. Spec + quality on that ticket’s diff only. |

Twenty implementers, one per ticket: MIC-156, 147, 115, 117, 146, 154, 158, 185, 187, 188, 189, 190, 191, 100, 102, 104, 101, 110, 114, 116.

---

## Rulings (frozen before dispatch)

1. **Follow the Linear DAG.** Adapters and MIC-147 do not start until MIC-156 is review-clean against the frozen `SmsAdapter` port. MIC-115 waits for MIC-147. MIC-117 waits for MIC-115. MIC-101 waits for MIC-104. MIC-116 waits for MIC-110.
2. **Do not rewrite working M5 SMS.** MIC-156 completes the remaining composer UI, generalizes `provider` off the Twilio-only check, and keeps existing Twilio env-bound secrets (`MCA_SMS_TWILIO_ACCOUNTS_JSON`) working. Existing `tests/milestone05-sms.test.ts` must stay green.
3. **Local fixture success can be Linear Done** when the only remaining gap is commercial provider access or live OAuth/handset, **if** the Linear comment lists the gate in the same words as M2–M5. Mock HTTP that claims a live SMS was delivered to a merchant is forbidden.
4. **No live merchant SMS, email, or webhook deliveries** unless the user later explicitly authorizes a named recipient. Adapters implement the shared contract against **synthetic fixtures** derived from **public** provider docs. Do not copy MCA Pilot endpoints, IPs, or sample credentials.
5. **SMS secrets stay out of logs and out of application tables when env-bound.** Existing Twilio pattern: symbolic `credentialRef` + deployment JSON. New adapters may add encrypted structured fields **only** for the keys their ticket lists, via `encryptSensitive`, workspace-scoped. Production credentials cannot fall back to another workspace.
6. **Capability flags stay honest.** If a provider has no documented delivery webhook, `statusCallbacks: false` and tests still prove idempotent send + rejected-number. Do not invent inbound conversation support.
7. **Scheduler is worker POST, not cron.** Same pattern as intake jobs and submission reply ingest: `POST /api/mca/comms/jobs/run` with injectable `nowIso`. Unique occurrence keys. Replay of the same key creates no second external request.
8. **Unknown is not invented.** Zero denominators are `N/A`, not infinity or zero. Missing payment permission shows a restricted state, not a fake $0. Approval without terms does not fabricate amounts. Incomplete report periods are labeled.
9. **Deal visibility applies everywhere a rep can see rows.** Reports pages are admin/super_admin + `features.reports`. Exports for reps use the same authorized deal query as the Deals screen and omit payment fields. Admin workspace exports use an explicit field manifest and still omit the future payment-export feature.
10. **Document / offer variables cannot leak commissions or another deal.** Merchant templates are a denylist for internal money fields. Unknown variables **block publish**.
11. **Opening a webhook config or preview does not mark delivered.** Failed transport ≠ successful pitch, reminder, digest, or follow-up.
12. **Home queue is derived from underlying state.** Completing an action removes only that reason. Do not store a parallel mutable “task” that can disagree with deals/offers/stipulations/contracts/renewals.
13. **Lead cost extends MIC-155; it does not fork a second batch identity.** Purchase cost/date live on (or 1:1 with) existing `lead_batches`. Acquisition history is append-only. Inactive sources cannot be selected for new deals but historical rows remain.
14. **Conductor owns `src/lib/mca/db/schema.ts`, `db/milestone05-*.ts`, `drizzle/**`, SMS `adapters/registry.ts`, and shared mounts.** Agents that need a schema column report `NEEDS_CONTEXT` instead of editing the migration.
15. **Do not mark Linear Done from an implementer.** Only the conductor marks Done, after reviewer pass + conductor verification.
16. **MIC-106 / MIC-108 / MIC-168 remaining live-provider gates do not block M6.** Use existing closing/offer/stipulation/contract service functions. If a required export is missing, `NEEDS_CONTEXT` — do not silently skip the Home reason.

---

## Wave 0 — conductor (before any ticket agent)

Write `nextjs-version/docs/milestone-06/implementation-plan.md` (this design, copied into the repo) and freeze compileable contracts + one Drizzle migration (`0012`).

### Migration `0012` (conductor only)

New / expanded objects (names locked):

- Widen `mca_sms_accounts.provider` and `mca_sms_messages.provider` checks to  
  `twilio | entrance | texttorrent | textus | openphone | gohighlevel`
- `mca_sms_adapter_credentials` — workspace, provider, environment (`development` \| `production`), encrypted payload, capability JSON
- `mca_message_templates` + `mca_message_template_versions` — channel `email | sms`, scope, body/subject, variable schema hash, published flag
- `mca_followup_policies` — status, channel, local schedule, template_id, enabled, retry
- `mca_followup_occurrences` — unique `(workspace_id, policy_id, deal_id, occurrence_key)`
- `mca_digest_subscriptions` — membership opt-in, timezone
- `mca_digest_deliveries` — unique `(workspace_id, membership_id, window_start)`
- `mca_workflow_webhook_endpoints` — URL, events, signing secret, originator/closer flags
- `mca_workflow_webhook_outbox` + `mca_workflow_webhook_deliveries` — stable `event_id`, attempts, last error
- `mca_export_jobs` + `mca_export_download_tokens` — kind, filter snapshot, state, checksum, expires_at
- `lead_batches.purchased_on` (nullable text date), `lead_batches.cost_cents` (nullable integer), `lead_batches.inactive` (0/1)
- `mca_deal_acquisition_events` — append-only deal/source/batch/cost snapshot
- `mca_funder_reminders` — job_id, sender_id, thread headers, last_reminded_at (does **not** change submission status)

### Frozen ports (verbatim for implementers)

```ts
// src/lib/mca/sms/contracts.ts  (conductor expands; agents do not edit)
export const SMS_PROVIDERS = [
  "twilio", "entrance", "texttorrent", "textus", "openphone", "gohighlevel",
] as const
export type SmsProvider = (typeof SMS_PROVIDERS)[number]

export interface SmsAdapter {
  slug: SmsProvider
  validate(input: unknown): { ok: true } | { ok: false; fields: Record<string, string> }
  testConnection(account: SmsAccount): Promise<{ ok: true } | { ok: false; code: string }>
  send(input: SmsAdapterSendInput): Promise<SmsDeliveryResult>
  parseStatus?(headers: Record<string, string>, body: unknown): Promise<SmsAdapterStatus>
  parseInbound?(headers: Record<string, string>, body: unknown): Promise<SmsAdapterInbound | { ignored: true }>
  capabilities: {
    send: true
    statusCallbacks: boolean
    inbound: boolean
    optOut: boolean
  }
}

// src/lib/mca/comms/contracts.ts
export interface RunCommsJobsInput {
  actor: DealActor
  nowIso: string
  kinds?: Array<"followup" | "digest" | "webhook_outbox">
}
export interface RunCommsJobsResult {
  followups: { attempted: number; sent: number; skipped: number }
  digests: { attempted: number; sent: number; skipped: number }
  webhooks: { attempted: number; delivered: number; failed: number }
}

// src/lib/mca/reports/contracts.ts
export interface ReportFilters {
  from?: string // YYYY-MM-DD inclusive, workspace tz
  to?: string
  membershipIds?: string[]
  funderIds?: string[]
  sourceIds?: string[]
  batchIds?: string[]
  basis: "event" | "cohort"
}
```

Wave 0 stubs: `runCommsJobs` is a no-op success with zeros; `getSmsAdapter(slug)` returns Twilio for `twilio` and `provider_unavailable` elsewhere until adapter tickets land. Home/report queries are unimplemented until their tickets.

Linear: leave tickets Backlog until their wave starts (MIC-156 stays In Progress).

---

## Exclusive files (locked)

Shared (conductor only): `src/lib/mca/db/schema.ts`, `src/lib/mca/db/milestone05-*.ts`, `drizzle/**`, `src/lib/mca/sms/contracts.ts`, `src/lib/mca/sms/adapters/registry.ts`, `src/app/(dashboard)/dashboard/page.tsx`, `src/app/(dashboard)/[section]/page.tsx`, `src/app/(dashboard)/reports/page.tsx` (created in Wave 0 as a shell), `src/app/(dashboard)/settings/connections/page.tsx`, `src/app/(dashboard)/deals/components/deals-workspace.tsx`, `src/components/app-sidebar.tsx`, `src/lib/mca/policy.ts`, `package.json`.

| Ticket | Exclusive paths |
| --- | --- |
| MIC-156 | `src/lib/mca/sms/{service,http}.ts` (extend, do not delete Twilio path), `src/components/mca/sms/composer-panel.tsx`, `src/app/api/mca/sms/messages/**` (composer UX wiring only if needed), `tests/milestone06-sms-composer.test.ts` |
| MIC-190 | `src/lib/mca/sms/adapters/twilio/**` (extract from existing `sms/twilio.ts` behind `SmsAdapter`; keep `sms/twilio.ts` as a re-export until conductor deletes the shim), `tests/sms-adapters/twilio.test.ts` |
| MIC-185 | `src/lib/mca/sms/adapters/entrance/**`, `tests/sms-adapters/entrance.test.ts` |
| MIC-187 | `src/lib/mca/sms/adapters/texttorrent/**`, `tests/sms-adapters/texttorrent.test.ts` |
| MIC-188 | `src/lib/mca/sms/adapters/textus/**`, `tests/sms-adapters/textus.test.ts` |
| MIC-189 | `src/lib/mca/sms/adapters/openphone/**`, `tests/sms-adapters/openphone.test.ts` |
| MIC-191 | `src/lib/mca/sms/adapters/gohighlevel/**`, `tests/sms-adapters/gohighlevel.test.ts` |
| MIC-147 | `src/lib/mca/comms/templates.ts`, `src/app/api/mca/comms/templates/**`, `src/components/mca/comms/template-editor.tsx`, `tests/milestone06-templates.test.ts` |
| MIC-115 | `src/lib/mca/comms/followups.ts`, `src/app/api/mca/comms/followups/**`, `src/components/mca/comms/followup-panel.tsx`, `tests/milestone06-followups.test.ts` |
| MIC-117 | `src/lib/mca/comms/sender-fallback.ts`, `src/app/api/mca/comms/sender-fallback/**`, `tests/milestone06-sender-fallback.test.ts` |
| MIC-146 | `src/lib/mca/comms/digest.ts`, `src/app/api/mca/comms/digest/**`, `src/components/mca/comms/digest-settings.tsx`, `tests/milestone06-digest.test.ts` |
| MIC-154 | `src/lib/mca/comms/reminders.ts`, `src/app/api/mca/comms/reminders/**`, `src/components/mca/comms/remind-funder.tsx`, `tests/milestone06-reminders.test.ts` |
| MIC-158 | `src/lib/mca/comms/webhooks.ts`, `src/app/api/mca/comms/webhooks/**`, `src/components/mca/comms/webhook-console.tsx`, `tests/milestone06-webhooks.test.ts` |
| MIC-100 | `src/lib/mca/exports/**`, `src/app/api/mca/exports/**`, `src/components/mca/exports/export-panel.tsx`, `tests/milestone06-exports.test.ts` |
| MIC-102 | `src/lib/mca/home/**`, `src/app/api/mca/home/**`, `src/components/mca/home/needs-action.tsx`, `tests/milestone06-home.test.ts` |
| MIC-104 | `src/lib/mca/reports/rep-funnel.ts`, `src/app/api/mca/reports/rep-funnel/**`, `src/components/mca/reports/rep-funnel.tsx`, `tests/milestone06-rep-funnel.test.ts` |
| MIC-101 | `src/lib/mca/reports/team-profit.ts`, `src/app/api/mca/reports/team-profit/**`, `src/components/mca/reports/team-profit.tsx`, `tests/milestone06-team-profit.test.ts` |
| MIC-110 | `src/lib/mca/leads/**`, `src/app/api/mca/leads/**`, `src/components/mca/leads/providers-panel.tsx`, `tests/milestone06-leads.test.ts` |
| MIC-114 | `src/lib/mca/reports/funder-analytics.ts`, `src/app/api/mca/reports/funders/**`, `src/components/mca/reports/funder-analytics.tsx`, `tests/milestone06-funder-analytics.test.ts` |
| MIC-116 | `src/lib/mca/reports/lead-roi.ts`, `src/app/api/mca/reports/lead-roi/**`, `src/components/mca/reports/lead-roi.tsx`, `tests/milestone06-lead-roi.test.ts` |

Shared comms job runner `src/lib/mca/comms/jobs.ts` + `src/app/api/mca/comms/jobs/run/route.ts` is **conductor-owned**; MIC-115 / MIC-146 / MIC-158 register handlers through a frozen `registerCommsJob` map the conductor writes in Wave 0.

Every ticket also owns `docs/milestone-06/<id>-report.md` and `docs/milestone-06/<id>-acceptance.md`.

If an agent needs a shared-file change: stop, `NEEDS_CONTEXT`. Do not edit outside the exclusive list.

---

## Waves

### Wave 1 — five parallel (unblocked foundations)

| Agent | Ticket | What they ship |
| --- | --- | --- |
| Implementer MIC-156 | SMS remaining | Deal-level composer UI (preview, assigned-account picker, consent gate, message thread). Generalize service to `SmsProvider` union calling `getSmsAdapter`. Keep Twilio env JSON. Unassigned account → 403. Opt-out blocks send. |
| Implementer MIC-110 | Lead cost | Provider + purchase batch cost/date, import/intake/manual assignment, inactive sources, unassigned-deal reconciliation. Cross-workspace source IDs rejected. |
| Implementer MIC-104 | Rep funnel | Admin date/rep filters, unique-deal counts (five funders = one submitted deal), conversions, attributed distributions, drilldown that reconciles to totals. Restricted state when payment permission is off. |
| Implementer MIC-100 | Exports | Rep export = visible deals/offers + allowed fields. Admin all-deals-and-owners and funded-deals with field manifest. Async job + expiring download for large snapshots. Formula text inert. Not a payment export. |
| Implementer MIC-154 | Reminders | Remind Funder only on unanswered **email** jobs. Preview original recipients/sender. Thread headers when present; disclosed fallback otherwise. Status unchanged; last-reminded recorded. API jobs have no button. |

Conductor then remounts: composer on the deal panel, export control on Deals, Remind on submissions, lead-cost on Connections/import.

### Wave 2 — five parallel (dependents of Wave 1 + independent comms/reports)

| Agent | Ticket | Depends on |
| --- | --- | --- |
| Implementer MIC-147 | Templates + variables | MIC-156 review-clean |
| Implementer MIC-116 | CAC / ROI | MIC-110 review-clean |
| Implementer MIC-101 | Team profit | MIC-104 review-clean |
| Implementer MIC-114 | Funder analytics | Wave 1 not required (112/113 already Done) |
| Implementer MIC-146 | Daily digest | Wave 1 not required (121/118/93 Done) |

MIC-147: typed registry, channel-aware escaping, all/selected/highest offers, scoped upload links, version history, unknown variable blocks publish, no commission leakage.

MIC-116: cost per funded merchant vs per funded deal; ROI = (attributed collected commission − purchase cost) / purchase cost; zero-cost → undefined; renewals follow documented attribution (do not inflate acquisition counts).

MIC-101: admin-only; gross contribution = collected commission/fees − paid distributions; no double-count shared deals; reversal updates the report.

MIC-114: submissions / unique merchants / approvals / fundings / collected commissions by funder; revised offers do not double-count approvals; earned totals reconcile to ledger.

MIC-146: profile opt-in, workspace-local 6 AM default, trailing 24h **event** timestamps (edit today of a 3-day-old funding does not include it), visibility-scoped, replay-safe window key.

### Wave 3 — five parallel

| Agent | Ticket | Depends on |
| --- | --- | --- |
| Implementer MIC-115 | Scheduled follow-ups | MIC-147 |
| Implementer MIC-158 | Workflow webhooks | independent |
| Implementer MIC-102 | Home queue + panel | independent (M5 contracts) |
| Implementer MIC-190 | Twilio adapter (gold) | MIC-156 |
| Implementer MIC-185 | Entrance adapter | MIC-156 |

MIC-115: status + channel + local schedule + template + retry; recheck status/consent/recipient immediately before send; stage change skips; unique occurrence key.

MIC-158: versioned envelopes for offers, deal transitions, assignments, submissions; transactional outbox; HMAC; bounded retries; replay keeps `event_id`; SSRF-safe destinations; assignment notifies only authorized configured recipients.

MIC-102: derive reasons (submit/resubmit, pitch, merchant/funder follow-up, contract, missing-doc, signature, repricing, funding, renewal). Own-action vs overdue-waiting vs renewal. Completing one reason leaves others. Queue obeys deal visibility. In-place panel: contacts, offers, submissions, notes, workflow actions.

MIC-190: extract existing Twilio send/signature/opt-out into `SmsAdapter`. Tests cover routing, accepted send, rejected number, retried callback without duplicate rows. Remaining gate: live account.

MIC-185: public-docs fixtures for login email + API secret; honest capability flags.

### Wave 4 — five parallel (last dependents + remaining adapters)

| Agent | Ticket | Depends on |
| --- | --- | --- |
| Implementer MIC-117 | Sender fallback / CC / BCC | MIC-115 |
| Implementer MIC-187 | TextTorrent | MIC-156 + Twilio template |
| Implementer MIC-188 | TextUs | MIC-156 + Twilio template |
| Implementer MIC-189 | OpenPhone | MIC-156 + Twilio template |
| Implementer MIC-191 | GoHighLevel | MIC-156 + Twilio template |

MIC-117: workspace-shared vs originator merchant sender; verified fallback used **once** when originator is down; template CC and fallback BCC independent from submission rep-copy; neither sender available → visible failure, not success.

Adapter tickets copy `docs/milestone-06/sms-adapter-template.md` (conductor writes from MIC-190). Conductor appends registry imports after each adapter batch.

---

## Per-ticket agent protocol

Each implementer prompt includes: ticket id/url/uuid, full Linear description, these rulings, exclusive file list, frozen types, acceptance criteria, “do not spawn subagents”, “do not mark Linear Done”, “cd nextjs-version for tests”.

Report envelope:

```text
TICKET_WORKER_DONE
ticket: MIC-xxx
summary: <one line>
files: <paths>
checks: <commands and pass/fail>
gates: <remaining provider/OAuth/handset gates or none>
handoff: <what conductor must mount>
```

or `TICKET_WORKER_BLOCKED` / `NEEDS_CONTEXT`.

After DONE: conductor exclusive-file audit → reviewer on that diff → conductor runs ticket tests → only then next dependent.

---

## Per-ticket acceptance (Linear boxes, all five on every issue)

Every ticket already has the same five checkboxes. Implementers must prove all of them plus the ticket-specific bullets:

**MIC-156:** rep cannot send through an unassigned account; opted-out merchant blocked from outreach; composer loading/empty/validation/success/failure; API permissions match UI.

**MIC-147:** unknown variable blocks publish; merchant template cannot read commissions or another deal.

**MIC-115:** leaving the target stage before delivery suppresses the message; scheduler replay cannot double-send an occurrence.

**MIC-117:** disconnecting originator selects configured fallback exactly once; no available sender is a visible failure.

**MIC-146:** a deal funded three days ago does not appear because it was edited today; replay does not send a second digest for the same recipient/window.

**MIC-154:** API submissions have no email-thread reminder control; reminder preserves submission status.

**MIC-158:** replay preserves event identity; assigning a rep notifies only authorized configured recipients.

**SMS adapters (185/187–191):** sandbox/mock verifies routing, successful send, rejected-number; retried callback updates the existing message.

**MIC-100:** a rep export contains only visible records and allowed fields; row count matches the query snapshot; embedded formula text is inert.

**MIC-102:** completing a required action removes only that reason; queue and panel obey deal visibility.

**MIC-104:** a deal submitted to five funders counts as one submitted deal; report total reconciles to drilldown.

**MIC-101:** company totals are not inflated by a multi-rep deal; reversing a ledger entry updates the report.

**MIC-110:** importing a purchased package attaches every created deal to the chosen batch; a source in another workspace cannot be selected.

**MIC-114:** revised offers do not create multiple approval counts; funder earned totals reconcile to the payment ledger.

**MIC-116:** zero-cost batch displays undefined ROI; renewals do not silently inflate acquisition counts.

---

## Verification (required before any Linear Done)

| Check | Owner |
| --- | --- |
| Per-ticket synthetic acceptance (Linear boxes) | Implementer |
| Exclusive-file audit | Conductor after each agent |
| Reviewer spec + quality | Reviewer |
| Ticket tests via `cd nextjs-version && node --conditions=react-server --import tsx --test --test-concurrency=1 <file>` | Conductor after each agent |
| `pnpm test && pnpm typecheck && pnpm lint` | Conductor after each wave |
| Production `pnpm build` | Conductor after Wave 4 |
| Browser | Conductor after Waves 1, 2, 4 |
| Linear comment + Done | Conductor only |

Browser (exercise like a user — click/type/submit — not a single screenshot). Desktop and mobile for new panels:

- After Wave 1: Connections SMS composer on a deal, export as rep vs admin, Remind Funder on an email job vs hidden on API job, lead batch cost + cross-workspace reject.
- After Wave 2: template picker + unknown-variable error, digest opt-in, `/reports` funnel/funder/ROI (permission-off state), team profit no double-count.
- After Wave 4: follow-up skip-on-status-change, webhook replay identity, Home queue reason removal, fallback sender, adapter connection-test fixtures in Settings (no live send).

Honest Done comment template:

> Implemented locally with synthetic fixtures. Remaining gate: \<live Twilio / provider sandbox credentials / none\>. Mock success is not production integration readiness.

---

## Linear status protocol

1. Wave start → `state: "In Progress"` on those issues (MIC-156 already is).
2. Implementer + reviewer + conductor checks green → comment with tests, files, gates. Do not paste secrets.
3. `state: "Done"` only from conductor.
4. If a gate is **product-blocking** (missing schema decision that was not frozen), leave **In Progress** and surface it — do not fake Done.

Expected:

- Platform comms/reporting tickets Done with listed provider/OAuth gates where applicable (MIC-156/190 live Twilio; MIC-146 live sender; MIC-158 reachable HTTPS endpoints).
- Five non-Twilio adapters Done with **provider-access remaining** unless a public contract is too thin to fixture — then In Progress + comment, not silent skip.

---

## Out of scope

- Milestone 07 parity audit (MIC-96, MIC-99)
- Completing M5 live Postmark / DocuSeal / Twilio activation (MIC-106, 108, 157, 168, 156 live handset)
- MIC-111 recurring distributions (still awaiting a validated example)
- Payment CSV export (explicitly a later feature; MIC-100 must distinguish it)
- Changing M1–M5 behavior except mounts (Home, Reports shell, deal composer/export/remind buttons, SMS provider check)
- Live merchant messages

---

## Success

20 Linear issues have an implementer, a reviewer pass, a conductor verification, and a Linear comment. `/reports` is no longer a construction card. Home shows real Needs Action. SMS routing is provider-agnostic with Twilio extracted and five additional fixture adapters. Existing M1–M5 tests still pass, including `tests/milestone05-sms.test.ts`. No live merchant data leaves the workspace.

# Milestone 05 remaining — Offers, funding and commissions

> **For agentic workers:** REQUIRED: one implementer subagent per remaining Linear ticket. Do not re-implement the ten tickets already Done. This session is the senior conductor: it freezes the MIC-111 example, owns schema/migrations/shared mounts, reviews each wave, independently verifies, then marks Linear **Done**. Do not start five editors on shared closing or accounting files.

**Goal:** Close Linear milestone **05 Offers funding and commissions** (`8f1c9349-feca-42c8-b2ac-28263430d190`) on the MCA Next.js app. Ten of fourteen tickets are already Done. Dispatch **five** implementers — one per remaining ticket — then verify and update Linear honestly.

**Architecture:** Offers, advances, payments, renewals, and closing already ship. Remaining product work is (1) reverse consolidation + weekly expected-distribution schedules, and (2) remaining software/activation for four closing tickets that already have synthetic coverage.

**Tech stack:** Next.js App Router 16, Neon Postgres + Drizzle, existing `DealActor` / accounting ledger / closing transports / SMS adapter registry / Postmark closing adapter / DocuSeal PSF provider, AES-GCM (`encryptSensitive`), pnpm, `node:test`.

**Spec:** Live Linear issues on project [MCA](https://linear.app/michael-belenkiy/project/mca-1e94b0617388) (`b223a780-3987-440c-8e04-41516a97e69b`). Local history: `nextjs-version/docs/milestone-05/execution-plan.md`, `integration-acceptance.md`, `provider-activation.md`.

**Workspace:** `/Users/mbele/Desktop/mca` is **not a git repository**. Isolation is exclusive file ownership, not worktrees. Work only in `nextjs-version/`. Always run Drizzle, tsc, tests, and lint from `nextjs-version`, never the workspace root.

---

## Scan result (Linear, 2026-09-08)

Milestone progress is **71.43%** (10/14 Done). Team **Michael Belenkiy** (`MIC`), medium priority.

### Already Done — do not reopen, rewrite, or assign agents

| ID | Title |
| --- | --- |
| [MIC-109](https://linear.app/michael-belenkiy/issue/MIC-109) | Offer records, comparison, revisions and selection |
| [MIC-161](https://linear.app/michael-belenkiy/issue/MIC-161) | Payback, periodic payment and commission calculations |
| [MIC-118](https://linear.app/michael-belenkiy/issue/MIC-118) | Mark offer funded and atomically create advance records |
| [MIC-107](https://linear.app/michael-belenkiy/issue/MIC-107) | Advance ledger, paid-in estimates and performance status |
| [MIC-112](https://linear.app/michael-belenkiy/issue/MIC-112) | Commission and fee payment ledger with automatic payouts |
| [MIC-103](https://linear.app/michael-belenkiy/issue/MIC-103) | Reusable commission split rules and recipient distributions |
| [MIC-105](https://linear.app/michael-belenkiy/issue/MIC-105) | Renewal eligibility, follow-up and repeat funding history |
| [MIC-125](https://linear.app/michael-belenkiy/issue/MIC-125) | Permissioned mock submissions and manual approval capture |
| [MIC-120](https://linear.app/michael-belenkiy/issue/MIC-120) | Import prior funded deals and opening accounting history |

Local evidence: `docs/milestone-05/lane-a-acceptance.md`, `lane-b-acceptance.md`, `integration-acceptance.md`. Accounting uses integer cents and basis points. Funding is transactional. No automatic bank transfer exists.

### Remaining (5) — one subagent each

| ID | Title | Status | Why it is still open | Blocks |
| --- | --- | --- | --- | --- |
| [MIC-111](https://linear.app/michael-belenkiy/issue/MIC-111) | Reverse consolidation and recurring weekly distributions | Backlog | Ticket forbids inventing schedule rules. Public MCA Pilot article is [video-only](https://docs.mcapilot.com/en/articles/12110845-how-to-add-reverse-consolidations-and-schedule-weekly-distributions). No schema or UI exists. | — |
| [MIC-106](https://linear.app/michael-belenkiy/issue/MIC-106) | Stipulation tasks and secure merchant upload requests | In Progress | Software + Railway ClamAV verified. Remaining: authorized recipient and a real Postmark merchant upload-request send. | MIC-108 |
| [MIC-108](https://linear.app/michael-belenkiy/issue/MIC-108) | Contract request, acceptance, repricing and signature tracking | In Progress | Software verified. Remaining: verified submission sender and live contract delivery/evidence. | — |
| [MIC-157](https://linear.app/michael-belenkiy/issue/MIC-157) | PSF document request and webhook-to-signature workflow | In Progress | Generic webhook + DocuSeal provider path exist. Remaining: approved PSF template/bindings, API-enabled DocuSeal credentials, controlled signing run. MIC-158 (M6) is now Done. | — |
| [MIC-168](https://linear.app/michael-belenkiy/issue/MIC-168) | Email or text offers and record merchant pitch | In Progress | Preview/pitch/SMS consent verified synthetically. Remaining: live email/SMS. Closing still types `TwilioSmsTransport` instead of the M6 `SmsAdapter` port. | — |

```
MIC-103 ✓ + MIC-107 ✓ ──► MIC-111 (only new product code)

MIC-106 (software ✓, live email gate)
   └──► MIC-108 (software ✓, live contract email/evidence gate)

MIC-157 (software ✓, DocuSeal credentials gate)  [MIC-158 ✓]
MIC-168 (software ✓, live email/SMS gate; wire SmsAdapter)
```

---

## Frozen MIC-111 example (plan approval = validation)

The ticket says: *“Detailed fields and formulas above are proposed and require a validated example before implementation.”* Approving this plan validates the following example. Do not invent other formulas, APR, bank-transfer behavior, or undocumented document templates.

**Worked example**

- Four expected weekly installments of **$1,000.00** (`100000` cents) each.
- Due on **Mondays**, starting **2026-10-05**, so due dates are 2026-10-05, 2026-10-12, 2026-10-19, 2026-10-26.
- Split **60/40** using a MIC-103 split template (6000 / 4000 basis points). Largest-remainder already implemented in `accounting/calculations.ts`.
- Each installment is an **expected distribution schedule row**, not a bank transfer and not a collected receipt.
- Re-running the scheduler creates each `(scheduleId, occurrenceDate, recipientMembershipId)` once.
- Pause / exception / amendment / cancel version the schedule. **Paid** installments stay immutable. Only **unpaid future** rows are voided and regenerated.
- Reverse consolidation is a product record on a deal that **references existing advances/obligations** and attaches this same weekly schedule. It does not rewrite prior funding, commission, or paid-distribution history.

**Acceptance that must pass before Linear Done**

- Scheduler retry creates each installment once.
- Amendment changes future unpaid installments without rewriting paid entries.
- Direct API authorization matches the Payments UI permission (`payments` feature + payment-table permission).
- Loading, empty, validation, success, and failure UI states exist.
- Logs exclude secrets.

---

## Current code (starting point)

**Already real (do not rewrite):**

- Offers, funding, advances, payments, splits, renewals: `src/lib/mca/{offers,funding,advances,accounting,renewals,historical}/` plus dashboard pages and deal-dialog tabs.
- Closing: stipulations, expiring upload tokens, Request Info, contract/repricing, PSF generic webhook + DocuSeal provider, offer email/text previews, phone pitch. Tests in `tests/milestone05-closing.test.ts` (7/7) and `tests/milestone05-closing-postmark.test.ts`.
- SMS accounts + M6 `SmsAdapter` registry (`twilio|entrance|texttorrent|textus|openphone|gohighlevel`). Closing still imports `TwilioSmsTransport` from `sms/twilio.ts`.
- Postmark closing adapter behind `MCA_CLOSING_EMAIL_PROVIDER=postmark` and `MCA_CLOSING_POSTMARK_CONNECTIONS_JSON`. Pending merchant/submission sender rows exist in Railway secrets; **no live send was performed**.
- Production: `https://fundlane.io` on Railway project `Fundlane`, Neon production migrated. DocuSeal PSF remains unconfigured (`MCA_DOCUSEAL_PSF_CONNECTIONS_JSON`).

**Not built:** reverse-consolidation tables, weekly distribution scheduler, schedules UI.

---

## Team

| Agent | Ticket | Owns (exclusive) | Must not touch |
| --- | --- | --- | --- |
| Conductor (this session) | Wave 0 contracts, schema, mounts, Linear Done | `db/schema.ts`, `db/milestone05-*.ts`, `drizzle/**`, `accounting/contracts.ts`, `accounting/service.ts`, `accounting/repository.ts`, `payments-panel.tsx`, `payments/page.tsx`, `closing/service.ts`, `closing-panel.tsx`, `package.json`, Linear state | — |
| A1 | MIC-111 | `src/lib/mca/accounting/schedules.ts`, `src/app/api/mca/accounting/schedules/**`, `src/components/mca/accounting/schedules-panel.tsx`, `tests/milestone05-schedules.test.ts`, `docs/milestone-05/MIC-111-{brief,report,acceptance}.md` | schema.ts, drizzle, payments-panel, existing accounting service/repository |
| A2 | MIC-106 | `src/lib/mca/closing/stipulation-activation.ts` (only if a real remaining software gap exists), `docs/milestone-05/MIC-106-{report,acceptance}.md`, focused tests under `tests/milestone05-mic-106*.test.ts` | closing/service.ts, closing-panel.tsx, schema |
| A3 | MIC-108 | `src/lib/mca/closing/contract-activation.ts` (same rule), `docs/milestone-05/MIC-108-{report,acceptance}.md`, `tests/milestone05-mic-108*.test.ts` | closing/service.ts, closing-panel.tsx, schema |
| A4 | MIC-157 | `src/lib/mca/closing/psf-activation.ts` if needed, `docs/milestone-05/MIC-157-{report,acceptance}.md`, `tests/milestone05-mic-157*.test.ts` | closing/service.ts, psf-docuseal-service.ts (read-only unless a proven bug), schema |
| A5 | MIC-168 | `src/lib/mca/closing/offer-sms.ts` (SmsAdapter-backed merchant offer text), `docs/milestone-05/MIC-168-{report,acceptance}.md`, `tests/milestone05-mic-168*.test.ts` | sms/adapters/registry.ts, sms/service.ts, closing/service.ts, closing-panel.tsx |

Max **5** parallel. One wave of remaining tickets is enough; MIC-111 does not block the four closing agents.

---

## Wave 0 — conductor (before any implementer)

1. Write `docs/milestone-05/remaining-plan.md` (copy of this plan) and per-ticket briefs.
2. Add empty exclusive files listed above so agents do not create colliding paths.
3. Draft schema fragment **`src/lib/mca/db/milestone05-schedules.ts`** (conductor-owned). Register it in `schema.ts` only after A1 publishes the contract. Generate **one** Drizzle migration from `nextjs-version` (`pnpm db:generate`).
4. Freeze ports in `accounting/contracts.ts` (conductor):

```ts
export type DistributionScheduleStatus = "active" | "paused" | "cancelled"
export type ScheduledInstallmentStatus = "expected" | "paid" | "void"

export interface ReverseConsolidation {
  id: string
  dealId: string
  referencedAdvanceIds: string[]
  scheduleId: string
  createdAt: string
}

export interface DistributionSchedule {
  id: string
  workspaceId: string
  reverseConsolidationId: string
  status: DistributionScheduleStatus
  version: number
  startDate: string          // calendar date, Monday
  installmentCount: number
  installmentCents: number
  splitTemplateId: string
  splitTemplateVersion: number
}

export interface ScheduledInstallment {
  id: string
  scheduleId: string
  scheduleVersion: number
  occurrenceDate: string     // unique with recipient
  recipientMembershipId: string
  amountCents: number
  status: ScheduledInstallmentStatus
}
```

5. Mount points (conductor, after A1): render `<SchedulesPanel />` on `/payments` below the existing ledger. Do not edit `payments-panel.tsx` inside A1.
6. Wire A5's `offer-sms.ts` into `sendMerchantOfferPreview` after A5 finishes. Keep existing Twilio env fixtures green.

Proposed tables (names may tighten during generate, not during agent edits): `mca_reverse_consolidations`, `mca_distribution_schedules`, `mca_distribution_schedule_versions`, `mca_scheduled_installments` with unique `(workspace_id, schedule_id, occurrence_date, recipient_membership_id)` and integer-cent amounts.

Scheduler endpoint: `POST /api/mca/accounting/schedules/run` with the same worker-auth pattern as comms jobs. Do **not** register this as a `registerCommsJob` kind.

---

## Wave 1 — five parallel implementers

### A1 — MIC-111 (only greenfield ticket)

- Implement create/list reverse consolidation against existing advances in the same workspace/deal.
- Create schedule version 1 from the frozen example fields (start Monday, count, cents, split template).
- `run` materializes unpaid expected installments with stable occurrence keys; second run inserts zero duplicates.
- Pause, cancel, exception, and amendment: new version; void unpaid future; never mutate `paid`.
- Marking an installment paid is an accounting state change only — no ACH/transfer.
- UI: schedules panel with empty/loading/error/success, run, pause, amend, cancel.
- Tests on a disposable DB from `tests/helpers/postgres-test-db.mjs`. Never migrate production from the agent.

### A2 — MIC-106

Software is implemented. Agent job:

1. Re-read Linear AC and `lane-c-acceptance.md`. Hunt for remaining software gaps (token isolation, Request Info preview identity, public upload page).
2. If a gap is real, fix it in the exclusive file and add a focused test. If not, write `REVIEW_PASS` with file:line evidence and **do not churn closing-panel**.
3. Produce an activation checklist: pending Postmark merchant sender, authorized recipient, Test-sender then one Request Info send. **Do not send live email.**
4. Report remaining gate in the ticket docs.

### A3 — MIC-108

Same pattern for contract/repricing/signature. Confirm a request still does not mark signed; missing DL/VC remains a blocker or explicit exception. No live funder email.

### A4 — MIC-157

Same pattern for PSF. Confirm failed webhook stays failed; confirmation reuses one external request identity. Do not invent a DocuSeal template or paste API tokens. MIC-158 mapping may be cited; do not rewrite `comms/webhooks.ts`.

### A5 — MIC-168

Remaining software: merchant offer **text** should go through `getSmsAdapter` like the M6 composer, not a Twilio-only transport type.

- Implement `closing/offer-sms.ts` that calls `deliverClosingSms` / `getSmsAdapter` and returns the existing `ClosingTransport` shape.
- Tests: preview hash matches send; failed adapter result records no pitch; unknown provider outcome stays unpitched.
- Conductor wires the module into `closing/service.ts`.
- No live SMS or email.

Each agent writes `docs/milestone-05/MIC-XXX-{report,acceptance}.md` and must not mark Linear Done.

---

## Wave 2 — conductor integration and Linear

1. Register `milestone05-schedules.ts`, generate/apply migration **only** on disposable DBs (and production only if the user later authorizes a deploy).
2. Mount `SchedulesPanel` on `/payments`. Export from `accounting/index.ts`.
3. Wire `offer-sms.ts`. Restore `TwilioSmsTransport` fixtures if tests need the optional override.
4. Run:

```bash
cd nextjs-version
node --conditions=react-server --import tsx --test --test-concurrency=1 \
  tests/milestone05-schedules.test.ts \
  tests/milestone05-accounting-core.test.ts \
  tests/milestone05-accounting-db.test.ts \
  tests/milestone05-closing.test.ts \
  tests/milestone05-sms.test.ts
pnpm typecheck
```

5. Browser-verify `/payments` schedules (synthetic data only) if a local/dev server is available.
6. Graphify incremental update after final code.
7. Linear: only the conductor updates state.

### Linear Done policy (plan approval = this policy)

| Ticket | Mark Done when | Remaining gate to document on the issue |
| --- | --- | --- |
| MIC-111 | Focused tests + typecheck + UI empty/error/success | None for software. No bank transfer, by design. |
| MIC-106 | Software re-verified; no new regressions | Authorized merchant recipient + real Postmark Request Info delivery |
| MIC-108 | Software re-verified | Verified submission sender + live contract delivery/evidence |
| MIC-157 | Software re-verified; MIC-158 available | DocuSeal API token, approved PSF template/bindings, controlled signing run |
| MIC-168 | SmsAdapter wired; pitch-failure tests green | Live merchant email/SMS to a controlled recipient/handset |

This matches Milestone 6: software-complete tickets become Done with explicit remaining provider gates. Mock or synthetic transport success is **not** claimed as production send readiness. **No live merchant email, SMS, webhook, or DocuSeal signing request is sent during execution.**

If the user later supplies Postmark/Twilio/DocuSeal credentials and authorizes named recipients, run a separate activation wave. Do not fold live sends into Wave 1.

---

## Constraints (every agent)

- No MCA Pilot endpoint copying.
- No live merchant SMS/email/webhooks/signing unless the user later authorizes a named recipient.
- No production `db:migrate` without explicit user approval.
- Exclusive files only. If you need a conductor-owned file, stop and report `NEEDS_CONDUCTOR`.
- Honest Linear: remaining provider gates stay on the issue comment.
- Tests use disposable databases from `tests/helpers/postgres-test-db.mjs`.

---

## Out of scope

- Re-implementing the ten Done tickets.
- MIC-184 inbound MX (Milestone 2, still In Progress).
- Milestone 7 launch/parity.
- A dedicated MIC-117 settings panel.
- Inventing DocuSeal PSF field names or a reverse-consolidation formula beyond the frozen example.

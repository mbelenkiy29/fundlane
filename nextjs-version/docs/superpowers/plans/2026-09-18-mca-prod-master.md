# MCA Production Hardening — Master Orchestration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Execute **one workstream at a time** (or parallel only where the DAG says so). Do not start Wave 2 until Wave 0+1 contracts exist.

**Goal:** Make Fundlane safe for a live MCA brokerage: workers actually process jobs, bank files are scanned, underwriting math matches shop rules, submits cannot double-fire, closing cannot send to the wrong inbox, remittance and commissions tell the truth, and tenant PII hashes stay isolated.

**Architecture:** Six workstream teams, each with its own plan file. The master plan owns sequencing, shared contracts, migration numbers, and file ownership. Implementers read **this file plus their workstream plan**. Conflicts resolve against this file, then the workstream plan.

**Tech Stack:** Next.js 16 / React 19 in `nextjs-version/`, Supabase Postgres + Auth + Storage, Render document/messaging workers, Drizzle hand-written SQL, `node:test` + `MCA_TEST_DATABASE_ADMIN_URL`.

**Spec:** Production MCA audit (2026-09-18 conversation). Workstream plans:

| Team | Plan |
| --- | --- |
| A Workers & scan | `2026-09-18-mca-prod-a-workers-scan.md` |
| B Underwriting | `2026-09-18-mca-prod-b-underwriting.md` |
| C Submissions | `2026-09-18-mca-prod-c-submissions.md` |
| D Closing & offers | `2026-09-18-mca-prod-d-closing.md` |
| E Money & remittance | `2026-09-18-mca-prod-e-money.md` |
| F Tenancy & PII | `2026-09-18-mca-prod-f-tenancy-pii.md` |
| G Later (not this program) | Section “Wave 6” below |

## Global constraints

- Work only in `nextjs-version/` (plus root `render.yaml` / `graphify-out/` if A or docs require it). Never `vite-version/` or root template `docs/`.
- Isolated Postgres only. Never hosted Supabase / production data.
- Integer cents. Workspace isolation in the **service**, not CSS.
- Do not enable `MCA_APPLICATION_INVITATION_EMAIL_ENABLED`, `MCA_SMS_ISV_APPROVED`, `MCA_STRIPE_BILLING_ENABLED`, `MCA_CALENDAR_GOOGLE_ENABLED` as part of this program.
- Do not rotate `MCA_DATA_ENCRYPTION_KEY`.
- Do not implement Wave 6 items in Waves 0–5.
- After a workstream’s tests pass: `pnpm typecheck` from `nextjs-version/`, then `graphify update .` from repo root.
- Migration numbers are assigned **here**. Workstream drafts that say `0040` are wrong; use the table below.

## Migration numbers (journal starts at idx 36 = `0039_fundlane_forms`)

| File | Owner | Contents |
| --- | --- | --- |
| `drizzle/0040_document_worker_heartbeat.sql` | A | `mca_private.ops_control.document_worker_heartbeat_at` |
| `drizzle/0041_underwriting_policy_v2.sql` | B | statement NSF/neg dates; aggregate deposit_count / worst_month_nsf / warnings; `deals.requested_term_months` |
| `drizzle/0042_submission_duplicate_identity.sql` | C | `merchant_identity_key`, `package_fingerprint`; job states `declined`/`funded` |
| `drizzle/0043_closing_upload_and_offer_expiry.sql` | D | `mca_merchant_upload_links.token_cipher`; `mca_offer_revisions.expires_at` + 14-day backfill |
| `drizzle/0044_money_remittance.sql` | E | installment `amount_cents >= 0`; `received_on`; payment/distribution status `written_off` |
| `drizzle/0045_tenancy_ein_hmac.sql` | F | unique `(workspace_id, ein_hash)` where hash not null; hmac backfill is application job, not SQL of ciphertext |

Journal idx: 37–42 in that order.

## Locked product decisions

1. Deal documents fail closed until scan `clean`. Historical `ready` stays usable via `isDocumentReady`.
2. Vercel may enqueue jobs; a live worker must claim them. Surface heartbeat lag. Edge documents stay 503.
3. Completeness = last N **closed** months in workspace TZ + ready application + checking months + driver license + voided check. Filename never covers.
4. NSF/negative days = unique calendar days in the lookback window. Persist worst-month NSF. Two accounts, same 5 days = 5.
5. Hard DQ includes ADB, requested amount, term, deposit count. Unknown still DQ. Auto-select grade **C+** only.
6. `defaultFlag` is not `deal.status === "default"`. Confirmed default-ish position or DataMerch Default/Slow pay; else false. DataMerch not required.
7. `positionCount` = confirmed only. Proposed blocks automatic_send.
8. Duplicate lock = workspace + merchant identity (EIN hash else merchantId else dealId) + funder. No 24h expiry. Decline/funded + same package stays blocked. `privilegedRetry` = admin session + reason.
9. Outbox resumes `sending`. Enqueue `submission_delivery`. Send packaged bytes. Watermark enabled + no logo = fail closed. Production preview ≠ sent.
10. Recipients bind to deal contact / funder route. Upload URLs mint at send. ABA checksum. Offers expire in 14 days. One selected revision unless split-fund.
11. Remittance: leftover $0 stays 0; receipts match by amount; one workspace TZ; renewal = collected/payback; no clawback of paid splits; write off unpaid expected commission on default.
12. `hmacLookup` includes `workspaceId`. Unique EIN per workspace. `forceDuplicate` attaches, does not insert a second EIN.
13. Hide money in services when `!canViewCompanyFinancials`.

## Team and file ownership

Do not edit another team’s owned files except the listed **touch points**.

| Path | Owner | Others may |
| --- | --- | --- |
| `documents/service.ts`, `scanner.ts`, `jobs/worker.ts` heartbeat/recover enqueue, `operations/*` | A | C calls `enqueueSubmissionDelivery` only |
| `underwriting/*` except `submission-port` call from C | B | C imports `evaluateUnderwritingSendGates` / `checkCompleteness` |
| `submissions/*` | C | A does not change `outbox.ts` resume internals |
| `offers/*`, `closing/*` | D | C writes `mca_offers` via `createOffer` |
| `accounting/*`, `advances/performance.ts`, `deals/remittance.ts`, `deals/book*.ts`, `renewals/*`, `funding/service.ts`, `home/kpis.ts`, `reports/team-profit.ts` | E | F reuses `actorCanViewCompanyFinancials` |
| `crypto.ts` hmacLookup, `merchants/*`, deal list financial hide, intake rate limit, applications TTL, privacy-notice | F | C calls `einLookupHash` after F’s hmac change |

**Shared helper (create once, reuse):**

```ts
// src/lib/mca/policy.ts
export function actorCanViewCompanyFinancials(
  role: Role | null | undefined,
  actionVisibility: ActionVisibility,
): boolean
```

Owner: **E Task 7**. F and book/deal-list must import it, not fork.

**Shared send gate:**

```ts
// src/lib/mca/underwriting/send-gates.ts
export async function evaluateUnderwritingSendGates(actor: DealActor, dealId: string): Promise<{
  ok: boolean
  completenessReady: boolean
  proposedPositionCount: number
  reasons: Array<"completeness_not_ready" | "positions_unconfirmed">
}>
```

Owner: **B**. C calls it inside `queueSubmissions`.

**Shared delivery enqueue:**

```ts
// src/lib/mca/submissions/delivery-job.ts
export function submissionDeliveryActor(job: { workspaceId: string; dealId: string; id: string }): DealActor
export async function enqueueSubmissionDelivery(job: { workspaceId: string; dealId: string; id: string }): Promise<void>
```

Owner: **C**. A’s `recoverSubmissionOutbox` calls `enqueueSubmissionDelivery` (system actor + `intakeDealId`). Do not implement recover twice.

## Execution DAG

```
Wave 0  A (scan + enqueue document_scan + heartbeat)
          │
          ├─ Wave 1a  F hmacLookup + EIN unique + hash backfill
          ├─ Wave 1b  B underwriting policy v2 (needs A’s clean docs for completeness)
          └─ Wave 1c  E Task 1 leftover-0 + millionths (no file overlap)
                │
Wave 2  C submissions (needs B send-gates, F hashes, A worker enqueue)
                │
          ├─ Wave 3  D closing (needs C mca_offers bridge)
          ├─ Wave 4  E remainder (money/TZ/receipts/renewal/hide/KPIs)
          └─ Wave 5  F remainder (rate limit, apply TTL, privacy, audits)
                │
Wave 6  deferred product (see below) — separate program
```

Parallel inside a wave is allowed **only** on disjoint file sets.

Recommended implementer teams (subagent-driven, one task at a time **per workstream**; two workstreams may run in parallel when the DAG allows):

| Subagent label | Workstream | Model |
| --- | --- | --- |
| `[impl-a]` | A mechanical scan/enqueue | standard |
| `[impl-b]` | B underwriting math | most capable |
| `[impl-c]` | C submissions/outbox | most capable |
| `[impl-d]` | D closing | standard |
| `[impl-e]` | E money | most capable |
| `[impl-f]` | F tenancy | standard |
| `[reviewer]` | per-task then whole-branch | most capable |

Do **not** run B completeness tests expecting `ready` until A’s scanner tests exist (or B stubs `setDocumentScannerForTests(clean)` as today).

## Wave 0 — Team A: Workers and scan

Must ship before treating uploads/submits as live.

1. Wire `documentScanner()` Cloudmersive; unconfigured stays `unavailable`.
2. `completeDocumentUpload` scans; promote only on `clean`.
3. HTTP uploads enqueue `document_scan` when `backgroundJobsEnabled() && !inBackgroundWorker()`.
4. Fix tests/docs/UI that assumed skip-scan `ready`.
5. Confirm path enqueues `submission_delivery` when jobs enabled (inline when jobs off so unit tests still send).
6. `recoverSubmissionOutbox` enqueues via C’s helper (if C helper not merged yet, A may add a thin `enqueueSubmissionDelivery` in `jobs/worker.ts` and C moves it — **Ruling:** prefer C creating `delivery-job.ts` first if Wave 2 is close; otherwise A adds the helper and C relocates). Safer ruling: **A creates `delivery-job.ts` in Wave 0** with system+`intakeDealId`; C extends it in Wave 2. Master assigns `delivery-job.ts` to **A then C**.
7. Heartbeat column + admin/health lag.
8. Honest fail-closed copy for invitation email / SMS / Stripe / calendar.
9. Keep Edge documents 503.

**Done when:** `tests/documents-core.test.ts` fail-closed; unconfigured scan ≠ ready; jobs-enabled upload inserts `document_scan`; health exposes heartbeat; no production flag flipped.

## Wave 1 — Teams B + F (hmac) + E (math only)

### B Underwriting

1. `POLICY_VERSION = 2`; `lookback.ts` closed months in workspace TZ.
2. Extraction: real account kinds, NSF/neg dates, transfer/MCA warnings. Migration `0041`.
3. `aggregates.ts` unique-day NSF, worst-month, confirmed positions, skip current/unknown periods.
4. Completeness: extraction-only coverage, DL + voided check.
5. Optional `requestedTermMonths`.
6. `defaultFlag` from confirmed positions / DataMerch.
7. Hard DQ ADB/amount/term/deposit_count; NAICS prefix.
8. Send gates + auto-select C+; block `automatic_send`.
9. UI copy for unique-day NSF and confirmed positions.
10. Rewrite tests that encoded NSF-sum / UTC current month / filename-ready.

**Done when:** two accounts same 5 NSF days → 5; Sep 18 NY lookback is Jun–Aug; F grade not auto-selected; automatic_send blocked without completeness.

### F hmac + EIN (must precede C duplicate persist)

1. `hmacLookup(kind, workspaceId, normalized)` → HMAC of `` `${kind}:${workspaceId}:${normalized}` ``.
2. Backfill job: recompute `ein_hash` / identity last-4 hashes in place (not ciphertext).
3. Unique index `(workspace_id, ein_hash)` where hash is not null.
4. `forceDuplicate` is admin-only, attaches to existing merchant, audits. No second EIN row.

**Done when:** two workspaces same EIN have different hashes; second insert of same EIN in one workspace attaches.

### E Task 1 only

Leftover installment `0` stays `0`; `ratioFromMillionths`; start `0044` with `amount_cents >= 0`.

## Wave 2 — Team C: Submissions

1. Persist merchant identity + package fingerprint (`0042`).
2. Duplicate policy as locked; rewrite 24h tests.
3. `privilegedRetry` admin session only.
4. Call B send-gates + `isDocumentReady` originals; DataMerch warn only.
5. Resume `sending` attempts; enqueue `submission_delivery`.
6. Packaged email bytes; watermark fail-closed; production preview ≠ sent.
7. Reply match: no unique-domain zero-hit; extract skip offers when `requiresReview`; bridge `mca_offers`; job `declined`/`funded`.
8. Webhook `eventId` required; outbound DNS private-IP block.

**Done when:** 24h later same package still blocked; EIN across deals blocked; sending attempt resumes; extract without terms writes zero offers.

## Wave 3 — Team D: Closing

1. Bind recipients; admin override + audit.
2. Preview uses `[secure-upload:id]`; mint random token at send (`0043` token_cipher).
3. ABA checksum; PSF email = deal contact.
4. `expiresAt` default +14 days; block new select/fund when expired.
5. Highest = amount desc then factor asc.
6. One selected revision unless `product` is split-fund.
7. Render honest productionGates.
8. DocuSeal ABA only; do not rebuild provider.

**Done when:** preview has no live upload URL; `123456789` routing rejected; second MCA select 409s; highest picks lower factor on amount tie.

## Wave 4 — Team E remainder

Timezone + `received_on`; amount-aware receipts + void API; funding fingerprint + explicit schedule; renewal from collected; write-off unpaid expected commission; hide book/advance money; home KPI relabel + merchantCollectionsToday; team-profit unassigned ledger.

**Done when:** $1 receipt does not clear a $1,000 installment; renewal ignores calendar estimate; funding key + different amount → 409; rep book JSON omits principal.

## Wave 5 — Team F remainder

Await intake rate limit; apply invite 7-day TTL + iframe `referrerPolicy=no-referrer` (not consume-on-open if that breaks Jotform resume); privacy notice GLBA/Vercel/Supabase (drop Clerk/Neon/Render); audit document download redeem + merchant-upload inspect; HighLevel public key fail-closed in production.

## Wave 6 — Later program (do not build now)

Tracked so “all audit items” are not dropped:

| Item | Hook later |
| --- | --- |
| First-party apply (replace Jotform) | `applications/`, `public-application.tsx` |
| Cross-workspace ISO stacking | new company-level merchant index; privacy review first |
| DataMerch required / inquiry throttle | `datamerch/service.ts` + B defaultFlag unknown |
| Deposit true-up (strip transfers/MCA credits) | `aggregates.ts` warnings already |
| OFAC / UCC / bureau FICO | new modules |
| Holdback % / true split / ACH processor / lockbox / bank holidays / first-pay offset | E follow-ups |
| Paid-commission clawback / revive write-offs | `accounting/service.ts` |
| Assignment-scoped API keys | `access-policy.ts` |
| Encryption key rotation (dual-key) | `crypto.ts` |
| GDPR erasure / legal hold | new retention module |
| Live Stripe / SMS ISV / invitation email / Google calendar | env flags only after workers Live |
| Syndication / participation | new ledger |

## Cross-cutting rulings (do not re-open in workstreams)

1. **`delivery-job.ts`:** A creates it in Wave 0; C owns it after Wave 2 starts.
2. **`recoverSubmissionOutbox`:** A implements enqueue; C must not replace it with log-only. C may extend the query. Legacy actorless rows stay log-only.
3. **Financial hide convention:** omit keys + `financialsHidden: true`. Never send `0` as a stand-in.
4. **Term months:** optional on deals; if a funder has a term rule and the deal has no term → unknown → DQ. Do not invent `paymentCount` from term.
5. **DataMerch:** warn on submit, never hard-block in this program.
6. **ISO stacking across workspaces:** Wave 6 only.

## Verification (program)

From `nextjs-version/` after each wave:

```bash
pnpm test
pnpm typecheck
pnpm lint
```

Targeted suites are listed in each workstream plan.

From repo root after code:

```bash
graphify update .
graphify cluster-only . --no-label
```

Ops (not code): manual-deploy Render document worker; confirm `/admin/status` heartbeat; do not claim processing live until that is green.

## Execution choice

This master plan is ready. Two ways to run it:

1. **Subagent-driven (recommended)** — orchestrator stays in this session, one implementer subagent per task inside the current wave, review between tasks. Start Wave 0 Task 1.
2. **Inline** — same DAG, implementer is this session using executing-plans.

Do not start all six teams at once. Wave 0 first.

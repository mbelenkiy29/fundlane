# Milestone 03 agent team — underwriting and funders

> **For agentic workers:** One implementer subagent per Linear ticket, dispatched in dependency waves. The controller session is the conductor: it freezes contracts, owns shared files, reviews each wave, and updates Linear. Do not start ten editors at once.

**Goal:** Deliver all 10 Linear tickets in milestone **03 Underwriting and funders** with the same isolation, fixture honesty, and permission model as milestones 01–02.

**Architecture:** Two new domains (`funders`, `underwriting`) plus an isolated Data Merch adapter. Ticket agents own exclusive files. The conductor owns shared mounts (`deals-workspace.tsx`, settings, `package.json`, placeholder `/funders` route). Cross-milestone blockers (MIC-166, MIC-121) stay fail-closed interfaces — they are not pulled into this milestone.

**Tech stack:** Next.js App Router, Node 24 SQLite, existing `DealActor` / document vault / OpenAI Responses extraction, pnpm, `node:test`.

**Spec:** Live Linear issues on project [MCA](https://linear.app/michael-belenkiy/project/mca-1e94b0617388), milestone `03 Underwriting and funders`. Local M2 pattern: `nextjs-version/docs/milestone-02/implementation-plan.md`.

## Why not ten agents at once

The tickets form a DAG. Parallel editors on the same SQLite schema, deal panel, and scoring inputs will corrupt each other. Milestone 02 succeeded with exclusive paths and three lanes. This plan keeps **one agent per ticket** and runs them in **four waves** so dependents consume frozen APIs, not half-written files.

The parent folder is **not a git repository**, so git worktrees cannot isolate edits. Exclusive file ownership is the isolation mechanism.

```
MIC-95 ✓ ──► MIC-192 directory
                 └──► MIC-170 eligibility
                          ├──► MIC-194 criteria scan (also MIC-169 ✓)
                          └──► MIC-163 scoring
MIC-169 ✓ ──► MIC-179 bank underwriting
                 ├──► MIC-172 corrections ──► MIC-163 scoring
                 └──► MIC-180 Data Merch
MIC-169 ✓ ──► MIC-164 completeness
MIC-164 + MIC-163 + MIC-166 (M4, out of scope)
              └──► MIC-148 auto modes
                     └──► MIC-150 review email
                            also blocked by MIC-121 (M6, out of scope)
```

## Rulings (frozen before dispatch)

1. **Do not implement MIC-166 or MIC-121 in this milestone.** MIC-148 `automatic_send` and MIC-150 production sender connections are fail-closed. Analyze-only and review-first must be complete. Automatic send records a run snapshot and returns `submission_unavailable` until MIC-166 exists. Review email uses the existing `MCA_EMAIL_WEBHOOK_URL` contract with a new template; it does not build sender-connection UI.
2. **Default analysis mode is `review_first`.** Admin must enable `automatic_send`. Workspace defaults are snapshotted per run.
3. **Scores are fit, not approval probability.** Hard restrictions run before scoring. Disqualified funders cannot be auto-selected.
4. **Unknown is not zero.** Corrupt scans, unspecified limits, and missing months stay flagged. No numeric sentinels for “unspecified.”
5. **Checking-account statements only** for MIC-179. Savings/credit-card/loan documents in the statement category are `unsupported`, not blended.
6. **Data Merch selected contract:** `GET https://api.datamerch.com/v2/merchants` with `Authorization: Bearer <key>` and query `q` = EIN (fallback legal name). Response mapping is documented in the adapter; live credentials remain an external gate. Fixtures prove the path.
7. **Yearly revenue criteria convert explicitly to monthly** (`annual / 12`) and store both unit and operator. Conflicting min/max cannot publish.
8. **Funder directory is the source of truth for names.** Deal `deal_submissions.funder_name` stays a display cache. New matching uses funder IDs.
9. **Admins configure; deal-visible roles read.** Directory/criteria/Data Merch config: `admin` / `super_admin`. Scoring, completeness, statement tables, review actions: same visibility as the deal (`deals:read` / `deals:write`).
10. **Local fixture success ≠ production verified.** Same completion evidence rule as M2.

## Team

| Agent | Ticket | Specialty | Wave |
| --- | --- | --- | --- |
| Conductor (this session) | none | Contracts, shared mounts, Linear, wave review, final verification | 0 and after each wave |
| Agent MIC-192 | [MIC-192](https://linear.app/michael-belenkiy/issue/MIC-192) | Funder directory, contacts, groups, routes | 1 |
| Agent MIC-179 | [MIC-179](https://linear.app/michael-belenkiy/issue/MIC-179) | Bank-statement underwriting and positions | 1 |
| Agent MIC-164 | [MIC-164](https://linear.app/michael-belenkiy/issue/MIC-164) | Document completeness / readiness | 1 |
| Agent MIC-170 | [MIC-170](https://linear.app/michael-belenkiy/issue/MIC-170) | Eligibility rules and NAICS aliases | 2 |
| Agent MIC-172 | [MIC-172](https://linear.app/michael-belenkiy/issue/MIC-172) | Manual corrections and stale scores | 2 |
| Agent MIC-180 | [MIC-180](https://linear.app/michael-belenkiy/issue/MIC-180) | Data Merch config, run, result viewer | 2 |
| Agent MIC-194 | [MIC-194](https://linear.app/michael-belenkiy/issue/MIC-194) | AI scan of funder criteria PDFs/images | 3 |
| Agent MIC-163 | [MIC-163](https://linear.app/michael-belenkiy/issue/MIC-163) | Explainable scoring, rank, disqualify | 3 |
| Agent MIC-148 | [MIC-148](https://linear.app/michael-belenkiy/issue/MIC-148) | Analyze / review-first / auto-send modes | 4 |
| Agent MIC-150 | [MIC-150](https://linear.app/michael-belenkiy/issue/MIC-150) | Review email + authenticated selection | 4 (after 148) |

Each ticket agent is paired with a **ticket reviewer** after it reports DONE (spec + quality). Reviewers are read-only. Ticket agents never spawn their own reviewers or sibling implementers.

Max parallel implementers: **3** (Wave 1 and Wave 2). Wave 3: 2. Wave 4: 148 then 150 sequentially.

## Wave 0 — conductor (before any ticket agent)

Write `nextjs-version/docs/milestone-03/implementation-plan.md` (this design, copied into the repo) and freeze the TypeScript contracts below in empty modules that compile.

Create directories only; do not implement ticket behavior.

- Create: `src/lib/mca/funders/contracts.ts`
- Create: `src/lib/mca/underwriting/contracts.ts`
- Create: `src/lib/mca/datamerch/contracts.ts`
- Create: `docs/milestone-03/lane-*-acceptance.md` placeholders per ticket after each agent lands
- Linear: set the 10 issues to In Progress when their wave starts; do not mark Done until local acceptance + reviewer pass

### Frozen contracts (verbatim for implementers)

```ts
// src/lib/mca/funders/contracts.ts
import type { DealActor } from "../deals/schema"

export const FUNDER_ROUTE_KINDS = ["email", "api", "manual_portal", "custom_webhook"] as const
export type FunderRouteKind = (typeof FUNDER_ROUTE_KINDS)[number]

export const CRITERIA_OPERATORS = ["min", "max", "eq", "in", "not_in"] as const
export type CriteriaOperator = (typeof CRITERIA_OPERATORS)[number]

export const CRITERIA_UNITS = [
  "usd_monthly", "usd_annual", "usd", "count", "days", "months", "years",
  "fico", "percent", "naics", "state", "entity", "boolean", "unspecified",
] as const
export type CriteriaUnit = (typeof CRITERIA_UNITS)[number]

export interface FunderContact {
  id: string
  name?: string
  email?: string
  phone?: string
  role?: string
}

export interface FunderRoute {
  id: string
  kind: FunderRouteKind
  label: string
  destination: string
  documentExceptions: string[]
  active: boolean
}

export interface FunderRecord {
  id: string
  workspaceId: string
  legalName: string
  nickname?: string
  website?: string
  domains: string[]
  products: string[]
  active: boolean
  contacts: FunderContact[]
  routes: FunderRoute[]
  criteriaVersion: number
  profileVersion: number
  createdAt: string
  updatedAt: string
}

export interface FunderGroup {
  id: string
  workspaceId: string
  name: string
  funderIds: string[]
  createdAt: string
  updatedAt: string
}

export interface EligibilityRule {
  id: string
  funderId: string
  field: string
  operator: CriteriaOperator
  unit: CriteriaUnit
  value: string | number | string[] | boolean | null
  sourceText?: string
  unspecified: boolean
}

export interface IndustryAlias {
  id: string
  workspaceId: string
  alias: string
  naics?: string
  normalizedIndustry: string
}

export interface CriteriaScanProposal {
  id: string
  funderId: string
  documentId: string
  version: number
  rules: EligibilityRule[]
  warnings: string[]
  evidence: Record<string, { confidence: number; page?: number; text?: string; unknown?: boolean }>
  provider: string
  requestId?: string
  status: "proposed" | "accepted" | "rejected"
}
```

```ts
// src/lib/mca/underwriting/contracts.ts
import type { DealActor } from "../deals/schema"

export const STATEMENT_ACCOUNT_KINDS = ["checking", "savings", "credit_card", "loan", "unsupported"] as const
export type StatementAccountKind = (typeof STATEMENT_ACCOUNT_KINDS)[number]

export interface MetricEvidence {
  value: number | null
  unknown: boolean
  page?: number
  text?: string
  confidence: number
}

export interface StatementMonthRecord {
  id: string
  dealId: string
  documentId: string
  accountKind: StatementAccountKind
  period: string // YYYY-MM
  accountSuffix?: string
  deposits: MetricEvidence
  depositCount: MetricEvidence
  averageDailyBalance: MetricEvidence
  nsfCount: MetricEvidence
  negativeDays: MetricEvidence
  endingBalance: MetricEvidence
  duplicateOfId?: string
  extractionVersion: number
  corrected: boolean
  correctionReason?: string
  correctedByUserId?: string
  correctedAt?: string
}

export interface ExistingPositionCandidate {
  id: string
  dealId: string
  label: string
  estimatedPayment?: number
  evidence: string
  status: "proposed" | "confirmed" | "dismissed"
}

export interface UnderwritingAggregate {
  dealId: string
  version: number
  monthlyRevenue: MetricEvidence
  averageDailyBalance: MetricEvidence
  nsfCount: MetricEvidence
  negativeDays: MetricEvidence
  positionCount: number
  stale: boolean
  computedAt: string
}

export interface CompletenessFinding {
  code: string
  message: string
  documentId?: string
  period?: string
}

export interface CompletenessResult {
  dealId: string
  ready: boolean
  version: number
  ruleSnapshot: string
  findings: CompletenessFinding[]
  checkedAt: string
}

export const ANALYSIS_MODES = ["analyze_only", "review_first", "automatic_send"] as const
export type AnalysisMode = (typeof ANALYSIS_MODES)[number]

export interface FunderScore {
  funderId: string
  rank: number
  score: number
  grade: "A" | "B" | "C" | "D" | "F" | "DQ"
  eligible: boolean
  reasons: Array<{ ruleId: string; result: "pass" | "fail" | "unknown"; detail: string }>
  dataAge?: string
}

export interface AnalysisSnapshot {
  id: string
  dealId: string
  policyVersion: number
  underwritingVersion: number
  completenessVersion: number
  mode: AnalysisMode
  topN: number
  scores: FunderScore[]
  createdAt: string
}

export interface AnalysisRun {
  id: string
  snapshotId: string
  mode: AnalysisMode
  state: "scored" | "review_pending" | "approved" | "blocked" | "submission_unavailable"
  selectedFunderIds: string[]
  reason: string
}
```

```ts
// src/lib/mca/datamerch/contracts.ts
export interface DataMerchConfig {
  workspaceId: string
  enabled: boolean
  hasCredential: boolean
  lastDiagnostic?: string
}

export interface DataMerchCheck {
  id: string
  dealId: string
  dealVersion: number
  status: "queued" | "no_result" | "records" | "failed"
  correlationId: string
  resultSummary?: string
  recordCount: number
  createdAt: string
}
```

Default scoring policy (MIC-163, version `1`): hard DQ first (state/entity/industry/default flag/NSF max/negative-day max/position max/time-in-business/FICO/min revenue). Soft score 0–100 from available monthly revenue fit, ADB fit, NSF, positions, requested amount vs max, FICO. Missing input → `unknown` reason, never a fake pass. Weights live in `underwriting/policy.ts` as named constants.

## Exclusive file map

Ticket agents **must not** edit files outside their column. Conductor is the only shared-file editor.

| Agent | Exclusive create/modify | Forbidden |
| --- | --- | --- |
| MIC-192 | `src/lib/mca/funders/directory.ts`, `directory-repository.ts`, `src/app/api/mca/funders/**` except `criteria`/`scan`, `src/components/mca/funders/funder-directory-panel.tsx`, `src/app/(dashboard)/funders/page.tsx`, `tests/funders-directory.test.ts` | deals-workspace, package.json, underwriting/** |
| MIC-170 | `src/lib/mca/funders/criteria.ts`, `criteria-repository.ts`, `src/app/api/mca/funders/criteria/**`, `src/components/mca/funders/criteria-panel.tsx`, `tests/funders-criteria.test.ts` | directory.ts except calling its read APIs |
| MIC-194 | `src/lib/mca/funders/criteria-scan.ts`, `scan-repository.ts`, `src/app/api/mca/funders/scan/**`, `src/components/mca/funders/criteria-scan-panel.tsx`, `tests/funders-scan.test.ts` | documents/extraction.ts internals (call provider interface only) |
| MIC-179 | `src/lib/mca/underwriting/statements.ts`, `statement-repository.ts`, `statement-extraction.ts`, `src/app/api/mca/underwriting/statements/**`, `src/components/mca/underwriting/statement-panel.tsx`, `tests/underwriting-statements.test.ts` | funders/**, deals/repository.ts schema |
| MIC-172 | `src/lib/mca/underwriting/corrections.ts`, `src/app/api/mca/underwriting/corrections/**`, `src/components/mca/underwriting/correction-panel.tsx`, `tests/underwriting-corrections.test.ts`; may **append** correction columns via `statement-repository.ts` after Wave 1 merge | scoring, funders |
| MIC-164 | `src/lib/mca/underwriting/completeness.ts`, `completeness-repository.ts`, `src/app/api/mca/underwriting/completeness/**`, `src/components/mca/underwriting/completeness-panel.tsx`, `tests/underwriting-completeness.test.ts` | statement extraction |
| MIC-180 | `src/lib/mca/datamerch/**`, `src/app/api/mca/datamerch/**`, `src/components/mca/datamerch/data-merch-panel.tsx`, `tests/datamerch.test.ts` | email.ts, funders write APIs |
| MIC-163 | `src/lib/mca/underwriting/scoring.ts`, `policy.ts`, `snapshot-repository.ts`, `src/app/api/mca/underwriting/scores/**`, `src/components/mca/underwriting/score-panel.tsx`, `tests/underwriting-scoring.test.ts` | sending, email |
| MIC-148 | `src/lib/mca/underwriting/analysis.ts`, `analysis-repository.ts`, `src/app/api/mca/underwriting/analysis/**`, `src/components/mca/underwriting/analysis-panel.tsx`, `tests/underwriting-analysis.test.ts` | MIC-166 submission jobs; must import a `queueSubmissions` port that Wave 0 stubs |
| MIC-150 | `src/lib/mca/underwriting/review-mail.ts`, `src/app/api/mca/underwriting/review/**`, `src/app/(dashboard)/review/[token]/page.tsx`, `src/components/mca/underwriting/review-panel.tsx`, `tests/underwriting-review.test.ts` | sender-connection UI (MIC-121) |
| Conductor | `funders/contracts.ts`, `underwriting/contracts.ts`, `datamerch/contracts.ts`, `deals-workspace.tsx`, `settings/connections/page.tsx`, `package.json` / lockfile, `email.ts` template union extension, `src/lib/mca/underwriting/submission-port.ts`, docs/milestone-03/*, Linear | ticket business logic |

`submission-port.ts` (Wave 0):

```ts
export async function queueSubmissions(_input: {
  actor: DealActor
  dealId: string
  funderIds: string[]
  analysisRunId: string
}): Promise<{ ok: false; code: "submission_unavailable" }> {
  return { ok: false, code: "submission_unavailable" }
}
```

MIC-148 must call this port. It must not create submission rows.

## Per-ticket briefs (what each agent must ship)

Every agent: TDD first in its `tests/*.test.ts`; use temporary SQLite; inject provider fixtures; enforce `DealActor` workspace; no secrets in logs; UI loading/empty/validation/success/failure; write `docs/milestone-03/<ticket>-acceptance.md`; comment on the Linear issue with local vs live gates.

### Agent MIC-192 — directory
- CRUD funder profiles, contacts, routes (`email|api|manual_portal|custom_webhook`), named groups.
- Inactive funders rejected for new selection; history still readable.
- Group resolution: unique active funder IDs, no duplicates.
- Soft-delete or archive only — never hard-delete if referenced.
- Replace placeholder `/funders` page (specific route wins over `[section]`).
- Acceptance: inactive cannot be targeted; group of `[A,A,inactive B]` resolves `[A]`.

### Agent MIC-179 — bank underwriting
- Extract deposits, deposit count, ADB, NSFs, negative days, balances with page evidence.
- Per-document month rows; duplicate statements do not double-count.
- Existing-position candidates for review (not silent facts).
- Checking only; other account kinds `unsupported`.
- Queue analysis on clean statement upload (event from documents list, not a hook inside `documents/service.ts` — poll or explicit `analyzeDealStatements(actor, dealId)` called from the statement panel and a documents-status consumer in the agent’s API route).
- Corrupt/uncertain → `unknown: true`, never `value: 0` presented as fact.
- Reuse document bytes via authorized document read; do not bypass scanner.

### Agent MIC-164 — completeness
- Configurable rules: application present, N recent checking statement months (workspace default 3).
- Findings for missing month, unreadable (`scan_failed`/`quarantined`), account/date mismatch.
- Readiness independent of application field completeness (`draftState`).
- One readiness event per meaningful state change; unchanged rerun does not emit a new automatic-submit trigger (MIC-148 consumes this).
- Missing month → `ready: false` and named request code `missing_statement_YYYY-MM`.

### Agent MIC-170 — eligibility
- Typed rules with units, operators, `unspecified: true`.
- Fields: revenue, FICO, time in business, positions, requested amount, term, deposit/ADB, NSF/negative days, default status, entity, state, industry.
- Industry aliases / NAICS map, editable.
- Versioned; contradicting min/max on the same field+unit cannot publish (`422 criteria_conflict`).
- Yearly min revenue 120000 ≡ monthly min 10000 via explicit conversion helper.

### Agent MIC-172 — corrections
- Edit statement metrics and position status with source-vs-manual indicators.
- Immutable original extraction retained; each correction stores actor, time, reason.
- Recompute aggregates; set `UnderwritingAggregate.stale = true` and any analysis snapshots stale.
- New AI run cannot overwrite reviewed corrections unless the user explicitly replaces.

### Agent MIC-180 — Data Merch
- Encrypted workspace credential; enable toggle; diagnostic.
- Run/View only when enabled, authorized, and EIN or legal name present.
- Persist check metadata + deal version; `no_result` vs `failed` vs `records`.
- Disabled config → UI hides action and API returns `403`/`409 datamerch_disabled`.
- Expired credential → recoverable failure, no secret in body/logs.
- Fixture HTTP; live key is an external gate.

### Agent MIC-194 — criteria scan
- PDF/PNG/JPEG through vault (clean only).
- Proposed changeset; preserve contacts; do not silently broaden rules or fill unspecified with sentinels.
- Ambiguous ranges flagged for review.
- Accept/reject with version history and rollback.

### Agent MIC-163 — scoring
- Hard DQ before score. Reproducible for same inputs + `policyVersion`.
- Rank, score, grade, reasons, data age. Copy: “fit, not approval odds.”
- Persist snapshots. Reanalyze after criteria or underwriting version change.
- DQ funder absent from auto-selection lists (MIC-148).

### Agent MIC-148 — modes
- Workspace defaults + run-level override: mode, top-N, review notification channel.
- Default `review_first`. `automatic_send` requires admin enablement.
- Trigger after completeness `ready` or manual run. Snapshot settings on the run.
- `analyze_only`: never changes selection, never calls `queueSubmissions`.
- `review_first`: state `review_pending`.
- `automatic_send`: call `queueSubmissions`; today always `submission_unavailable`; still record why each destination was selected/excluded/blocked.
- No-qualified-funder outcome is first-class.

### Agent MIC-150 — review email
- Concise message: scores, reasons, candidates.
- Short-lived signed token (5 minutes, HMAC like document downloads) to `/review/[token]`.
- Expired or foreign-workspace token cannot submit.
- Recipients from configured roles + workspace CC (reuse membership emails; no MIC-121 sender picker).
- Confirm revalidates permissions, completeness ready, score freshness; records approval on that snapshot only (later reruns do not mutate it).
- Extend `email.ts` template union via conductor if the agent cannot touch `email.ts` — **exception:** MIC-150 may add `"funder_analysis_review"` to the template union in `email.ts` only, no other email changes.

## Conductor shared mounts (after each wave)

Wave 1: `/funders` page (192), deal tab **Underwriting** mounting statement + completeness panels.  
Wave 2: criteria panel on funder detail; correction panel on deal; Data Merch on deal + connections settings.  
Wave 3: criteria scan on funder detail; score panel on deal.  
Wave 4: analysis panel on deal; review route; connections/settings for analysis defaults.

Do not let ticket agents edit `deals-workspace.tsx`. They export panels; conductor mounts.

## Global constraints (every agent)

- Node `>=24`, existing SQLite helpers in `src/lib/mca/db.ts`, no nested `BEGIN IMMEDIATE` around other modules’ transactions.
- `server-only` on services. Actor workspace is authority; never a client-supplied workspace id.
- Permissions on the API match the UI. `intake:write` cannot read underwriting or funders.
- Encrypted credentials use workspace-bound crypto (`crypto.ts`).
- Tests: `node --conditions=react-server --import tsx --test --test-concurrency=1`.
- No live provider calls in tests. Missing credentials → `provider_unavailable`.
- Do not modify M1/M2 tests except if a type export forces a mechanical import update (conductor handles it).
- Do not mark Linear Done if the ticket’s own external gate is unmet (Zoho-style honesty). For these 10, local fixture completion **can** be Done when gates are only “live Data Merch key” or “MIC-166 send,” provided the Linear comment lists the gate. MIC-148 may be Done with `automatic_send` fail-closed. MIC-150 may be Done with webhook/preview email, not Gmail OAuth.

## Execution procedure

1. Conductor writes contracts + `submission-port.ts` + milestone-03 docs skeleton.
2. Linear: In Progress for Wave 1 tickets.
3. Dispatch Wave 1 implementers in parallel (`general-purpose`, isolation `none`, exclusive files in the prompt).
4. Per agent: reviewer on that agent’s diff (files in its exclusive map only).
5. Conductor mounts panels, runs full `pnpm test && pnpm typecheck && pnpm lint`.
6. Repeat for waves 2–4. MIC-150 starts only after MIC-148 is review-clean.
7. Final verification: `pnpm test`, typecheck, lint, production build, browser pass for `/funders`, deal underwriting tab, completeness not-ready, score DQ, analyze-only, expired review token.
8. Linear comments + status. Refresh `docs/milestone-03` snapshots. Project status: move MCA from Backlog toward In Progress if Wave 1 lands.

## Agent prompt contract (every dispatch)

Each implementer prompt includes:

- Ticket id, url, full Linear description
- This plan’s rulings and its exclusive file list
- Frozen contract types it consumes/produces
- “You may not edit files outside your exclusive list. If you need a shared-file change, stop and report NEEDS_CONTEXT.”
- “Do not spawn subagents.”
- Acceptance criteria copied from Linear
- Report path: `docs/milestone-03/<id>-report.md` with tests run, remaining gates, files touched

## Verification

| Check | Owner |
| --- | --- |
| Per-ticket synthetic acceptance | Ticket agent |
| Exclusive-file audit (no overlap) | Conductor after each wave |
| Full suite + typecheck + lint | Conductor after each wave |
| Browser: funders, underwriting tab, review token | Conductor after Wave 4 |
| Linear status honest vs gates | Conductor |

## Out of scope

- MIC-166 multi-funder submission jobs (M4)
- MIC-121 email sender connections (M6)
- Funder API adapters (M4)
- Billing, SMS, commissions

## Success

All 10 tickets have an implementer, a reviewer pass, and a Linear comment. MIC-192/170/194/179/172/164/163 locally Done. MIC-180 Done locally with live-key gate. MIC-148 Done with send fail-closed. MIC-150 Done with webhook/preview mail and expired-token denial. No M4/M6 code. Existing M1/M2 tests still pass.

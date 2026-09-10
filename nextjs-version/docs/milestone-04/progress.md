# M4 SDD ledger — plan: docs/milestone-04/implementation-plan.md

Wave 0: complete (contracts, ports, drizzle 0006).
Wave 1: MIC-121 complete (11/11 senders tests, review PASS, Linear Done). Minors parked: Microsoft OAuth untested vs Google; callback missing no-store; Send test still shown on expired (server 409).
Wave 2: MIC-166 complete (4/4 submissions-core, analysis remount queued, 10/10 combined, Linear Done).
Wave 3: MIC-174, MIC-178, MIC-171 complete (12/12 tests, reviews PASS, Linear Done). PortalPanel mounted.
Wave 4: MIC-124, MIC-153, MIC-162 complete (12/12 tests, reviews PASS, Linear Done).
Wave 5: MIC-113, MIC-149, MIC-160 complete (10/10 tests, reviews PASS, Linear Done). ReplyQueue mounted.
Wave 6: MIC-122 + adapters 123/126/127/129/130 complete (29/29 tests, reviews PASS, Linear Done, registry updated).
Wave 7: complete. MIC-128 + adapters 131–145 registered. Linear milestone **04 Submissions and integrations** is **100%** (33/33 Done).

## Conductor final verification (2026-09-08)

| Check | Result |
| --- | --- |
| Linear M4 issues | 33/33 Done (none remaining) |
| Adapter registry | 20 slugs |
| M4 tests (senders, submissions-*, adapters-framework, adapters/*, underwriting-analysis) | **162/162 pass** |
| M1–M3 regression (excluding M5) | **128/128 pass** |
| `pnpm typecheck` | pass |
| `pnpm lint` | 0 errors, 6 warnings (3 pre-existing table compiler; 3 unused-symbol in M4 files) |
| `pnpm build` | pass (Next.js 16.1.1) |
| Browser | sign-in → dashboard; Settings → Connections (Email senders + Funder API adapters, desktop and 390px); deal Submissions tab four panels; confirm empty selection → “Select at least one funder.” |

Honesty gates still open (fixture success is not production integration readiness):

- Live Google/Microsoft OAuth and mailbox ingest (MIC-121 / MIC-149). Demo senders are SMTP `pending`; email preview fails closed `sender_not_usable` until a submission sender is verified.
- Commercial funder sandbox credentials for all 20 adapters. No live merchant submissions.
- Global `/submissions` remains a navigation placeholder; the working UI is the deal **Submissions** tab.

Demo workspace leftover from browser pass: deal `MCA-BE931DBC` (“M4 Verification Merchant”).

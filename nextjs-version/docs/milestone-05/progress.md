# Milestone 05 remaining progress

- Wave 0: remaining-plan, briefs, exclusive stubs, frozen contracts, `milestone05-schedules.ts`, drizzle `0014_youthful_silver_samurai.sql`.
- Wave 1: A1 MIC-111 implemented (7 tests); A2 MIC-106 REVIEW_PASS; A3 MIC-108 REVIEW_PASS; A4 MIC-157 REVIEW_PASS (+ 3 extra tests); A5 MIC-168 extracted `offer-sms.ts` (10 tests).
- Wave 2: conductor mounted `SchedulesPanel` on `/payments`, wired `createMerchantOfferSmsTransport`, fixed replay typecheck, focused suite **51/51**, `pnpm typecheck` green.
- Linear: remaining five tickets Done with documented live-provider gates.
- 2026-09-09: applied 0012–0014 to Neon verification then production; Railway deploy `d04b4edb-54bd-4c84-8589-c8f30215cc37` SUCCESS. Sandbox scheduler inserted 8 expected rows. No live merchant email/SMS/DocuSeal send.

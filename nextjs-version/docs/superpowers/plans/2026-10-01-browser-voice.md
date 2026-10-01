# Browser Voice Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement task-by-task. User explicitly selected plan then execute in this isolated task; independent review at completion.

**Goal:** User-operated desktop browser inbound/outbound calls with recording off and missed-call alerts.
**Architecture:** Twilio Device, session-only scoped tokens, one-use deal-authorized dial intents, signed canonical TwiML callbacks, tenant call history and leased browser presence. SMS owns number readiness and notifications owns internal events.
**Tech Stack:** Next.js 16, React 19, TypeScript, pg/Drizzle, Twilio Voice SDK.
**Spec:** ../specs/2026-10-01-browser-voice-design.md

## Global constraints

No live calls/mic acceptance, provider data invention, provisioning, production data, hosted migrations, live credential/security grants or merges. Reviewed migration definitions and restricted-role local tests are explicitly authorized by parent clarification. Recording always do-not-record. All shared contracts pinned before consumption; parent reserves migration/build slots.

## Review focus

- Canceled asynchronous SDK connect cannot resurrect audio.
- Number reassignment/revoked membership between token and dial fails closed.
- Signed callbacks with wrong tenant/account/number cannot write history.
- Duplicated/out-of-order callbacks cannot duplicate missed alerts/regress terminal state.
- Failed/disabled registration clears device and leased presence.

### Task 1: Provider primitives
Files: src/lib/mca/voice/provider.ts, contracts.ts; tests/voice-provider.test.ts.
Interfaces: VoiceCredentials {accountSid,authToken,apiKeySid,apiKeySecret,applicationSid,publicOrigin}; identityFor(workspaceId,membershipId); createVoiceToken(credentials,identity,now); outboundTwiml(number,to,actionUrl); inboundTwiml(identities,actionUrl); verifyVoiceWebhook(request,credentials,canonicalUrl).
- [x] Write token grant/5-minute expiry, identity separation, XML escaping/recording-off, forged/duplicate/body-size/account tests.
- [x] Run focused tests; expect missing module failure.
- [x] Implement provider primitives using existing Twilio verifier and HMAC signing.
- [x] Run focused tests; expect all pass; commit.

### Task 2: Authenticated service and persistence
Files: voice/http.ts, service.ts, readiness.ts; voice API routes; db/voice.ts; centrally reserved migration/journal; tests/voice-service.test.ts.
Consumes pinned SMS/notification modules and Task 1 primitives. Produces GET readiness/history, POST token/presence/dial-intent/cancel and signed inbound/outbound/action endpoints. Intent TTL 60 seconds, token/presence TTL 300 seconds; identity is tenant/member hash; active memberships and visible deal rechecked at dispatch. Missed alert eventKey includes workspaceId and parent CallSid.
- [x] Pin shared dependencies + migration slot before dependent edits.
- [x] Write focused service/auth/tenant/role/replay/order/missed-dedupe tests; run RED.
- [x] Implement encrypted phone history, transactional replay gates, opt-in presence lease and safe callback handling; run GREEN.
- [x] Commit implementation and evidence.

### Task 3: Browser panel and integration
Files: voice/browser.ts, voice-panel.tsx, voice-readiness.tsx; app layout mount and existing call entrypoints; package.json/pnpm-lock.yaml; tests/voice-browser.test.ts.
Consumes Task 2 endpoints; exposes VoiceReadiness component and user action launcher.
- [x] Write mocked lifecycle tests for registration, incoming answer/reject, outgoing cancel/disconnect, async cancellation races, cleanup, token expiry and manual retry; run RED.
- [x] Add SDK dependency and adapter; build persistent opt-in panel, history and readiness view; replace tel actions after coordinating shared UI.
- [x] Run GREEN, typecheck and targeted lint; commit.

### Task 4: Review and publication
- [x] Self-review against spec/plan and run targeted checks.
- [x] Independent code review; resolve important findings with reproducing tests.
- [ ] Parent-allocated build/aggregate checks; refresh Graphify; record actual evidence and external activation gates.
- [ ] Push branch, create draft PR, attach artifact; verify remote head/check state. Never merge.

Plan self-review: all scope maps to tasks; provider primitives are independent; shared contracts explicitly gate Task 2; failure cases map to service/browser tests. No conflicting ownership introduced.

## Execution ledger

Pre-flight: provider->service token/TwiML API consistent; service->browser endpoint names/intent semantics consistent; SMS ownership and notification enqueue were dependency gates, not duplicated tables/transports.
Task 1: complete03dad6f; provider tests3/3 RED (missing module) -> GREEN.
Task 2: completeeb77c22; disposable Postgres service4/4 including missed alert RED0!=1 -> GREEN after pinned41a4264.
Task 3: completeeb77c22; browser/policy10 total focused checks GREEN, typecheck0 and targeted ESLint0 errors/warnings. CRM owner confirmed nonconflicting launcher insertions subsequently applied in Voice branch.
Final independent review: local voice_review reviewedeb77c22, four important findings. All reproduced before fixes: dispatch permissions, historical terminal callback readiness, late refresh presence, replay rejection nonterminal. Fixed in one pass; focused provider/browser/policy11/11 and service7/7 GREEN. Type/lint rechecked. No deferred minor findings or spec rulings.
Remaining: parent-allocated build/aggregate slot, publication/remote checks; activation remains external and documented.

Parent clarification: security prohibition concerns live application.0069 now includes least-privilege server-role grants/RLS definitions, with local mca_app access/negative grant tests RED→GREEN; no hosted execution. Home renewal launcher authorized and integrated preserving contracts/phone/access guards. SMS stable pin388c3f8+4ca987e resolves dependency lint error; notifications stable10013c8 retained.
New-scope migration review: db:secure overrode restricted Voice grants; reproduced RED true!=false and fixed via table-specific runtime-grants helper preserving existing exceptions. Migration+real local securing script+restricted service proof GREEN; final focused36/36, typecheck0, full lint0 errors/16 baseline warnings. Home launcher guards independently reviewed. Evidence: ../../acceptance/browser-voice-2026-10-01.md.

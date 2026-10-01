# Browser Voice Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement task-by-task. User explicitly selected plan then execute in this isolated task; independent review at completion.

**Goal:** User-operated desktop browser inbound/outbound calls with recording off and missed-call alerts.
**Architecture:** Twilio Device, session-only scoped tokens, one-use deal-authorized dial intents, signed canonical TwiML callbacks, tenant call history and leased browser presence. SMS owns number readiness and notifications owns internal events.
**Tech Stack:** Next.js 16, React 19, TypeScript, pg/Drizzle, Twilio Voice SDK.
**Spec:** ../specs/2026-10-01-browser-voice-design.md

## Global constraints

No live calls/mic acceptance, provider data invention, provisioning, production data, hosted migrations, credential grants or merges. Recording always do-not-record. All shared contracts pinned before consumption; parent reserves migration/build slots.

## Review focus

- Canceled asynchronous SDK connect cannot resurrect audio.
- Number reassignment/revoked membership between token and dial fails closed.
- Signed callbacks with wrong tenant/account/number cannot write history.
- Duplicated/out-of-order callbacks cannot duplicate missed alerts/regress terminal state.
- Failed/disabled registration clears device and leased presence.

### Task 1: Provider primitives
Files: src/lib/mca/voice/provider.ts, contracts.ts; tests/voice-provider.test.ts.
Interfaces: VoiceCredentials {accountSid,authToken,apiKeySid,apiKeySecret,applicationSid,publicOrigin}; identityFor(workspaceId,membershipId); createVoiceToken(credentials,identity,now); outboundTwiml(number,to,actionUrl); inboundTwiml(identities,actionUrl); verifyVoiceWebhook(request,credentials,canonicalUrl).
- [ ] Write token grant/5-minute expiry, identity separation, XML escaping/recording-off, forged/duplicate/body-size/account tests.
- [ ] Run focused tests; expect missing module failure.
- [ ] Implement provider primitives using existing Twilio verifier and HMAC signing.
- [ ] Run focused tests; expect all pass; commit.

### Task 2: Authenticated service and persistence
Files: voice/http.ts, service.ts, readiness.ts; voice API routes; db/voice.ts; centrally reserved migration/journal; tests/voice-service.test.ts.
Consumes pinned SMS/notification modules and Task 1 primitives. Produces GET readiness/history, POST token/presence/dial-intent/cancel and signed inbound/outbound/action endpoints. Intent TTL 60 seconds, token/presence TTL 300 seconds; identity is tenant/member hash; active memberships and visible deal rechecked at dispatch. Missed alert eventKey includes workspaceId and parent CallSid.
- [ ] Pin shared dependencies + migration slot before dependent edits.
- [ ] Write focused service/auth/tenant/role/replay/order/missed-dedupe tests; run RED.
- [ ] Implement encrypted phone history, transactional replay gates, opt-in presence lease and safe callback handling; run GREEN.
- [ ] Commit implementation and evidence.

### Task 3: Browser panel and integration
Files: voice/browser.ts, voice-panel.tsx, voice-readiness.tsx; app layout mount and existing call entrypoints; package.json/pnpm-lock.yaml; tests/voice-browser.test.ts.
Consumes Task 2 endpoints; exposes VoiceReadiness component and user action launcher.
- [ ] Write mocked lifecycle tests for registration, incoming answer/reject, outgoing cancel/disconnect, async cancellation races, cleanup, token expiry and manual retry; run RED.
- [ ] Add SDK dependency and adapter; build persistent opt-in panel, history and readiness view; replace tel actions after coordinating shared UI.
- [ ] Run GREEN, typecheck and targeted lint; commit.

### Task 4: Review and publication
- [ ] Self-review against spec/plan and run targeted checks.
- [ ] Independent code review; resolve important findings with reproducing tests.
- [ ] Parent-allocated build/aggregate checks; refresh Graphify; record actual evidence and external activation gates.
- [ ] Push branch, create draft PR, attach artifact; verify remote head/check state. Never merge.

Plan self-review: all scope maps to tasks; provider primitives are independent; shared contracts explicitly gate Task 2; failure cases map to service/browser tests. No conflicting ownership introduced.

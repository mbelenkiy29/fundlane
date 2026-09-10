# MIC-178 review — Manual portal tasks and custom webhook

**Spec:** PASS
**Quality:** Approved (Minor)

Live ISO portals and live webhook endpoints remain an external gate. Fixture HTTP 500 / `pending_portal` is not production delivery readiness. Custom webhooks do not poll or ingest provider callbacks (MIC-113). No live merchant submissions. Do not mark Linear Done from this review.

## Spec

| Requirement | Result | Evidence |
| --- | --- | --- |
| Portal open ≠ submitted; state stays `pending_portal` | Pass | `createPortalTask` returns `pending_portal` (`portal.ts:184-190`). `openPortalTask` only rewrites reason while still `pending_portal` and never sets `sent` (`241-266`). Queue + HTTP open leave job/attempt not `sent` (`tests/submissions-portal.test.ts:241-261`). UI treats open `sent` as an error (`portal-panel.tsx:129-133`). |
| Confirm completion with `deals:write` and optional external ref | Pass | POST uses `requireSubmissionActor(..., "write")` → `deals:write` + `assertTrustedMutation` (`portal/[dealId]/route.ts:21-36`, `queue.ts:285-288`). `complete` with `PORTAL-REF-17` → job/attempt/cache `sent`; replay keeps first ref (`portal.ts:277-320`, test `263-294`). Write key POST 200 (`404-409`). |
| Webhook failure distinct from portal complete | Pass | Mixed queue: portal `pending_portal` then `sent`; webhook HTTP 500 `failed` / `provider_error`; webhook stays failed after portal complete; `deal_offers` 0; board `responseSync: false` (`webhook.ts:180-185`, `portal.ts:222-235`, test `298-361`). |
| Shared job ledger; no webhook response-sync | Pass | Jobs/attempts/cache via MIC-166 repository. Portal complete updates the existing attempt (`portal.ts:286-311`). Webhook POSTs checksum JSON only; bodies are not parsed into offers (`webhook.ts:114-130`, `162-196`). `WEBHOOK_RESPONSE_SYNC = false`. |
| Intake key 403; reads `deals:read` | Pass | GET `deals:read` 200; `intake:write` complete 403 (`scope_required` \| `permission_denied`), job stays `pending_portal`; `deals:read` POST 403; forged workspace 404 (`test:364-423`). |
| Schema preview, dest auth header, delivery log; secrets omitted | Pass | Preview + host + attempt log on board (`portal.ts:222-235`, `webhook.ts:133-149`). Userinfo/token → `Authorization`; credentials stripped from outbound URL (`webhook.ts:87-111`, test `316-319`). `assertNoSecret` on HTTP/JSON/logs. |
| Loading / empty / validation / success / failure UI + conductor mount | Pass | Loading/empty/422 invalid action/success/failure (`portal-panel.tsx:192-198`, test `398-402`). Panel mounted next to `SelectionPanel` (`deals-workspace.tsx:31`, `246`). |

## Quality

Approved. Minor only:

1. Webhook SSRF is hostname/literal-IP only (`webhook.ts:47-61`) and `fetch` follows redirects by default. A public HTTPS destination that DNSes or 302s to a private address is not blocked. Destinations are admin funder routes; live webhooks remain a gate.
2. `toAttemptState("pending_portal")` is `queued` (`jobs.ts:65-69`). Job state is the submitted/not-submitted signal; tests only assert the attempt is not `sent` after open.
3. Implementer handoff is stale: `PortalPanel` is already mounted on the deal workspace. Report correctly says it did not edit `deals-workspace.tsx`.
4. Acceptance “Board GET … `x-mca-response-sync: false`” is JSON `responseSync: false` plus the outbound webhook header (`webhook.ts:145`, `174`), not an HTTP response header on GET (`portal/[dealId]/route.ts:11-16`).
5. Open is tested with an admin session; complete is tested with a `deals:write` key. Session auth does not check scopes (`auth.ts:93-96`). Concurrent complete is not transactional.

No Critical or Important defects on the exclusive surface.

## Unverified claims

- **3/3 passed:** the test file defines three `test("MIC-178:…")` cases matching the report; this review did not re-execute Postgres.
- **Did not edit `queue.ts` / `outbox.ts` / `repository.ts` / `schema.ts` / `deals-workspace.tsx`:** current ledger, Wave 0 `deliver.ts` switch, unique constraints, and mount match the brief; the repo has no git, so in-place rewrites cannot be proven.
- **Live ISO portals / live custom webhooks:** not production-verified (documented remaining gate).

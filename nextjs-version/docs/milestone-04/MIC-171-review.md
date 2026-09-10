# MIC-171 review — Destination funder stamps

**Spec:** PASS
**Quality:** Approved (Minor)

No exclusive UI on this ticket. Live sending is out of scope. Fixture success is not production sending readiness. Do not mark Linear Done from this review.

## Spec

| Requirement | Result | Evidence |
| --- | --- | --- |
| Two funders receive distinct correct stamps | Pass | Harbor vs Northwind: different `documentId` / output checksum, `stage: "stamp"`, original id preserved (`stamps.ts:562-595`, `persistStamp` unique `(original_document_id, funder_id, stage, template_version)` at `303-326`; schema `db/schema.ts:1467`). Text `Submitted to {legal name}` (`155-157`, `412-443`). Test inflates PDF streams (`tests/submissions-stamps.test.ts:254-275`). |
| Stored original checksum unchanged | Pass | `applyStamp` reads vault originals (`stamps.ts:580`) and writes `{workspaceId}/derivatives/stamp/{id}` (`195-196`, `514`). `prepareOutgoingPackage` freezes `originalChecksums` before the hook (`package.ts:12-14`). Test: `mca_documents.checksum`, storage SHA-256, and package map stay the source digest; vault bytes lack stamp text (`submissions-stamps.test.ts:299-317`). Cached hit rejects `original_checksum` mismatch (`stamps.ts:502-505`). |
| Exclusion skip returns originals | Pass | Disabled or excluded funders return the input identities (`stamps.ts:568-569`). Test: Northwind excluded → original id/checksum/`stage: "original"`; Harbor still stamps; preview `skipped: "excluded"` (`submissions-stamps.test.ts:320-343`). Non-PDF path returns `asOriginalOutgoing` (`581-583`) — claimed, not fixture-covered. |
| `applyStamp` used by conductor `package.ts` | Pass | `package.ts:5,14` `documents = await applyStamp(documents, input.funderId)` before watermark/compress. Pipeline order original → stamp → watermark → compress matches the milestone plan. |
| Settings admin-only | Pass | GET/PATCH `requireStampAdmin` → `requireMembershipAccess(..., ["admin", "super_admin"])` session-only (`stamps.ts:282-286`; `auth.ts:104-106`). PATCH `assertTrustedMutation` (`stamps.ts:283`, `route.ts:24`). `updateStampSettings` re-checks `canManageWorkspace` (`242-243`). Tests: empty GET defaults disabled; PATCH 422/400; admin 200; rep / `deals:read` / `intake:write` 403 (`submissions-stamps.test.ts:346-420`). Preview is `deals:read` (`288-290`), not settings. |

## Quality

Approved. Minor only:

1. `POST /stamps/preview` persists a real derivative (`previewStamp` → `persistStamp`, `stamps.ts:625-641`) without `assertTrustedMutation`. Identity reuse is intentional (test expects `replayed: true`), but it is a mutating read-scoped POST. Session cookies that are SameSite=Lax still mitigate browser CSRF.
2. Replay preview rebuilds page boxes from **original** bytes when `persistStamp` returns `pages: []` (`643`, `501-507`). Layout matches; it does not re-read the stored stamped PDF.
3. `layoutStamp` records `page.getRotation().angle` but does not transform coordinates (`359-386`, `428-437`). Fixture landscape is a different page size, not a rotated page.
4. Every settings PATCH increments `template_version` (`254-260`), including no-op toggles, which forces new derivatives.
5. `applyStamp` always `originalBytes` before the cache check inside `persistStamp` (`580` vs `501`). Extra read only.
6. Untested on this surface: non-PDF passthrough, disabled `prepareOutgoingPackage` identity, dirty 423, encrypted PDF 422, `deals:write` key on settings (sessionOnly would 403).

No Critical or Important defects on the exclusive surface.

## Unverified claims

- **4/4 passed:** four `test("MIC-171:…")` cases match the report; this review did not re-execute Postgres.
- **Did not edit `package.ts` / `schema.ts` / `watermarks.ts` / settings UI:** current `applyStamp` call, unique constraint, and watermark stub match the brief; the repo has no git, so in-place rewrites cannot be proven.
- **Live funder delivery:** not production-verified (documented remaining gate).

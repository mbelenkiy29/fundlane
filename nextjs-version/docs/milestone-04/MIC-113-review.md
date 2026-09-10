# MIC-113 review — Status polling, webhook ingestion, offer reconciliation

**Spec:** PASS
**Quality:** Approved (Minor)

Live funder status APIs and signed webhooks remain an external gate. Fixture success is not production integration readiness. Offers comparison UI is M5. Do not mark Linear Done from this review.

## Spec

| Requirement | Result | Evidence |
| --- | --- | --- |
| Poll only `capabilities.statusPoll` adapters; manual refresh same gate | Pass | `assertPollable` requires `routeKind === "api"` then `assertStatusPollAllowed` (`poll.ts:66-72`; `framework.ts:135-138` needs `statusPoll` **and** `getStatus`). `refreshSubmissionStatus` calls `getStatusViaAdapter` only after that gate (`poll.ts:99-108`). Batch `pollActiveSubmissions` skips `capability_unsupported` instead of failing the run (`poll.ts:127-133`). Manual submit-only refresh is `409 capability_unsupported` (`tests/submissions-status.test.ts:457-466`). |
| Webhooks: authenticity + dedupe by provider event/reference | Pass | Shared secret `x-mca-webhook-secret` / `x-webhook-secret` / non-`mca_` bearer, or HMAC `x-mca-signature`, vs credential `webhookSecret` (`webhooks.ts:54-70,122-128,157-165`). Missing/wrong authenticity is `401 webhook_unauthenticated` (no secret: test `486-494`). Receipts use unique `(job_id, attempt_key)` via `eventAttemptKey` (`reconciliation.ts:192-194,410-441`; schema unique `mca_submission_attempts_job_attempt_key`). Webhook key is `webhook:<slug>:<eventId>` (`webhooks.ts:174-180`). Same `eventId` twice is `duplicate: true` (`test:327-360`). |
| `deal_offers` only when financial terms exist | Pass | `hasFinancialTerms` requires a finite `amount` / `rate` / `term` / `commission` (`reconciliation.ts:170-173`). `writeOffer` runs only when `!ignoreReason && hasFinancialTerms` (`459-473`). Unknown hold with no terms: no offer row (`test:399-412`). Approval/funding without terms is the same gate (code; not a dedicated fixture). |
| Unknown statuses stay visible with the original raw value | Pass | Versioned map `STATUS_MAPPING_VERSION = 1`; unmapped tokens stay `unknown: true` and keep `rawStatus` (`reconciliation.ts:10-42,151-168`). In-flight unknown writes `deal_submissions.status` to the raw string (`cacheStatus` `182-186`). `CREDIT_COMMITTEE_HOLD` then poll `AWAITING_BANK_VERIFICATION` both persist on the cache with `unknown: true` and no offer (`test:399-431`). Board flags non-enum cache values (`poll.ts:199-202`). |
| Replay / out-of-order must not duplicate offers or regress funded | Pass | One API offer per submission (`LIMIT 1 FOR UPDATE`, `reconciliation.ts:251-255`). Replay keeps one id and amount `25000` (`test:327-360`). `shouldIgnore`: `accepted` offer + non-funded → `funded_terminal` (`270-277`). Funded then pending: still one `accepted` row, amount 25000, `raw_status` `funded`, cache `approved` (`test:362-397`). |
| Reads `deals:read`; refresh `deals:write`; inbound webhook is not a user session; secrets omitted | Pass | GET/POST refresh `requireSubmissionActor` (`refresh/route.ts:11,21`; `queue.ts:285-287` + `assertTrustedMutation` on write). Tests: GET `deals:read` 200; POST `deals:read` / `intake:write` 403; cross-workspace 404; webhook 401 without secret; `assertNoSecret` (`test:434-494`). Webhook actor is `source: "system"` (`webhooks.ts:109-120`). `runtime = "nodejs"`, `cache-control: no-store`. |
| Offers comparison UI is M5 — persist rows only | Pass | Exclusive surface is poll/webhooks/reconciliation + HTTP + tests. GET board returns jobs/offers JSON only (`poll.ts:170-214`). No comparison workspace. |

## Quality

Approved. Minor only:

1. Terminal funded is **offer-row** `accepted`, not the submission cache. A terms-less `funded`/`approved`/`declined` event writes cache (`approved`/`declined`) with no offer; a later lower-rank event is not ignored (`shouldIgnore` returns undefined when `!row`) and can rewrite cache to `sent` and insert an offer. The brief’s funded-with-terms fixture is protected; terms-less funded is not.
2. Missing `eventId` / `reference` skips the receipt insert (`eventKey` undefined). Replay can mutate terms on the same API row. Poll keys `poll:<eventId>` vs webhook `webhook:<slug>:<eventId>`, so the same provider id can apply twice across channels.
3. `ingestAdapterWebhook` resolves the job (and 409s unsupported slugs) **before** `verifySecret`. Missing job and bad secret are both 401 (no existence leak in the status code). Capability 409 is unauthenticated.
4. Mapping: provider `accepted` aliases to `submitted`, not `funded` (`STATUS_ALIASES_V1`). `approved` and `declined` share rank 3, so they can overwrite each other. HMAC path and wrong-secret (vs missing) are unimplemented in the test file. Deal-level POST refresh skips incapable jobs with HTTP 200 rather than 409.
5. Status receipts are stored as `mca_submission_attempts` with `errorCode: "provider_status"`. `lastExternalRef` is oldest-first so the original submit ref still wins (`poll.ts:74-77`, `repository.ts:246-249`). No unique `(submission_id, source)` on `deal_offers`; uniqueness is the transaction lock.

No Critical defects on the exclusive surface. Item 1 is the only behavior hole that can regress a funded cache when the provider never sent terms.

## Unverified claims

- **4/4 passed:** four `test("MIC-113: …")` cases match the report/acceptance; this review did not re-execute Postgres.
- **Did not edit `schema.ts` / drizzle / `registry.ts` / adapter framework/credentials / `repository.ts` / deal UI:** current unique attempt key, `deal_offers` term columns, and `getStatusViaAdapter` gate match the brief; the repo has no git, so in-place rewrites cannot be proven.
- **Live funder status poll HTTP and signed webhooks:** not production-verified (documented remaining gate).
- **Scheduled `pollActiveSubmissions`:** library + deal POST only; no cron mount on this ticket (handoff).

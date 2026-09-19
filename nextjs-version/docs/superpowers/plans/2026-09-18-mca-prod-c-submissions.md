# MCA Prod C — Submissions, Duplicate Policy, Outbox, Packaging, Reply Extract

> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven-development or executing-plans. Migration is **`0042_submission_duplicate_identity.sql`**. Call B’s `evaluateUnderwritingSendGates` / `checkCompleteness`. Extend A’s `delivery-job.ts`. Do not rewrite `hmacLookup` (Team F).

**Goal:** Merchant+funder duplicate lock until decline/funded/new package; completeness-gated send of ready documents; crash-safe outbox; packaged email bytes; strict reply matching; no offers on `requiresReview`; `mca_offers` bridge for closing.

**Architecture:** Keep `mca_submission_jobs` / attempts / outbox. Persist `merchant_identity_key` + `package_fingerprint`. Team A already enqueues `submission_delivery`; this team resumes `sending` and attaches packaged bytes.

**Spec:** `2026-09-18-mca-prod-master.md`

## Locked decisions

See master. DataMerch = warn only. ISO stacking across workspaces = Wave 6.

## File map

| File | Role |
| --- | --- |
| `submissions/identity.ts` | **Create.** EIN hash else merchantId else dealId; package fingerprint |
| `submissions/delivery-job.ts` | Extend A’s helper |
| `submissions/closing-offers.ts` | **Create.** Extract → `createOffer` / `reviseOffer` |
| `submissions/{duplicate-policy,queue,outbox,preflight,jobs,watermarks,email-templates,replies,extract-outcomes,reconciliation,webhooks,webhook,contracts,repository}.ts` | Policy + send + extract |
| `drizzle/0042_submission_duplicate_identity.sql` | Columns + states `declined`/`funded` |
| `home/derive.ts`, `reports/{lead-roi,rep-funnel,funder-analytics}.ts` | Count declined/funded as submitted history |
| Tests | `submissions-*.test.ts`, new `submissions-outbox.test.ts`, `submissions-webhooks-ssrf.test.ts` |

```ts
export function submissionMerchantIdentityKey(input: {
  workspaceId: string; ein?: string | null; merchantId?: string | null; dealId: string
}): string // ein:${einLookupHash} | merchant:${id} | deal:${dealId}

export function packageFingerprint(checksums: string[]): string // sha256 of sorted unique checksums
```

Duplicate: advisory lock `mca-dup:${workspace}:${merchantKey}` + funder. Active states `queued|sending|sent|pending_portal` + same fingerprint → `active_duplicate` (no 24h). Terminal `declined|funded` + same fingerprint → `package_unchanged`. Different fingerprint → allow. Error states keep 2-minute `retry_too_soon`.

## Task 1: Schema + identity helpers

- [ ] Identity unit tests (EIN > merchantId > dealId; fingerprint order-independent).
- [ ] `0042`: columns NOT NULL after backfill `deal:{deal_id}` / empty fingerprint; index `(workspace_id, merchant_identity_key, funder_id, created_at)`; state check adds `declined`,`funded`.
- [ ] Persist on insert. `displayCacheStatus`: declined → declined, funded → approved.
- [ ] Commit: `feat(submissions): persist merchant identity and package fingerprint`

## Task 2: Duplicate policy

- [ ] Replace 24h test: still blocked after 24h; decline + same package blocked; new checksum allowed; EIN shared across deals blocked.
- [ ] Delete `ACTIVE_DUPLICATE_MS`.
- [ ] Commit: `fix(submissions): lock duplicates on merchant+funder until decline or new package`

## Task 3: privilegedRetry admin-only

```ts
function privilegedOverrideAllowed(actor: DealActor): boolean {
  return actor.source === "user" && Boolean(actor.role && canManageWorkspace(actor.role))
}
```

HTTP `privilegedRetry: true` as rep/api_key → 403 `privileged_retry_forbidden`. Keep audit on success.

- [ ] Commit: `fix(submissions): restrict privilegedRetry to admin sessions`

## Task 4: Completeness + ready docs + DataMerch warn

Call `evaluateUnderwritingSendGates` (preferred) or `checkCompleteness`. 422 `completeness_not_ready` / `positions_unconfirmed`. `originalsForRoute` filters `isDocumentReady`. Empty originals → preflight error. DataMerch records → `severity: "warning"` (does not fail destination). Test stub `setSubmissionCompletenessForTests` so other suites stay green until B’s real completeness is seeded.

- [ ] Commit: `fix(submissions): require completeness.ready and ready documents`

## Task 5: Resume sending + enqueue

`processJobDelivery`: existing attempt `sent|failed|skipped` → mark processed. `sending` **falls through** to package+deliver (do not insert a second attempt). After created `queued` job: `enqueueSubmissionDelivery`. Inline `processJobDelivery` only when `!backgroundJobsEnabled()`. Recover: reuse A’s function; do not revert to log-only.

- [ ] Tests in `submissions-outbox.test.ts`: resume sending, one attempt row, outbox processed after success; enqueue row exists when jobs enabled.
- [ ] Commit: `fix(submissions): resume sending attempts and enqueue submission_delivery`

## Task 6: Packaged bytes, watermark fail-closed, preview ≠ sent

- [ ] `applyWatermark` enabled + no logo → 409 `watermark_logo_required` (preview may still report skipped).
- [ ] Email webhook attachments: `bytesBase64` of **packaged** documents via `getOutgoingDocumentBytes`, never raw vault originals.
- [ ] Production + missing webhook / `delivery: "preview"` → job `failed`, never `sent`. Outbox extra guard: preview ref in production throws `preview_not_sent`.
- [ ] Commit: `fix(submissions): send packaged bytes and fail closed without watermark logo`

## Task 7: Replies, extract, mca_offers, job outcomes

- [ ] Delete unique-domain + zero subject-hit auto-match. Those stay `pending_review`.
- [ ] `persistReplyExtraction`: if `requiresReview`, write **zero** `deal_offers` / `mca_offers`.
- [ ] Confirmed approval with amount → `upsertClosingOfferFromExtract` (`source: "email"`, `externalId: email-extract:${replyId}`, `submissionId: job.id`, amount dollars → cents).
- [ ] Confirmed decline → job `declined`. Reconciliation funded/declined maps job state.
- [ ] Commit: `fix(submissions): tighten reply match and bridge confirmed extracts to mca_offers`

## Task 8: Webhook eventId + outbound DNS

- [ ] Missing `eventId`/`event_id` → 422 `webhook_event_id_required`. Do not use `reference` as eventId.
- [ ] `deliverWebhook`: DNS lookup; block RFC1918/loopback/link-local/CGNAT/IPv6 ULA like `offer-links.ts`. `setWebhookLookupForTests`.
- [ ] Commit: `fix(submissions): require webhook eventId and block private webhook DNS`

## Verification

```bash
cd nextjs-version
node --experimental-test-module-mocks --conditions=react-server --import tsx --test --test-concurrency=1 \
  tests/submissions-duplicates.test.ts tests/submissions-core.test.ts tests/submissions-outbox.test.ts \
  tests/submissions-watermarks.test.ts tests/submissions-email.test.ts tests/submissions-replies.test.ts \
  tests/submissions-extract.test.ts tests/submissions-status.test.ts tests/submissions-webhooks-ssrf.test.ts
```

## Dependencies

- A: worker dispatch + `delivery-job.ts`.
- B: send-gates / completeness rules.
- F: `einLookupHash` includes workspaceId **before** this team persists identity keys. If F is late, identity still works (`merchant:` / `deal:`) but EIN cross-deal lock is weaker until F merges — **Ruling:** do not ship C Task 1 persist to production ahead of F hmac backfill.
- D: consumes `mca_offers` from Task 7.

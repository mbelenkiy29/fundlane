# MCA Prod D — Offers, Closing, PSF, Merchant Upload, Recipients

> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven-development or executing-plans. Migration is **`0043_closing_upload_and_offer_expiry.sql`**. Do not implement C’s `deal_offers` → `mca_offers` bridge. Do not rebuild DocuSeal.

**Goal:** Bind recipients, mint upload URLs only at send, ABA checksum, expire offers in 14 days, rank highest by amount then lower factor, one selected revision unless split-fund, honest production gates.

**Architecture:** Harden `offers/service.ts` + `closing/service.ts` + DocuSeal validation. New helpers: `closing/recipients.ts`, `closing/aba.ts`, `offers/rank.ts`.

**Spec:** `2026-09-18-mca-prod-master.md`

## Locked decisions

- Default recipient = `deal.contactEmail` / `deal.contactPhone`. Funder contract = active email route. Admin session override requires reason (8–500 chars) + audit `closing.recipient_overridden` (no raw address in metadata). API keys cannot override.
- Preview body uses `[secure-upload:<stipulationId>]`. Staff “Create upload link” still mints immediately.
- New upload tokens = `randomBytes(32)` + `token_cipher`. Drop deterministic HMAC for **new** links. Old HMAC hashes remain redeemable until expiry.
- `expiresAt` defaults to `createdAt + 14 days`. Past `effectiveAt` means in force, **not** expired.
- `isSplitFundProduct`: `/^split[\s_-]*fund$/i`.
- Production gate strings stay qualified (“configured; verify delivery…”). Never “ready” for email/PSF.

## Task 1: Recipient binding

**Files:** create `closing/recipients.ts`; wire stipulation/offer/contract/PSF previews; split UI fields; `tests/milestone05-closing.test.ts`.

```ts
export function bindMerchantEmail(deal, input, actor): BoundRecipient
export function bindMerchantSms(deal, input, actor): BoundRecipient
export function bindFunderEmail(input, actor): Promise<BoundRecipient>
```

- [ ] Bound preview masks deal contact. Other email without reason → `recipient_override_required`. Rep override → `recipient_override_denied`. Missing contact → `merchant_contact_missing`.
- [ ] Commit: `fix(closing): bind merchant and funder recipients with audited admin override`

## Task 2: Upload links at send

**Files:** `closing/service.ts`, `0043` `token_cipher`, merchant upload token generation, closing panel copy.

- [ ] Preview has **no** `/merchant-upload/` and **zero** link rows. Send materializes one idempotent link `send:${previewId}:${stipulationId}`. Replay send does not duplicate. Guessed HMAC 404s.
- [ ] Commit: `fix(closing): mint merchant upload URLs at send, not preview`

## Task 3: ABA + PSF email bind

**Files:** create `closing/aba.ts`; `confirmPsfRequest`; `docuseal-provider.ts` `validateSubmissionInput`.

Checksum: `3(d0+d3+d6)+7(d1+d4+d7)+(d2+d5+d8) ≡ 0 (mod 10)` plus 9 digits. `021000021` valid. `123456789` invalid.

- [ ] PSF contactEmail must match deal contact unless admin override.
- [ ] Commit: `fix(closing): require ABA routing checksum and matching PSF email`

## Task 4: Offer expiry

**Files:** offers contracts/repository/service; `0043` `expires_at` backfill + NOT NULL; `assertOfferRevisionEligibleForClosing`; funding already calls it; update raw test INSERTs that omit `expires_at`.

```ts
export function offerRevisionValidity(revision, nowIso): "not_yet_effective" | "active" | "expired"
```

New select/fund when expired → 409 `offer_revision_expired`. Future `effectiveAt` → `offer_revision_not_yet_effective`. Deselect still allowed.

- [ ] Commit: `feat(offers): expire revisions 14 days after create`

## Task 5: Highest ranking + required revision pick

```ts
export function pickHighestMerchantOffer<T extends { amountCents: number; factorRate?: number; revisionId: string }>(offers: T[]): T
```

Amount desc, factor asc (`undefined` → +Infinity), revisionId asc. Closing UI always posts `revisionId`.

- [ ] Commit: `fix(closing): rank highest offer by amount then lower factor`

## Task 6: One selection per deal unless split-fund

Transactional lock `hashtext(workspaceId || ':offer-select:' || dealId)`. Second non-split select → 409 `offer_selection_conflict`. Tag existing multi-select funding tests as `product: "split-fund"`.

- [ ] Commit: `fix(offers): one selected revision per deal unless split-fund`

## Task 7: Honest production gates UI

Render `snapshot.productionGates` four lines. Assert email/PSF copy does not include a bare “ready” for email.

- [ ] Commit: `fix(closing): show qualified production delivery gates`

## Task 8: DocuSeal ABA only

One call to `assertUsAbaRoutingNumber` in `validateSubmissionInput`. Do not touch webhook signature, template binding, or creation-mode.

- [ ] Run `tests/milestone05-closing-docuseal*.test.ts`

## Task 9: C bridge consumption test

Insert `createOffer({ source: "email", ... })` and close it. Documents the D/C contract. No extract-outcomes edits.

## Task 10: Migration + journal idx 40 tag `0043_closing_upload_and_offer_expiry`

Order in SQL: `token_cipher`; then `expires_at` backfill.

## Verification

```bash
cd nextjs-version
node --conditions=react-server --import tsx --test --test-concurrency=1 \
  tests/milestone05-closing.test.ts tests/milestone05-closing-docuseal.test.ts \
  tests/milestone05-closing-docuseal-service.test.ts tests/milestone05-offers-funding.test.ts
pnpm typecheck
```

## Dependencies

C must merge before extracted emails appear in Offers. D is shippable on manual `mca_offers`. A’s scanner covers merchant uploads via `storeDocument`.

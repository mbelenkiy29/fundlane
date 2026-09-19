# MCA Prod F — Tenancy, PII Hashes, EIN Uniqueness, Financial Hiding, Privacy

> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven-development or executing-plans. Migration is **`0045_tenancy_ein_hmac.sql`**. Hmac+EIN unique **must land before Team C persists `merchant_identity_key`**. Import E’s `actorCanViewCompanyFinancials` for deal-list hide; do not fork.

**Goal:** Lookup hashes are workspace-scoped; EIN is unique per workspace; money is hidden in deal list/export; intake rate limits actually block; public apply is less leaky; privacy copy matches the live stack.

**Architecture:** Ciphertext AAD stays `workspaceId`. Only HMAC message changes. Backfill hashes in an application job (not a SQL rewrite of ciphertext). `forceDuplicate` attaches to the existing merchant.

**Spec:** `2026-09-18-mca-prod-master.md`

## Locked decisions

- `hmacLookup` → HMAC-SHA256 of `` `${kind}:${workspaceId}:${normalized}` ``. Stop `void workspaceId`.
- Unique `(workspace_id, ein_hash)` WHERE `ein_hash IS NOT NULL`. Phone is not unique this wave.
- `forceDuplicate`: admin session only + audit `merchant.force_attach`. Never insert a second row for the same EIN.
- Deal list/export: omit `requestedAmount` / `monthlyRevenue` when `!actorCanViewCompanyFinancials`. Book/advances owned by E.
- Await `consumeRequestRateLimit` before intake ingest.
- Public apply: 7-day invite TTL + iframe `referrerPolicy="no-referrer"`. **Do not consume-on-open** (breaks Jotform resume).
- Privacy notice: Vercel + Supabase; drop Clerk/Neon/Render; workspace merchant data is GLBA-sensitive, retained until workspace deletion; no erasure API this wave.
- Audit: document download redeem + merchant-upload inspect.
- HighLevel: production without `MCA_HIGHLEVEL_WEBHOOK_PUBLIC_KEY` fail-closed (no hardcoded key).
- API keys remain workspace-wide for deals (Wave 6 to scope them).

## Task 1: Workspace-scoped hmacLookup + backfill

**Files:** `crypto.ts`, `merchants/lookup-hash.ts`, backfill helper (e.g. `merchants/backfill.ts` if hashes are stored), tests around `einLookupHash`.

```ts
export function hmacLookup(kind: LookupHashKind, workspaceId: string, normalized: string): string {
  return createHmac("sha256", encryptionKey()).update(`${kind}:${workspaceId}:${normalized}`, "utf8").digest("hex")
}
```

- [ ] Test: same EIN, two workspaceIds → different hashes. Same workspace → stable.
- [ ] Backfill: SELECT merchants/owners with hashes; UPDATE to new hmac. Idempotent. Run from a guarded script or one-shot job, not at request time for every lookup.
- [ ] Commit: `fix(crypto): include workspaceId in EIN and identity lookup HMACs`

## Task 2: Unique EIN + attach-not-duplicate

**Files:** `drizzle/0045_tenancy_ein_hmac.sql`, `merchants/service.ts`, `deals/service.ts` create path.

```sql
CREATE UNIQUE INDEX IF NOT EXISTS merchants_workspace_ein_hash_uidx
  ON merchants (workspace_id, ein_hash)
  WHERE ein_hash IS NOT NULL;
```

Confirm actual table name (`merchants` vs `mca_merchants`) from `src/lib/mca/db/schema.ts` before writing SQL.

- [ ] Second `createDeal` with same EIN and no attach → 409 with matches (existing `MerchantExistsError`) **or** attach when `forceDuplicate` + admin.
- [ ] Rep `forceDuplicate` → 403. Admin force → attach existing `merchantId`, audit.
- [ ] Commit: `fix(merchants): unique EIN per workspace and attach instead of duplicating`

## Task 3: Hide deal-list / export money

**Files:** `deals/service.ts` list/detail mapping, export snapshot if it includes amounts, tests.

Omit `requestedAmount` and `monthlyRevenue` when `!actorCanViewCompanyFinancials(actor.role, settings.actionVisibility)`. Do not send 0.

- [ ] Commit: `fix(deals): omit financial fields on list and export without viewCompanyFinancials`

## Task 4: Await intake rate limit

**Files:** `src/app/api/mca/intake/providers/[provider]/[integrationId]/route.ts`, `auth.ts` if `consumeRequestRateLimit` is fire-and-forget.

```ts
await consumeRequestRateLimit(...)
```

If it returns a Response/throws 429, return that **before** `ingestProviderDelivery`.

- [ ] Test: 121st request in a window → 429, ingest not called (mock).
- [ ] Commit: `fix(intake): await rate limit before ingesting provider deliveries`

## Task 5: Apply invite TTL + referrerPolicy

**Files:** `applications/service.ts` (30d → 7d), `public-application.tsx` iframe `referrerPolicy="no-referrer"`, `apply/[formId]/page.tsx`.

- [ ] Test: invite `expires_at` is createdAt+7d. Do not revoke on first open.
- [ ] Commit: `fix(applications): 7-day invite TTL and no-referrer on the public form iframe`

## Task 6: Privacy notice

**Files:** `src/lib/marketing/privacy-notice.ts`

Replace “Render hosts… Neon stores… Clerk…” with Vercel hosting, Supabase Auth/Postgres/Storage. Add a short workspace section: merchant bank statements, EINs, and owner last-4 are GLBA-sensitive; retained until the brokerage workspace is deleted; this notice is not a substitute for the brokerage’s own privacy policy.

- [ ] Commit: `docs(privacy): describe Vercel/Supabase and workspace merchant data`

## Task 7: Audit download redeem + upload inspect

**Files:** `documents/service.ts` download token redeem; `closing/service.ts` `inspectMerchantUpload`.

`recordAuditEvent` with `source: "system"` / public actor as used today. Metadata: documentId or linkId, not bytes.

- [ ] Commit: `fix(audit): record document download redeem and merchant-upload inspect`

## Task 8: HighLevel fail-closed

**Files:** `intake/providers.ts`

If `NODE_ENV === "production"` and `MCA_HIGHLEVEL_WEBHOOK_PUBLIC_KEY` unset → reject HighLevel deliveries (no hardcoded key).

- [ ] Commit: `fix(intake): fail closed when HighLevel webhook public key is missing in production`

## Verification

```bash
cd nextjs-version
# targeted tests for merchants, deals list, intake providers, applications, crypto
pnpm typecheck
```

Two workspaces, same EIN, different hashes. Unique index rejects a second merchant row. Rate limit 429 before ingest.

## Dependencies

- Land Tasks 1–2 before Team C duplicate persist.
- Task 3 after E Task 7 helper exists, or temporarily inline the same boolean and rebase onto `actorCanViewCompanyFinancials`.

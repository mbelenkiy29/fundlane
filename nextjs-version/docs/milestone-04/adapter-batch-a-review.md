# Adapter batch A review (MIC-123, MIC-126, MIC-127, MIC-129, MIC-130)

**Batch spec:** PASS (5/5)
**Quality:** Approved (Minor)
**Linear Done:** Do not mark. This review did not re-execute tests, did not fetch live Linear, and did not edit code.

Live funder APIs remain an external gate on every ticket. Fixture success is not production integration readiness.

Shared contract: `FunderAdapter` in `src/lib/mca/submissions/contracts.ts` (`validate`, `submit`, optional `getStatus` / `parseWebhook`, `capabilities: { submit: true; statusPoll; webhooks; offers }`). Template: `docs/milestone-04/adapter-template.md`.

## Batch confirmations

| Check | Result | Evidence |
| --- | --- | --- |
| No live HTTP | Pass | No `fetch`, `axios`, `http.request`, or `https.request` under the five exclusive adapter trees. Submit/status are in-memory fixture maps. |
| No MCA Pilot endpoints | Pass | No Pilot URLs, IPs, or sample provider credentials. Only synthetic tokens (`expired-ecg-development-token`, `cpc-expired-credential`) and Kapitus `fixture://kapitus/applications` plus `https://offers.example.test/kapitus/synthetic-offer`. |
| `attemptKey` idempotent | Pass | Each adapter keys stored receipts on `job.attemptKey` and replays the first external identity. Timeouts/expired credentials do not mint a second ref. |
| Capability flags honest | Pass | Flags match implemented methods: `getStatus` only when `statusPoll: true`; no `parseWebhook`; `offers: true` only on Kapitus, which is the only adapter that returns `terms`. |
| Exclusive trees | Pass | Each ticket owns `adapters/<slug>/{index,mapping,fixtures}.ts`, `tests/adapters/<slug>.test.ts`, and `docs/milestone-04/<MIC>-{report,acceptance}.md`. |
| `registry.ts` conductor-owned | Pass (unverified authorship) | Exclusive trees never call `registerAdapter`. Reports instruct conductor to register after review. Current `src/lib/mca/submissions/adapters/registry.ts` already imports all five slugs. No git history; implementer vs conductor write cannot be proven. Do not treat that wiring as an adapter exclusive-file pass. |

Graphify CLI was not available in this read-only tool set. Review is from source, tests, reports, and the frozen contract.

## Compact table

| Ticket | Slug | Spec | Caps | Ticket-specific | Notes |
| --- | --- | --- | --- | --- | --- |
| MIC-123 | `expansion-capital-group` | PASS | submit + statusPoll; webhooks/offers false | 2 owners by %, partner attribution | Landlord blank in mapping, not asserted in tests |
| MIC-126 | `kapitus` | PASS | submit + statusPoll + offers; webhooks false | First ack is `Application Received`, not approval | Closing → approved with no terms; terms only on approved/funded fixtures |
| MIC-127 | `fintegra` | PASS | submit + statusPoll; offers false | Max 3 owners; no `terms` | Validation failures are stored on `attemptKey` (blocks corrected retry) |
| MIC-129 | `quantum-lends` | PASS | submit + statusPoll; offers false | EIN optional for sole proprietor | Timeout/expired mint no ref; later accept reuses one `ql-<attemptKey>` |
| MIC-130 | `channel-partners-capital` | PASS | submit-only; statusPoll false | No `getStatus` / `parseWebhook`; 409 poll | Submit uses destination-keyed fixtures, not a bound job payload |

---

## MIC-123 — Expansion Capital Group

**Spec:** PASS
**Quality:** Approved (Minor)

### Spec

| Requirement | Result | Evidence |
| --- | --- | --- |
| `FunderAdapter`; exclusive files; no `registry.ts` in the tree | Pass | `expansionCapitalGroupAdapter` at `adapters/expansion-capital-group/index.ts:97-162`. Files match the template. |
| 2 owners, partner attribution | Pass | `MAX_OWNERS = 2`; `selectOwners` sorts by percent then primary (`mapping.ts:193-205`). Validate requires registered partner email + rep name (`mapping.ts:278-283`). Test maps Alex 55% + Jordan 30%, drops Sam 15% (`expansion-capital-group.test.ts:174-178`). Unregistered partner is a field error (`test.ts:127-133`). |
| `statusPoll`, no offers | Pass | `{ submit: true, statusPoll: true, webhooks: false, offers: false }`; `getStatus` present; `parseWebhook` absent (`index.ts:99-104,147`; `test.ts:150-157`). Status never sets `terms` (`test.ts:184,306`). |
| Validate field errors | Pass | Empty payload errors business, owners, partner (`test.ts:116-125`). Invalid EIN/SSN/percent (`test.ts:135-144`). |
| Submit idempotent on `attemptKey` | Pass | Fixture record keyed by `attemptKey`; timeout reserves `ecg_<attemptKey>` then recovers on the same ref; expired token mints no ref; completed replay under expired token keeps original ref (`fixtures.ts:136-181`; `test.ts:219-267`). |
| Document receipt | Pass | `api_application` → application, `statement` → bank_statements; replay keeps receipt ids (`test.ts:190-216`). |
| Outstanding docs → pending | Pass | `UW Prep` + outstanding list → `pending` with requests in `rawStatus` (`mapping.ts:384-394`; `test.ts:275-308`). |
| No live HTTP / no Pilot | Pass | Fixture-only `executeSubmit`. |

### Quality

1. `landlordName` / `landlordPhone` are hardcoded `""` in `mapApplication` (`mapping.ts:360-361`) and never asserted.
2. Production `submit(job)` maps owners only when `bindExpansionCapitalGroupApplication` is set; unbound jobs still succeed with destination fixtures (template-allowed).
3. Tests were not re-run in this review (report claims 5/5).

---

## MIC-126 — Kapitus

**Spec:** PASS
**Quality:** Approved (Minor)

### Spec

| Requirement | Result | Evidence |
| --- | --- | --- |
| `statusPoll` + `offers` | Pass | `{ submit: true, statusPoll: true, webhooks: false, offers: true }`; `getStatus` implemented; `parseWebhook` undefined (`kapitus/index.ts:106-208`; `kapitus.test.ts:270-279`). |
| First acknowledgement is not approval | Pass | Successful `submit` always `rawStatus: "Application Received"` / `submitted`, including an `approved` fixture override (`index.ts:168-174`; `test.ts:108-113,212-216`). |
| Offers only when terms exist | Pass | `getStatus` attaches `scenarioTerms` only for `approved` / `funded`. Closing / credit review / ack have no terms (`index.ts:196-206`; `test.ts:171-210`). |
| Primary owner only | Pass | `selectPrimaryOwner` by highest percent (`mapping.ts:193-200`). Mapped payload has Mira 80%, not Jonah (`test.ts:101-106`). |
| Validate + documents | Pass | Missing primary, revenue, amount, unsigned application (`test.ts:55-97`). Job without application/statement is `validation_failed` and is **not** stored, so a corrected retry on the same key succeeds (`index.ts:150-159`; `test.ts:133-146`). |
| Idempotent `attemptKey` | Pass | Stored attempt replay; timeout reserves `kapitus-app-<attemptKey>` with `providerSubmissions === 1`; expired credential has no ref (`index.ts:110-175`; `test.ts:219-267`). |
| Unknown raw stays unknown | Pass | `CREDIT_COMMITTEE_HOLD` → `unknown: true` (`mapping.ts:211-217`; `test.ts:163-167,205-210`). |
| No live HTTP / no Pilot | Pass | Transport is `fixture://kapitus/applications`. Offer link is `offers.example.test`. |

### Quality

1. Timeout replay stays failed (does not recover like ECG/QL). Still one reserved ref. Acceptable under the template.
2. `kapitusResultContainsSecret` treats any `ssn` key as secret; tests use it rather than JSON string search for SSN values on mapped requests (mapped request still contains full SSN internally).
3. Tests not re-run (report 5/5).

---

## MIC-127 — Fintegra

**Spec:** PASS
**Quality:** Approved (Minor)

### Spec

| Requirement | Result | Evidence |
| --- | --- | --- |
| `statusPoll`, `offers: false` | Pass | `{ submit: true, statusPoll: true, webhooks: false, offers: false }`; `getStatus` present; `"parseWebhook" in adapter === false` (`fintegra/index.ts:40-45,90-184`; `fintegra.test.ts:271-275`). Every status assertion has `terms === undefined` (`test.ts:234,261,268,290`). |
| Up to 3 owners | Pass | `FINTEGRA_MAX_OWNERS = 3`; fourth owner field error (`mapping.ts:198-202`; `test.ts:116-120`). Three-owner map + `ownerCount: "3"` (`test.ts:137-165`). |
| Originator email / disregarded-email | Pass | Invalid email is a field error. Fixture `disregarded_email` is a distinct error, not generic Rejected (`index.ts:124-136`; `test.ts:277-293`). |
| Status map without priced offers | Pass | Received / WIP / Underwriting / Processed → submitted; Awaiting Clarification → pending; Rejected variants / Cancelled / Disregarded Email → declined; unknown raw preserved (`mapping.ts:75-82,284-292`; `test.ts:227-268`). |
| Idempotent `attemptKey` | Pass | `rememberFintegraReceipt` first-write wins (`fixtures.ts:59-64`). Timeout keeps `ftg-attempt-timeout`; expired has no ref; accepted replay reuses ref (`test.ts:182-224`). |
| No live HTTP / no Pilot | Pass | Fixture receipts only; runtime key redacted via `redactAdapterSecrets`. |

### Quality

1. **Validation failures are stored.** `submit` `store()`s `validation_failed` (`index.ts:148-157`). A later complete payload on the same `attemptKey` returns the first field-error result. Kapitus deliberately does not store that case. Template requires idempotency, not corrected-retry; still a hole if preflight and submit share a key after a doc miss.
2. `getStatus` without a receipt uses `randomUUID()` for `correlationId` (`index.ts:47-48,180`), so poll identity is unstable until submit.
3. Unbound submit (no `setFintegraApplicationForTests`) skips full application validate unless destination is `missing_fields` (template fixture path).
4. Tests not re-run (report 5/5).

---

## MIC-129 — Quantum Lends

**Spec:** PASS
**Quality:** Approved (Minor)

### Spec

| Requirement | Result | Evidence |
| --- | --- | --- |
| `statusPoll`, `offers: false` | Pass | `{ submit: true, statusPoll: true, webhooks: false, offers: false }`; `getStatus` present; no `parseWebhook` (`quantum-lends/index.ts:28-33,122-131`; `quantum-lends.test.ts:74-84`). Status results omit `terms` (`test.ts:211,217,231`). |
| EIN exception | Pass | Non-sole-prop requires 9-digit EIN; sole proprietor without EIN maps and omits EIN on the outbound merchant (`mapping.ts:294-298,334`; `test.ts:112-128`). |
| Primary applicant + NAICS | Pass | Highest ownership is primary (Miles 70%); `Restaurants` → `722511`, `Trucking` → `484121`; unmapped industry is a field error (`mapping.ts:191-221,293`; `test.ts:112-140`). |
| Validate field errors | Pass | Empty object errors legal name, amount, annual revenue, EIN, owners, industry (`test.ts:86-109`). |
| Idempotent `attemptKey` | Pass | Success stored in `acceptedByAttemptKey`. Timeout/expired return no `externalRef`. Retry after timeout then accept creates one `ql-attempt-timeout`. Later timeout fixture on an accepted key still returns success (`index.ts:70-100`; `test.ts:169-201`). |
| Document receipt | Pass | Statement docs only; application excluded; checksums not echoed (`index.ts:55-67`; `test.ts:147-166`). |
| Status map | Pass | Sent/Approved/Funded/Declined; `OnHold` stays unknown (`fixtures.ts:55-65`; `test.ts:204-231`). |
| No live HTTP / no Pilot | Pass | Destination/override fixtures only. |

### Quality

1. Timeout/expired are not stored, so repeating a timeout destination never “locks” a reserved ref (unlike ECG/Kapitus). Recovery path is tested and still one ref.
2. `submit` does not call `validate` on a bound application; mapping is validate-only (template `submit(job)` fixture path).
3. Tests not re-run (report 6/6).

---

## MIC-130 — Channel Partners Capital

**Spec:** PASS
**Quality:** Approved (Minor)

### Spec

| Requirement | Result | Evidence |
| --- | --- | --- |
| Submit-only; `statusPoll: false` | Pass | `{ submit: true, statusPoll: false, webhooks: false, offers: false }`. No `getStatus` / `parseWebhook`. `assertStatusPollAllowed` throws `409 capability_unsupported` (`channel-partners-capital/index.ts:23-28,94-102`; `channel-partners-capital.test.ts:203-216`). |
| Validate required fields | Pass | Primary owner (explicit or highest %), two-letter state of incorporation, 6-digit NAICS (`mapping.ts:211-255`; `test.ts:75-87`). |
| Account ID acknowledgement | Pass | `externalRef` `CPC-ACC-<attemptKey>`, `rawStatus: "Sent"` (`fixtures.ts:141-143`; `test.ts:89-116`). |
| Document receipt | Pass | Package ids filter application + statement; excluded `other_stip` not sent (`mapping.ts:199-208`; `test.ts:118-144`). |
| Idempotent `attemptKey` | Pass | Only **accepted** submissions are remembered. Timeout/expired/missing-fields mint no Account ID. Replay of success under a timeout override keeps the same Account ID and correlation id. A prior timeout key can later accept once (`index.ts:53-91`; `test.ts:146-201`). |
| No live HTTP / no Pilot | Pass | In-memory fixtures; expired key `cpc-expired-credential`; results through `redactAdapterSecrets`. Mapped owner stores SSN last four only (`test.ts:218-237`). |

### Quality

1. `submit` validates `applicationForChannelPartnersCapitalFixture(fixture)`, not a deal-bound payload (`index.ts:66-72`). Allowed by the template; production mapping of live deal fields is not exercised except via `validate()`.
2. Test titles omit the `MIC-130:` prefix used by the other four files.
3. Tests not re-run (report 5/5).

---

## Unverified claims

- **Test execution:** reports/acceptance claim 5/5 (MIC-123/126/127/130) and 6/6 (MIC-129). This review did not run `node --test`.
- **Linear AC text:** compared against the adapter template, frozen `FunderAdapter`, and the ticket-specific constraints in the review prompt / local reports. Live Linear descriptions were not fetched.
- **`registry.ts` authorship:** file is conductor-owned by plan; it currently registers all five Batch A adapters. Exclusive trees do not import it. Without git, premature conductor wiring vs implementer edit cannot be distinguished.
- **Live sandbox HTTP:** not production-verified on any ticket (documented remaining gate).

## Handoff

Do not mark Linear Done from this review. Conductor should treat registry wiring as its own mount (already present in the working tree), run the five adapter test files, then comment gates in the same words as the reports: commercial provider sandbox access; mock/fixture success is not production integration readiness.

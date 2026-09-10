# Milestone 02 Lane A cross-review

Reviewed 2026-09-08 against the complete MIC-169, MIC-193, MIC-182, and MIC-177 ticket descriptions in `tickets.current.full.json`. This is an independent review of the implementation as it existed before the Lane A follow-up fixes prompted by this report. It includes source tracing, focused-test inspection, route authorization inspection, and a rendered PDF stress case. It does not claim live scanner or extraction-provider verification.

## Readiness

| Ticket | Status at review boundary | Evidence that passed | Work required before ready |
| --- | --- | --- | --- |
| MIC-169 | Not ready | Workspace/deal authorization is reapplied on list/get/token redemption; short-lived tokens bind workspace, document, and version; MIME, size, magic-byte, and scan-state gates are implemented; pending/failed scans can be retried; UI covers empty/loading/success/failure and preview/download/category/version actions. | Make upload replay and version allocation safe under concurrency; persist one idempotency key across a lost response; provide a durable recoverable upload record before/with blob persistence; make version lineage explicit and category correction preserve it. |
| MIC-193 | Not ready | Redacted contact values were absent from extracted PDF text and PDF metadata; unsigned output remains unsigned; signed-on-behalf generation requires a session-recorded authorization; generation/document replay rechecks current deal access; source and generated categories are distinct. | Render all owners and long validated deal values without silent loss, with pagination/wrapping or an explicit template-capacity validation. Add the realistic multi-owner/long-content fixture. |
| MIC-182 | Not ready | Upload/extract is authenticated and scan gated; the provider boundary is strict and records evidence/unknown values; missing identity data remains unknown; stored manual edits survive a rescan; merge requires an expected deal version and accepted conflict fields; original PDF and extraction version are retained. | Atomically claim an extraction/draft before create/merge side effects; revalidate source category, clean state, and document version at confirmation; expose every extracted business/owner field and its evidence/confidence in the review UI. |
| MIC-177 | Mostly ready after log fix | Bank/month/last-four filenames are deterministic; duplicate suggestions remain distinct through a document-ID suffix; preview and correction retain immutable bytes, object ID, checksum, and original filename; uncertainty is surfaced. | Remove raw original/display filenames from audit metadata because an uploaded bank filename can contain a full account number or merchant PII. |

## Blocking findings

### 1. Upload persistence, replay, and version allocation are not atomic

`storeDocument` reads the next category version, awaits immutable storage, and then inserts the row. The database has no unique constraint on `(workspace_id, deal_id, category, version)`. Two concurrent uploads can therefore receive the same version and previous-document pointer. Two requests with the same idempotency key can both create different immutable blob keys; the losing insert raises the database uniqueness error and leaves an orphaned blob. A process interruption after the blob write but before the row insert has the same orphaned, invisible result.

The UI also creates a new UUID inside each upload call. A retry after the server committed but the response was lost therefore creates a second document instead of replaying the first record. This does not meet MIC-169's interrupted-upload and retry-identity acceptance criteria.

Required coverage: concurrent different-key uploads allocate distinct monotonic versions; concurrent same-key uploads return one identity; a simulated lost response retries with the same key; failure between storage and commit produces a visible recoverable state or deterministic cleanup.

### 2. Version lineage can be corrupted by normal UI actions

The service defines a version as the latest document in an entire deal/category. The UI sends `sourceReference` for “Upload new version,” but the service ignores it when choosing `previousDocumentId`. Uploading a replacement for an older document can therefore attach it to an unrelated latest file in the category.

Category correction mutates the moved document's version and previous pointer to the latest target-category record but does not repair documents that point to it in the old category. A later old-category version can point across categories. MIC-169 calls for immutable originals and versions; this needs either an explicit logical lineage identifier/parent validation or transactional relinking with invariant tests.

### 3. Extraction and draft confirmation allow concurrent double side effects

Both confirmation paths check `state`, create/update a deal, copy the source document, and only then unconditionally update the extraction/draft to confirmed. The update does not compare the prior state. Two concurrent requests with distinct confirmation IDs can both pass the read and create two deals, or mutate two target deals, from one reviewed extraction.

Confirmation needs an atomic claim/CAS before side effects and deterministic completion/recovery. Add concurrency fixtures for the same and different confirmation IDs and for failures after the deal mutation but before source preservation/finalization.

### 4. Existing-document confirmation accepts stale or unsafe source state

`confirmApplicationScan` retrieves the document record and later reads its storage key directly. It does not require that the current record is still clean, still categorized as `application`, or still matches the extraction's stored document version. A document can be extracted, rescanned into quarantine or recategorized, and then confirmed from the stale extraction.

Confirmation should reapply the same clean-content gate used during extraction and compare category and version before creating or merging a deal.

### 5. Generated PDFs silently omit valid CRM data

The renderer hardcodes one page and loops over `deal.owners.slice(0, 4)`. A seven-owner synthetic deal produced a one-page PDF containing only owners 1–4; owners 5–7 were absent from both rendering and extracted text. Values are also truncated at 82 characters without wrapping or an omission marker. The PDF metadata did not contain the redacted contact values, and the visual layout otherwise rendered cleanly.

MIC-193 requires templates populated from validated deal and owner data. The renderer needs pagination/wrapping, or explicit validation that prevents generation when the chosen template cannot truthfully represent the record. Coverage should include more than four owners, long legal/DBA/industry values, and signed attestation pagination.

### 6. The extraction review UI cannot review the complete strict schema

The API/provider models business, address, multiple owners, field-level confidence, pages, evidence text, and unknown markers. The UI exposes editable controls only for legal name, DBA, contact email, and requested amount. It lists low-confidence field names but does not show their evidence text/page and offers no controls for owners, identity unknown status, address, contact phone, entity, revenue, or the other deal fields. A user can confirm create/merge without resolving or explicitly accepting those low-confidence values.

Expose the complete extracted schema, multiple-owner editing, evidence/confidence, and explicit field-level acceptance. The confirmation request should represent reviewed choices rather than accepting every conflict merely because its field name appeared in a preview.

### 7. Statement rename audit data can leak account data

The generated filename restricts account data to at most four digits and uses a stable document suffix, but `statement.filename_applied` logs both the original and display filenames. Uploaded bank filenames can contain a full account number or merchant PII. Log document identity and change flags or sanitized labels instead of raw filenames.

## Verification evidence

- The latest aggregate run before this review was `pnpm test`: 39 passed, 0 failed. Lane A had six focused core cases and one HTTP route case. Those tests cover the happy/replay paths described above but do not cover the concurrency, stale-source, lost-response, multi-owner pagination, or complete review-UI scenarios in this report.
- `pnpm typecheck` passed with no diagnostics at the same boundary.
- A stress PDF was generated through `renderApplicationPdf`, inspected with `pdfinfo` and `pdftotext`, rendered at 160 DPI with `pdftoppm`, and visually inspected. It was one letter page; redacted contact content/metadata did not leak; owners 5–7 were missing; long legal and DBA values were silently truncated.
- No live scanner, OpenAI extraction request, or other external provider call was made. Fixture success establishes adapter behavior only. Production readiness still requires configured durable storage, malware scanner, extraction credentials/model approval, and provider/privacy review.

## Test gaps after fixes

1. Direct authorization for every mutation route, including category, filename, extraction review/confirm, and PDF authorization/generation, across a different workspace and a same-workspace unauthorized deal assignment.
2. Parallel upload/version and extraction/draft-confirm races using separate database connections or HTTP requests.
3. Lost-response upload retry with the same client idempotency key and preserved document identity.
4. Confirmation after quarantine, category correction, newer document version, or superseding extraction.
5. PDF output with long fields, more than four owners, page-count assertions, visual page inspection, and text/metadata leakage assertions in every disclosure mode.
6. UI acceptance for reviewing and editing multiple owners and every low-confidence/unknown field with evidence pages before create or merge.
7. Statement rename with a sensitive original filename, duplicate suggestions, correction, and audit-log assertions that no full account number is retained in logs.

## Post-fix resolution — 2026-09-08

Independent re-review found no remaining blocking issue in Lane A. The original findings are retained above as the pre-fix record; each is now closed:

1. Uploads reserve a durable database identity and logical lineage in an immediate transaction before object storage. Workspace/lineage/version uniqueness prevents duplicate allocation, same-key replay returns the reserved identity, and a failed storage write leaves a visible `scan_failed` reservation that the same key recovers.
2. Explicit lineage and parent validation preserve version history across replacement and category correction. The focused fixture checks monotonic versions and category correction without cross-lineage pointers.
3. Document and draft confirmation now acquire a source-scoped tokenized claim before side effects. Claims have an expiry, failed or expired work can be reclaimed, and completion/failure use token CAS so a stale worker cannot overwrite the retry. The recovery fixture simulates an abandoned claim, reclaims it, and rejects the old token.
4. Confirmation reads through the clean-content gate and rejects a changed category, quarantined source, or document-version mismatch. Source preservation uses explicit immutable document/version references.
5. The renderer wraps long values, paginates every owner, and prints page counts. The two rendered pages were visually inspected: the long end marker and owners 1–7 are present without overlap, while redacted contact values remain absent from visible output and metadata.
6. The review UI now exposes the full business/address schema, arbitrary owner rows, unknown/confidence/page/evidence details, saved manual edits, and an explicit checkbox for every merge conflict before confirmation.
7. Statement audit metadata uses document identity and change flags rather than raw original/display filenames; sensitive originals remain encrypted document metadata and are not copied into the audit event.
8. The upload UI retains one idempotency key per file fingerprint across failed or lost-response retries and clears it only after success.

Verification commands at this boundary:

- `pnpm exec node --conditions=react-server --import tsx --test tests/documents-core.test.ts`: 11 passed, 0 failed, including atomic reservation/storage interruption, lineage/category preservation, multi-owner pagination, confirmation concurrency/stale-source checks, expired-lease reclaim, and statement audit privacy.
- `pnpm exec node --test tests/documents-http.test.mjs`: 1 passed, 0 failed; direct route authorization and recoverable provider states are covered.
- `pnpm exec tsc --noEmit --pretty false`: passed at the post-fix workspace boundary.

Recommendation: mark MIC-169, MIC-193, MIC-182, and MIC-177 Done for local acceptance. Production storage, scanner, and extraction-provider configuration remain deployment work and do not invalidate the implemented ticket behavior.

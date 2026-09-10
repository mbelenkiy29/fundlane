# Lane A acceptance - documents and extraction

Executed September 8, 2026. Scope: MIC-169, MIC-193, MIC-182, and MIC-177.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| Lane A core acceptance | 11/11 passed | `tests/documents-core.test.ts` |
| Document route smoke | 1/1 passed | `tests/documents-http.test.mjs` |
| TypeScript | Passed after final concurrency and UI hardening | `pnpm typecheck` |
| Production build | Earlier Lane A build passed; final aggregate build is recorded by the milestone verifier | `pnpm build` |
| PDF text and metadata | Passed | `pdftotext`, `pdfinfo`, and PDF metadata assertions |
| PDF visual rendering | Passed | 2-page stress-case US Letter output rendered at 144 DPI with `pdftoppm`; no clipping, overlap, broken glyphs, or spacing defects observed |
| Lint | Lane A paths passed with no findings | `pnpm lint` |

Synthetic rendered artifact: `output/pdf/milestone-02-redacted-application-sample.pdf`. It contains explicit `REDACTED` markers and excludes the synthetic real email and phone from visible text and metadata.

## MIC-169 - Secure document vault and categorized uploads

Status: implemented and verified locally with scanner doubles; actual ClamAV and production durable storage/backups remain external deployment gates.

- A database-first immediate transaction reserves document identity, idempotency key, logical lineage, and version before immutable storage. Retries resume a pending or storage-failed reservation with the same identity; conflicting replays fail. Explicit new versions advance one lineage, concurrent attempts cannot share a version, and category corrections preserve prior/child links. Storage locators never appear in summaries or routes.
- Multipart UI supports progress, recoverable interruption messages, categorized PDF/PNG/JPEG uploads, empty/loading/error/success states, category correction, explicit new-version upload, preview, download, and scan retry.
- Uploads reject unsupported MIME, over-25-MiB content, bad magic, unsafe names, and conflicting idempotency replays.
- Configurable `clamdscan`/`clamscan` runs against a private temporary file with timeout and cleanup. Missing scanner stays `pending_scan`; infected content is `quarantined`; scanner errors are `scan_failed`. Only a real clean result unlocks content.
- Five-minute HMAC download tokens bind document ID, version, and workspace. Redemption rechecks current actor visibility and clean state. Direct routes require `deals:read` or `deals:write`; an `intake:write` key cannot browse, upload, scan, categorize, preview, or download vault content.
- Synthetic acceptance proves pending upload recovery, concurrent idempotent retry identity, interruption after reservation and recovery, explicit lineage/version behavior, category correction, quarantine, clean-only read, 5-minute expiry, cross-workspace denial, and MIME/magic mismatch rejection.

Ticket criteria:

- [x] Interrupted/unavailable scanning produces a recoverable state and UI retry; idempotent re-upload preserves identity.
- [x] Changing a download/document identifier cannot expose another workspace's document.
- [x] Atomic idempotency reservation, explicit version lineage, concurrent version rejection, interrupted-storage recovery, and response-loss replay have synthetic assertions.
- [x] Loading, empty, validation, success, failure, progress, and retry states are represented in the mounted UI.
- [x] Direct server permissions are tested. Audit metadata contains identifiers, checksums, counts, categories, and states; it excludes bodies, credentials, and sensitive field values.

## MIC-193 - Generate application PDFs with contact disclosure controls

Status: implemented and verified locally; actual downstream submission-provider templates remain an external configuration/product gate.

- The server renders a polished paginated application from the unmasked authorized deal record. The UI previews `real`, `omitted`, and explicitly `redacted` contact output before generation.
- All text wraps without silent truncation, every owner is included, and pages are added as needed. Redacted/omitted PDF values are explicit markers. PDF title, subject, author, producer, creator, and keywords exclude merchant contact data. The source application remains category `application`; generated output is a separate versioned `api_application` vault object.
- Signed-on-behalf generation fails until a session user records merchant name and an authorization reference. Ordinary generation leaves a merchant signature line and does not fabricate a signature.
- Generation records deal version, actor, correlation ID, disclosure mode, authorization ID, document ID, and stable idempotency key. A retry returns the same generation/document; a key reused with changed settings fails.
- Synthetic acceptance uses `pdf-lib` metadata reads plus `pdftotext`; real synthetic contact email/phone are absent while `REDACTED` is present. `pdfinfo` and rendered PNG inspection confirms both pages of a seven-owner stress case have clean layout; the final owner and a long-field end marker remain present.

Ticket criteria:

- [x] Masked/redacted output does not include real contact values in metadata.
- [x] Missing merchant authorization blocks signed-on-behalf generation.
- [x] Realistic synthetic PDF, authorization, and retry scenarios cover all implementation items.
- [x] UI supports loading, disclosure preview, validation, success, failure, authorization, and stable server-side retry identity.
- [x] Direct generate/authorization routes enforce document write scope; authorization recording is session-only. Logs exclude secrets and document bodies.

## MIC-182 - AI application PDF extraction and deal creation

Status: adapter, pre-deal workflow, review, creation, and merge are implemented and verified with deterministic provider fixtures. Live model verification is pending credentials.

- Authenticated pre-deal drafts are scoped by actor workspace, use immutable private storage, run through the same fail-closed scanner, and provide retry. A draft is not exposed through a caller-selected workspace.
- The configurable OpenAI Responses adapter sends PDF file input with `store: false`, timeout, credential/authentication errors, provider request IDs, and strict JSON Schema output. The strict schema covers business fields, multiple owners, page evidence, confidence, and unknown markers. Official API design source: [OpenAI Responses API reference](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/responses/methods/create).
- Identity last-four accepts only exactly four extracted digits. The prompt forbids SSN inference; fixture acceptance proves an absent SSN remains absent with `unknown: true` evidence.
- Each rescan increments extraction version and merges previously approved fields over new provider candidates. The UI exposes all business, address, financial, contact, and owner fields plus confidence, page, excerpt, and unknown evidence; it supports owner add/remove and saves human edits.
- Confirmation supports new deal creation or an explicit existing-deal merge. Merge preview reports differing populated fields and requires a separate UI choice for each conflict at the expected deal version. Confirmation uses an expiring, tokenized database claim before side effects; stale claims can be reclaimed and stale workers cannot complete. The source is revalidated as the same clean application/version immediately before confirmation, then attached to the resulting deal with extraction provenance.
- Confirmation ID is generated when review content changes and retained across response-loss retries. Server uniqueness returns the original deal/document for the same confirmation, rejects conflicting reuse, blocks concurrent distinct confirmations, and supports deterministic retry after failure or an expired lease.

Ticket criteria:

- [x] Missing SSN remains unknown.
- [x] Rescan preserves approved edits unless a reviewer supplies a replacement.
- [x] Synthetic upload, scan recovery, strict extraction, review, create, replay, source preservation, conflict preview, and merge cover every implementation item.
- [x] UI exposes upload progress, unavailable scanner, retry, provider failure, editable review, create, merge, conflict, and success states.
- [x] Routes require `deals:write`; API keys stay in server environment variables and never enter URLs. Audit logs store provider/request IDs and counts, not raw application payloads.

## MIC-177 - AI bank-statement filename standardization

Status: implemented and verified locally with a provider fixture. Live model verification and MIC-179 bank underwriting remain external; underwriting is not represented as complete.

- The extraction provider returns bank label, `YYYY-MM` statement month, and final-four candidate with confidence, page, excerpt, warnings, provider, and request ID.
- The mounted vault UI offers suggestion preview, editable bank/month/final-four correction, and apply. It flags bank/period values below 0.8 or missing.
- Applied names keep document identity and immutable original bytes/name/checksum. Every suggested name includes a stable eight-character document suffix, so identical bank/month/account candidates remain distinct.
- Only the final four digits can be applied. Longer account strings fail validation and full account values cannot enter generated filenames.

Ticket criteria:

- [x] Two otherwise identical suggestions remain distinct through the stable document suffix.
- [x] Rename preserves document ID, original filename, checksum, content, and references.
- [x] Synthetic extract, uncertainty, correction, duplicate, full-account rejection, and apply scenarios cover all implementation items.
- [x] UI exposes provider failure, preview, correction, apply, retry, and success states.
- [x] Direct filename routes require `deals:write`; audit metadata excludes statement bodies and account numbers.

## Done recommendations and external readiness gates

- `clamdscan` and `clamscan` are not installed on this host. No live benign/EICAR result is claimed. Configure `MCA_DOCUMENT_SCANNER=clamdscan` or `clamscan` and optionally `MCA_DOCUMENT_SCANNER_COMMAND`, then use the existing retry controls for pending/failed records.
- Configure `MCA_DOCUMENT_STORAGE_PATH` on a durable production volume and provision backup/restore monitoring. The local filesystem adapter is functional but is not evidence of deployed durability.
- Configure a 32+ character `MCA_DOCUMENT_TOKEN_SECRET` in production.
- No usable OpenAI key was present. Configure `MCA_DOCUMENT_AI_PROVIDER=openai`, `OPENAI_API_KEY`, and `MCA_DOCUMENT_AI_MODEL`; then perform live synthetic (non-merchant) extraction acceptance. Fixture tests validate request/response contracts but do not establish live model readiness.
- Actual API application submission is outside these tickets until a downstream provider and truthful required-field contract are configured. The generated artifact is kept separately and is not represented as submitted.
- Keep MIC-177 filename extraction bounded to naming metadata. MIC-179 underwriting remains the explicit Milestone 3 dependency for statement analytics, underwriting calculations, and underwriting readiness; this implementation does not manufacture those results.

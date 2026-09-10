# Milestone 02 implementation plan

Reconciled September 8, 2026 by Astra 6 medium. Execution: Sol 5.6 high in three lanes. Planning only; no app code or Linear changes.

Current project `b223a780-3987-440c-8e04-41516a97e69b`; milestone `5172b3ee-e393-425e-a7fb-611f6e724c30` **02 Intake and documents**. Access is restored. All 17 full ticket descriptions and relations were fetched; complete project pagination has no next page. Snapshots: `project-issues.current.snapshot.json`, `tickets.current.full.json`. Old snapshots are historical.

SEN-36 → MIC-169; SEN-40 → MIC-152; SEN-45 → MIC-193; SEN-52 → MIC-175; SEN-53 → MIC-186; SEN-54 → MIC-181; SEN-55 → MIC-183; SEN-56 → MIC-159; SEN-57 → MIC-119; SEN-58 → MIC-184; SEN-59 → MIC-182; SEN-65 → MIC-177; SEN-67 → MIC-176; SEN-68 → MIC-165; SEN-69 → MIC-155; SEN-70 → MIC-173; SEN-80 → MIC-167.

## Observed dependencies

- MIC-193 is blocked by MIC-169, MIC-91.
- MIC-186 is blocked by MIC-152.
- MIC-184 is blocked by MIC-97, MIC-152.
- MIC-183 is blocked by MIC-152.
- MIC-182 is blocked by MIC-169, MIC-152.
- MIC-181 is blocked by MIC-152.
- MIC-177 is blocked by MIC-169, MIC-179.
- MIC-176 is blocked by MIC-175, MIC-97.
- MIC-175 is blocked by MIC-152.
- MIC-173 is blocked by MIC-119, MIC-93.
- MIC-169 is blocked by MIC-91.
- MIC-167 is blocked by MIC-165.
- MIC-165 is blocked by MIC-119, MIC-169.
- MIC-159 is blocked by MIC-152.
- MIC-155 is blocked by MIC-119, MIC-97.
- MIC-152 is blocked by MIC-169, MIC-91.
- MIC-119 is blocked by MIC-152.

MIC-91, MIC-93 and MIC-97 are Done. MIC-177 has an external milestone-03 dependency on MIC-179 (bank underwriting), still Backlog. Implement reusable bank metadata extraction now, retain this dependency as pending, and do not add full underwriting to scope.

## Execution-ready corrections and frozen contracts

These decisions supersede tentative statements in the architecture retained below. All 17 authoritative implementation requirements and acceptance criteria follow the architecture.

1. **Lane A:** MIC-169, MIC-193, MIC-182, MIC-177; owns documents domain/routes/components/tests. **Lane B:** MIC-152, MIC-175, MIC-186, MIC-181, MIC-183, MIC-159, MIC-184, MIC-176; owns intake domain/routes/components/tests. **Lane C:** MIC-119, MIC-165, MIC-155, MIC-173, MIC-167; owns imports domain/routes/components/tests, and is sole shared-file/package/lockfile/existing-page editor. Root owns aggregate evidence and Linear. Each lane writes `lane-a/b/c-acceptance.md`. No silent cross-lane edits.
2. A publishes `documents/contracts.ts`: category union `statement | application | api_application | driver_license | voided_check | closing_document | other_stip`; `UploadDocumentInput {dealId,idempotencyKey,filename,mimeType,bytes:Uint8Array,category,source,sourceReference?}`; `DocumentSummary {id,dealId,workspaceId,originalFilename,displayFilename,mimeType,byteLength,checksum,category,version,createdAt,processingState}`. Processing states are `pending_scan | clean | quarantined | scan_failed`. `documents/service.ts` exports `storeDocument(actor:DealActor,input:UploadDocumentInput):Promise<DocumentSummary>` and `listDocuments(actor:DealActor,dealId:string):DocumentSummary[]`. Authorized reads remain A-owned and never expose storage paths.
3. A publishes independent `documents/extraction.ts` (must not import intake service): `extractApplication(actor,input:{filename,mimeType,bytes:Uint8Array,sourceReference}):Promise<ApplicationExtraction>`, returning `{version,fields:DealWriteInput,evidence:Record<string,{confidence,page?,text?,unknown?}>,warnings:string[],provider,requestId?}`. Also `suggestFieldMapping(actor,{headers:string[],samples:string[][],allowedFields:string[]})` → `{mapping:Record<string,string>,confidence:Record<string,number>,warnings:string[],provider}`; `extractStatementMetadata(actor,sameFileInput)` → bank/month/accountSuffix candidates with confidence/provenance. Missing model credentials throw actionable `provider_unavailable`; fixture providers are explicitly injected tests only. A chooses actual model adapter from official docs and sends environment setup to B/C.
4. B publishes `intake/contracts.ts`: `NormalizedIntakeInput {schemaVersion:1,provider,eventId,application:DealWriteInput,sourceReference?,initialStatus?:DealStatus}`; `IntakeResult {intakeId,dealId:string|null,created:boolean,state:"received"|"validated"|"created"|"file_pending"|"error",warnings:string[]}`. `intake/service.ts` exports `ingestApplication(actor:DealActor,input):Promise<IntakeResult>`; unique workspace/provider/event ID plus payload checksum rejects conflicting replay, never merges distinct applications. C calls it with provider import and event ID batchId:rowId. A scan confirmation calls it after review, using immutable confirmation ID. B email uses independent A extraction so no circular service import.
5. B `attachIntakeDocument(actor,{intakeId,attachmentId,filename,mimeType,bytes,category}):Promise<DocumentSummary>` resolves deal from authenticated intake then calls A storage. Persist async attachment jobs with independent checkpoint/replay and readiness-summary recomputation after late files. Do not manufacture bank-underwriting readiness. Network fetches have configured host allowlist, private-address/redirect denial and byte/time bounds.
6. C first adds server-only `getDealForDocument(actor:DealActor,id:string):DealRecord` in deals/service.ts using existing assertVisible/findDealById, for A PDF generation and conflict review. No raw-record browser endpoint. C alone installs real PDF/workbook/ZIP dependencies and owns shared integration. All domains initialize their own SQLite tables; do not nest existing deal transactions.
7. UI mount contracts: A `DocumentPanel({dealId})` from `src/components/mca/documents/document-panel.tsx` and `ApplicationScanPanel()` from `application-scan-panel.tsx`; B `IntakePanel()` from `src/components/mca/intake/intake-panel.tsx`; C `ImportPanel()` from `src/components/mca/imports/import-panel.tsx`. C mounts them in existing deals/integrations/workspace pages under existing server permissions.
8. Vault requires real scanning, version relationships, immutable originals, recoverable upload states and short-lived download links. Choose configurable ClamAV clamd/clamscan; absent scanner means pending/unavailable, never fake clean. Infected/error files remain quarantined and cannot be downloaded or sent to extraction. Inject scanner doubles for tests, distinguish actual scanner evidence. Default max document 25 MiB; validate PDF/PNG/JPEG content/magic, MIME and size; unsupported types show actionable errors. Five-minute download tokens bind document/version/workspace and still require current authorized actor.
9. PDF output supports real/omitted/explicitly redacted contact preview. Keep source/generated API application separate. Signed-on-behalf generation requires recorded merchant authorization; ordinary unsigned generation does not fabricate signatures. Test redacted text and metadata. Unknown SSN remains unknown; existing model stores identity last-four, do not add full-SSN retention. Scans support create or explicit versioned conflict-reviewed merge, preserve manual edits and source PDF/extraction version; pre-deal drafts require actor/workspace scope.
10. MIC-176 is a configured shared **Jotform** with opaque per-rep tokens, admin copy/test links, active-member/form/workspace binding, and quarantine for tampered/deactivated mappings. Do not replace this with an unrelated new public form. Document required statements, state selectors, identifier/date validation.
11. All connectors need configuration/status, mapping preview, realistic vendor fixture, private attachment retrieval, credential rotation and recoverable failures. MIC-181 explicitly needs customer-approved Zoho payload/access method: implement documented candidate adapter/configuration now, but record approval/upstream discovery pending. Verify actual DocuSeal completion nomenclature against official docs and normalize it into ticket's form.completed semantic; unknown templates go to review. Do not invent common signatures for all providers.
12. Email requires actual inbound route configuration separately from display address, optional sender/domain rules, selectable initial status, one lead/email, ignore signature graphics, stable rep pool, extraction review and forwarding confirmation handling. Receipt outbox persists pending/sent/failed and authenticated deal/add-document links plus warnings. Preview is not delivery.
13. Imports support **CSV/XLSX/XLS/TSV**, header/encoding detection, editable AI confidence review, reusable workspace mapping profiles, duplicates, required business name, 1,000-row scenario, checkpointed errors/results CSV. Cancellation makes zero deals. Manual mapping remains available and labeled when model is absent.
14. C adds minimal workspace source/batch registry with create/select UI so each run references an existing source and batch; retain import provenance without implementing later cost accounting. Deterministic per-run row-order round robin: explicit originator overrides only its row and does not consume pool cursor. Member removal invalidates preview before further commit.
15. Multiple ZIP archives inventory exact normalized names, ambiguous/unmatched folders and category review. Persist only confirmed associations. Application enrichment fills blanks only without overwriting sheet/manual fields, records provenance. Enforce safe paths/expansion limits.
16. CSV update is separate with template, allowed deal fields/status/assignment only, rejects owner/offer/payment edits. Blank cells no-op by default, explicit clearing reviewable. Blank IDs never create in update mode; explicit create mode reuses import. Expected versions and existing status transitions govern commit; record checkpoints if update plus transition requires two steps.
17. Drive uses real folder URL and supported authorized server listing/download with pagination, bounded transfers, checkpoint resumption, per-file denied/removed results and revocation. Use current official docs for least-privilege authorization; local manifests are not Drive implementation.

## Provider and completion gates

Continue all adapter/UI/persistence/review/test work despite missing credentials. Realistic fixture criteria can pass locally; they do not prove production readiness. Record per criterion implemented/tested locally, verified live, pending external setup, or unimplemented. Root makes criterion-specific status decisions; no blanket mock-success or blanket all-live requirement.

Explicit gates: durable production storage/backups, actual configured ClamAV, live model credentials, form accounts/private-read credentials, approved Zoho upstream contract, DocuSeal template/signing setup, inbound email domain/route and outbound receipt transport, Drive credentials/granted fixture folder, and MIC-179 dependency. Expose actionable provider-unavailable states. Missing providers do not excuse unimplemented adapter/UI/test work.

## Existing foundation to preserve

The app is in `nextjs-version`; its parent directory is not a Git repository. No Git repository or additional AGENTS files were found by the root inspection.

- Node 24 built-in SQLite provides persistent state, WAL, foreign keys, busy timeout, and immediate write transactions through `src/lib/mca/db.ts`.
- `auth.ts` resolves workspace from a verified membership or scoped API key; `intake:write` already exists. Session mutations use origin validation. Active membership, role, manager scope, and configuration must be enforced on the server.
- `deals/service.ts` exposes `actorForDeals`, `createDeal`, `getDeal`, and `updateDealRecord`. Creation is workspace-idempotent; updates are versioned. Reuse validation and assignment rules.
- `deals/repository.ts` holds the deal schema in its own module. Sensitive fields use workspace-bound encryption. New repositories should use similarly isolated schemas without concurrent edits to the foundation database module.
- `getDeal` returns masked EIN/owner fields. PDF generation and extraction reconciliation must not accidentally use masked display values as original data.
- Deal source currently permits manual, import, application_scan, api, and system. Preserve richer intake provenance in new domain records; agree on any additions before modifying shared deal types.
- The deal dialog is implemented in `src/app/(dashboard)/deals/components/deals-workspace.tsx`. Integrate new components there through a single owner.
- `email.ts` supports invitations and recovery only. Private intake receipts need a separate checked delivery contract or an explicitly coordinated extension.
- Baseline milestone 01 evidence is in `docs/milestone-01/final-verification.md`: 13 tests passed, typecheck passed, lint had 3 existing advisories, production build and smoke passed. The fresh baseline is a separate task.
- Production deploy/storage and live email delivery were not provisioned in milestone 01. Milestone 02 must describe corresponding runtime dependencies honestly.

## Proposed architecture and shared contracts

### A. Durable records and authorization

Use three domain directories with schema initialization in their own repositories: `documents/`, `intake/`, and `imports/`. Initialize schema against the actual database instance (not an unrecoverable module boolean after tests close/reopen the DB). All primary business records include immutable workspace ID. Use unique constraints for retry keys and provider event IDs. Validate workspace/resource pairs before processing queued or deferred work.

Services accept authenticated `AuthContext` or `DealActor`; they never accept a caller-selected workspace as authority. Public/provider endpoints resolve a configured integration or form token to a workspace, validate that credential, and only then create a narrow server-side actor. Broad API-key actors must not be manufactured from untrusted JSON.

Documents inherit deal visibility. Downloads, previews, metadata, extraction results, import reviews, and error manifests need equivalent access checks; hiding UI controls is insufficient. Recheck membership before assigning an imported deal or submitting a rep form.

Do not nest `BEGIN IMMEDIATE`: existing deal create/update repositories already own transactions. For multi-record atomic work, introduce a deliberately shared transaction-aware repository operation, or use durable row/event states plus idempotent reconciliation. Never wrap calls that start their own transactions in another immediate transaction. Do not hold database write transactions across provider network requests.

### B. Domain responsibilities under the frozen contracts

The exact frozen contracts above supersede these general responsibilities.

- Documents owns `documents/contracts.ts`: document categories, `DocumentSummary`, `UploadDocumentInput`, and processing state. Server service exports upload/store, list, authorized content read, and metadata update. Persist original filename, current display filename, content hash, MIME, byte length, storage locator, source kind/source reference, actor, created time, category, and processing result. Callers pass `dealId`, stable source reference, bytes, filename, MIME, category; server verifies the deal and workspace.
- Documents owns extraction and PDF provider contracts. Extraction returns structured candidates with field-level confidence/provenance and warnings; unsupported or unavailable processing is explicit. Preserve original files and confirmed human edits.
- Intake owns `intake/contracts.ts`: normalized application payload, external event ID, provider/form identifier, source metadata, assignment hint, attachment references, and result with stable intake/deal IDs and per-attachment outcomes.
- Intake normalizes external payloads into the existing `DealWriteInput`; it does not create a second deal model. Provider mapping stays in provider-specific modules.
- Imports owns `imports/contracts.ts`: immutable import batch, staged row, field mapping, row validation/conflict results, assignment configuration, commit result, and matching candidates. Preview and commit use the same normalized mapping and an expected preview revision.
- Each domain owns its own additional routes under `/api/mca/documents`, `/api/mca/intake`, and `/api/mca/imports`. Provider-facing endpoints require explicit authenticated admission controls. Any deal-nested alias must have one designated owner.
- Use existing API error envelopes, request correlation IDs, non-sensitive audit metadata, and no-store responses. Secrets, document bodies, raw application payloads, and sensitive row contents do not belong in audit logs.

### C. External services and truthful states

Vendor adapters need verified provider documentation for the selected payload/authentication contract. Do not assert that all form vendors use the same webhook signature or support the same retry identifier.

For AI work, implement an actual configurable provider adapter with structured output validation, timeout, errors, provenance, and reproducible test fixtures. Heuristic mapping can be a useful separately labeled fallback; it is not evidence that AI extraction works. Unconfigured provider states must be visible and actionable, not return fabricated extraction success.

Storage must persist outside public assets, retain original bytes, and support backup/deployment configuration. A filesystem adapter can provide working local storage; a production deployment needs a durable volume or a real object-store adapter. Serving a file requires authorization every time. Protect imported URLs against private-network access and redirects; restrict provider download hosts and stream with byte/time limits. ZIP processing must enforce path and expansion limits.

No live webhook, form, Drive access, inbound email DNS, or model credential should be represented as configured without evidence. Implemented adapters plus contract tests are distinct from live end-to-end provider acceptance.

## Ownership for up to three Sol high execution agents

| Lane | Tickets | Exclusive new paths | Integration ownership |
| --- | --- | --- | --- |
| A — Documents and extraction | MIC-169, MIC-193, MIC-182, MIC-177 | `src/lib/mca/documents/**`, `src/app/api/mca/documents/**`, `src/components/mca/documents/**`, `tests/documents-*.test.*`, lane evidence | Document contracts, storage, AI/PDF providers, vault/extraction UI |
| B — Intake and connectors | MIC-152, MIC-175, MIC-186, MIC-181, MIC-183, MIC-159, MIC-184, MIC-176 | `src/lib/mca/intake/**`, `src/app/api/mca/intake/**`, `src/components/mca/intake/**`, `tests/intake-*.test.*`, lane evidence | Intake contracts, provider settings, shared Jotform links, receipts |
| C — Imports and final integration | MIC-119, MIC-165, MIC-155, MIC-173, MIC-167 | `src/lib/mca/imports/**`, `src/app/api/mca/imports/**`, `src/components/mca/imports/**`, `tests/imports-*.test.*`, lane evidence | Import contracts; sole editor of package/lockfiles, shared foundation changes, existing deal dialog/navigation/settings, final build fixes |

Lane C should land the agreed small shared changes first, then work independently on imports. Lanes A/B send dependency requests and components' public props to C; they do not modify package manifests, lockfiles, existing shell/deal components, `db.ts`, `types.ts`, or `deals/**` in parallel. If C is overloaded, pause the relevant lane and transfer explicit file ownership; do not allow silent shared-file edits.

Provider settings components can be built independently by B; C mounts them after their contracts stabilize. A's document UI accepts a deal ID and refresh callback. B's intake UI and C's import UI can be linked from the existing deal workspace without introducing a new global page-permission key.

Engineering dependencies (observed relations are authoritative above): foundation → MIC-169 and MIC-152; MIC-169 → MIC-193/59/65 and all attachment delivery; MIC-152 → form connectors/email/shared form; MIC-119 → MIC-165/69/70/80 batch review, with MIC-169 handling stored files. MIC-167 can stage Drive contents through the same batch contract. No later milestone should be silently added merely to make these tickets easier.


## Authoritative per-ticket requirements

Every numbered implementation item and acceptance checkbox below requires lane evidence; text is copied from the full current tickets.

### MIC-193 — Generate application PDFs with contact disclosure controls

UUID `03c50896-717a-499c-92bf-50e244e85758`. [Linear](https://linear.app/michael-belenkiy/issue/MIC-193/generate-application-pdfs-with-contact-disclosure-controls).

#### Proposed implementation

1. Build original application PDF templates populated from validated deal and owner data.
2. Provide real, omitted or masked contact preview with explicit representation of missing/redacted fields.
3. Require recorded merchant authorization before any signature-on-behalf workflow and preserve a generation audit trail.
4. Keep source application and generated API application separate; require provider-compatible, truthful fields for actual API submission.

#### Data and service contract

Use typed request/response schemas. Persist workspace ID, stable record identifiers, actor/source, timestamps and relevant version references. Keep calculations and authorization server-side. Expose actionable field errors; external service records must retain correlation IDs and capability limits.

#### Acceptance criteria

- [ ] Masked output never accidentally includes real contact values in metadata.
- [ ] Generation without required authorization cannot create a signed-on-behalf artifact.
- [ ] Demonstrate every implementation requirement with a realistic synthetic scenario and expected output.
- [ ] Loading, empty, validation, success and failure states are usable; retries preserve record identity.
- [ ] Direct API requests enforce the same permissions as the UI. Logs exclude secrets and full sensitive document contents.


### MIC-186 — GoHighLevel / MCA Simplified application intake connector

UUID `4615d2d7-a316-4785-926c-381a69ab506a`. [Linear](https://linear.app/michael-belenkiy/issue/MIC-186/gohighlevel-mca-simplified-application-intake-connector).

#### Proposed implementation

1. Accept tag/workflow-triggered contact applications; map location, source contact and assigned rep.
2. Expose connection status, mapping configuration and a safe test submission preview.
3. Map business/owner fields into the shared intake contract and preserve provider submission identifiers.
4. Support credential rotation and recover attachment failures without recreating the deal.

#### Data and service contract

Use typed request/response schemas. Persist workspace ID, stable record identifiers, actor/source, timestamps and relevant version references. Keep calculations and authorization server-side. Expose actionable field errors; external service records must retain correlation IDs and capability limits.

#### Acceptance criteria

- [ ] A provider fixture creates the expected deal, documents and rep assignment.
- [ ] Expired credentials show an actionable error and retry does not duplicate the application.
- [ ] Demonstrate every implementation requirement with a realistic synthetic scenario and expected output.
- [ ] Loading, empty, validation, success and failure states are usable; retries preserve record identity.
- [ ] Direct API requests enforce the same permissions as the UI. Logs exclude secrets and full sensitive document contents.


### MIC-184 — Private email intake with extraction and receipts

UUID `299c7938-efed-464f-8652-a4e00c43b3ae`. [Linear](https://linear.app/michael-belenkiy/issue/MIC-184/private-email-intake-with-extraction-and-receipts).

#### Proposed implementation

1. Provision workspace intake addresses with optional sender/domain allowlists and selectable initial status.
2. Extract one lead per email, ignore signature graphics and classify genuine attachments.
3. Deduplicate by message identity and use a stable assignment pool; retain uncertain extractions for human review.
4. Send a receipt with authorized deal/add-document links and warnings; support forwarding confirmation handling.

#### Data and service contract

Use typed request/response schemas. Persist workspace ID, stable record identifiers, actor/source, timestamps and relevant version references. Keep calculations and authorization server-side. Expose actionable field errors; external service records must retain correlation IDs and capability limits.

#### Acceptance criteria

- [ ] Forwarding the same message twice yields one intake record.
- [ ] A failed extraction remains visible in a review queue and unauthorized senders are refused.
- [ ] Demonstrate every implementation requirement with a realistic synthetic scenario and expected output.
- [ ] Loading, empty, validation, success and failure states are usable; retries preserve record identity.
- [ ] Direct API requests enforce the same permissions as the UI. Logs exclude secrets and full sensitive document contents.


### MIC-183 — Fillout and custom forms application intake connector

UUID `f6f6619f-7863-4c6e-b927-084cab6cc5dc`. [Linear](https://linear.app/michael-belenkiy/issue/MIC-183/fillout-and-custom-forms-application-intake-connector).

#### Proposed implementation

1. Provide a documented generic webhook path and a verified Fillout mapping fixture; do not assume identical provider schemas.
2. Expose connection status, mapping configuration and a safe test submission preview.
3. Map business/owner fields into the shared intake contract and preserve provider submission identifiers.
4. Support credential rotation and recover attachment failures without recreating the deal.

#### Data and service contract

Use typed request/response schemas. Persist workspace ID, stable record identifiers, actor/source, timestamps and relevant version references. Keep calculations and authorization server-side. Expose actionable field errors; external service records must retain correlation IDs and capability limits.

#### Acceptance criteria

- [ ] A provider fixture creates the expected deal, documents and rep assignment.
- [ ] Expired credentials show an actionable error and retry does not duplicate the application.
- [ ] Demonstrate every implementation requirement with a realistic synthetic scenario and expected output.
- [ ] Loading, empty, validation, success and failure states are usable; retries preserve record identity.
- [ ] Direct API requests enforce the same permissions as the UI. Logs exclude secrets and full sensitive document contents.


### MIC-182 — AI application PDF extraction and deal creation

UUID `b55ffc02-c4c1-47f0-bda5-436ac41b148c`. [Linear](https://linear.app/michael-belenkiy/issue/MIC-182/ai-application-pdf-extraction-and-deal-creation).

#### Proposed implementation

1. Provide authenticated upload-and-scan flow using the document processing service.
2. Extract business and multiple owners to a strict schema with page evidence and unknown markers.
3. Review missing/low-confidence fields before create; save original PDF and extraction version.
4. Offer explicit merge into an existing deal only after conflict review; do not place permanent API keys in URLs.

#### Data and service contract

Use typed request/response schemas. Persist workspace ID, stable record identifiers, actor/source, timestamps and relevant version references. Keep calculations and authorization server-side. Expose actionable field errors; external service records must retain correlation IDs and capability limits.

#### Acceptance criteria

- [ ] A missing SSN stays unknown instead of receiving an invented value.
- [ ] Rescanning the same document preserves approved manual edits unless explicitly replaced.
- [ ] Demonstrate every implementation requirement with a realistic synthetic scenario and expected output.
- [ ] Loading, empty, validation, success and failure states are usable; retries preserve record identity.
- [ ] Direct API requests enforce the same permissions as the UI. Logs exclude secrets and full sensitive document contents.


### MIC-181 — Zoho application intake connector

UUID `4a209e91-099c-4f15-ae82-d6297aaa5fb9`. [Linear](https://linear.app/michael-belenkiy/issue/MIC-181/zoho-application-intake-connector).

#### Proposed implementation

1. Map a customer-approved Zoho form/workflow payload and attachment access method; exact upstream contract needs discovery.
2. Expose connection status, mapping configuration and a safe test submission preview.
3. Map business/owner fields into the shared intake contract and preserve provider submission identifiers.
4. Support credential rotation and recover attachment failures without recreating the deal.

#### Data and service contract

Use typed request/response schemas. Persist workspace ID, stable record identifiers, actor/source, timestamps and relevant version references. Keep calculations and authorization server-side. Expose actionable field errors; external service records must retain correlation IDs and capability limits.

#### Acceptance criteria

- [ ] A provider fixture creates the expected deal, documents and rep assignment.
- [ ] Expired credentials show an actionable error and retry does not duplicate the application.
- [ ] Demonstrate every implementation requirement with a realistic synthetic scenario and expected output.
- [ ] Loading, empty, validation, success and failure states are usable; retries preserve record identity.
- [ ] Direct API requests enforce the same permissions as the UI. Logs exclude secrets and full sensitive document contents.


### MIC-177 — AI bank-statement filename standardization

UUID `53adb066-e385-4d12-aa3e-471d2610c1c8`. [Linear](https://linear.app/michael-belenkiy/issue/MIC-177/ai-bank-statement-filename-standardization).

#### Proposed implementation

1. Extract bank label, statement month and account suffix and suggest a readable filename.
2. Offer preview, apply and correction actions without changing object identity.
3. Avoid full account numbers in filenames; handle duplicate names using stable suffixes.
4. Keep original filename in metadata and flag uncertain period/bank extraction.

#### Data and service contract

Use typed request/response schemas. Persist workspace ID, stable record identifiers, actor/source, timestamps and relevant version references. Keep calculations and authorization server-side. Expose actionable field errors; external service records must retain correlation IDs and capability limits.

#### Acceptance criteria

- [ ] Two statements with the same suggested filename remain distinct.
- [ ] Renaming preserves all references and original file contents.
- [ ] Demonstrate every implementation requirement with a realistic synthetic scenario and expected output.
- [ ] Loading, empty, validation, success and failure states are usable; retries preserve record identity.
- [ ] Direct API requests enforce the same permissions as the UI. Logs exclude secrets and full sensitive document contents.


### MIC-176 — Shared application form and personal rep links

UUID `f0303f51-9b02-4f81-93c2-e61d2c7c2fef`. [Linear](https://linear.app/michael-belenkiy/issue/MIC-176/shared-application-form-and-personal-rep-links).

#### Proposed implementation

1. Create per-rep opaque attribution tokens bound to workspace, active member and configured form.
2. Provide an admin copy-link interface and a test path showing the resolved originator.
3. Validate incoming hidden attribution against configured routing; quarantine unknown/deactivated rep mappings.
4. Document required statement upload, state selectors and identifier/date validation for the shared form.

#### Data and service contract

Use typed request/response schemas. Persist workspace ID, stable record identifiers, actor/source, timestamps and relevant version references. Keep calculations and authorization server-side. Expose actionable field errors; external service records must retain correlation IDs and capability limits.

#### Acceptance criteria

- [ ] Two personal links create deals for different intended reps on the same form.
- [ ] Tampering with a rep identifier cannot assign into another workspace.
- [ ] Demonstrate every implementation requirement with a realistic synthetic scenario and expected output.
- [ ] Loading, empty, validation, success and failure states are usable; retries preserve record identity.
- [ ] Direct API requests enforce the same permissions as the UI. Logs exclude secrets and full sensitive document contents.


### MIC-175 — Jotform application intake connector

UUID `32d60417-4800-4c11-b987-f3ebe907557e`. [Linear](https://linear.app/michael-belenkiy/issue/MIC-175/jotform-application-intake-connector).

#### Proposed implementation

1. Fetch private attachments using the customer's authorized read credential; support per-rep form IDs and detect missing files.
2. Expose connection status, mapping configuration and a safe test submission preview.
3. Map business/owner fields into the shared intake contract and preserve provider submission identifiers.
4. Support credential rotation and recover attachment failures without recreating the deal.

#### Data and service contract

Use typed request/response schemas. Persist workspace ID, stable record identifiers, actor/source, timestamps and relevant version references. Keep calculations and authorization server-side. Expose actionable field errors; external service records must retain correlation IDs and capability limits.

#### Acceptance criteria

- [ ] A provider fixture creates the expected deal, documents and rep assignment.
- [ ] Expired credentials show an actionable error and retry does not duplicate the application.
- [ ] Demonstrate every implementation requirement with a realistic synthetic scenario and expected output.
- [ ] Loading, empty, validation, success and failure states are usable; retries preserve record identity.
- [ ] Direct API requests enforce the same permissions as the UI. Logs exclude secrets and full sensitive document contents.


### MIC-173 — CSV bulk updates with field mapping and change preview

UUID `c3345c42-01f3-45a7-9371-3b3a83167355`. [Linear](https://linear.app/michael-belenkiy/issue/MIC-173/csv-bulk-updates-with-field-mapping-and-change-preview).

#### Proposed implementation

1. Build a separate update wizard with template download, column mapping and before/after review.
2. Allow listed deal fields, status and assignments; reject owner, offer and payment edits in this path.
3. Validate IDs against authorized workspace; require explicit create mode for rows without IDs.
4. Record per-row changes, errors and audit information; protect against stale updates.

#### Data and service contract

Use typed request/response schemas. Persist workspace ID, stable record identifiers, actor/source, timestamps and relevant version references. Keep calculations and authorization server-side. Expose actionable field errors; external service records must retain correlation IDs and capability limits.

#### Acceptance criteria

- [ ] An ID from another workspace cannot be updated.
- [ ] Blank IDs do not silently create deals in update mode.
- [ ] Demonstrate every implementation requirement with a realistic synthetic scenario and expected output.
- [ ] Loading, empty, validation, success and failure states are usable; retries preserve record identity.
- [ ] Direct API requests enforce the same permissions as the UI. Logs exclude secrets and full sensitive document contents.


### MIC-169 — Secure document vault and categorized uploads

UUID `13fb5435-4216-401b-a977-aef74cc4ed7b`. [Linear](https://linear.app/michael-belenkiy/issue/MIC-169/secure-document-vault-and-categorized-uploads).

#### Proposed implementation

1. Model immutable Document originals, versions, category, checksum, uploader and processing state.
2. Support multipart uploads, progress, retries, preview, authorized downloads and category correction.
3. Separate statements, application, API application, DL/voided check, closing documents and other stips.
4. Validate content/type/size and scan uploads; issue short-lived download links and prevent cross-deal object access.

#### Data and service contract

Use explicit typed request/response schemas for this workflow. Persist workspace ID, stable record identifiers, actor/source, timestamps and relevant version references. Keep calculations and authorization on the server; expose actionable validation errors to the UI. For external services, store request correlation IDs and capability limits rather than claiming unsupported outcomes.

#### Acceptance criteria

- [ ] Interrupted uploads resume or fail with a recoverable state.
- [ ] Changing a download identifier cannot expose another workspace's document.
- [ ] Each requirement above is demonstrated with a realistic synthetic scenario and documented expected output.
- [ ] Loading, empty, validation, success and failure states are usable; retries preserve record identity.
- [ ] Server-side permissions apply to direct requests as well as the UI, and no secrets or full sensitive document contents appear in logs.


### MIC-167 — Google Drive package import

UUID `4699cede-3d7d-45e1-91f3-84845402df9c`. [Linear](https://linear.app/michael-belenkiy/issue/MIC-167/google-drive-package-import).

#### Proposed implementation

1. Accept a shared folder link through a supported authorization flow and list only granted folder contents.
2. Transfer spreadsheets and documents server-side with pagination, limits, progress and resumable checkpoints.
3. Reuse merchant matching and review before creating records; expose inaccessible or removed files.
4. Revoke connection access cleanly and avoid retaining unnecessary Drive credentials.

#### Data and service contract

Use typed request/response schemas. Persist workspace ID, stable record identifiers, actor/source, timestamps and relevant version references. Keep calculations and authorization server-side. Expose actionable field errors; external service records must retain correlation IDs and capability limits.

#### Acceptance criteria

- [ ] A permission-denied file appears in results without blocking other imports.
- [ ] A resumed transfer does not create duplicate documents.
- [ ] Demonstrate every implementation requirement with a realistic synthetic scenario and expected output.
- [ ] Loading, empty, validation, success and failure states are usable; retries preserve record identity.
- [ ] Direct API requests enforce the same permissions as the UI. Logs exclude secrets and full sensitive document contents.


### MIC-165 — ZIP document matching and classification during import

UUID `0cbf1dd7-3d9a-4ea0-ac51-649dcd0ac53b`. [Linear](https://linear.app/michael-belenkiy/issue/MIC-165/zip-document-matching-and-classification-during-import).

#### Proposed implementation

1. Accept multiple archives, inventory contents and reject unsafe paths or decompression bombs.
2. Match exact normalized merchant names first and present uncertain suggestions for user approval.
3. Classify confirmed files into statement, application and stipulation destinations; display unmatched folders separately.
4. Fill blank fields from application scans without overriding sheet values; record enrichment provenance.

#### Data and service contract

Use typed request/response schemas. Persist workspace ID, stable record identifiers, actor/source, timestamps and relevant version references. Keep calculations and authorization server-side. Expose actionable field errors; external service records must retain correlation IDs and capability limits.

#### Acceptance criteria

- [ ] An ambiguous folder remains unassigned until reviewed.
- [ ] Only confirmed row/file associations are persisted, and originals remain intact.
- [ ] Demonstrate every implementation requirement with a realistic synthetic scenario and expected output.
- [ ] Loading, empty, validation, success and failure states are usable; retries preserve record identity.
- [ ] Direct API requests enforce the same permissions as the UI. Logs exclude secrets and full sensitive document contents.


### MIC-159 — DocuSeal signed application intake and form assignment

UUID `f83877e5-72db-4ba3-9d14-9f03fd107c4d`. [Linear](https://linear.app/michael-belenkiy/issue/MIC-159/docuseal-signed-application-intake-and-form-assignment).

#### Proposed implementation

1. Receive verified form.completed callbacks and fetch signed application artifacts.
2. Map template/form identity to workspace and rep; support onboarding a cloned template.
3. Store completion ID, signer metadata and signed document reference with the intake record.
4. Recover delayed PDF availability separately from deal creation; avoid treating incomplete signing events as final applications.

#### Data and service contract

Use typed request/response schemas. Persist workspace ID, stable record identifiers, actor/source, timestamps and relevant version references. Keep calculations and authorization server-side. Expose actionable field errors; external service records must retain correlation IDs and capability limits.

#### Acceptance criteria

- [ ] A repeated completion callback creates one deal and one signed artifact.
- [ ] Unknown template IDs remain in a review queue.
- [ ] Demonstrate every implementation requirement with a realistic synthetic scenario and expected output.
- [ ] Loading, empty, validation, success and failure states are usable; retries preserve record identity.
- [ ] Direct API requests enforce the same permissions as the UI. Logs exclude secrets and full sensitive document contents.


### MIC-155 — Round-robin import assignment and lead batch attribution

UUID `ef3e6f46-26c2-47f1-9f28-0778900247cd`. [Linear](https://linear.app/michael-belenkiy/issue/MIC-155/round-robin-import-assignment-and-lead-batch-attribution).

#### Proposed implementation

1. Provide active-rep pools and deterministic row-order round-robin assignment.
2. Honor explicit originator mappings with previewed precedence and flag unresolved names.
3. Attach every import run to an existing source and batch and retain import-run provenance.
4. Show assignments before commit and include rep, source and batch references in results.

#### Data and service contract

Use typed request/response schemas. Persist workspace ID, stable record identifiers, actor/source, timestamps and relevant version references. Keep calculations and authorization server-side. Expose actionable field errors; external service records must retain correlation IDs and capability limits.

#### Acceptance criteria

- [ ] An explicit originator overrides the pool only for its row.
- [ ] Removing a rep between preview and commit forces revalidation.
- [ ] Demonstrate every implementation requirement with a realistic synthetic scenario and expected output.
- [ ] Loading, empty, validation, success and failure states are usable; retries preserve record identity.
- [ ] Direct API requests enforce the same permissions as the UI. Logs exclude secrets and full sensitive document contents.


### MIC-152 — Authenticated intake webhooks and separate attachment delivery

UUID `ba7dfd9d-156e-4085-89d2-6e17ffd1e0b8`. [Linear](https://linear.app/michael-belenkiy/issue/MIC-152/authenticated-intake-webhooks-and-separate-attachment-delivery).

#### Proposed implementation

1. Define versioned intake and document-attachment contracts with provider event ID, workspace binding, business, owners and source IDs.
2. Verify signatures or scoped credentials, normalize fields and persist received/validated/created/file-pending/error states.
3. Download attachments asynchronously with restricted outbound fetches; correlate later file events to the existing deal.
4. Provide field-map preview, sample payloads and replay tools; deduplicate retry delivery without merging distinct applications.

#### Data and service contract

Use typed request/response schemas. Persist workspace ID, stable record identifiers, actor/source, timestamps and relevant version references. Keep calculations and authorization server-side. Expose actionable field errors; external service records must retain correlation IDs and capability limits.

#### Acceptance criteria

- [ ] Repeated delivery of one event creates one deal.
- [ ] A document arriving after the application attaches to the intended deal and triggers readiness re-evaluation.
- [ ] Demonstrate every implementation requirement with a realistic synthetic scenario and expected output.
- [ ] Loading, empty, validation, success and failure states are usable; retries preserve record identity.
- [ ] Direct API requests enforce the same permissions as the UI. Logs exclude secrets and full sensitive document contents.


### MIC-119 — Spreadsheet bulk import with AI mapping and review

UUID `a195cd02-d0a4-44d2-8a19-63a7f5e04e30`. [Linear](https://linear.app/michael-belenkiy/issue/MIC-119/spreadsheet-bulk-import-with-ai-mapping-and-review).

#### Proposed implementation

1. Build an import wizard for CSV/XLSX/XLS/TSV with header detection, encoding checks and sample-value mapping.
2. Offer AI field suggestions with editable confidence review and reusable workspace mapping profiles.
3. Require business name; validate rows, show duplicates and provide an explicit create review before persistence.
4. Use checkpointed row processing with results CSV and recoverable row errors; proposed scale target is 1,000 leads per run.

#### Data and service contract

Use typed request/response schemas. Persist workspace ID, stable record identifiers, actor/source, timestamps and relevant version references. Keep calculations and authorization server-side. Expose actionable field errors; external service records must retain correlation IDs and capability limits.

#### Acceptance criteria

- [ ] Cancel at review creates no deals.
- [ ] A malformed row is reported while valid rows finish exactly once.
- [ ] Demonstrate every implementation requirement with a realistic synthetic scenario and expected output.
- [ ] Loading, empty, validation, success and failure states are usable; retries preserve record identity.
- [ ] Direct API requests enforce the same permissions as the UI. Logs exclude secrets and full sensitive document contents.

## Verification and completion evidence

Each lane writes focused domain tests and HTTP tests consistent with the existing `pnpm test` discovery patterns. Favor behavior over tests that mirror helpers. Use temporary SQLite paths and private temporary storage; reset schema initialization safely between tests. Never overwrite the user's persistent data.

Minimum shared regression matrix:

- Same-named records in two workspaces; Rep, Manager, Admin, scoped API key, revoked key, and unauthenticated access.
- Intake/row/file retry, interrupted processing and resumption, duplicate delivery with changed payload, stale preview/version conflict.
- Original byte retention, no public/cache exposure, metadata/body limits, meaningful provider failure, safe audit content.
- File formats/real parsing for PDFs, ZIPs, and every supported spreadsheet type; inspect generated PDFs visually and textually.
- Browser workflows for document upload/download, extraction review/create, batch preview/commit, shared Jotform copy/test links, and provider configuration at desktop and narrow width.
- Full `pnpm test`, `pnpm typecheck`, `pnpm lint`, isolated production build, and temporary production-start HTTP smoke. Preserve existing milestone-01 evidence and distinguish pre-existing lint advisories.

For each ticket record: formal acceptance criterion, implementation file(s), exact executable/browser evidence, local result, external dependency/configuration, and live verification result. A ticket with an unimplemented criterion stays open. An adapter tested with fixtures may be implemented locally while live provider verification is still pending; state that distinction explicitly.

Final coordinator evidence should include test counts, tested environment, build/start commands, screenshots or browser acceptance notes where helpful, and a concise list of operational dependencies. All 17 full tickets have been reconciled. Root's fresh baseline passed 13 tests and typecheck.

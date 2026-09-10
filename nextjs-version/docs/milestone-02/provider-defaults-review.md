# Provider defaults bounded review

Reviewed 2026-09-08 against `provider-defaults-plan.md`, limited to the selected MIC-181 Zoho Forms JSON/private Google Drive contract and MIC-184 Postmark Inbound contract. This was a read-only application-code review; no live provider setup, mailbox delivery, attachment retrieval, or outbound receipt was performed.

## Result

No code blockers remain in the selected scope.

| Area | Verified behavior | Evidence |
| --- | --- | --- |
| Zoho contract | `zoho_forms_json_drive_v1` is the selected approved default. It requires exact top-level `formId` and `entryId`; fallback-only `form_id` and `entry_id` payloads fail. Unknown custom contract keys remain in `pending_customer_contract`. | The focused fixture covers successful selected-contract intake, wrong/missing exact keys, and the unknown-contract gate. |
| Zoho mapping | The selected flat fields map business, contact, state, revenue, and first-owner values. An empty UI mapping uses the selected defaults instead of overriding them. The configured active assignment pool supplies the originator. | The created fixture deal contains the expected business, numeric revenue, owner, and active rep. |
| Zoho attachments | Only the two recognized Drive file URL shapes are accepted. File IDs are constrained and converted to `https://www.googleapis.com/drive/v3/files/<id>?alt=media`. The OAuth bearer credential is sent only to `www.googleapis.com`; URL/DNS, redirects, response time, streamed size, and encrypted source URL/credential controls remain active. | The fixture stores the application and statement PDFs, observes only Google API URLs and the expected bearer header, rejects foreign/malformed links, then proves expired-token retry and credential rotation without another deal. |
| Zoho setup UI | The panel names the selected fields and attachment parameters, labels the credential as a Google Drive OAuth access token, requires an expiry value, displays contract/attachment/readiness state, and reports live Zoho serialization and Drive access as unverified. | UI creation preserves the default mapping when its editor contains `{}`; initial and rotation requests carry `credentialExpiresAt`. |
| Postmark admission and schema | Email integrations persist an explicit `postmark` or `custom` gateway. Runtime validation rejects every other value, including direct authenticated API JSON. Postmark uses HTTP Basic username `mca` plus the hashed one-time secret; admission completes before JSON parsing. The adapter maps `FromFull.Email`, `OriginalRecipient`, `Subject`, `TextBody`, `MessageID`, `Headers`, and `Attachments`. | Service and authenticated route regressions reject an invalid gateway. The real-shaped fixture rejects bad Basic credentials and a wrong recipient. |
| Postmark identity and assignment | A valid original `Message-ID` header is preferred, with Postmark `MessageID` as fallback. Stable message identity drives one intake, assignment, receipt, and per-index attachment IDs, so same-named PDFs do not collide. | Repeated callbacks and two Postmark callback IDs carrying one original Message-ID resolve to one deal/intake. The active rep is assigned and two same-named PDFs are stored separately. |
| Postmark attachment safety | The route streams the request with a 35 MiB ceiling before full allocation. Canonical base64, decoded individual and aggregate 25 MiB ceilings, and declared/decoded `ContentLength` equality are validated before deal creation. CID images are ignored while CID PDFs remain. Extraction failures and forwarding confirmations become review records without following links. | Fixtures cover a bounded over-limit request stream, malformed base64, length mismatch, oversized content, ignored inline logo, retained CID PDF, extraction failure, and forwarding-confirmation review. |
| Postmark readiness/provisioning | The admin and trusted-mutation route uses a server-side `X-Postmark-Account-Token`, verifies an existing server ID and exact name or explicitly creates one, reads the provider-issued inbound address, and configures the public HTTPS webhook with one-time Basic credentials. Account tokens and credential-bearing hook URLs are not persisted or returned. Saved provider evidence distinguishes `live_configured` from `live_unverified`. | The synthetic provider-response fixture verifies GET/PUT headers and body, provider-returned address, readiness, secret non-disclosure, and rejection of a local HTTP origin. The UI states that no provider account is connected in this environment. |

## Independent validation

```text
pnpm exec node --conditions=react-server --import tsx --test tests/intake-core.test.ts
12 tests passed, 0 failed, 353 ms

pnpm exec tsc --noEmit --pretty false
passed

pnpm exec eslint src/lib/mca/intake src/components/mca/intake src/app/api/mca/intake tests/intake-core.test.ts
passed with no diagnostics
```

The tests use an isolated temporary SQLite database, temporary document storage, fixture extraction, synthetic Google/Postmark responses, and a fixture receipt transport. They make no provider call and send no email.

## Ticket recommendation and external gate

- **MIC-181: Done — local acceptance complete.** The delegated provider choice resolves the prior product-contract gate. The selected contract now creates the mapped deal, owner, rep, and two private documents and covers replay, rejection, expiry, rotation, and retry. Customer Zoho form configuration, Google Drive storage/grant setup, and one captured live delivery remain deployment verification.
- **MIC-184: activation pending.** The selected Postmark contract, security controls, genuine payload adapter, processing, recovery behavior, setup API, and UI are complete locally. The ticket's literal real workspace intake address cannot be accepted until an authenticated Postmark account/server and deployed public HTTPS origin return and activate the provider-issued address. Receipt delivery also remains unperformed. This is an external credential/setup gate, not an open local-code defect.

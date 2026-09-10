# MIC-108 report — Contract request, acceptance, repricing, and signature tracking

Date: 2026-09-09
Agent: A3
Linear: [MIC-108](https://linear.app/michael-belenkiy/issue/MIC-108/contract-request-acceptance-repricing-and-signature-tracking) (`e3b78cfd-1e9e-46b4-9099-5db9e4cfd9ef`)
Status read: **In Progress**. Not marked Done.

**Verdict: `REVIEW_PASS`**

No remaining software gap was found that can be fixed in the exclusive module. `src/lib/mca/closing/contract-activation.ts` stays a documented no-op. `closing/service.ts`, `closing-panel.tsx`, schema, drizzle, and Linear were not edited. No live funder email was sent.

## What was reviewed

Linear MIC-108, `docs/milestone-05/remaining-plan.md`, `MIC-108-brief.md`, `lane-c-acceptance.md`, `provider-activation.md`, `postmark-closing.md`, `src/lib/mca/closing/{service,contracts,http,delivery}.ts`, contract API routes, `closing-panel.tsx`, offer eligibility, and `tests/milestone05-closing.test.ts`.

Current focused suite (disposable Neon DB, 2026-09-09):

```text
cd nextjs-version
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/milestone05-closing.test.ts

MIC-108 requests preserve blockers, attach pinned clean documents, never imply signature, and require evidence (8019ms)
tests 7
pass 7
fail 0
duration_ms 48629
```

## Required proofs (file:line)

### 1. A request does not mark contracts signed

Acceptance inserts `accepted` with `signed_at` null. Preview writes `contract_requested` or `repricing_requested`. Successful send may advance only `contract_requested` → `contract_sent`. None of those paths set `signed`.

```354:357:nextjs-version/src/lib/mca/closing/service.ts
  const inserted = await getDatabase().prepare<Row>(`INSERT INTO mca_contract_workflows
    (id,workspace_id,deal_id,offer_id,offer_revision_id,offer_revision_number,funder_id,funder_name,state,recipient_cipher,attached_document_ids_json,outstanding_stips_json,accepted_at,contract_requested_at,contract_sent_at,signed_at,final_review_at,repricing_requested_at,signature_source,signature_external_id,signature_evidence_document_id,manual_signature_reason,idempotency_key,created_by_user_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?, 'accepted',NULL,'[]','[]',?,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,?,?,?,?)
    ON CONFLICT (workspace_id,deal_id,offer_revision_id) DO NOTHING RETURNING *`).get(id, actor.workspaceId, input.dealId, offer.offerId, offer.revisionId, offer.revisionNumber, offer.funderId ?? null, offer.funderName, now, key, actor.userId, now, now)
```

```386:389:nextjs-version/src/lib/mca/closing/service.ts
  const kind = input.action === "request_contract" ? "contract_request" : "repricing_request", state = input.action === "request_contract" ? "contract_requested" : "repricing_requested", now = nowIso()
  const subject = input.action === "request_contract" ? `Contract request · ${deal.displayId}` : `Repricing request · ${deal.displayId}`
  const body = `${input.action === "request_contract" ? "Please prepare the contract" : "Please review the requested repricing"} for ${deal.legalName || deal.dbaName || deal.displayId}.\n\nOffer revision: ${row.offer_revision_number}\nFunder: ${row.funder_name}${input.action === "request_repricing" ? `\nReason: ${input.reason!.trim()}` : ""}\nAttachments: ${attachments.length}\nOutstanding stipulations: ${openStips.length ? openStips.map((item) => item.label).join(", ") : "None"}`
  const updated = await getDatabase().prepare<Row>(`UPDATE mca_contract_workflows SET state=?,recipient_cipher=?,attached_document_ids_json=?,outstanding_stips_json=?,${input.action === "request_contract" ? "contract_requested_at" : "repricing_requested_at"}=?,updated_at=? WHERE workspace_id=? AND id=? RETURNING *`).get(state, encryptSensitive(input.recipient.trim(), actor.workspaceId), JSON.stringify(attachments), JSON.stringify(openStips.map((item) => String(item.label))), now, now, actor.workspaceId, input.workflowId)
```

```419:422:nextjs-version/src/lib/mca/closing/service.ts
  const result = await attemptDelivery(actor, { dealId: String(row.deal_id), kind: String(row.kind), recordId: String(row.record_id), attemptKey, channel, recipient, payloadHash: pinnedHash, senderId, sender: emailSender, subject, body, attachments })
  await getDatabase().prepare("UPDATE mca_closing_previews SET state=?,updated_at=? WHERE workspace_id=? AND id=?").run(result.state === "sent" ? "sent" : "failed", nowIso(), actor.workspaceId, previewId)
  if (result.state === "sent" && row.kind === "contract_request") await getDatabase().prepare("UPDATE mca_contract_workflows SET state='contract_sent',contract_sent_at=?,updated_at=? WHERE workspace_id=? AND id=? AND state='contract_requested'").run(nowIso(), nowIso(), actor.workspaceId, row.record_id)
  return result
```

Focused test: after preview+send the workflow is `contract_sent`, not `signed` (`tests/milestone05-closing.test.ts` 79–83). Signed state is a later `recordContractSignature` call (88–89).

### 2. Absent DL / voided check is a visible blocker or explicit exception

Server: contract request requires a clean same-deal `driver_license` and `voided_check` attachment, or a trimmed per-category exception. Missing items throw `closing_documents_missing` with field errors.

```364:383:nextjs-version/src/lib/mca/closing/service.ts
async function validatedClosingDocuments(actor: DealActor, dealId: string, documentIds: string[], exceptions: Record<string, string>): Promise<{ attachments: string[]; missing: string[] }> {
  const documents = await listDocuments(actor, dealId), clean = new Map(documents.filter((item) => item.processingState === "clean").map((item) => [item.id, item]))
  for (const id of documentIds) if (!clean.has(id)) throw new AppError(422, "attachment_invalid", "Every attachment must be a clean document from this deal.")
  const attachments = [...new Set(documentIds)]
  const missing: string[] = []
  for (const category of ["driver_license", "voided_check"] as const) {
    const has = attachments.some((id) => clean.get(id)?.category === category)
    if (!has && !exceptions[category]?.trim()) missing.push(category)
  }
  return { attachments, missing }
}
// ...
  if (input.action === "request_contract" && missing.length) throw new AppError(422, "closing_documents_missing", "Attach a driver license and voided check, or record an explicit exception for each missing item.", Object.fromEntries(missing.map((item) => [item, ["Attach this document or enter an exception."]])))
```

UI: Contracts card copy, empty-attachment message, and exception fields (`src/components/mca/closing/closing-panel.tsx` 45, 97, 123–126, 144). Outstanding open/received stips are stored on the workflow and shown in `ContractRow` (service 384–389; panel 153).

Test: preview without DL/VC rejects `closing_documents_missing` (`tests/milestone05-closing.test.ts` 76). The `RequestError` message is the AppError text (`src/lib/mca/client.ts` 16–18).

### 3. Repricing requires a reason

API schema, service, and UI all require a reason before a repricing preview exists.

```8:8:nextjs-version/src/app/api/mca/closing/contracts/[id]/preview/route.ts
const schema = z.object({ action: z.enum(["request_contract", "request_repricing"]), recipient: z.email(), senderId: z.string().min(1), attachedDocumentIds: z.array(z.string()).optional(), exceptions: z.record(z.string(), z.string()).optional(), reason: z.string().trim().min(1).max(1_000).optional(), idempotencyKey: z.string().min(1) }).strict().superRefine((value, context) => { if (value.action === "request_repricing" && !value.reason) context.addIssue({ code: "custom", path: ["reason"], message: "A repricing reason is required." }) })
```

```385:385:nextjs-version/src/lib/mca/closing/service.ts
  if (input.action === "request_repricing" && !input.reason?.trim()) throw new AppError(422, "repricing_reason_required", "Enter a reason before preparing a repricing request.")
```

UI: required-reason textarea; Preview repricing is disabled until `repricingReason.trim()` (`closing-panel.tsx` 46, 144, 153). Preview body includes `Reason: …` (service 388). Delivery is a second action on that exact preview (panel 113–117, 140).

Test: no-reason preview rejects `repricing_reason_required`; with reason, state is `repricing_requested` and the body contains the reason (`tests/milestone05-closing.test.ts` 84–86).

### 4. External signature id alone is not signed evidence

External capture requires both a provider id and a clean same-deal `closing_document`. Manual stage is a separate source with a required reason and never stores provider evidence.

```425:437:nextjs-version/src/lib/mca/closing/service.ts
export async function recordContractSignature(actor: DealActor, input: { workflowId: string; source: "external" | "manual"; externalId?: string; evidenceDocumentId?: string; manualReason?: string }): Promise<ContractWorkflow> {
  // ...
  if (input.source === "external") {
    required(input.externalId, "externalId", 300)
    required(input.evidenceDocumentId, "evidenceDocumentId", 300)
    const evidence = await getDocument(actor, input.evidenceDocumentId!)
    if (evidence.dealId !== row.deal_id || evidence.category !== "closing_document" || evidence.processingState !== "clean") throw new AppError(422, "signature_evidence_invalid", "External signature evidence must be a clean closing document from this deal.")
  } else required(input.manualReason, "manualReason", 500)
  const now = nowIso()
  const updated = await getDatabase().prepare<Row>(`UPDATE mca_contract_workflows SET state='signed',signed_at=?,signature_source=?,signature_external_id=?,signature_evidence_document_id=?,manual_signature_reason=?,updated_at=? WHERE workspace_id=? AND id=? RETURNING *`).get(now, input.source, input.source === "external" ? input.externalId!.trim() : null, input.evidenceDocumentId ?? null, input.source === "manual" ? input.manualReason!.trim() : null, now, actor.workspaceId, input.workflowId)
```

`required()` throws `validation_failed` when `evidenceDocumentId` is absent (`service.ts` 28–31). UI disables Record external signature unless both fields are set, and Manual signed stage unless a reason is present (`closing-panel.tsx` 153). Final review requires persisted `signed` + `signed_at` + `signature_source` (`service.ts` 445–447).

Test: external id alone rejects `validation_failed`; clean closing PDF then signs (`tests/milestone05-closing.test.ts` 87–89).

### 5. Retries preserve identity; send cannot regress signed / final-review

Identity:

- One workflow per `(workspace, deal, offer_revision)` and one per `(workspace, idempotency_key)` (`src/lib/mca/db/milestone05-closing.ts` 64–65). Accept retries `ON CONFLICT … DO NOTHING` (`service.ts` 357–358).
- Previews unique on `(workspace, idempotency_key)`; replay returns the same row only when the content hash matches (`milestone05-closing.ts` 36; `service.ts` 275–284).
- Deliveries unique on `(workspace, kind, record_id, attempt_key)` (`milestone05-closing.ts` 49). A later key against an existing `pending`/`sent`/`provider_outcome_unknown` row is fenced and does not blindly resend (`service.ts` 297–313).
- UI keeps the same `retryKey(scope)` until success (`closing-panel.tsx` 30, 88–91, 123–125).

Monotonic send:

```421:421:nextjs-version/src/lib/mca/closing/service.ts
  if (result.state === "sent" && row.kind === "contract_request") await getDatabase().prepare("UPDATE mca_contract_workflows SET state='contract_sent',contract_sent_at=?,updated_at=? WHERE workspace_id=? AND id=? AND state='contract_requested'").run(nowIso(), nowIso(), actor.workspaceId, row.record_id)
```

Test: after `signed`, a late send replay leaves state `signed`; after `final_review`, another send leaves `final_review` (`tests/milestone05-closing.test.ts` 90–94).

## Adjacent software (already implemented; not a gap)

- Acceptance binds an authorized immutable revision: `resolveOffer` → `assertOfferRevisionEligibleForClosing` rejects unselected, withdrawn, and funded revisions (`service.ts` 65–68; `src/lib/mca/offers/service.ts` 137–147, 173–176). A selected superseded revision remains addressable by exact `revisionId` (`offers/service.ts` 133–134).
- Preview requires a verified **submission** sender (`service.ts` 378; send rechecks purpose at 402–405). UI `recipientReady` is a verified submission sender plus recipient (`closing-panel.tsx` 95, 144).
- Attachment identity `{id, version, checksum}` is hashed into the preview; send revalidates clean version/checksum and issues five-minute artifact URLs (`service.ts` 276–277, 408–417). The focused transport redeemed original PDF bytes (test 81–82).
- Direct APIs use `requireClosingActor` (Deals page visibility + `deals:read`/`deals:write`). Signature and final-review are session-only (`src/lib/mca/closing/http.ts` 10–16; signature/final-review routes). HTTP test: read key 200, write 403, deals page off 403 (`tests/milestone05-closing.test.ts` 213–221).
- Audit metadata uses `externalIdPresent` / hashes / record ids, not recipient plaintext, document bytes, or provider secrets (`service.ts` 323, 328, 360, 437). Recipients live in `recipient_cipher`.
- Loading / empty / validation / success / failure: panel loading copy, empty “Accept an offer revision…”, `role="alert"` errors, `role="status"` notices, disabled preview without recipient/sender (`closing-panel.tsx` 131–144).

## Residual (not exclusive-file gaps)

These live in conductor-owned `service.ts` / `closing-panel.tsx`. They do not fail the Linear AC items above.

1. `previewContractAction` updates workflow state by id with no `signed`/`final_review` predicate (`service.ts` 389). A **new** preview after signed could overwrite state. Late **send** retries cannot, because of `AND state='contract_requested'`. The focused test does not preview after signed. The Contracts row still offers preview buttons after signed (`closing-panel.tsx` 153).
2. `recordContractSignature` likewise has no signed/final-review predicate (`service.ts` 436). The UI hides those buttons once `signedAt` is set.
3. DL/VC blockers apply to `request_contract` only, not `request_repricing` (`service.ts` 383). Repricing still requires a reason.

No `NEEDS_CONDUCTOR` stop: Wave 1 software AC is met; remaining work is the live provider gate.

## Remaining gate (do not mark Linear Done)

**Verified submission sender + live contract delivery/evidence.**

Activation checklist — **not executed this session; no live funder email**:

1. Settings → Connections: SMTP sender, purpose `submission`, `smtp.postmarkapp.com`, TLS port, Postmark server credential, provider-confirmed From.
2. Railway secret `MCA_CLOSING_POSTMARK_CONNECTIONS_JSON` binds exact workspace id, sender record id, From address, server token (`docs/milestone-05/postmark-closing.md`).
3. Authorize a named test/funder recipient. Run **Test sender**. Verified only after Postmark `ErrorCode: 0` and a `MessageID`.
4. Preview a contract request with clean DL + voided check (or explicit exceptions), then send **that** saved preview. Retain Postmark `MessageID` as delivery evidence.
5. Record signed only with provider external id **and** a clean same-deal `closing_document`. Do not treat Test sender, preview, or external id alone as signature.

Production still has a pending submission sender binding and no authorized recipient (`docs/milestone-05/provider-activation.md`). Snapshot `productionGates.contractDelivery` remains “configured; verify delivery before production use” or unavailable (`service.ts` 126–129).

## Files

| Path | Change |
| --- | --- |
| `src/lib/mca/closing/contract-activation.ts` | Unchanged no-op |
| `tests/milestone05-mic-108.test.ts` | Not added; existing focused test covers the AC |
| `docs/milestone-05/MIC-108-report.md` | This report |
| `docs/milestone-05/MIC-108-acceptance.md` | Acceptance table |

Linear was not updated.

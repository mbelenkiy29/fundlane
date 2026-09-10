# MIC-153 review — Submission email templates, signatures, prefixes and rep CC

**Spec:** PASS
**Quality:** Approved (Minor)

Live SMTP / Google / Microsoft mailbox send remains an external gate. Fixture `delivery: "preview"` is not production sending readiness. No live merchant submissions. Do not mark Linear Done from this review.

## Spec

| Requirement | Result | Evidence |
| --- | --- | --- |
| Two funders receive separately addressed packages; no cross-exposed recipients | Pass | `previewSubmissionEmails` and `sendSubmissionEmail` render per funder (`email-templates.ts:787-856`, `684-704`). Alpha To `alpha@funders.example.test` / CC originator; Beta To `beta@funders.example.test` / CC closer; neither package includes the other funder’s address; merchant `contactEmail` is not CC’d (`tests/submissions-email.test.ts:287-332`). |
| Per-funder subject/body, workspace prefix, funder prefix, sender signature | Pass | Null-`funder_id` row is workspace default; funder row supplies prefix and CC flags (`478-487`, `575-585`). Subject is `workspacePrefix funderPrefix <rendered>` (`326-328`); body appends sender signature (`331-335`, `584-585`). Tokens include `legalName`, `displayId`, `requestedAmount`, `monthlyRevenue`, `industry`, `funderName` (`299-319`). Test subjects start `WS ALPHA ` / `WS BETA `; body matches signature (`303-306`). |
| Originator/closer CC flags on the template, separate from merchant follow-up | Pass | Flags stored on `mca_submission_templates` (`cc_originator` / `cc_closer`). CC is assignment emails only (`595-591`); merchant contact never added. Alpha `ccOriginator`, Beta `ccCloser` (`163-178`, `293-302`). |
| Preview recipient, CC, reply-to, attachments; no live SMTP | Pass | POST `/api/mca/submissions/email/preview` returns To/CC/reply-to/subject/body/attachment metadata (`preview/route.ts`, `787-883`). Preview does not call `deliverRendered`. Tests unset `MCA_EMAIL_WEBHOOK_URL` and assert webhook capture count unchanged (`122`, `273-285`, `318`). UI lists To, CC, reply-to, attachments (`email-preview.tsx:297-312`). |
| Immutable sent content on the attempt; prefix/signature change does not rewrite old attempts | Pass | `external_ref` JSON `{ messageId, threadId, references, delivery, snapshot }` (`125-148`, `644-677`). Snapshot copies rendered To/CC/subject/body/prefixes/signature (`406-425`). After Alpha send, template prefix `NEWALPHA` + sender signature update leave stored `external_ref` (including Message-ID) unchanged; new preview picks up the change (`336-381`). Template upsert does not touch attempt rows (`729-776`). |
| `assertSenderUsable` used; unauthorized sender id 403 | Pass | Imported from `senders/service.ts` (`email-templates.ts:17`). Explicit preview `senderId` and job send both call it (`612`, `630`). Rep forging the workspace sender and admin `missing-sender` are `403 permission_denied` (`384-407`). |
| Secrets excluded | Pass | Public sender has `hasCredential`, not `credentialCipher` (`senders/repository.ts:125-143`). Webhook JSON is metadata + body, no SMTP password or file bytes (`428-451`). Tests `assertNoSecret` on preview, attempts, GET/PUT (`213-218`, `285`, `332-333`, `435`, `465-469`). |
| Template ACL matches UI; preview is `deals:read` | Pass | GET/PUT `/api/mca/submissions/email` require interactive admin + `assertTrustedMutation` on PUT (`route.ts`, `886-890`). Preview `deals:read` (`892-895`). Intake and `deals:read` template GET 403; `deals:write` PUT 403; admin PUT/GET 200; cross-workspace deal 404 (`415-469`). |
| Loading / empty / validation / success / failure UI | Pass | Loading copy, dashed empty state, blank subject/body client checks, saved-template success, request-error alert (`email-preview.tsx:151-157`, `201-203`, `174`, `278-281`). Mounted on deal Submissions tab (`deals-workspace.tsx:247`). |

Exclusive files match the brief: `email-templates.ts`, `src/app/api/mca/submissions/email/**`, `email-preview.tsx`, `tests/submissions-email.test.ts`, report, acceptance. Table `mca_submission_templates` already exists.

## Quality

Approved. Minor only:

1. Default preview (no `senderId`) picks a verified submission sender from `listSenders` and does not call `assertSenderUsable` (`611-619`). Forged/missing ids still 403. Job send always calls `assertSenderUsable` via a system actor (`622-630`).
2. `redactedPayload` omits credentials and file bytes but still posts full subject/body (`428-451`). Name overstates redaction; tests only forbid SMTP password / `credentialCipher`.
3. No unique `(workspace_id, funder_id)` on `mca_submission_templates`; `findTemplate` / `listTemplateRows` take latest and de-dupe (`454-475`).
4. Sender is not pinned on the job. Queue → send uses the current workspace default at delivery time (`622-630`), so a default/signature change before first outbox processing affects that send. After `external_ref` is written, outbox skips existing attempts (`outbox.ts:41-46`) and template updates do not rewrite history.
5. Report/handoff say `deals-workspace.tsx` was not edited; `EmailPreview` is already mounted on the Submissions tab.

No Critical or Important defects on the exclusive surface.

## Unverified claims

- **3/3 passed:** the test file defines three `test("MIC-153:…")` cases matching the report/acceptance; this review did not re-execute Postgres.
- **Did not edit `deliver.ts` / `queue.ts` / `schema.ts` / `senders/service.ts` / `deals-workspace.tsx`:** current `deliverSubmission` email case, attempt snapshot, and conductor mount match the handoff; the repo has no git, so in-place rewrites cannot be proven.
- **Live SMTP / OAuth send:** not production-verified (documented remaining gate).

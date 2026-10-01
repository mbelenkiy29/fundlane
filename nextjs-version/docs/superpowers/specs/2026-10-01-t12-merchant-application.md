# T12 invited merchant application funnel

Approved scope: existing branded invited resumable links collect business details and requested bank statements. No campaign builder or custom domains. Use synthetic local fixtures only.

## Existing architecture
Native Fundlane invitations resolve through applications/service.ts; draft.ts encrypts partial answers; files.ts scans/stages documents; submit.ts validates every visible step, gates documents and associates intake/deal with the original invitation. Preserve these APIs and tenant/role boundaries. T0 owns documents/service.ts; T2 owns intake/submission-review.ts.

## Genuine gaps and intended behavior
- Save and exit explicitly persists the current partial step, confirms success and explains that the same invitation link resumes it. Never claim a save succeeded after an error.
- A failed pre-submit save stops submission. Lock editing during save/upload/submit so a late response cannot erase newer inputs. Upload responses preserve current unsaved answers and current step.
- Count only ready/clean statements; display pending/blocked scan states clearly. Block submission when any file is not ready. Refresh status on demand; do not invent scan outcomes or mark quarantined files clean.
- Reject impossible/future start dates, malformed ZIP/phone, nonfinite amounts, and negative/out-of-range individual ownership shares even when they total 100. Shared stepError is also used by server submission.
- Offer correction/removal of extra owners and retain legitimate zero monetary/share input. Use labelled inputs, wrapping filenames/review values, and disabled form controls during requests. Verify mobile widths 390 and 768.
- Surface native-session load errors instead of offering an apparently fresh application. Retain expiry/revocation enforcement by the server.

## Dependencies and remaining gates
No applications/service.ts edits. No new document integrity implementation. Blocked-file replacement/deletion needs a pinned safe T0 contract: current files.ts stores blocked rows but exposes no removal endpoint and submit.ts blocks any such row. Approved consent wording/version/acceptance contract is absent; do not invent legal terms. Ask parent for both dependencies. Existing correlation and scope tests are extended with negative fixtures.

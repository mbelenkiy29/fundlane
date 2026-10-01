# T12 merchant application funnel evidence

Base: refreshed `origin/main` `3901e7e8a41b72bd08177cbd0c7b5967d9a7cb09`. Branch `codex/t12-merchant-application-funnel`, isolated worktree `/Users/mbele/Documents/Codex/2026-09-30/task-11/fundlane-t12`.

## Delivered

Existing branded native Fundlane invitations now offer explicit **Save and exit** and resume confirmation. Continue/back also save the current draft. Submission stops if the preceding save fails. Inputs lock during operations; upload/status responses keep local partial answers. Unsequenced pagehide/visibility writes were removed because late writes could overwrite newer confirmed saves. Closing without Continue or Save and exit does not guarantee saving edits; the UI states the explicit save action.

Only ready/clean statements count toward required files. Any pending/blocked/unknown file state prevents submission. Rejected uploads refresh the authoritative file list and direct merchants to their representative when a persisted file is blocked. Refresh reports persisted state; it does not rescan or fabricate an outcome. Long filenames and review values wrap on mobile. Owner removal and fractional financial/ownership entry work.

Shared step validation now rejects impossible/future start dates, malformed US ZIP/phone, nonfinite/negative financial values and individual ownership percentages outside 0–100. Zero monthly deposits/share are retained. Existing server submission uses this same validator. Invitation services, storage integrity, intake approval and legal notices are unchanged; no new migration, provider activation, credentials, grants, real uploads or live submissions.

## Verification

- Node 24.7.0 / pnpm 11.1.2; own locked dependency installation.
- `node --import tsx --test tests/application-form-schema.test.ts tests/application-funnel-session.test.ts`: 10/10 pass. Schema negatives RED 2 failures before fix; coordinator RED 4 missing helpers before fix.
- Disposable PostgreSQL 16 at loopback `55412`, unique databases created/dropped by existing test harness. `MCA_TEST_DATABASE_ADMIN_URL=postgresql://mbele@127.0.0.1:55412/postgres node --experimental-test-module-mocks --conditions=react-server --import tsx --test --test-concurrency=1 tests/application-forms.test.ts tests/application-outreach.test.ts tests/application-form-schema.test.ts tests/application-funnel-session.test.ts`: 67/67 pass, no skipped tests. Final rerun includes a genuine foreign-company admin, genuine second rep and forged-role denial; 67/67 passed.
- Integration covers revoked/expired/rebound/disabled links, foreign tenant and other employee denial, forged role rejection, invalid required fields without deal/claim, pending/quarantined documents, original invitation/intake/deal correlation, concurrent claims and legacy links.
- `pnpm typecheck`: pass. Focused ESLint: pass. Full `pnpm lint`: 0 errors, 16 existing warnings.
- Real components bundled with application Tailwind CSS; HTTP requests intercepted with synthetic fixtures. `tests/browser/application-funnel/README.md` provides reproduction commands. Browser scenarios passed at 390 and 768: explicit save/exit, fresh-session resume, lifecycle write suppression, fractional ownership/money, owner removal, failed save blocks submit, quarantine gating/counts, rejected-upload feedback, draft preservation, inactive session handling and no horizontal overflow. Screenshots in ignored `output/playwright/t12/{resume,quarantine}-{390,768}.png`. Visual inspection confirmed 390px quarantine flow is readable.
- Regression proof: old fractional typing produced `333` for `33.3`; restored legacy pagehide effect failed lifecycle-write assertion; removed error refresh failed blocked-upload-guidance assertion. All pass with fixes restored.
- Independent reviewer reported 4 Important findings: lifecycle-write race, stale quarantine list/guidance, invalid employee-scope fixture, and fractional entry. All fixed and covered by regressions. No deferred review findings.
- Graphify AST update and cluster refresh completed (14,776 nodes); generated graph evidence preserved separately under `/tmp/fundlane-t12-graph`, excluded from the functional PR.
- Full build and aggregate suite: **pending parent-coordinated exclusive slot**, not started concurrently with other tasks. Hosted Auth/Storage/real scanner acceptance not run.

## Consent and recovery gates

Parent explicitly confirmed no owner-supplied attorney-approved consent copy/version exists. This PR adds no acceptance wording, checkbox, compliance claim or invented legal terms. No consent hook is needed to ship these existing-funnel fixes. Any future consent feature requires exact owner-provided text, scope, version, effective date and server acceptance/audit contract before UI integration.

T0 adds read integrity only and provides no invitation-file recovery API. Current server intentionally blocks submission if any stored upload is pending/quarantined. This PR retains truthful state feedback and representative-assisted recovery; uploading another clean document cannot remove a blocked row. Pending scans have no invented automatic recovery behavior.

Separate recovery proposal (not implemented here): a token-authorized DELETE/replacement endpoint for an active native invitation must enforce current form/employee/tenant/token expiry/revocation at the write, bind the exact file to invitation+workspace, and never release quarantined bytes. A retry must rescan unchanged immutable bytes, fail closed on scanner failure, and preserve append-only scan/audit evidence. Define safe superseded/removed membership before changing submit's any-blocked-file gate. Test wrong tenant/file/token, expired/revoked/rebound/inactive links, replay/concurrent submit/removal, clean-vs-blocked replacement and immutable-byte integrity. Reserve ownership with parent before implementation.

## Decisions

- Native Plan mode unavailable: written spec/plan and self-review precede execution under explicit user plan-and-execute authorization.
- CLI-first browser attempts repeatedly lost their isolated daemon session. Used the installed Playwright API and Chrome for the same synthetic component harness; no app dependency or product fixture route added.
- Existing shared applications/service.ts, documents/service.ts and intake/submission-review.ts were not edited. No dependency code was copied or cherry-picked.

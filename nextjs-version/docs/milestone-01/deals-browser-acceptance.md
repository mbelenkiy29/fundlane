# Milestone 01 — deal workspace browser acceptance

Verified with Chromium at desktop and 390 × 844 phone widths on September 7, 2026. The workspace, users, credentials, invitation, recovery token, and deal records were temporary synthetic fixtures. Tokens and passwords are not present in the screenshots.

| Scenario | Browser result |
| --- | --- |
| Create a partial application | Saving only a legal name created a stable `MCA-…` record, opened its detail view, and reported every missing submission field. |
| Edit and validate | An edit preserved entered values. Invalid EIN, NAICS, FICO, per-owner ownership, and combined ownership errors rendered beside the relevant fields. A corrected save incremented the record version and masked the EIN in detail. |
| Notes and activity | Adding an internal note cleared the composer, retained the note, added an activity event, and incremented the version. |
| Lifecycle transition | The Lead detail view offered only allowed next states. Moving to New application updated the modal, table, activity version, and list count. The full lifecycle path remains covered by the HTTP acceptance suite. |
| Shared list filters | Search persisted as `q=Harbor+Browser`; switching views added `view=kanban` without dropping the search. Table and Kanban each showed the same one-record filtered collection, with a Kanban count of one in New application. |
| Concurrent edits | Two real browser tabs opened version 4. The second tab saved version 5; the first tab then received the conflict dialog while retaining its unsaved industry value. `Keep mine & retry` saved that value as version 6. `Reload current` was present as the alternative resolution. |
| Phone workflow | At 390 × 844, the primary New deal action and all filters stacked without clipping. Table and Kanban controls had accessible names, the dense table stayed inside its horizontally scrollable card, and the record detail dialog exposed tabs, transition control, and Edit application. |
| Invitation acceptance | A real synthetic invitation opened the join form, accepted a profile and password, activated the membership, established a session, and routed the invitee to the dashboard. |
| Account recovery | The forgot-password form returned the non-enumerating confirmation state. The synthetic single-use reset link opened the reset form, mismatched passwords produced an alert without losing input, and a matching password completed the reset and routed to sign-in. |

The browser console contained expected failed-request entries for the deliberate HTTP 422 validation and 409 concurrency scenarios. One development-only RSC request returned 404 during a hot reload while another process changed source files; the page recovered automatically, and the isolated production build and smoke run passed separately.

## Artifacts

- `output/playwright/sen-31-deal-partial-desktop.png`
- `output/playwright/sen-31-deals-mobile-table.png`
- `output/playwright/sen-31-deal-detail-mobile.png`

The browser exercised the first allowed lifecycle transition; the HTTP acceptance suite provides deterministic coverage of the remaining path through Funded, inclusive date and funder filtering, authorization scopes, tenant isolation, and status side-effect boundaries.

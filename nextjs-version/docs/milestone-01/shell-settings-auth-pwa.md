# Milestone 01 — shell, settings, auth, and PWA

## Implementation plan

### SEN-27 — Workspace isolation and brokerage configuration

- Use the authenticated membership’s immutable workspace ID for every settings request.
- Provide admin configuration for brokerage name, logo, timezone, seats, features, pages, and individual actions.
- Keep permission decisions on the server and render returned validation or conflict messages next to the active workflow.

### SEN-28 — Roles, manager hierarchy and financial visibility

- Show Rep, Manager, Admin, and Super admin as permission roles; keep originator/closer as deal assignments.
- Let authorized admins change roles and reporting managers from a responsive team table.
- Explain and enforce company totals, Payments page, and payment table access as separate permissions.

### SEN-30 — User invitations, profiles, seat checks and account recovery

- Support invite, preview delivery, resend, acceptance, profile editing, deactivation, and recovery screens.
- Show occupied and available seats before invite actions, with server-side concurrency checks as the source of truth.
- Preserve membership/application identity across invite retry and deactivation.

### SEN-31 — Original responsive app shell and configurable page visibility

- Retain the supplied shadcn dashboard structure while replacing template branding and sample products with MCA-specific navigation and content.
- Send the validated session into the shell during server rendering; omit disallowed pages and buttons without a client-side flash.
- Validate the current deep link in the server dashboard layout and route disallowed pages to a forbidden screen.
- Provide keyboard focus, mobile navigation, responsive overflow for dense tables, accessible dialogs, and reusable loading/error/empty/retry states.
- Label future milestone destinations as planned and avoid fabricated operational totals.

### SEN-34 — Workspace API keys and integration access

- Support scoped key creation, optional expiry, rate-limit metadata, rotation, and immediate revocation.
- Render the full secret in one modal after creation or rotation and only masked prefixes afterward.
- Keep keys out of URLs, logs, screenshots, browser cache, and application source.

## Acceptance evidence

Verified with a local synthetic workspace on September 7, 2026. The SQLite acceptance database and credentials were temporary and are not checked in.

| Check | Result | Evidence |
| --- | --- | --- |
| Unauthenticated direct request to `/settings/team` | Redirected to `/sign-in` | Playwright navigation and semantic snapshot |
| Disabled Reports page opened at `/reports` | Server layout redirected to `/errors/forbidden?from=%2Freports` | Playwright direct navigation |
| Workspace page and action controls | Loaded from `/api/workspace`; PATCH returned 200 | Browser interaction and server log |
| Invite reserves a seat | Occupied seats changed from 1/5 to 2/5; preview-delivery toast shown | `output/playwright/sen-30-team-mobile.png` |
| Duplicate invite conflict | Dialog retained identity and displayed “This person already has a reserved seat in the workspace.” | `output/playwright/sen-30-invite-conflict.png` |
| API key creation | Scoped key created; secret shown once; subsequent table showed masked prefix only | `output/playwright/sen-34-api-keys-desktop.png` |
| Desktop shell | MCA navigation, blank truthful metrics, and settings readiness rendered at 1200 px | `output/playwright/sen-31-dashboard-desktop.png` |
| Phone shell | Dashboard rendered at 390 × 844 without hover-only controls | `output/playwright/sen-31-dashboard-mobile.png` |
| Phone navigation | Accessible sheet exposed the full primary navigation | `output/playwright/sen-31-mobile-navigation.png` |
| Sign-in and invalid credentials | Successful sign-in reached `/dashboard`; 401 rendered inline as an alert | `output/playwright/sen-30-sign-in-mobile.png` and Playwright snapshot |
| Manifest and icons | Manifest JSON parsed with `/dashboard` start URL and real 192/512 PNGs | `curl`, JSON parse, and `file` inspection |
| Sensitive caching | Service worker cache list contains only manifest and install icons; API/pages are network-only | `public/sw.js` inspection |
| Browser runtime | Final dashboard/team/settings/API-key runs had no hydration or application console errors | Playwright console logs |

The Submissions, Offers, Advances, Renewals, Funders, Payments, and Reports destination screens are navigation-ready placeholders for later milestones. They are explicitly labeled as planned and are not counted as implemented workflows here.

## Artifacts

- `output/playwright/sen-31-dashboard-desktop.png`
- `output/playwright/sen-31-dashboard-mobile.png`
- `output/playwright/sen-31-mobile-navigation.png`
- `output/playwright/sen-30-team-mobile.png`
- `output/playwright/sen-30-invite-conflict.png`
- `output/playwright/sen-30-sign-in-mobile.png`
- `output/playwright/sen-34-api-keys-desktop.png`

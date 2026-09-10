# Team UI redesign verification

The shared Team panel now provides searchable Members, Invitations, and Inactive views, role/manager filters, desktop rows, mobile cards, and a responsive detail sheet. Editing uses explicit saves; email and application identifiers remain read-only. Invitations start with name/email/role and collapse optional fields. Existing endpoints and backend permissions remain unchanged.

## Automated verification

`tests/team-view.test.ts` covers combined filtering/sorting, delivery failure and expiry states, permitted roles, inactive/read-only behavior, self/last-Super-Admin safeguards, and valid manager choices excluding descendants.

The targeted team/auth/billing run passed all 28 tests:

```sh
node --experimental-test-module-mocks --conditions=react-server --import tsx --test --test-concurrency=1 tests/team-view.test.ts tests/foundation-core.test.ts tests/foundation-http.test.mjs tests/clerk-auth.test.ts tests/billing.test.ts tests/billing-http.test.mjs
```

Typecheck, lint, and build were run. Lint reports only the 16 existing warnings elsewhere in the app.

## Browser verification (September 9, 2026)

Used an isolated Neon database and a disposable Clerk development owner/organization. The reusable preview helper accepts `MCA_TEAM_PREVIEW=true` to seed active, pending, expired, failed-delivery, and inactive fixtures. Run with `MCA_CLERK_BILLING_ENABLED=false` for these UI fixtures; its synthetic organization capacity matches the eight local seats.

Verified desktop roster and mobile 390×844 layout; the mobile detail sheet measured exactly 390px with left edge zero. Checked search/no-matches/reset, role filtering, keyboard arrow navigation between linked tab panels, editable profile save, unsaved-change cancellation, and focus restoration after save. Inactive fields were disabled with no Save or Deactivate action.

Verified duplicate-invitation errors preserve the draft and offer navigation to the existing reservation. Retrying a failed invitation transitioned it to sent without adding a seat. Deactivation changed active count from three to two and retained the employee in Inactive. Setting the isolated fixture cap to its occupied count disabled Invite employee and explained that pending invitations reserve seats. Existing service tests cover concurrent seat reservations, permission failures, and successful invitations.

The preview owner/organization/database were cleaned up; no production data or configuration was modified. Graphify is refreshed after the source changes.

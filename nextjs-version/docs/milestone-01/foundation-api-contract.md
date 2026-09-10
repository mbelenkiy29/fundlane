# Foundation API contract

All JSON errors use `{ "error": { "code", "message", "fieldErrors?", "correlationId?" } }`. Cookie-authenticated browser mutations must be same-origin. `mca_session` is HttpOnly, SameSite=Lax, Secure in production, and expires after 12 hours.

## Authentication

- `POST /api/auth/sign-in` — `{ email, password, workspaceId? }`; returns `SessionResponse` and sets the session cookie.
- `GET /api/auth/session` — returns `SessionResponse`, including effective `permissions.pages` and `permissions.actions`.
- `POST /api/auth/sign-out` — deletes the current server session and clears the cookie.
- `POST /api/auth/recovery/request` — `{ email }`; always returns `202 { accepted: true }` for a well-formed request.
- `POST /api/auth/recovery/reset` — `{ token, password }`; consumes the token once and invalidates existing sessions.

## Workspace and users

- `GET /api/workspace` — session or API key with `workspace:read`.
- `PATCH /api/workspace` — Admin/Super Admin; accepts partial brokerage fields, `featureFlags`, `pageVisibility`, and `actionVisibility`.
- `GET /api/memberships` — Admin/Super Admin; returns profiles plus pending invitation ID, expiry, and delivery status.
- `PATCH /api/memberships/:id` — Admin/Super Admin; accepts partial `{ name, phone, role, managerMembershipId, senderAssociation }`.
- `POST /api/memberships/:id/deactivate` — Admin/Super Admin; invalidates sessions and sender authority.
- `POST /api/invitations` — Admin/Super Admin; `{ email, name, phone?, role, managerMembershipId?, senderAssociation? }`.
- `POST /api/invitations/:id/resend` — creates a new expiring token for the existing membership.
- `POST /api/invitations/accept` — `{ token, password, name?, phone? }`; activates the intended membership and sets a session.

## API keys and audit

- `GET /api/api-keys` — summaries only; secrets are omitted.
- `POST /api/api-keys` — `{ name, scopes, expiresAt?, rateLimitPerMinute? }`; returns the new secret once.
- `POST /api/api-keys/:id/rotate` — replaces the secret in place and returns it once.
- `DELETE /api/api-keys/:id` — revokes the key immediately.
- `GET /api/audit` — latest 200 tenant-scoped audit events for Admin/Super Admin.

Scopes are `deals:read`, `deals:write`, `deals:export`, `intake:write`, and `workspace:read`. API keys use `Authorization: Bearer mca_…`; workspace IDs are never accepted from a client header as an authentication override.

## Deals

- `GET /api/mca/deals` and `GET /api/mca/deals/:id` — session or API key with `deals:read`; results apply workspace and assignment visibility before totals are calculated.
- `POST /api/mca/deals` — session or API key with either `deals:write` or `intake:write`; a stable idempotency key is required.
- `PATCH /api/mca/deals/:id`, `POST /api/mca/deals/:id/notes`, and `POST /api/mca/deals/:id/transition` — session or API key with `deals:write`.
- `GET /api/mca/deals/export` — Admin/Super Admin session or API key with `deals:export`; the workspace `exportDeals` action must also be enabled. Rep and Manager sessions receive 403.

An `intake:write` key can create an application but cannot list, read, edit, add notes, transition, or export it. Merchant revenue and requested funding remain application fields on an otherwise authorized deal. Company commission totals and the financial reporting API are outside milestone 01 and are not exposed by this app.

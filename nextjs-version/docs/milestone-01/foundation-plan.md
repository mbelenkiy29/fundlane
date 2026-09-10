# Milestone 01 foundation plan

## SEN-27 — Workspace isolation and brokerage configuration

Implement immutable workspace IDs on workspaces, memberships, sessions, API keys, audit events, invitations, and every downstream business record. Resolve the workspace from a verified session membership or API key on the server. Add a validated admin settings API for brokerage name, logo, timezone, feature flags, page visibility, action visibility, and seat limit. Use a tenant-neutral 404 for cross-workspace resources, validate tenant/resource pairs before queued work, and record configuration audit events.

Acceptance evidence: two same-named tenant records resolve only through their own credentials; cross-tenant key mutation fails; job references with a mismatched workspace fail without identifying the resource; settings validation and minimum active-seat checks return actionable errors.

## SEN-28 — Roles, manager hierarchy and financial visibility

Define Rep, Manager, Admin, and Super Admin as permission roles. Keep originator and closer as deal assignment kinds. Compute effective pages and actions from the role and workspace configuration, and enforce role, action, and financial permissions inside services and API routes. Validate manager membership in the same workspace, prevent reporting cycles, and let deal queries apply assignment-aware manager visibility immediately.

Acceptance evidence: direct membership and API access checks; role-filtered session permissions; deal tests for originator-only manager scope, reassignment, exports, and masked financial fields.

## SEN-30 — Invitations, profiles, seats, and recovery

Reserve seats for pending and active memberships inside `BEGIN IMMEDIATE` SQLite transactions. Preserve one membership identity across expired invitation resends. Use hashed, expiring, single-use invitation and recovery tokens. Invalidate all membership sessions on deactivation and all user sessions after recovery. Deliver through a checked webhook in production; allow invitation previews only to the authenticated inviting admin when running locally.

Acceptance evidence: simultaneous invites cannot exceed the seat limit; simultaneous acceptance succeeds once; expired invite resend keeps the membership ID; recovery is enumeration-neutral, single-use, expiring, and session-invalidating; deactivation clears sender association and sessions.

## SEN-34 — Workspace API keys

Generate opaque keys with a display prefix, store only SHA-256 hashes, and return the secret once. Bind every key to a workspace; validate scopes and expiry per request; atomically consume per-minute rate limits. Rotate in place so stable key identity and audit attribution remain, and make revocation effective on the next request.

Acceptance evidence: key lists contain no secret, rotation disables the old secret, expiry and revocation return 401, insufficient scope returns 403, cross-tenant mutation returns 404, and rate overflow returns 429.

## Cross-cutting design

Use Node.js 24 built-in SQLite with WAL, foreign keys, a five-second busy timeout, and immediate write transactions. Encrypt sensitive deal fields with AES-256-GCM using the immutable workspace ID as authenticated data. Store correlation IDs and small non-sensitive audit metadata; never log tokens, API secrets, passwords, or full documents. Browser mutations validate the request origin, while non-browser API clients authenticate with scoped bearer keys.

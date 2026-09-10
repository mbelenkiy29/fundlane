# Foundation completion evidence

## Automated verification

Command: `pnpm test`

Current result: 13 passing acceptance cases (9 focused deal-domain cases and 4 HTTP/core cases).

- The direct HTTP test starts Next.js against a temporary persistent SQLite database. It verifies configured bootstrap login, secure cookie sessions, same-origin browser mutations, settings changes, role rejection, sequential and simultaneous seat checks, expired invitation resend with stable membership identity, single-winner invitation acceptance, recovery response neutrality, recovery expiry and single use, recovery and deactivation session invalidation, and self-deactivation protection.
- API-key scenarios verify one-time secret display, secret omission from lists and audit events, rotation, expiry, revocation, endpoint scope checks, atomic rate limiting, and a tenant-neutral failure when one tenant attempts to revoke another tenant's key.
- Core scenarios verify that a queued job with a mismatched workspace/resource pair returns the same not-found failure as a missing resource and does not expose the owning workspace. AES-256-GCM tests verify that ciphertext cannot be decrypted under a different workspace ID.
- Deal HTTP scenarios verify `intake:write` can create but cannot read or edit, Manager access follows managed-originator assignments, changing a Rep's manager changes access on the next request, Rep export is denied, `deals:read` cannot export, and `deals:export` plus Admin sessions can download the filtered tenant CSV.

Merchant monthly revenue and requested funding are application fields and remain present on authorized deal responses. Company commission totals and a financial reports API are not implemented in milestone 01, so there is no totals endpoint for a Rep to retrieve. Payments and Reports remain explicitly labeled later-milestone screens.

## Operational status

Local delivery is a development preview for invitations initiated by an authenticated administrator. Production email is not mocked: `MCA_EMAIL_WEBHOOK_URL` is required and the provider must return 2xx before delivery is recorded as sent. No external email provider has been production-verified in this workspace.

Neon deployment requires Node.js 24 or later, pooled `DATABASE_URL` for the app, and direct `DATABASE_URL_UNPOOLED` for migrations. Production also requires a managed 32-byte `MCA_DATA_ENCRYPTION_KEY`. Provider deployment, durable document storage, secret rotation policy, and real email delivery remain deployment responsibilities rather than completed provider integrations.

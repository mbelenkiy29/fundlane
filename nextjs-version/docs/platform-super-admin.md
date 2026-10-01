# Platform super-admin access

A super admin needs all three: a live Supabase session with a confirmed identity email, an unrevoked `platform_admin_grants` row for the linked local user ID, and AAL2 or app TOTP for that **same session**. `MCA_SUPER_ADMIN_EMAILS` is a ceiling, never a grant. Its unset default is exactly `mike@sentineltechsolutions.io,ben@sentineltechsolutions.io`; an explicitly empty list permits nobody. Matching trims entries and ignores case. `MCA_PLATFORM_OPERATOR_USER_IDS` is temporary and, when set, only narrows legacy SMS operator access. It cannot grant platform access.

SMS approve/reject also requires an email in `MCA_SUPER_ADMIN_SMS_APPROVER_EMAILS` (unset default: `mike@sentineltechsolutions.io`) and a fresh app TOTP step-up. The step-up endpoint is `POST /api/platform/step-up` with `{ "code": "..." }` and a trusted Origin. Its window is `MCA_PLATFORM_STEP_UP_MINUTES` (default 10). Recovery codes cannot satisfy step-up. Audit CSV export also requires a current step-up. Existing access pause and trial controls get their own step-up in S18.

`platform_admin_audit` is append-only; the runtime role has SELECT and INSERT, and a trigger rejects UPDATE/DELETE even for an owner. Company mutations write their redacted company audit mirror and one platform audit row in the same DB transaction. A failed platform audit insert rolls back the DB action. Authorized mutation attempts that produce no state change, including an already resolved billing state, still receive one platform audit row; their existing response remains unchanged. Provider calls cannot be rolled back by Postgres: billing reconcile may call Stripe before its local result is persisted, and SMS reconcile reads Twilio before updating the operation. Each audit row shares the transaction that persists the corresponding local outcome. A provider-side effect may survive a later DB failure; review the provider receipt and retry with the existing idempotency rules. Portal entry is logged once per user, and granted-user denials are rate limited.

There is no impersonation, “log in as,” or customer session creation. Platform routes never set a different user's session or the `mca_workspace` cookie.

## Ben access runbook — Michael only

1. Michael invites `ben@sentineltechsolutions.io` into **Sentinel Tech Solutions Demo** (`c880cbaf-f18d-4050-beab-840220624406`) as `rep`. Ben accepts using his confirmed Supabase email. Do not create a customer company for this purpose.
2. Ben enrolls app TOTP at `/account-security` and completes a same-session MFA challenge.
3. Michael uses the trusted DB operator connection for this **read-only check**. Confirm both local IDs, confirmed identity emails, MFA enrollment, and Ben's demo membership before reviewing any grant SQL:

```sql
SELECT u.id AS user_id, u.email AS local_email, au.email AS confirmed_identity_email,
       au.email_confirmed_at, g.granted_at, g.revoked_at,
       m.role AS demo_role, m.status AS demo_status
FROM public.users AS u
LEFT JOIN auth.users AS au ON au.id::text = u.supabase_user_id
LEFT JOIN public.platform_admin_grants AS g ON g.user_id = u.id
LEFT JOIN public.memberships AS m
  ON m.user_id = u.id
 AND m.workspace_id = 'c880cbaf-f18d-4050-beab-840220624406'
WHERE lower(trim(u.email)) IN
  ('mike@sentineltechsolutions.io', 'ben@sentineltechsolutions.io')
ORDER BY lower(trim(u.email));
```

Production read-only evidence supplied for S14 already showed unrevoked grants for Michael (`d5a46f20-279f-4e33-9357-055318e1a45e`) and Ben (`669dabeb-915c-4086-9532-6fca4462712f`). Verify the live rows; do **not** re-insert Ben's grant if it remains active. If a reviewed new grant is actually required, Michael alone substitutes the reviewed **local** `users.id` values and runs this guarded statement over the trusted operator connection:

```sql
INSERT INTO public.platform_admin_grants
  (user_id, granted_at, granted_by, reason)
SELECT '<BEN_USERS_ID>', now()::text, '<MICHAEL_USERS_ID>',
       'Super-admin portal: co-founder access'
WHERE EXISTS (
  SELECT 1 FROM public.users AS ben
  JOIN auth.users AS identity ON identity.id::text = ben.supabase_user_id
  WHERE ben.id = '<BEN_USERS_ID>'
    AND lower(trim(identity.email)) = 'ben@sentineltechsolutions.io'
    AND identity.email_confirmed_at IS NOT NULL
)
  AND EXISTS (
    SELECT 1 FROM public.platform_admin_grants AS michael_grant
    WHERE michael_grant.user_id = '<MICHAEL_USERS_ID>'
      AND michael_grant.revoked_at IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.platform_admin_grants AS existing
    WHERE existing.user_id = '<BEN_USERS_ID>'
      AND existing.revoked_at IS NULL
  )
ON CONFLICT (user_id) DO NOTHING;
```

To revoke, Michael sets `revoked_at` for the reviewed grant using the trusted operator connection, or removes the email from `MCA_SUPER_ADMIN_EMAILS`. The app cannot write grants. No grant seed, app grant API, automated email, or impersonation flow is part of S14.

Before deployment, apply migration `0070_platform_super_admin` and re-run runtime role hardening. Verify the grant rows and confirmed emails read-only, then test both AAL1 denial and AAL2 access in a reviewed nonproduction environment with synthetic records. Never apply hosted migrations as a build or agent setup step.

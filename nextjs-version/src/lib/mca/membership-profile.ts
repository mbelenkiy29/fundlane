// SQL expressions for a workspace membership (alias m) joined to its user (alias u).
// A pending shared account has not consented to exposing its global profile here.
const pendingSharedProfileSql = `m.status = 'pending' AND (u.supabase_user_id IS NOT NULL
  OR u.password_hash IS NOT NULL OR EXISTS (
    SELECT 1 FROM memberships other WHERE other.user_id = m.user_id AND other.id <> m.id
  ))`;

export const membershipProfileNameSql = `(CASE WHEN ${pendingSharedProfileSql} THEN u.email ELSE u.name END)`;
export const membershipProfilePhoneSql = `(CASE WHEN ${pendingSharedProfileSql} THEN NULL ELSE u.phone END)`;

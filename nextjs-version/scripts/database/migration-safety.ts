export interface RuntimeRole {
  rolsuper: boolean
  rolcreatedb: boolean
  rolcreaterole: boolean
  rolreplication: boolean
  rolbypassrls: boolean
  rolcanlogin: boolean
  memberships: number
}

/** A pre-existing role name is not proof that its privileges belong to Fundlane. */
export function assertSafeRuntimeRole(role: RuntimeRole): void {
  if (role.rolsuper || role.rolcreatedb || role.rolcreaterole || role.rolreplication || role.rolbypassrls || !role.rolcanlogin || role.memberships !== 0) {
    throw new Error('Existing mca_app role has unexpected privileges or role memberships. Inspect its ownership and grants before proceeding; no permissions were changed.')
  }
  // Existing INHERIT=true is the PostgreSQL default and is harmless with no role
  // memberships. New roles use NOINHERIT; do not change an existing role silently.
}

export const retireLegacyInvitationsSql = `UPDATE invitations SET token_hash='retired:'||id, delivery_status='failed'
  WHERE status='pending' AND token_hash NOT LIKE 'supabase:%' AND token_hash NOT LIKE 'retired:%'`

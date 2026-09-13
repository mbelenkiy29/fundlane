/** Business-service unit tests stub the identity boundary; Supabase itself is covered in supabase-auth.test.ts and browser/HTTP checks. */
import { mock } from "node:test"
import { getDatabase, nowIso } from "../../src/lib/mca/db"
import { hashOpaqueToken } from "../../src/lib/mca/crypto"
// The old fixture token is just a lookup key in these tests. Production rejects mca_session cookies.
mock.module(new URL("../../src/lib/mca/supabase-auth.ts", import.meta.url).href, {
  namedExports: {
    authenticateSupabaseSession: async (request?: Request) => {
      const token = request?.headers
        .get("cookie")
        ?.match(/(?:^|;\s*)mca_session=([^;]+)/)?.[1]
      if (!token) return null
      const row = await getDatabase()
        .prepare<{
          user_id: string
          membership_id: string
          workspace_id: string
          role: string
          session_id: string
        }>(
          `SELECT s.id session_id,m.id membership_id,m.user_id,m.workspace_id,m.role FROM sessions s JOIN memberships m ON m.id=s.membership_id WHERE s.token_hash=? AND s.expires_at>? AND m.status='active'`
        )
        .get(hashOpaqueToken(token), nowIso())
      return row
        ? {
            authType: "session",
            userId: row.user_id,
            membershipId: row.membership_id,
            workspaceId: row.workspace_id,
            role: row.role,
            sessionId: row.session_id,
            scopes: [],
          }
        : null
    },
  },
})

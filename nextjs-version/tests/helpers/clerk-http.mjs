// Local Clerk protocol fixture: real RSA-signed JWTs, no production impersonation switch.
import { createServer } from "node:http"
import { generateKeyPairSync, sign, randomUUID } from "node:crypto"
import { closeDatabaseForTests } from "../../src/lib/mca/db.ts"
import { createWorkspaceWithAdmin } from "../../src/lib/mca/workspaces.ts"
import {
  createSession,
  getSessionResponse,
} from "../../src/lib/mca/sessions.ts"
import { hashOpaqueToken } from "../../src/lib/mca/crypto.ts"
export async function createClerkHttpFixture(database) {
  Object.assign(process.env, database.env())
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  })
  const invitations = []
  const billingSubscriptions = new Map()
  const remoteRoles = new Map()
  const identityState = {
    passwordEnabled: true,
    verified: true,
    banned: false,
    sessionStatus: null,
  }
  const issuer = "https://clerk.fixture.test"
  const api = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost")
      const parts = url.pathname.split("/").filter(Boolean)
      let data
      if (parts[1] === "organizations" && parts[3] === "billing" && parts[4] === "subscription") {
        const subscription = billingSubscriptions.get(parts[2])
        res.writeHead(subscription ? 200 : 503, { "content-type": "application/json" })
        res.end(JSON.stringify(subscription ?? { errors: [{ code: "unavailable", message: "Synthetic billing outage" }] }))
        return
      }
      if (parts[1] === "organizations" && parts[3] === "invitations") {
        const org = parts[2]
        if (req.method === "POST" && parts[5] === "revoke") {
          data = invitations.find((i) => i.id === parts[4])
          if (data) data.status = "revoked"
        } else if (req.method === "POST") {
          let body = ""
          for await (const chunk of req) body += chunk
          const input = JSON.parse(body)
          data = {
            object: "organization_invitation",
            id: `inv_${randomUUID()}`,
            organization_id: org,
            email_address: input.email_address,
            role: input.role,
            public_metadata: input.public_metadata,
            private_metadata: {},
            status: "pending",
            created_at: Date.now(),
            updated_at: Date.now(),
            expires_at: Date.now() + 259200000,
          }
          invitations.push(data)
        } else {
          const states = url.searchParams.getAll("status")
          const list = invitations.filter(
            (i) =>
              i.organization_id === org &&
              (!states.length || states.includes(i.status))
          )
          data = { data: list, total_count: list.length }
        }
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify(data))
        return
      }
      if (parts[1] === "users") {
        const id = parts[2].replace(/^user_/, "")
        const result = await database.query("SELECT * FROM users WHERE id=$1", [
          id,
        ])
        const u = result.rows[0]
        if (u)
          data = {
            object: "user",
            id: `user_${id}`,
            password_enabled: identityState.passwordEnabled,
            banned: identityState.banned,
            locked: false,
            primary_email_address_id: `email_${id}`,
            email_addresses: [
              {
                id: `email_${id}`,
                email_address: u.email,
                linked_to: [],
                verification: {
                  status: identityState.verified ? "verified" : "unverified",
                  strategy: "email_code",
                },
              },
            ],
            first_name: u.name,
            last_name: null,
            external_id: id,
            public_metadata: {},
            private_metadata: {},
            unsafe_metadata: {},
            created_at: Date.now(),
            updated_at: Date.now(),
          }
      } else if (parts[1] === "sessions") {
        const result = await database.query(
          "SELECT * FROM sessions WHERE id=$1",
          [parts[2]]
        )
        const s = result.rows[0]
        if (s)
          data = {
            object: "session",
            id: s.id,
            user_id: `user_${s.user_id}`,
            status:
              identityState.sessionStatus ??
              (new Date(s.expires_at) > new Date() ? "active" : "expired"),
            last_active_at: Date.now(),
            expire_at: new Date(s.expires_at).getTime(),
            abandon_at: Date.now() + 86400000,
            created_at: Date.now(),
            updated_at: Date.now(),
          }
      } else if (parts[1] === "organizations" && parts[3] === "memberships") {
        const workspaceId = parts[2].replace(/^org_/, "")
        const uid = (
          url.searchParams.get("user_id") ??
          url.searchParams.get("user_id[]") ??
          parts[4] ?? ""
        ).replace(/^user_/, "")
        const result = await database.query(
          "SELECT id FROM memberships WHERE workspace_id=$1 AND user_id=$2",
          [workspaceId, uid]
        )
        const roleKey = `${workspaceId}:${uid}`
        if (req.method === "PATCH") { let body = ""; for await (const chunk of req) body += chunk; const patch = JSON.parse(body); if (patch.role) remoteRoles.set(roleKey, patch.role) }
        data = {
          data: result.rows.map((m) => ({
            object: "organization_membership",
            id: `orgmem_${m.id}`,
            role: remoteRoles.get(roleKey) ?? "org:member",
            organization: { id: parts[2], name: "Fixture" },
            public_user_data: { user_id: `user_${uid}` },
            public_metadata: {},
            private_metadata: {},
            created_at: Date.now(),
            updated_at: Date.now(),
          })),
          total_count: result.rowCount,
        }
        if (req.method === "PATCH") data = data.data[0]
      }
      res.writeHead(data ? 200 : 404, { "content-type": "application/json" })
      res.end(
        JSON.stringify(
          data ?? {
            errors: [{ code: "resource_not_found", message: "Not found" }],
          }
        )
      )
    } catch (error) {
      console.error("Clerk protocol fixture:", error.message)
      res.writeHead(500).end()
    }
  })
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve))
  const env = {
    MCA_CLERK_BILLING_ENABLED: "false",
    CLERK_JWT_KEY: publicKey.export({ type: "spki", format: "pem" }),
    CLERK_API_URL: `http://127.0.0.1:${api.address().port}`,
    CLERK_SECRET_KEY: "sk_test_fixture",
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from("clerk.fixture.test$").toString("base64")}`,
  }
  async function login(email, password) {
    let result = await database.query(
      `SELECT m.id membership_id,m.workspace_id,m.role,u.id user_id FROM users u JOIN memberships m ON m.user_id=u.id WHERE lower(u.email)=lower($1) AND m.status='active' LIMIT 1`,
      [email]
    )
    if (!result.rows[0]) {
      await createWorkspaceWithAdmin({
        workspaceName: "HTTP fixture company",
        adminName: "Owner",
        adminEmail: email,
        password,
      })
      result = await database.query(
        `SELECT m.id membership_id,m.workspace_id,m.role,u.id user_id FROM users u JOIN memberships m ON m.user_id=u.id WHERE lower(u.email)=lower($1) LIMIT 1`,
        [email]
      )
    }
    const row = result.rows[0]
    const session = await createSession(row.user_id, row.membership_id)
    const payload = await getSessionResponse({
      authType: "session",
      userId: row.user_id,
      membershipId: row.membership_id,
      workspaceId: row.workspace_id,
      role: row.role,
      scopes: [],
      sessionId: "fixture",
    })
    return {
      response: new Response(null, { status: 200 }),
      payload,
      cookie: `mca_session=${session.token}`,
    }
  }
  async function headers(cookie) {
    if (!cookie) return {}
    const token = cookie.replace(/^mca_session=/, "")
    const result = await database.query(
      `SELECT s.id,s.user_id,m.workspace_id FROM sessions s JOIN memberships m ON m.id=s.membership_id WHERE s.token_hash=$1`,
      [hashOpaqueToken(token)]
    )
    const row = result.rows[0]
    if (!row) return { cookie }
    await database.query("UPDATE users SET clerk_user_id=$1 WHERE id=$2", [
      `user_${row.user_id}`,
      row.user_id,
    ])
    await database.query(
      "UPDATE workspaces SET clerk_organization_id=$1 WHERE id=$2",
      [`org_${row.workspace_id}`, row.workspace_id]
    )
    const now = Math.floor(Date.now() / 1000)
    const payload = {
      iss: issuer,
      sub: `user_${row.user_id}`,
      sid: row.id,
      iat: now,
      nbf: now - 5,
      exp: now + 120,
      v: 2,
      o: { id: `org_${row.workspace_id}`, rol: "member", slg: "fixture" },
    }
    const part = (x) => Buffer.from(JSON.stringify(x)).toString("base64url")
    const unsigned = `${part({ alg: "RS256", typ: "JWT", kid: "fixture" })}.${part(payload)}`
    return {
      authorization: `Bearer ${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`,
    }
  }
  return {
    env,
    login,
    headers,
    invitations,
    billingSubscriptions,
    remoteRoles,
    identityState,
    close: async () => {
      await closeDatabaseForTests()
      api.closeAllConnections()
      await new Promise((resolve) => api.close(resolve))
    },
    id: randomUUID(),
  }
}

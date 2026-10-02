import { mock } from "node:test"
import { randomUUID } from "node:crypto"
import type { User } from "@supabase/supabase-js"
import { createPostgresTestDatabase } from "./postgres-test-db.mjs"
import {
  closeDatabaseForTests,
  getDatabase,
  nowIso,
} from "../../src/lib/mca/db"
import type { SupabaseIdentity } from "../../src/lib/mca/supabase-auth"
import {
  enrollmentTestEnv,
  resumeSecret,
  stripeFixture,
} from "./onboarding-billing"

export const browserCookies = new Map<string, string>()
export const provider = {
  current: null as SupabaseIdentity | null,
  users: new Map<string, User>(),
  otpError: null as object | null,
  failCookie: false,
  otpInputs: [] as unknown[],
  verificationInputs: [] as unknown[],
  exchangeInputs: [] as unknown[],
  onOtp: undefined as undefined | (() => Promise<void>),
  onGetUser: undefined as undefined | (() => Promise<void>),
}
// Node 24 uses exports; cache also keeps options compatible with the older installed type declarations.
const headersMock = {
  cache: false,
  exports: {
    cookies: async () => ({
      get: (name: string) =>
        browserCookies.has(name)
          ? { value: browserCookies.get(name)! }
          : undefined,
      set: (name: string, value: string) => {
        if (provider.failCookie) throw new Error("Synthetic cookie failure")
        browserCookies.set(name, value)
      },
      delete: (name: string) => {
        browserCookies.delete(name)
      },
    }),
  },
}
mock.module("next/headers", headersMock)
const serverMock = {
  cache: false,
  exports: {
    createSupabaseServerClient: async () => ({
      auth: {
        getUser: async () => {
          if (provider.onGetUser) await provider.onGetUser()
          return { data: { user: provider.current?.user ?? null }, error: null }
        },
        getClaims: async () => ({
          data: {
            claims: {
              sub: provider.current?.user.id,
              session_id: provider.current?.sessionId,
              aal: "aal2",
            },
          },
          error: null,
        }),
        signInWithOtp: async (input: unknown) => {
          provider.otpInputs.push(input)
          return { error: provider.otpError }
        },
        verifyOtp: async (input: unknown) => {
          provider.verificationInputs.push(input)
          if (provider.onOtp) await provider.onOtp()
          return { error: provider.otpError }
        },
        exchangeCodeForSession: async (input: unknown) => {
          provider.exchangeInputs.push(input)
          if (provider.onOtp) await provider.onOtp()
          return { error: provider.otpError }
        },
      },
    }),
    getSupabaseAdminClient: () => ({
      auth: {
        admin: {
          getUserById: async (id: string) => ({
            data: { user: provider.users.get(id) ?? null },
            error: null,
          }),
        },
      },
    }),
  },
}
mock.module(
  new URL("../../src/lib/supabase/server.ts", import.meta.url).href,
  serverMock
)

export async function authDatabase(name: string) {
  const originalEnv = { ...process.env }
  const database = await createPostgresTestDatabase(name)
  Object.assign(process.env, enrollmentTestEnv, {
    DATABASE_URL: database.databaseUrl,
  })
  await getDatabase().execute("CREATE SCHEMA auth")
  await getDatabase().execute(
    "CREATE TABLE auth.sessions(id uuid PRIMARY KEY,user_id uuid NOT NULL,not_after timestamptz)"
  )
  await getDatabase().execute(
    "CREATE VIEW mca_private.auth_sessions AS SELECT id,user_id,not_after FROM auth.sessions"
  )
  return async () => {
    await closeDatabaseForTests()
    await database.close()
    for (const key of Object.keys(process.env))
      if (!(key in originalEnv)) delete process.env[key]
    Object.assign(process.env, originalEnv)
  }
}
export function resetAuthProvider() {
  provider.current = null
  provider.otpError = null
  provider.failCookie = false
  provider.onOtp = undefined
  provider.onGetUser = undefined
  provider.otpInputs.length = 0
  provider.verificationInputs.length = 0
  provider.exchangeInputs.length = 0
  browserCookies.clear()
}
export async function liveIdentity(email: string): Promise<SupabaseIdentity> {
  const user = {
    id: randomUUID(),
    email,
    email_confirmed_at: nowIso(),
    app_metadata: {},
    user_metadata: {},
    aud: "authenticated",
    created_at: nowIso(),
  } as User
  const identity = { user, email, sessionId: randomUUID() }
  provider.users.set(user.id, user)
  provider.current = identity
  await getDatabase().execute(
    "INSERT INTO auth.sessions(id,user_id,not_after) VALUES (?,?,now()+interval '1 hour')",
    [identity.sessionId, user.id]
  )
  return identity
}
export async function activatedEnrollment() {
  const { startEnrollmentCheckout } =
    await import("../../src/lib/mca/onboarding/checkout")
  const { reconcileEnrollment } =
    await import("../../src/lib/mca/onboarding/reconcile")
  const f = stripeFixture(),
    secret = resumeSecret()
  const started = await startEnrollmentCheckout(
    { resumeSecret: secret },
    f.client
  )
  const completed = f.complete()
  const row = await reconcileEnrollment(started.enrollmentId, f.client)
  const identity = await liveIdentity(completed.customer_details!.email!)
  return { ...f, row, identity, secret, id: row.id }
}

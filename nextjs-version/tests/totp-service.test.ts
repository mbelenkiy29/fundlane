import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { closeDatabaseForTests, getDatabase, nowIso } from "../src/lib/mca/db"
import { createWorkspaceWithAdmin, getWorkspaceSettings, updateWorkspaceSettings } from "../src/lib/mca/workspaces"
import { decryptUserSecret } from "../src/lib/mca/crypto"
import { generateTotpCode } from "../src/lib/mca/totp"
import {
  assertSessionTotpAccess,
  beginTotpEnrollment,
  challengeTotp,
  confirmTotpEnrollment,
  disableTotp,
  getTotpAccessState,
  isGoogleOauthCallback,
  markGoogleTotpSession,
  regenerateRecoveryCodes,
  startPasswordTotpChallenge,
} from "../src/lib/mca/totp-service"
import type { SupabaseIdentity } from "../src/lib/mca/supabase-auth"
import type { User } from "@supabase/supabase-js"

let database: Awaited<ReturnType<typeof createPostgresTestDatabase>>

before(async () => {
  process.env.MCA_DATA_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64url")
  database = await createPostgresTestDatabase("totp_service")
  process.env.DATABASE_URL = database.databaseUrl
})

after(async () => {
  await closeDatabaseForTests()
  await database?.close()
})

async function fixture() {
  const email = `${randomUUID()}@example.test`
  const local = await createWorkspaceWithAdmin({
    workspaceName: "TOTP workspace",
    adminName: "Owner",
    adminEmail: email,
    password: "Unused fixture password 99!",
    role: "admin",
  })
  const supabaseUserId = randomUUID()
  const sessionId = randomUUID()
  await getDatabase().prepare("UPDATE users SET supabase_user_id = ? WHERE id = ?").run(supabaseUserId, local.userId)
  const identity: SupabaseIdentity = {
    user: { id: supabaseUserId, email, email_confirmed_at: nowIso(), app_metadata: {}, user_metadata: {}, aud: "authenticated", created_at: nowIso() } as User,
    email,
    sessionId,
  }
  return { local, identity }
}

test("enrollment stores an encrypted secret, confirms with TOTP, and issues hashed recovery codes", async () => {
  const { local, identity } = await fixture()
  const enrollment = await beginTotpEnrollment(local.userId, identity.email)
  assert.match(enrollment.secret, /^[A-Z2-7]+$/)
  assert.match(enrollment.qrCode, /^data:image\/png;base64,/)
  const stored = await getDatabase().prepare<{ secret_cipher: string; status: string }>("SELECT secret_cipher, status FROM user_totp_factors WHERE user_id = ?").get(local.userId)
  assert.equal(stored?.status, "pending")
  assert.equal(stored?.secret_cipher.includes(enrollment.secret), false)
  assert.equal(decryptUserSecret(stored!.secret_cipher, local.userId), enrollment.secret)
  const confirmed = await confirmTotpEnrollment(local.userId, generateTotpCode(enrollment.secret), identity.sessionId)
  assert.equal(confirmed.recoveryCodes.length, 10)
  const hashes = await getDatabase().prepare<{ code_hash: string }>("SELECT code_hash FROM user_totp_recovery_codes WHERE user_id = ?").all(local.userId)
  assert.equal(hashes.length, 10)
  assert.equal(hashes.some((row) => confirmed.recoveryCodes.includes(row.code_hash)), false)
  const state = await getTotpAccessState({ userId: local.userId, sessionId: identity.sessionId, workspaceId: local.workspaceId })
  assert.equal(state.enrolled, true)
  assert.equal(state.sessionVerified, true)
  assert.equal(state.recoveryRemaining, 10)
})

test("password sign-in requires a challenge that consumes a recovery code once", async () => {
  const { local, identity } = await fixture()
  const enrollment = await beginTotpEnrollment(local.userId, identity.email)
  const { recoveryCodes } = await confirmTotpEnrollment(local.userId, generateTotpCode(enrollment.secret))
  const nextSession = randomUUID()
  const started = await startPasswordTotpChallenge({ ...identity, sessionId: nextSession })
  assert.equal(started.mfaRequired, true)
  await assert.rejects(assertSessionTotpAccess({ userId: local.userId, sessionId: nextSession, workspaceId: local.workspaceId }), { code: "totp_required" })
  const used = await challengeTotp(local.userId, nextSession, recoveryCodes[0])
  assert.equal(used.method, "recovery")
  await assertSessionTotpAccess({ userId: local.userId, sessionId: nextSession, workspaceId: local.workspaceId })
  await assert.rejects(challengeTotp(local.userId, randomUUID(), recoveryCodes[0]), { code: "totp_verification_failed" })
})

test("enrolled users without a session marker must complete a challenge", async () => {
  const { local } = await fixture()
  const enrollment = await beginTotpEnrollment(local.userId, "owner@example.test")
  await confirmTotpEnrollment(local.userId, generateTotpCode(enrollment.secret))
  const otherSession = randomUUID()
  const state = await getTotpAccessState({ userId: local.userId, sessionId: otherSession, workspaceId: local.workspaceId })
  assert.equal(state.challengeRequired, true)
  await assert.rejects(assertSessionTotpAccess({ userId: local.userId, sessionId: otherSession, workspaceId: local.workspaceId }), { code: "totp_required" })
})

test("missing encryption key fail-closes enrolled accounts instead of skipping TOTP", async () => {
  const { local, identity } = await fixture()
  const enrollment = await beginTotpEnrollment(local.userId, identity.email)
  await confirmTotpEnrollment(local.userId, generateTotpCode(enrollment.secret))
  const previousKey = process.env.MCA_DATA_ENCRYPTION_KEY
  process.env.MCA_DATA_ENCRYPTION_KEY = "invalid-totp-key"
  try {
    const nextSession = randomUUID()
    const started = await startPasswordTotpChallenge({ ...identity, sessionId: nextSession })
    assert.equal(started.mfaRequired, true)
    const state = await getTotpAccessState({ userId: local.userId, sessionId: nextSession, workspaceId: local.workspaceId })
    assert.equal(state.available, false)
    assert.equal(state.enrolled, true)
    assert.equal(state.challengeRequired, true)
    await assert.rejects(assertSessionTotpAccess({ userId: local.userId, sessionId: nextSession, workspaceId: local.workspaceId }), { code: "totp_required" })
  } finally {
    process.env.MCA_DATA_ENCRYPTION_KEY = previousKey
  }
})

test("only Google OAuth code callbacks skip TOTP; email and recovery stay challenged", () => {
  assert.equal(isGoogleOauthCallback({ hasCode: true, hasTokenHash: false, type: null, provider: "google", next: "/onboarding" }), true)
  assert.equal(isGoogleOauthCallback({ hasCode: false, hasTokenHash: true, type: "email", provider: "google", next: "/onboarding" }), false)
  assert.equal(isGoogleOauthCallback({ hasCode: false, hasTokenHash: true, type: "recovery", provider: "google", next: "/reset-password?next=%2Fonboarding" }), false)
  assert.equal(isGoogleOauthCallback({ hasCode: true, hasTokenHash: false, type: null, provider: "google", next: "/reset-password?next=%2Fonboarding" }), false)
  assert.equal(isGoogleOauthCallback({ hasCode: true, hasTokenHash: false, type: "signup", provider: "google", next: "/onboarding" }), false)
  assert.equal(isGoogleOauthCallback({ hasCode: true, hasTokenHash: false, type: "magiclink", provider: "google", next: "/onboarding" }), false)
})

test("Google sign-in does not require a second factor after Google authentication", async () => {
  const { local, identity } = await fixture()
  const enrollment = await beginTotpEnrollment(local.userId, identity.email)
  await confirmTotpEnrollment(local.userId, generateTotpCode(enrollment.secret))
  await markGoogleTotpSession(identity)
  const state = await getTotpAccessState({ userId: local.userId, sessionId: identity.sessionId, workspaceId: local.workspaceId })
  assert.equal(state.enrolled, true)
  assert.equal(state.challengeRequired, false)
  await assertSessionTotpAccess({ userId: local.userId, sessionId: identity.sessionId, workspaceId: local.workspaceId })
})

test("workspace require-2FA sends members without enrollment to enroll", async () => {
  const { local, identity } = await fixture()
  const settings = await getWorkspaceSettings(local.workspaceId)
  assert.equal(settings.require2fa, false)
  const updated = await updateWorkspaceSettings({
    authType: "session",
    userId: local.userId,
    membershipId: local.membershipId,
    workspaceId: local.workspaceId,
    role: "admin",
    scopes: [],
    sessionId: identity.sessionId,
  }, { require2fa: true })
  assert.equal(updated.require2fa, true)
  await assert.rejects(assertSessionTotpAccess({ userId: local.userId, sessionId: identity.sessionId, workspaceId: local.workspaceId }), { code: "totp_enrollment_required" })
  const enrollment = await beginTotpEnrollment(local.userId, identity.email)
  await confirmTotpEnrollment(local.userId, generateTotpCode(enrollment.secret), identity.sessionId)
  await assertSessionTotpAccess({ userId: local.userId, sessionId: identity.sessionId, workspaceId: local.workspaceId })
})

test("disable and regenerate require a live code and replace hashed recovery codes", async () => {
  const { local, identity } = await fixture()
  const enrollment = await beginTotpEnrollment(local.userId, identity.email)
  const first = await confirmTotpEnrollment(local.userId, generateTotpCode(enrollment.secret), identity.sessionId)
  const next = await regenerateRecoveryCodes(local.userId, first.recoveryCodes[1])
  assert.equal(next.recoveryCodes.length, 10)
  assert.equal(next.recoveryCodes.includes(first.recoveryCodes[1]), false)
  await assert.rejects(challengeTotp(local.userId, randomUUID(), first.recoveryCodes[2]), { code: "totp_verification_failed" })
  await disableTotp(local.userId, next.recoveryCodes[0])
  const factor = await getDatabase().prepare("SELECT user_id FROM user_totp_factors WHERE user_id = ?").get(local.userId)
  assert.equal(factor, undefined)
  const started = await startPasswordTotpChallenge(identity)
  assert.equal(started.mfaRequired, false)
})

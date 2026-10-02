import test, { before, after, beforeEach, mock } from "node:test"
import assert from "node:assert/strict"
import {
  authDatabase,
  activatedEnrollment,
  browserCookies,
  liveIdentity,
  provider,
  resetAuthProvider,
} from "./helpers/onboarding-auth"
import { getDatabase, nowIso } from "../src/lib/mca/db"
import { linkSupabaseUser } from "../src/lib/mca/supabase-auth"
import {
  findEnrollment,
  readEnrollmentContact,
} from "../src/lib/mca/onboarding/store"
import type { SuperAdminActor } from "../src/lib/mca/platform-auth"
import { resumeSecret, stripeFixture } from "./helpers/onboarding-billing"
import { startEnrollmentCheckout } from "../src/lib/mca/onboarding/checkout"
import { reconcileEnrollment } from "../src/lib/mca/onboarding/reconcile"

let close: () => Promise<void>
before(async () => {
  close = await authDatabase("enrollment_recovery")
})
after(async () => {
  await close?.()
})
beforeEach(resetAuthProvider)
function request(origin: string | null = "http://localhost:3000") {
  return new Request("http://localhost:3000/api/platform/onboarding/test", {
    method: "POST",
    headers: origin ? { origin } : {},
  })
}
async function operator(): Promise<SuperAdminActor> {
  const identity = await liveIdentity(
    `operator-${Date.now()}-${Math.random()}@example.test`
  )
  process.env.MCA_SUPER_ADMIN_EMAILS = identity.email
  const userId = await linkSupabaseUser(identity)
  await getDatabase().execute(
    "INSERT INTO platform_admin_grants(user_id,granted_at,granted_by,reason) VALUES (?,?,'synthetic-test','Synthetic platform fixture')",
    [userId, nowIso()]
  )
  await getDatabase().execute(
    "INSERT INTO platform_step_ups(session_id,user_id,verified_at) VALUES (?,?,?)",
    [identity.sessionId, userId, nowIso()]
  )
  return {
    userId,
    supabaseUserId: identity.user.id,
    sessionId: identity.sessionId,
    email: identity.email,
  }
}
async function targetProof(
  f: Awaited<ReturnType<typeof activatedEnrollment>>,
  actor: SuperAdminActor,
  email: string
) {
  const recovery = await import("../src/lib/mca/onboarding/recovery"),
    auth = await import("../src/lib/mca/onboarding/auth")
  await recovery.authorizeEnrollmentContactVerification(
    actor,
    {
      enrollmentId: f.id,
      correctedEmail: email,
      reason: "Independent purchase review completed",
      purchaseEvidence: "support-case:AUTH-12345",
      expectedRevision: (await findEnrollment(f.id))!.revision,
    },
    request(),
    f.client
  )
  const before = (await findEnrollment(f.id))!
  assert.equal(readEnrollmentContact(before).email, f.identity.email)
  await auth.requestEnrollmentAuthentication({ enrollmentId: f.id, email })
  const target = await liveIdentity(email),
    challengeId = browserCookies.get(auth.enrollmentAuthCookie)!.split(".")[0]
  await auth.verifyEnrollmentAuthentication({
    challengeId,
    email,
    token: "123456",
  })
  return { target, challengeId, before }
}
test("contact authorization requires real platform authority, trusted origin, current purchase reference and fresh step-up", async () => {
  const f = await activatedEnrollment(),
    actor = await operator(),
    recovery = await import("../src/lib/mca/onboarding/recovery")
  const input = {
    enrollmentId: f.id,
    correctedEmail: "corrected@example.test",
    reason: "Reviewed independent purchase control",
    purchaseEvidence: "support-case:AUTH-12345",
    expectedRevision: f.row.revision,
  }
  await assert.rejects(
    recovery.authorizeEnrollmentContactVerification(
      actor,
      input,
      request(null),
      f.client
    ),
    { code: "untrusted_origin" }
  )
  await assert.rejects(
    recovery.authorizeEnrollmentContactVerification(
      actor,
      input,
      request("https://foreign.test"),
      f.client
    ),
    { code: "untrusted_origin" }
  )
  await getDatabase().execute(
    "UPDATE platform_step_ups SET verified_at=? WHERE session_id=?",
    [new Date(Date.now() - 3600000).toISOString(), actor.sessionId]
  )
  await assert.rejects(
    recovery.authorizeEnrollmentContactVerification(
      actor,
      input,
      request(),
      f.client
    ),
    { code: "step_up_required" }
  )
  await getDatabase().execute(
    "UPDATE platform_step_ups SET verified_at=? WHERE session_id=?",
    [nowIso(), actor.sessionId]
  )
  await assert.rejects(
    recovery.authorizeEnrollmentContactVerification(
      actor,
      { ...input, purchaseEvidence: "email known" },
      request(),
      f.client
    ),
    { code: "enrollment_recovery_evidence_required" }
  )
  await getDatabase().execute(
    "UPDATE platform_admin_grants SET revoked_at=? WHERE user_id=?",
    [nowIso(), actor.userId]
  )
  await assert.rejects(
    recovery.authorizeEnrollmentContactVerification(
      actor,
      input,
      request(),
      f.client
    ),
    { code: "platform_admin_required" }
  )
})
test("target OTP and purchase review alone never correct contact or grant tenant ownership; separate audited approval rotates generations", async () => {
  const f = await activatedEnrollment(),
    actor = await operator(),
    email = "new-corrected@example.test"
  const proof = await targetProof(f, actor, email)
  const { claimEnrollment } = await import("../src/lib/mca/onboarding/claim")
  await assert.rejects(
    claimEnrollment({ enrollmentId: f.id, identity: proof.target }, f.client),
    { code: "enrollment_identity_mismatch" }
  )
  const originalSnapshot = (await findEnrollment(f.id))!.providerSnapshotCipher
  provider.current = {
    user: provider.users.get(actor.supabaseUserId)!,
    email: actor.email,
    sessionId: actor.sessionId,
  }
  const recovery = await import("../src/lib/mca/onboarding/recovery")
  await getDatabase().execute(
    "UPDATE platform_step_ups SET verified_at=? WHERE session_id=?",
    [nowIso(), actor.sessionId]
  )
  await recovery.recoverEnrollmentContact(
    actor,
    {
      enrollmentId: f.id,
      verifiedProviderUserId: proof.target.user.id,
      reason: "Approved independent purchase identity proof",
      purchaseEvidence: "support-case:AUTH-12345",
      expectedRevision: (await findEnrollment(f.id))!.revision,
    },
    request(),
    f.client
  )
  const row = (await findEnrollment(f.id))!
  assert.equal(row.workspaceId, null)
  assert.equal(row.userId, null)
  assert.equal(row.claimedProviderUserId, proof.target.user.id)
  assert.equal(readEnrollmentContact(row).email, email)
  assert.equal(row.providerSnapshotCipher, originalSnapshot)
  assert.equal(row.resumeGeneration, 2)
  assert.equal(row.emailGeneration, 2)
  assert.equal(row.trialEndsAt, f.row.trialEndsAt)
  assert.equal(
    (
      await getDatabase().queryOne<{ count: number }>(
        "SELECT count(*)::int count FROM mca_onboarding_service_emails WHERE enrollment_id=? AND state='suppressed'",
        [f.id]
      )
    )?.count,
    2
  )
  assert.equal(
    (
      await getDatabase().queryOne<{ count: number }>(
        "SELECT count(*)::int count FROM mca_onboarding_service_emails WHERE enrollment_id=? AND generation=2",
        [f.id]
      )
    )?.count,
    2
  )
  const audit = await getDatabase().queryOne<{ after_json: object }>(
    "SELECT after_json FROM platform_admin_audit WHERE action='enrollment.identity_recovery_approved' AND target_id=?",
    [f.id]
  )
  assert.ok(audit)
  assert.equal(JSON.stringify(audit).includes(email), false)
  provider.current = proof.target
  assert.ok(
    (
      await claimEnrollment(
        { enrollmentId: f.id, identity: proof.target },
        f.client
      )
    ).workspaceId
  )
})
test("revoked target session, stale version and audit failure cannot change the original contact", async () => {
  const f = await activatedEnrollment(),
    actor = await operator(),
    email = "revocation@example.test",
    proof = await targetProof(f, actor, email)
  provider.current = {
    user: provider.users.get(actor.supabaseUserId)!,
    email: actor.email,
    sessionId: actor.sessionId,
  }
  const recovery = await import("../src/lib/mca/onboarding/recovery"),
    input = {
      enrollmentId: f.id,
      verifiedProviderUserId: proof.target.user.id,
      reason: "Reviewed independent purchase identity",
      purchaseEvidence: "support-case:AUTH-12345",
      expectedRevision: (await findEnrollment(f.id))!.revision,
    }
  await getDatabase().execute(
    "UPDATE platform_step_ups SET verified_at=? WHERE session_id=?",
    [nowIso(), actor.sessionId]
  )
  await getDatabase().execute(
    "INSERT INTO auth_session_revocations(id,revoked_at) VALUES (?,?)",
    [proof.target.sessionId, nowIso()]
  )
  await assert.rejects(
    recovery.recoverEnrollmentContact(actor, input, request(), f.client),
    { code: "enrollment_recovery_proof_invalid" }
  )
  await getDatabase().execute(
    "DELETE FROM auth_session_revocations WHERE id=?",
    [proof.target.sessionId]
  )
  await assert.rejects(
    recovery.recoverEnrollmentContact(
      actor,
      { ...input, expectedRevision: 1 },
      request(),
      f.client
    ),
    { code: "enrollment_revision_conflict" }
  )
  await getDatabase().execute(
    "CREATE FUNCTION test_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$"
  )
  await getDatabase().execute(
    "CREATE TRIGGER test_audit_fail BEFORE INSERT ON platform_admin_audit FOR EACH ROW EXECUTE FUNCTION test_audit_fail()"
  )
  try {
    await assert.rejects(
      recovery.recoverEnrollmentContact(
        actor,
        { ...input, expectedRevision: (await findEnrollment(f.id))!.revision },
        request(),
        f.client
      ),
      /synthetic audit failure/
    )
  } finally {
    await getDatabase().execute(
      "DROP TRIGGER test_audit_fail ON platform_admin_audit"
    )
    await getDatabase().execute("DROP FUNCTION test_audit_fail()")
  }
  assert.equal(
    readEnrollmentContact((await findEnrollment(f.id))!).email,
    f.identity.email
  )
})
test("a pre-company claimant may manage cancellation in the provider portal with MFA, without tenant creation", async () => {
  const f = await activatedEnrollment(),
    { manageEnrollmentBilling } =
      await import("../src/lib/mca/onboarding/recovery")
  assert.equal(
    await manageEnrollmentBilling(
      { enrollmentId: f.id, identity: f.identity },
      f.client
    ),
    "https://billing.stripe.com/p/session/test"
  )
  assert.equal(
    f.state.portalReturnUrl,
    `http://localhost:3000/enrollment?enrollment=${f.id}`
  )
  assert.equal((await findEnrollment(f.id))?.workspaceId, null)
  const userId = await linkSupabaseUser(f.identity)
  await getDatabase().execute(
    "INSERT INTO user_totp_factors(user_id,status,secret_cipher,created_at,updated_at) VALUES (?,'enabled','synthetic',?,?)",
    [userId, nowIso(), nowIso()]
  )
  await assert.rejects(
    manageEnrollmentBilling(
      { enrollmentId: f.id, identity: f.identity },
      f.client
    ),
    { code: "totp_required" }
  )
})
test("operator approval requires a new step-up after target verification and cannot replay on a claimed company", async () => {
  const f = await activatedEnrollment(),
    actor = await operator(),
    proof = await targetProof(f, actor, "fresh-step-up@example.test")
  provider.current = {
    user: provider.users.get(actor.supabaseUserId)!,
    email: actor.email,
    sessionId: actor.sessionId,
  }
  const { recoverEnrollmentContact } =
    await import("../src/lib/mca/onboarding/recovery")
  const input = {
    enrollmentId: f.id,
    verifiedProviderUserId: proof.target.user.id,
    reason: "Reviewed independent purchase identity",
    purchaseEvidence: "support-case:AUTH-12345",
    expectedRevision: (await findEnrollment(f.id))!.revision,
  }
  await assert.rejects(
    recoverEnrollmentContact(actor, input, request(), f.client),
    { code: "enrollment_recovery_proof_invalid" }
  )
  await getDatabase().execute(
    "UPDATE platform_step_ups SET verified_at=? WHERE session_id=?",
    [nowIso(), actor.sessionId]
  )
  await recoverEnrollmentContact(
    actor,
    { ...input, expectedRevision: (await findEnrollment(f.id))!.revision },
    request(),
    f.client
  )
  provider.current = proof.target
  const { claimEnrollment } = await import("../src/lib/mca/onboarding/claim")
  await claimEnrollment(
    { enrollmentId: f.id, identity: proof.target },
    f.client
  )
  provider.current = {
    user: provider.users.get(actor.supabaseUserId)!,
    email: actor.email,
    sessionId: actor.sessionId,
  }
  await assert.rejects(
    recoverEnrollmentContact(
      actor,
      { ...input, expectedRevision: (await findEnrollment(f.id))!.revision },
      request(),
      f.client
    ),
    { code: "enrollment_recovery_not_allowed" }
  )
})
test("revoking target authorization between lookup and challenge persistence prevents issuance", async () => {
  const f = await activatedEnrollment(),
    actor = await operator(),
    recovery = await import("../src/lib/mca/onboarding/recovery")
  await recovery.authorizeEnrollmentContactVerification(
    actor,
    {
      enrollmentId: f.id,
      correctedEmail: "revoked-authorization@example.test",
      reason: "Reviewed independent purchase proof",
      purchaseEvidence: "support-case:AUTH-12345",
      expectedRevision: f.row.revision,
    },
    request(),
    f.client
  )
  const db = getDatabase(),
    query = db.queryOne.bind(db)
  const interception = mock.method(
    db,
    "queryOne",
    async (...args: Parameters<typeof db.queryOne>) => {
      const result = await query(...args)
      if (
        args[0].includes("purpose='contact_recovery'") &&
        args[0].includes("state='pending'")
      )
        await db.execute(
          "UPDATE mca_enrollment_challenges SET state='revoked' WHERE enrollment_id=? AND purpose='contact_recovery'",
          [f.id]
        )
      return result
    }
  )
  try {
    const auth = await import("../src/lib/mca/onboarding/auth")
    await auth.requestEnrollmentAuthentication({
      enrollmentId: f.id,
      email: "revoked-authorization@example.test",
    })
    assert.equal(provider.otpInputs.length, 0)
  } finally {
    interception.mock.restore()
  }
})
test("target proof expiry at the approval transaction boundary rolls back contact correction", async () => {
  const f = await activatedEnrollment(),
    actor = await operator(),
    proof = await targetProof(f, actor, "expiring-proof@example.test")
  provider.current = {
    user: provider.users.get(actor.supabaseUserId)!,
    email: actor.email,
    sessionId: actor.sessionId,
  }
  await getDatabase().execute(
    "UPDATE platform_step_ups SET verified_at=? WHERE session_id=?",
    [nowIso(), actor.sessionId]
  )
  const db = getDatabase(),
    query = db.queryOne.bind(db)
  const interception = mock.method(
    db,
    "queryOne",
    async (...args: Parameters<typeof db.queryOne>) => {
      const result = await query(...args)
      if (args[0].includes("ORDER BY verified_at DESC"))
        await db.execute(
          "UPDATE mca_enrollment_challenges SET expires_at=?,created_at=? WHERE id=?",
          [
            new Date(Date.now() - 1000).toISOString(),
            new Date(Date.now() - 3600000).toISOString(),
            proof.challengeId,
          ]
        )
      return result
    }
  )
  try {
    const recovery = await import("../src/lib/mca/onboarding/recovery")
    await assert.rejects(
      recovery.recoverEnrollmentContact(
        actor,
        {
          enrollmentId: f.id,
          verifiedProviderUserId: proof.target.user.id,
          reason: "Reviewed independent purchase identity",
          purchaseEvidence: "support-case:AUTH-12345",
          expectedRevision: (await findEnrollment(f.id))!.revision,
        },
        request(),
        f.client
      ),
      { code: "enrollment_recovery_proof_invalid" }
    )
    assert.equal(
      readEnrollmentContact((await findEnrollment(f.id))!).email,
      f.identity.email
    )
  } finally {
    interception.mock.restore()
  }
})
test("a signed-in initiator can correct correspondence to its own verified address without relaxing the identity binding", async () => {
  const f = stripeFixture(),
    initiator = await liveIdentity("initiator-correction@example.test")
  const started = await startEnrollmentCheckout(
    {
      resumeSecret: resumeSecret(),
      initiatingProviderUserId: initiator.user.id,
    },
    f.client
  )
  f.complete()
  const row = await reconcileEnrollment(started.enrollmentId, f.client),
    actor = await operator()
  const recovery = await import("../src/lib/mca/onboarding/recovery"),
    auth = await import("../src/lib/mca/onboarding/auth")
  const evidence = {
    enrollmentId: row.id,
    reason: "Reviewed independent purchase identity proof",
    purchaseEvidence: "support-case:BOUND-12345",
    expectedRevision: row.revision,
  }
  await recovery.authorizeEnrollmentContactVerification(
    actor,
    { ...evidence, correctedEmail: initiator.email },
    request(),
    f.client
  )
  await auth.requestEnrollmentAuthentication({
    enrollmentId: row.id,
    email: initiator.email,
  })
  provider.current = initiator
  await auth.verifyEnrollmentAuthentication({
    challengeId: browserCookies.get(auth.enrollmentAuthCookie)!.split(".")[0],
    email: initiator.email,
    token: "123456",
  })
  provider.current = {
    user: provider.users.get(actor.supabaseUserId)!,
    email: actor.email,
    sessionId: actor.sessionId,
  }
  await getDatabase().execute(
    "UPDATE platform_step_ups SET verified_at=? WHERE session_id=?",
    [nowIso(), actor.sessionId]
  )
  await recovery.recoverEnrollmentContact(
    actor,
    {
      ...evidence,
      expectedRevision: (await findEnrollment(row.id))!.revision,
      verifiedProviderUserId: initiator.user.id,
    },
    request(),
    f.client
  )
  const corrected = (await findEnrollment(row.id))!
  assert.equal(corrected.initiatingProviderUserId, initiator.user.id)
  assert.equal(corrected.claimedProviderUserId, initiator.user.id)
  assert.equal(readEnrollmentContact(corrected).email, initiator.email)
  assert.equal(corrected.workspaceId, null)
})

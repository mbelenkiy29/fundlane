import test, { before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import {
  authDatabase,
  activatedEnrollment,
  provider,
  resetAuthProvider,
  liveIdentity,
} from "./helpers/onboarding-auth"
import { getDatabase, newId, nowIso } from "../src/lib/mca/db"
import { findEnrollment } from "../src/lib/mca/onboarding/store"
import { linkSupabaseUser } from "../src/lib/mca/supabase-auth"

let close: () => Promise<void>
before(async () => {
  close = await authDatabase("enrollment_claim")
})
after(async () => {
  await close?.()
})
beforeEach(resetAuthProvider)
async function claim(f: Awaited<ReturnType<typeof activatedEnrollment>>) {
  const { claimEnrollment } = await import("../src/lib/mca/onboarding/claim")
  return claimEnrollment({ enrollmentId: f.id, identity: f.identity }, f.client)
}
test("a verified matching email without a live session cannot claim", async () => {
  const f = await activatedEnrollment()
  await getDatabase().execute("DELETE FROM auth.sessions WHERE id=?", [
    f.identity.sessionId,
  ])
  await assert.rejects(claim(f), { code: "authentication_required" })
  assert.equal((await findEnrollment(f.id))?.workspaceId, null)
})
test("claim atomically creates one owner, company, billing and SMS grant and same-owner retries converge", async () => {
  const f = await activatedEnrollment()
  const a = await claim(f),
    b = await claim(f)
  assert.deepEqual(a, b)
  const row = (await findEnrollment(f.id))!
  assert.equal(row.claimState, "claimed")
  assert.equal(row.claimedProviderUserId, f.identity.user.id)
  assert.equal(row.trialEndsAt, f.row.trialEndsAt)
  for (const table of [
    "workspace_owners",
    "memberships",
    "workspace_stripe_customers",
    "sms_companies",
  ]) {
    assert.equal(
      (
        await getDatabase().queryOne<{ count: number }>(
          `SELECT count(*)::int count FROM ${table} WHERE workspace_id=?`,
          [a.workspaceId]
        )
      )?.count,
      1
    )
  }
  assert.deepEqual(
    await getDatabase().queryOne(
      "SELECT trial_started_at,trial_ends_at FROM company_subscription_state WHERE workspace_id=?",
      [a.workspaceId]
    ),
    { trial_started_at: null, trial_ends_at: null }
  )
})
test("claim rechecks session revocation after provider refresh and rolls back all grants", async () => {
  const f = await activatedEnrollment()
  provider.onGetUser = async () => {
    await getDatabase().execute(
      "INSERT INTO auth_session_revocations(id,revoked_at) VALUES (?,?) ON CONFLICT DO NOTHING",
      [f.identity.sessionId, nowIso()]
    )
  }
  await assert.rejects(claim(f), { code: "authentication_required" })
  assert.equal((await findEnrollment(f.id))?.workspaceId, null)
})
test("wrong Google email, banned identity, migration pending and a foreign session cannot claim", async () => {
  const f = await activatedEnrollment()
  const wrong = await liveIdentity("wrong@example.test")
  const { claimEnrollment } = await import("../src/lib/mca/onboarding/claim")
  await assert.rejects(
    claimEnrollment({ enrollmentId: f.id, identity: wrong }, f.client),
    { code: "enrollment_identity_mismatch" }
  )
  provider.current = f.identity
  for (const patch of [
    { banned_until: new Date(Date.now() + 60000).toISOString() },
    { app_metadata: { mca_migration_pending: true } },
  ]) {
    const old = f.identity.user
    f.identity.user = { ...old, ...patch }
    await assert.rejects(claim(f), { code: "authentication_required" })
    f.identity.user = old
  }
  await assert.rejects(
    claimEnrollment(
      { enrollmentId: f.id, identity: { ...f.identity, sessionId: newId() } },
      f.client
    ),
    { code: "authentication_required" }
  )
})
test("email collisions retain historical account and invitation isolation", async () => {
  const f = await activatedEnrollment(),
    id = newId()
  await getDatabase().execute(
    "INSERT INTO users(id,email,password_hash,name,application_identifier,created_at,updated_at) VALUES (?,?,'legacy','Historical',?,?,?)",
    [id, f.identity.email, `MCA-${id}`, nowIso(), nowIso()]
  )
  await assert.rejects(claim(f), { code: "account_migration_required" })
  assert.equal((await findEnrollment(f.id))?.workspaceId, null)
  assert.equal(
    (
      await getDatabase().queryOne<{ supabase_user_id: string | null }>(
        "SELECT supabase_user_id FROM users WHERE id=?",
        [id]
      )
    )?.supabase_user_id,
    null
  )
})
test("required MFA cannot be enabled through a partial tenant grant", async () => {
  const f = await activatedEnrollment(),
    userId = await linkSupabaseUser(f.identity)
  await getDatabase().execute(
    "INSERT INTO user_totp_factors(user_id,status,secret_cipher,created_at,updated_at) VALUES (?,'enabled','synthetic',?,?)",
    [userId, nowIso(), nowIso()]
  )
  await assert.rejects(claim(f), { code: "totp_required" })
  assert.equal((await findEnrollment(f.id))?.workspaceId, null)
  await getDatabase().execute(
    "INSERT INTO auth_session_totp(session_id,user_id,method,verified_at,created_at) VALUES (?,?,'totp',?,?)",
    [f.identity.sessionId, userId, nowIso(), nowIso()]
  )
  assert.ok((await claim(f)).workspaceId)
})
test("faults at tenant boundaries roll back the entire claim, and cookie failure remains resumable", async () => {
  for (const table of [
    "workspaces",
    "memberships",
    "workspace_owners",
    "workspace_stripe_customers",
    "company_subscription_state",
    "workspace_billing_entitlements",
    "company_trial_grants",
    "mca_enrollment_trial_reservations",
    "sms_companies",
    "audit_events",
  ]) {
    const f = await activatedEnrollment(),
      db = getDatabase()
    const before = (await db.queryOne<{ count: number }>(
      "SELECT count(*)::int count FROM workspaces"
    ))!.count
    await db.execute(
      `CREATE FUNCTION test_claim_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic boundary'; END $$`
    )
    await db.execute(
      `CREATE TRIGGER test_claim_fail BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION test_claim_fail()`
    )
    try {
      await assert.rejects(claim(f), /synthetic boundary/)
      assert.equal((await findEnrollment(f.id))?.workspaceId, null)
      assert.equal(
        (await db.queryOne<{ count: number }>(
          "SELECT count(*)::int count FROM workspaces"
        ))!.count,
        before
      )
      assert.equal(
        (await db.queryOne<{ count: number }>(
          "SELECT count(*)::int count FROM workspace_stripe_customers WHERE stripe_customer_id=?",
          [f.row.customerId]
        ))!.count,
        0
      )
    } finally {
      await db.execute(`DROP TRIGGER test_claim_fail ON ${table}`)
      await db.execute("DROP FUNCTION test_claim_fail()")
    }
  }
  const f = await activatedEnrollment()
  provider.failCookie = true
  await assert.rejects(claim(f), /cookie failure/)
  assert.equal((await findEnrollment(f.id))?.claimState, "claimed")
  provider.failCookie = false
  assert.equal(
    (await claim(f)).workspaceId,
    (await findEnrollment(f.id))?.workspaceId
  )
})
test("final enrollment association failure rolls back tenant grants and original billing evidence remains retryable", async () => {
  const f = await activatedEnrollment(),
    db = getDatabase(),
    before = (await db.queryOne<{ count: number }>(
      "SELECT count(*)::int count FROM workspaces"
    ))!.count
  await db.execute(
    "CREATE FUNCTION test_final_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.claim_state='claimed' THEN RAISE EXCEPTION 'synthetic final association'; END IF; RETURN NEW; END $$"
  )
  await db.execute(
    "CREATE TRIGGER test_final_fail BEFORE UPDATE ON mca_enrollments FOR EACH ROW EXECUTE FUNCTION test_final_fail()"
  )
  try {
    await assert.rejects(claim(f), /synthetic final association/)
    assert.equal(
      (await db.queryOne<{ count: number }>(
        "SELECT count(*)::int count FROM workspaces"
      ))!.count,
      before
    )
  } finally {
    await db.execute("DROP TRIGGER test_final_fail ON mca_enrollments")
    await db.execute("DROP FUNCTION test_final_fail()")
  }
  assert.equal((await findEnrollment(f.id))?.trialEndsAt, f.row.trialEndsAt)
  assert.ok((await claim(f)).workspaceId)
})
test("parallel same-owner requests grant one company and competing verified identities cannot replay ownership", async () => {
  const f = await activatedEnrollment()
  const results = await Promise.allSettled([claim(f), claim(f)])
  assert.ok(results.some((result) => result.status === "fulfilled"))
  for (const result of results)
    if (result.status === "rejected")
      assert.ok(
        ["enrollment_busy", "enrollment_evidence_stale"].includes(
          result.reason.code
        ),
        `Unexpected concurrent claim failure: ${String(result.reason.code)}`
      )
  const winner = await claim(f),
    competing = await liveIdentity(f.identity.email)
  const { claimEnrollment } = await import("../src/lib/mca/onboarding/claim")
  await assert.rejects(
    claimEnrollment({ enrollmentId: f.id, identity: competing }, f.client),
    { code: "enrollment_identity_mismatch" }
  )
  assert.equal((await findEnrollment(f.id))?.workspaceId, winner.workspaceId)
})
test("existing operational companies and historical trial grants commit a blocked recovery before narrow compensation", async () => {
  for (const kind of ["company", "trial"] as const) {
    const f = await activatedEnrollment(),
      userId = await linkSupabaseUser(f.identity),
      workspaceId = newId(),
      stamp = nowIso()
    await getDatabase().execute(
      "INSERT INTO workspaces(id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at) VALUES (?,'Existing company','UTC',1,'{}','{}','{}',?,?)",
      [workspaceId, stamp, stamp]
    )
    if (kind === "company") {
      await getDatabase().execute(
        "INSERT INTO memberships(id,workspace_id,user_id,role,status,created_at,updated_at) VALUES (?,?,?,'admin','active',?,?)",
        [newId(), workspaceId, userId, stamp, stamp]
      )
      await getDatabase().execute(
        "INSERT INTO company_subscription_state(workspace_id,legacy_exempt,state_kind,selected_seats,updated_at) VALUES (?,1,'internal_demo',1,?)",
        [workspaceId, stamp]
      )
    } else {
      process.env.MCA_TRIAL_ABUSE_LIMITS_ENABLED = "true"
      await getDatabase().execute(
        "INSERT INTO company_trial_grants(workspace_id,stripe_subscription_id,owner_user_id,owner_email,email_domain,trial_started_at,created_at) VALUES (?,'sub_prior',?,?,'example.test',?,?)",
        [workspaceId, userId, f.identity.email, stamp, stamp]
      )
    }
    try {
      await assert.rejects(claim(f), {
        code:
          kind === "company"
            ? "enrollment_existing_company"
            : "trial_not_eligible",
      })
    } finally {
      delete process.env.MCA_TRIAL_ABUSE_LIMITS_ENABLED
    }
    const row = (await findEnrollment(f.id))!
    assert.equal(row.claimState, "blocked")
    assert.equal(row.workspaceId, null)
    assert.equal(row.recoveryState, "canceled")
    assert.equal(f.state.cancelCalls, 1)
    assert.equal(
      (
        await getDatabase().queryOne<{ count: number }>(
          "SELECT count(*)::int count FROM workspaces WHERE id=?",
          [workspaceId]
        )
      )?.count,
      1
    )
  }
})
test("revocation at the last durable boundary rolls back all tenant grants", async () => {
  const f = await activatedEnrollment(),
    db = getDatabase()
  await db.execute(
    `CREATE FUNCTION test_late_revoke() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO auth_session_revocations(id,revoked_at) VALUES ('${f.identity.sessionId}',now()::text); RETURN NEW; END $$`
  )
  await db.execute(
    "CREATE TRIGGER test_late_revoke AFTER INSERT ON sms_companies FOR EACH ROW EXECUTE FUNCTION test_late_revoke()"
  )
  try {
    await assert.rejects(claim(f), { code: "authentication_required" })
    assert.equal((await findEnrollment(f.id))?.workspaceId, null)
  } finally {
    await db.execute("DROP TRIGGER test_late_revoke ON sms_companies")
    await db.execute("DROP FUNCTION test_late_revoke()")
  }
})

import "./helpers/business-auth"
import test from "node:test"
import assert from "node:assert/strict"
import pg from "pg"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { BATCH, EMAIL, seedBen } from "../scripts/demo/seed-ben"
import { closeDatabaseForTests } from "../src/lib/mca/db"
import { listDealBook } from "../src/lib/mca/deals/book"
import { listPayments } from "../src/lib/mca/accounting/service"
import { listSubmissionDashboard } from "../src/lib/mca/submissions/dashboard"
import type { DealActor } from "../src/lib/mca/deals/schema"

test("Ben seed preserves data, is repeatable, and renders repayment/commission/submission views", async () => {
  const fixture = await createPostgresTestDatabase("ben_seed")
  Object.assign(process.env, fixture.env())
  const client = new pg.Client({ connectionString: fixture.databaseUrl })
  await client.connect()
  const now = "2026-09-16T16:00:00.000Z"
  try {
    await client.query(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
      VALUES ('ben-test','Ben demo test','America/New_York',5,'{"payments":false,"reports":true}','{"payments":true,"deals":true}','{"viewCompanyFinancials":true,"viewPaymentTable":true}',$1,$1)`, [now])
    await client.query(`INSERT INTO users (id,email,name,application_identifier,created_at,updated_at) VALUES ('ben-user',$1,'Ben','APP-BEN',$2,$2)`, [EMAIL, now])
    await client.query(`INSERT INTO memberships (id,user_id,workspace_id,role,status,created_at,updated_at) VALUES ('ben-member','ben-user','ben-test','admin','active',$1,$1)`, [now])
    await client.query(`INSERT INTO deals (id,workspace_id,display_id,legal_name,status,draft_state,missing_required_json,field_sources_json,created_at,updated_at)
      VALUES ('existing','ben-test','EXISTING','Preserve me','new_application','partial','[]','{}',$1,$1)`, [now])
    const before = (await client.query("SELECT * FROM deals WHERE id='existing'")).rows
    await assert.rejects(seedBen(client, { apply: true, expectedWorkspace: "wrong" }), /Unexpected destination/)
    const dry = await seedBen(client, { expectedWorkspace: "ben-test", asOf: "2026-09-16" })
    assert.equal(dry.mode, "dry-run")
    assert.equal((await client.query("SELECT count(*)::int count FROM deals")).rows[0].count, 1)
    const first = await seedBen(client, { apply: true, expectedWorkspace: "ben-test", asOf: "2026-09-16" })
    assert.equal(first.mode, "created")
    assert.deepEqual(JSON.parse((await client.query("SELECT feature_flags FROM workspaces WHERE id='ben-test'")).rows[0].feature_flags), { payments: true, reports: true })
    const replay = await seedBen(client, { apply: true, expectedWorkspace: "ben-test", asOf: "2026-10-01" })
    assert.equal(replay.mode, "existing")
    assert.deepEqual(replay.manifest.ids, first.manifest.ids)
    assert.equal(replay.manifest.asOf, "2026-09-16")
    assert.deepEqual((await client.query("SELECT * FROM deals WHERE id='existing'")).rows, before)
    const actor: DealActor = { workspaceId: "ben-test", userId: "ben-user", membershipId: "ben-member", role: "admin", source: "user", activeMembershipIds: ["ben-member"], managedMembershipIds: [], correlationId: BATCH }
    const book = await listDealBook(actor, { asOf: now, search: "TEST" })
    assert.equal(book.total, 80)
    assert.equal(book.rows.filter(r => r.servicingStatus === "paid_off" && r.paidDownBasisPoints === 10000 && r.balanceRemainingCents === 0).length, 20)
    assert.equal(book.rows.filter(r => r.paidDownBasisPoints === 5000 && !r.paidDownEstimated).length, 20)
    assert.equal(book.rows.filter(r => r.paidDownBasisPoints === 0).length, 10)
    assert.ok(book.rows.every(r => r.assignedRep === "Ben"))
    const payments = await listPayments(actor, {}, true)
    assert.equal(payments.payments.length, 80)
    assert.equal(payments.payments.filter(p => p.status === "partial" && p.receivedAmountCents * 2 === p.expectedAmountCents).length, 30)
    assert.equal(payments.totals!.expectedCents, payments.totals!.collectedCents + payments.totals!.outstandingCents)
    const submissions = await listSubmissionDashboard(actor, new URLSearchParams("q=TEST"))
    assert.equal(submissions.total, 180)
    for (const table of ["mca_submission_jobs", "mca_submission_outbox"]) assert.equal((await client.query(`SELECT count(*)::int count FROM ${table}`)).rows[0].count, 0)
    assert.equal((await client.query("SELECT count(*)::int count FROM audit_events WHERE resource_id=$1", [BATCH])).rows[0].count, 1)
  } finally { await client.end(); await closeDatabaseForTests(); await fixture.close() }
})

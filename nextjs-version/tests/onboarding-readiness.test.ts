import './helpers/business-auth'
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createPostgresTestDatabase } from './helpers/postgres-test-db.mjs'
import { getDatabase, closeDatabaseForTests, nowIso } from '../src/lib/mca/db'
import { createWorkspaceWithAdmin } from '../src/lib/mca/workspaces'
import type { DealActor } from '../src/lib/mca/deals/schema'
import { createSender, testSend, getSender, setSenderDeliveryFetchForTests, updateSender } from '../src/lib/mca/senders/service'
import * as senderService from '../src/lib/mca/senders/service'
import { saveBusinessBasics } from '../src/lib/mca/onboarding/business-profile'
import { onboardingStatus, profileSchema } from '../src/lib/mca/sms/onboarding'
import * as sms from '../src/lib/mca/sms/onboarding'
let readiness: typeof import('../src/lib/mca/onboarding/readiness') | undefined
let fixture: Awaited<ReturnType<typeof createPostgresTestDatabase>>
const prior = { ...process.env }; let serial = 0
async function owner() { const c = await createWorkspaceWithAdmin({ workspaceName: 'Readiness Company', adminName: 'Owner', adminEmail: `ready-${++serial}@example.test`, password: 'SyntheticPassword123', role: 'admin' }); return { ...c, source: 'user', role: 'admin', sessionId: 'verified-session', managedMembershipIds: [], activeMembershipIds: [c.membershipId], correlationId: 'readiness-test' } as DealActor }
async function sender(actor: DealActor) { return createSender(actor, { provider: 'smtp', purpose: 'submission', fromName: 'Test Sender', fromAddress: 'owner@example.test', smtp: { host: 'smtp.example.test', port: 587, username: 'synthetic', password: 'synthetic-secret' } }) }
const input = (requestKey: string) => ({ to: 'owner@example.test', recipientControlConfirmed: true as const, requestKey })
before(async () => { readiness = await import('../src/lib/mca/onboarding/readiness').catch(() => undefined); fixture = await createPostgresTestDatabase('onboarding_readiness'); Object.assign(process.env, fixture.env({ MCA_DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64url') })) })
after(async () => { setSenderDeliveryFetchForTests(); await closeDatabaseForTests(); await fixture?.close(); for (const k of Object.keys(process.env)) if (!(k in prior)) delete process.env[k]; Object.assign(process.env, prior) })

test('readiness is observational and business basics are supplied without granting SMS registration', async () => {
  assert.ok(readiness?.getOnboardingReadiness)
  const actor = await owner()
  assert.deepEqual(await readiness.getOnboardingReadiness(actor), { businessDetails: 'missing', sender: 'missing', defaultSender: false, safeSubmission: 'unavailable', trialEndsAt: null })
  await saveBusinessBasics(actor, { legalName: 'Supplied Company', ein: '123456789', expectedRevision: 0 })
  assert.equal((await readiness.getOnboardingReadiness(actor)).businessDetails, 'supplied')
  const db = getDatabase()
  for (const table of ['deals', 'mca_funders', 'mca_submission_jobs', 'sms_companies', 'mca_sender_test_runs']) assert.equal((await db.prepare<{ count: number }>(`SELECT count(*)::int count FROM ${table} WHERE workspace_id=?`).get(actor.workspaceId))?.count, 0)
})
test('sender preview is durable and never marks the sender verified or receipt confirmed', async () => {
  const actor = await owner(), s = await sender(actor)
  const result = await testSend(actor, s.id, input('preview-1'))
  assert.equal(result.delivery, 'preview'); assert.equal((await getSender(actor, s.id)).state, 'pending')
  assert.ok(readiness?.getOnboardingReadiness)
  assert.equal((await readiness.getOnboardingReadiness(actor)).sender, 'preview')
  const rows = await getDatabase().prepare<{ state: string; recipient_cipher: string; received_at: string | null }>('SELECT state,recipient_cipher,received_at FROM mca_sender_test_runs WHERE workspace_id=?').all(actor.workspaceId)
  assert.equal(rows.length, 1); assert.equal(rows[0].state, 'preview'); assert.equal(rows[0].received_at, null); assert.doesNotMatch(rows[0].recipient_cipher, /owner@example/)
})
test('explicit own-recipient confirmation and request key are required before any test send', async () => {
  const actor = await owner(), s = await sender(actor)
  for (const bad of [{ to: 'owner@example.test' }, { ...input('invalid-1'), recipientControlConfirmed: false }, { ...input('invalid-2'), to: '' }]) await assert.rejects(() => testSend(actor, s.id, bad), { code: 'validation_failed' })
  assert.equal((await getDatabase().prepare<{ count: number }>('SELECT count(*)::int count FROM mca_sender_test_runs WHERE workspace_id=?').get(actor.workspaceId))?.count, 0)
})
test('provider acceptance is idempotent durable evidence separate from explicit customer receipt', async () => {
  const actor = await owner(), s = await sender(actor); let calls = 0
  process.env.MCA_EMAIL_WEBHOOK_URL = 'https://synthetic.example.test/mail'
  setSenderDeliveryFetchForTests(async () => { calls++; return new Response('ok', { status: 202 }) })
  const [a, b] = await Promise.all([testSend(actor, s.id, input('accepted-1')), testSend(actor, s.id, input('accepted-1'))])
  assert.equal(calls, 1); assert.equal(a.correlationId, b.correlationId)
  assert.ok(readiness?.getOnboardingReadiness); assert.equal((await readiness.getOnboardingReadiness(actor)).sender, 'accepted')
  assert.ok(senderService.confirmSenderTestReceipt)
  const row = await getDatabase().prepare<{ id: string; received_at: string | null }>('SELECT id,received_at FROM mca_sender_test_runs WHERE workspace_id=?').get(actor.workspaceId)
  assert.ok(row); assert.equal(row.received_at, null)
  const other = await owner()
  await assert.rejects(() => senderService.confirmSenderTestReceipt(other, s.id, row.id, { received: true }), { code: 'permission_denied' })
  await senderService.confirmSenderTestReceipt(actor, s.id, row.id, { received: true })
  assert.equal(calls, 1); assert.equal((await readiness.getOnboardingReadiness(actor)).sender, 'received')
  assert.equal((await getDatabase().prepare<{ evidence_source: string }>('SELECT evidence_source FROM mca_sender_test_runs WHERE id=?').get(row.id))?.evidence_source, 'user_confirmed')
  await updateSender(actor, s.id, { smtp: { password: 'replacement-secret' } })
  assert.equal((await readiness.getOnboardingReadiness(actor)).sender, 'configured')
  delete process.env.MCA_EMAIL_WEBHOOK_URL
})
test('uncertain timeout holds the attempt and blocks automatic or new-key resend', async () => {
  const actor = await owner(), s = await sender(actor); let calls = 0
  process.env.MCA_EMAIL_WEBHOOK_URL = 'https://synthetic.example.test/mail'
  setSenderDeliveryFetchForTests(async () => { calls++; throw new Error('timeout') })
  const first = await testSend(actor, s.id, input('uncertain-1'))
  assert.equal(first.delivery, 'uncertain')
  assert.equal((await testSend(actor, s.id, input('uncertain-1'))).delivery, 'uncertain')
  await assert.rejects(() => testSend(actor, s.id, input('uncertain-2')), { code: 'sender_test_uncertain' })
  assert.equal(calls, 1)
  delete process.env.MCA_EMAIL_WEBHOOK_URL
})

test('expired in-flight evidence is uncertain and resumable through explicit receipt without resend', async () => {
  const actor = await owner(), s = await sender(actor)
  let calls = 0
  process.env.MCA_EMAIL_WEBHOOK_URL = 'https://synthetic.example.test/mail'
  setSenderDeliveryFetchForTests(async () => { calls++; return new Response('ok', { status: 202 }) })
  try {
    const result = await testSend(actor, s.id, input('crashed-claim-test'))
    // Model a crash after the provider attempt, before durable completion.
    await getDatabase().prepare("UPDATE mca_sender_test_runs SET state='sending',accepted_at=NULL,claim_token='synthetic-crashed-claim',lease_until='2000-01-01T00:00:00.000Z' WHERE id=?").run(result.testId)
    const evidence = (await senderService.listSenders(actor)).senders[0].testEvidence
    assert.equal(evidence?.state, 'uncertain')
    assert.equal(evidence?.canConfirm, true)
    await senderService.confirmSenderTestReceipt(actor, s.id, result.testId!, { received: true })
    assert.equal(calls, 1)
    assert.equal((await senderService.listSenders(actor)).senders[0].testEvidence?.state, 'received')
    assert.equal((await getDatabase().prepare<{ claim_token: string | null }>('SELECT claim_token FROM mca_sender_test_runs WHERE id=?').get(result.testId))?.claim_token, null)
  } finally { delete process.env.MCA_EMAIL_WEBHOOK_URL }
})
test('SMS routine status masks stored EIN and full-form composition requires all registration fields', async () => {
  const actor = await owner(); await saveBusinessBasics(actor, { legalName: 'Full Company', ein: '123456789', expectedRevision: 0 })
  assert.ok(sms.resolveFullBusinessProfile)
  await assert.rejects(() => sms.resolveFullBusinessProfile(actor, { legalName: 'Full Company' }, { useStoredEin: true, basicRevision: 1 }), { code: 'validation_failed' })
  await assert.rejects(() => sms.resolveFullBusinessProfile(actor, {}, { useStoredEin: true, basicRevision: 0 }), { code: 'business_revision_conflict' })
  const full = { businessType: 'Corporation', contactPosition: 'CEO', contactTitle: 'CEO', legalName: 'Full Company', street: '123 Main Street', city: 'New York', region: 'NY', postalCode: '10001', website: 'https://example.test', contactFirstName: 'Test', contactLastName: 'Owner', contactEmail: 'owner@example.test', contactPhone: '+12125551234', purpose: 'Application updates requested by customers only.', samples: ['Your application has been received.', 'Your application is ready for review.'], consentEvidence: 'Customers request application updates on our first-party form.', privacyUrl: 'https://example.test/privacy', termsUrl: 'https://example.test/terms', applicationUpdatesOnly: true }
  const composed = await sms.resolveFullBusinessProfile(actor, full, { useStoredEin: true, basicRevision: 1 })
  assert.equal(profileSchema.parse(composed).ein, '123456789')
  const now = nowIso(); await sms.ensureCompany(actor); await getDatabase().prepare('UPDATE sms_companies SET profile_cipher=?,email_verified_at=? WHERE workspace_id=?').run((await import('../src/lib/mca/crypto')).encryptSensitive(JSON.stringify(composed), actor.workspaceId), now, actor.workspaceId)
  assert.doesNotMatch(JSON.stringify(await onboardingStatus(actor)), /123456789/)
})

test('acceptance for the old configuration cannot verify newly replaced credentials', async () => {
  const actor = await owner(), s = await sender(actor)
  process.env.MCA_EMAIL_WEBHOOK_URL = 'https://synthetic.example.test/mail'
  setSenderDeliveryFetchForTests(async () => { await updateSender(actor, s.id, { smtp: { password: 'new-credentials-during-send' } }); return new Response('ok', { status: 202 }) })
  await testSend(actor, s.id, input('changed-during-send'))
  assert.equal((await getSender(actor, s.id)).state, 'pending')
  assert.ok(readiness?.getOnboardingReadiness); assert.equal((await readiness.getOnboardingReadiness(actor)).sender, 'configured')
  delete process.env.MCA_EMAIL_WEBHOOK_URL
})

test('acceptance for the old transport cannot verify a changed deployment mail transport', async () => {
  const actor = await owner(), s = await sender(actor)
  process.env.MCA_EMAIL_WEBHOOK_URL = 'https://synthetic.example.test/mail'
  setSenderDeliveryFetchForTests(async () => {
    process.env.MCA_EMAIL_WEBHOOK_URL = 'https://replacement.example.test/mail'
    return new Response('ok', { status: 202 })
  })
  try {
    await testSend(actor, s.id, input('changed-transport-during-send'))
    assert.equal((await getSender(actor, s.id)).state, 'pending')
    assert.ok(readiness?.getOnboardingReadiness)
    assert.equal((await readiness.getOnboardingReadiness(actor)).sender, 'configured')
  } finally { delete process.env.MCA_EMAIL_WEBHOOK_URL }
})

test('safe submission readiness needs ready synthetic documents and an actual sandbox route, and only sandbox transport counts as accepted', async () => {
  assert.ok(readiness?.getOnboardingReadiness)
  const actor = await owner(), db = getDatabase(), now = nowIso(), dealId = `safe-deal-${serial}`, funderId = `safe-funder-${serial}`
  await db.prepare("INSERT INTO deals(id,workspace_id,display_id,legal_name,status,pipeline_version,draft_state,missing_required_json,field_sources_json,version,created_at,updated_at) VALUES (?,?,?,'[SYNTHETIC] Readiness Merchant','lead',1,'submission_ready','[]','{}',1,?,?)").run(dealId, actor.workspaceId, `SAFE-${serial}`, now, now)
  await db.prepare("INSERT INTO mca_funders(id,workspace_id,idempotency_key,legal_name,active,routes,created_at,updated_at) VALUES (?,?,'fundlane-sandbox-funder','Sandbox',1,?, ?,?)").run(funderId, actor.workspaceId, JSON.stringify([{ id: 'safe-route', kind: 'api', destination: 'fundlane-sandbox', active: true, documentExceptions: [] }]), now, now)
  assert.equal((await readiness.getOnboardingReadiness(actor)).safeSubmission, 'unavailable')
  await db.prepare("INSERT INTO mca_documents(id,workspace_id,deal_id,idempotency_key,original_filename,display_filename,mime_type,byte_length,checksum,category,version,storage_key,source,processing_state,created_at,updated_at) VALUES (?,?,?,'safe-doc','statement.pdf','statement.pdf','application/pdf',1,'synthetic-checksum','bank_statement',1,?,'upload','ready',?,?)").run(`safe-doc-${serial}`, actor.workspaceId, dealId, `safe-doc-${serial}`, now, now)
  assert.equal((await readiness.getOnboardingReadiness(actor)).safeSubmission, 'ready')
  await db.prepare("UPDATE mca_funders SET routes='[]' WHERE id=?").run(funderId)
  assert.equal((await readiness.getOnboardingReadiness(actor)).safeSubmission, 'unavailable')
  await db.prepare("INSERT INTO mca_submission_jobs(id,workspace_id,deal_id,funder_id,display_funder_name,route_kind,route_json,state,confirmation_key,attempt_key,deal_version,document_versions_json,package_json,preflight_errors_json,created_at,updated_at) VALUES (?,?,?,?,'Sandbox','api','{}','sent','safe-confirm','safe-attempt',1,'{}','{}','[]',?,?)").run(`safe-job-${serial}`, actor.workspaceId, dealId, funderId, now, now)
  assert.equal((await readiness.getOnboardingReadiness(actor)).safeSubmission, 'unavailable')
  await db.prepare('UPDATE mca_submission_jobs SET route_json=? WHERE id=?').run(JSON.stringify({ kind: 'api', destination: 'fundlane-sandbox' }), `safe-job-${serial}`)
  assert.equal((await readiness.getOnboardingReadiness(actor)).safeSubmission, 'accepted')
})

test('membership revoked while a test waits for the sender lock cannot acquire a send claim', async () => {
  const actor = await owner(), s = await sender(actor)
  let acquired!: () => void, started!: () => void
  const locked = new Promise<void>(resolve => { acquired = resolve }), pendingStarted = new Promise<void>(resolve => { started = resolve })
  const holder = (await import('../src/lib/mca/db')).withTransaction(async db => {
    await db.prepare('SELECT id FROM mca_email_senders WHERE id=? FOR UPDATE').get(s.id)
    acquired(); await pendingStarted
    let waiting = false
    for (let i = 0; i < 100; i++) {
      // A separate autocommit connection avoids PostgreSQL's cached statistics
      // snapshot in the transaction holding the sender lock.
      const result = await fixture.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%mca_email_senders%') waiting")
      if (result.rows[0]?.waiting) { waiting = true; break }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(waiting, true, 'sender action must wait behind the configuration lock')
    await db.prepare("UPDATE memberships SET status='deactivated' WHERE id=?").run(actor.membershipId)
  })
  await locked
  const pending = testSend(actor, s.id, input('revoked-while-waiting'))
  const rejection = assert.rejects(pending, { code: 'permission_denied' })
  started()
  try { await Promise.all([holder, rejection]) }
  finally { await Promise.allSettled([holder, pending, rejection]) }
  assert.equal((await getDatabase().prepare<{ count: number }>('SELECT count(*)::int count FROM mca_sender_test_runs WHERE workspace_id=?').get(actor.workspaceId))?.count, 0)
})

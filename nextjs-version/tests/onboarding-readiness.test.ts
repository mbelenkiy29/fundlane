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
import { createDeal } from '../src/lib/mca/deals/service'
import { setSandboxFunderEnabled } from '../src/lib/mca/sandbox/service'
import { checkCompleteness } from '../src/lib/mca/underwriting/completeness'
import { closedLookbackMonths, setUnderwritingNowForTests } from '../src/lib/mca/underwriting/lookback'
import { queueSubmissions } from '../src/lib/mca/submissions/queue'
import { setAutoSubmitSettings } from '../src/lib/mca/underwriting/auto-submit'
import { onboardingStatus, profileSchema } from '../src/lib/mca/sms/onboarding'
import * as sms from '../src/lib/mca/sms/onboarding'
let readiness: typeof import('../src/lib/mca/onboarding/readiness') | undefined
let fixture: Awaited<ReturnType<typeof createPostgresTestDatabase>>
const prior = { ...process.env }; let serial = 0
async function owner() { const c = await createWorkspaceWithAdmin({ workspaceName: 'Readiness Company', adminName: 'Owner', adminEmail: `ready-${++serial}@example.test`, password: 'SyntheticPassword123', role: 'admin' }); return { ...c, source: 'user', role: 'admin', sessionId: 'verified-session', managedMembershipIds: [], activeMembershipIds: [c.membershipId], correlationId: 'readiness-test' } as DealActor }
async function sender(actor: DealActor) { return createSender(actor, { provider: 'smtp', purpose: 'submission', fromName: 'Test Sender', fromAddress: 'owner@example.test', smtp: { host: 'smtp.example.test', port: 587, username: 'synthetic', password: 'synthetic-secret' } }) }
const input = (requestKey: string) => ({ to: 'owner@example.test', recipientControlConfirmed: true as const, requestKey })
async function safeFixture() {
  const actor = await owner()
  const { deal } = await createDeal(actor, { idempotencyKey: `readiness-synthetic-${serial}`, legalName: '[SYNTHETIC] Readiness Merchant', entityType: 'llc', address: { line1: '100 Test Road', city: 'New York', state: 'NY', postalCode: '10001' }, contactPhone: '+12125551234', owners: [{ firstName: 'Test', lastName: 'Owner', ownershipPercent: 100 }], startDate: '2020-01-01', industry: 'restaurants', monthlyRevenue: 20000, requestedAmount: 50000, fundingPurpose: 'working capital' })
  assert.equal(deal.draftState, 'submission_ready')
  const { funder } = await setSandboxFunderEnabled(actor, true)
  assert.ok(funder)
  return { actor, dealId: deal.id, funderId: funder.id }
}
async function readyDocument(actor: DealActor, dealId: string, category: string, filename = `${category}.pdf`) {
  const id = `readiness-doc-${++serial}`, now = nowIso()
  await getDatabase().prepare("INSERT INTO mca_documents(id,workspace_id,deal_id,idempotency_key,original_filename,display_filename,mime_type,byte_length,checksum,category,version,storage_key,source,processing_state,created_at,updated_at) VALUES (?,?,?,?,?,?,'application/pdf',1,?,?,1,?,'upload','ready',?,?)").run(id, actor.workspaceId, dealId, id, filename, filename, `checksum-${id}`, category, id, now, now)
  return id
}
async function completeDocuments(actor: DealActor, dealId: string) {
  const application = await readyDocument(actor, dealId, 'application')
  await readyDocument(actor, dealId, 'driver_license'); await readyDocument(actor, dealId, 'voided_check')
  for (const period of closedLookbackMonths(3, 'America/New_York')) {
    const id = await readyDocument(actor, dealId, 'statement', `statement-${period}.pdf`), now = nowIso()
    await getDatabase().prepare("INSERT INTO mca_statement_months(id,workspace_id,deal_id,document_id,account_kind,period,deposits,deposit_count,average_daily_balance,nsf_count,negative_days,ending_balance,extraction_version,created_at,updated_at) VALUES (?,?,?,?,'checking',?,'0','0','0','0','0','0',1,?,?)").run(`month-${id}`, actor.workspaceId, dealId, id, period, now, now)
  }
  return { application }
}
before(async () => { readiness = await import('../src/lib/mca/onboarding/readiness').catch(() => undefined); fixture = await createPostgresTestDatabase('onboarding_readiness'); Object.assign(process.env, fixture.env({ MCA_DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64url') })) })
after(async () => { setSenderDeliveryFetchForTests(); setUnderwritingNowForTests(); await closeDatabaseForTests(); await fixture?.close(); for (const k of Object.keys(process.env)) if (!(k in prior)) delete process.env[k]; Object.assign(process.env, prior) })

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

test('choosing a tested sender as default preserves its controlled-inbox evidence', async () => {
  const actor = await owner(), s = await sender(actor)
  process.env.MCA_EMAIL_WEBHOOK_URL = 'https://synthetic.example.test/mail'
  setSenderDeliveryFetchForTests(async () => new Response('ok', { status: 202 }))
  try {
    const result = await testSend(actor, s.id, input('test-before-default'))
    await senderService.confirmSenderTestReceipt(actor, s.id, result.testId!, { received: true })
    await updateSender(actor, s.id, { isDefault: true })
    assert.equal((await senderService.listSenders(actor)).senders[0].testEvidence?.state, 'received')
  } finally { delete process.env.MCA_EMAIL_WEBHOOK_URL }
})

test('Postmark evidence follows selected token and effective stream rotations only', async () => {
  const actor = await owner(), s = await sender(actor)
  const connection = { workspaceId: actor.workspaceId, senderId: s.id, fromAddress: s.fromAddress, serverToken: 'synthetic-token-a', messageStream: 'transactional-a' }
  let unrelated = { workspaceId: 'unrelated-workspace', senderId: 'unrelated-sender', fromAddress: 'unrelated@example.test', serverToken: 'unrelated-token' }
  const configure = (selected: object) => { process.env.MCA_CLOSING_POSTMARK_CONNECTIONS_JSON = JSON.stringify([selected, unrelated]) }
  process.env.MCA_CLOSING_EMAIL_PROVIDER = 'postmark'
  setSenderDeliveryFetchForTests(async () => Response.json({ ErrorCode: 0, MessageID: 'synthetic-postmark-message' }))
  try {
    configure(connection)
    const sent = await testSend(actor, s.id, input('postmark-original'))
    await senderService.confirmSenderTestReceipt(actor, s.id, sent.testId!, { received: true })
    unrelated = { ...unrelated, serverToken: 'unrelated-rotation' }; configure(connection)
    assert.equal((await senderService.listSenders(actor)).senders[0].testEvidence?.state, 'received')
    process.env.MCA_CLOSING_POSTMARK_MESSAGE_STREAM = 'ignored-fallback'
    assert.equal((await senderService.listSenders(actor)).senders[0].testEvidence?.state, 'received')
    configure({ ...connection, serverToken: 'synthetic-token-b' })
    assert.equal((await senderService.listSenders(actor)).senders[0].testEvidence, undefined)
    await assert.rejects(() => senderService.confirmSenderTestReceipt(actor, s.id, sent.testId!, { received: true }), { code: 'sender_connection_changed' })
    configure({ ...connection, messageStream: 'transactional-b' })
    assert.equal((await senderService.listSenders(actor)).senders[0].testEvidence, undefined)
    const { messageStream: explicitStream, ...fallbackConnection } = connection
    assert.ok(explicitStream)
    configure(fallbackConnection)
    const fallback = await testSend(actor, s.id, input('postmark-fallback'))
    assert.equal(fallback.evidence, 'accepted')
    process.env.MCA_CLOSING_POSTMARK_MESSAGE_STREAM = 'rotated-fallback'
    assert.equal((await senderService.listSenders(actor)).senders[0].testEvidence, undefined)
  } finally {
    delete process.env.MCA_CLOSING_EMAIL_PROVIDER; delete process.env.MCA_CLOSING_POSTMARK_CONNECTIONS_JSON; delete process.env.MCA_CLOSING_POSTMARK_MESSAGE_STREAM
  }
})

test('in-flight Postmark acceptance cannot verify a replacement selected transport', async () => {
  const actor = await owner(), s = await sender(actor)
  const connection = { workspaceId: actor.workspaceId, senderId: s.id, fromAddress: s.fromAddress, serverToken: 'synthetic-before', messageStream: 'before' }
  process.env.MCA_CLOSING_EMAIL_PROVIDER = 'postmark'; process.env.MCA_CLOSING_POSTMARK_CONNECTIONS_JSON = JSON.stringify([connection])
  setSenderDeliveryFetchForTests(async (_url, init) => {
    assert.equal(new Headers(init?.headers).get('x-postmark-server-token'), 'synthetic-before')
    assert.equal(JSON.parse(String(init?.body)).MessageStream, 'before')
    process.env.MCA_CLOSING_POSTMARK_CONNECTIONS_JSON = JSON.stringify([{ ...connection, serverToken: 'synthetic-after', messageStream: 'after' }])
    return Response.json({ ErrorCode: 0, MessageID: 'synthetic-before-message' })
  })
  try {
    const result = await testSend(actor, s.id, input('postmark-inflight'))
    assert.equal(result.evidence, 'accepted')
    assert.equal((await getSender(actor, s.id)).state, 'pending')
    assert.equal((await senderService.listSenders(actor)).senders[0].testEvidence, undefined)
  } finally { delete process.env.MCA_CLOSING_EMAIL_PROVIDER; delete process.env.MCA_CLOSING_POSTMARK_CONNECTIONS_JSON }
})

test('safe submission readiness rejects one bank statement and only frozen sandbox transport counts as accepted', async () => {
  assert.ok(readiness?.getOnboardingReadiness)
  const actor = await owner(), db = getDatabase(), now = nowIso(), dealId = `safe-deal-${serial}`, funderId = `safe-funder-${serial}`
  await db.prepare("INSERT INTO deals(id,workspace_id,display_id,legal_name,status,pipeline_version,draft_state,missing_required_json,field_sources_json,version,created_at,updated_at) VALUES (?,?,?,'[SYNTHETIC] Readiness Merchant','lead',1,'submission_ready','[]','{}',1,?,?)").run(dealId, actor.workspaceId, `SAFE-${serial}`, now, now)
  await db.prepare("INSERT INTO mca_funders(id,workspace_id,idempotency_key,legal_name,active,routes,created_at,updated_at) VALUES (?,?,'fundlane-sandbox-funder','Sandbox',1,?, ?,?)").run(funderId, actor.workspaceId, JSON.stringify([{ id: 'safe-route', kind: 'api', destination: 'fundlane-sandbox', active: true, documentExceptions: [] }]), now, now)
  assert.equal((await readiness.getOnboardingReadiness(actor)).safeSubmission, 'unavailable')
  await db.prepare("INSERT INTO mca_documents(id,workspace_id,deal_id,idempotency_key,original_filename,display_filename,mime_type,byte_length,checksum,category,version,storage_key,source,processing_state,created_at,updated_at) VALUES (?,?,?,'safe-doc','statement.pdf','statement.pdf','application/pdf',1,'synthetic-checksum','bank_statement',1,?,'upload','ready',?,?)").run(`safe-doc-${serial}`, actor.workspaceId, dealId, `safe-doc-${serial}`, now, now)
  assert.equal((await readiness.getOnboardingReadiness(actor)).safeSubmission, 'unavailable')
  await db.prepare("UPDATE mca_funders SET routes='[]' WHERE id=?").run(funderId)
  assert.equal((await readiness.getOnboardingReadiness(actor)).safeSubmission, 'unavailable')
  await db.prepare("INSERT INTO mca_submission_jobs(id,workspace_id,deal_id,funder_id,display_funder_name,route_kind,route_json,state,confirmation_key,attempt_key,deal_version,document_versions_json,package_json,preflight_errors_json,created_at,updated_at) VALUES (?,?,?,?,'Sandbox','api','{}','sent','safe-confirm','safe-attempt',1,'{}','{}','[]',?,?)").run(`safe-job-${serial}`, actor.workspaceId, dealId, funderId, now, now)
  assert.equal((await readiness.getOnboardingReadiness(actor)).safeSubmission, 'unavailable')
  await db.prepare('UPDATE mca_submission_jobs SET route_json=? WHERE id=?').run(JSON.stringify({ kind: 'api', destination: 'fundlane-sandbox' }), `safe-job-${serial}`)
  assert.equal((await readiness.getOnboardingReadiness(actor)).safeSubmission, 'accepted')
})

test('safe submission positive prerequisites pass ordinary explicit sandbox queue checks without a test bypass', async () => {
  assert.ok(readiness?.getOnboardingReadiness)
  const { actor, dealId, funderId } = await safeFixture()
  await completeDocuments(actor, dealId)
  assert.equal((await readiness.getOnboardingReadiness(actor)).safeSubmission, 'ready')
  assert.equal((await getDatabase().prepare<{ count: number }>('SELECT count(*)::int count FROM mca_completeness_results WHERE workspace_id=?').get(actor.workspaceId))?.count, 0)
  const result = await queueSubmissions({ actor, dealId, funderIds: [funderId], confirmationKey: `safe-explicit-${serial}`, deferDelivery: true })
  assert.equal(result.jobs.length, 1); assert.equal(result.jobs[0].state, 'queued')
})

test('read-only readiness never enqueues auto-submit while the explicit completeness writer retains events and automatic enqueue', async () => {
  assert.ok(readiness?.getOnboardingReadiness)
  const { actor, dealId, funderId } = await safeFixture(), db = getDatabase()
  await completeDocuments(actor, dealId)
  process.env.MCA_AUTO_SUBMIT_ENABLED = 'true'
  try {
    await setAutoSubmitSettings(actor, { mode: 'score_only', minMatchScore: 80, maxFundersPerDeal: 3, eligibleFunderIds: [funderId] })
    assert.equal((await readiness.getOnboardingReadiness(actor)).safeSubmission, 'ready')
    for (const table of ['mca_completeness_results', 'mca_readiness_events', 'mca_background_jobs', 'mca_submission_jobs']) assert.equal((await db.prepare<{ count: number }>(`SELECT count(*)::int count FROM ${table} WHERE workspace_id=?`).get(actor.workspaceId))?.count, 0)
    const checked = await checkCompleteness(actor, dealId)
    assert.equal(checked.ready, true)
    const queued = await db.prepare<{ kind: string; state: string; payload_json: string }>('SELECT kind,state,payload_json FROM mca_background_jobs WHERE workspace_id=?').all(actor.workspaceId)
    assert.equal(queued.length, 1); assert.equal(queued[0].kind, 'auto_submit'); assert.equal(queued[0].state, 'queued')
    assert.equal(JSON.parse(queued[0].payload_json).completenessVersion, checked.version)
    assert.equal((await db.prepare<{ count: number }>('SELECT count(*)::int count FROM mca_readiness_events WHERE workspace_id=?').get(actor.workspaceId))?.count, 1)
    assert.equal((await checkCompleteness(actor, dealId)).version, checked.version)
    assert.equal((await db.prepare<{ count: number }>('SELECT count(*)::int count FROM mca_background_jobs WHERE workspace_id=?').get(actor.workspaceId))?.count, 1)
    await db.prepare("UPDATE mca_documents SET processing_state='quarantined' WHERE workspace_id=? AND deal_id=? AND category='application'").run(actor.workspaceId, dealId)
    const invalidated = await checkCompleteness(actor, dealId)
    assert.equal(invalidated.ready, false); assert.equal(invalidated.version, checked.version + 1)
    assert.equal((await db.prepare<{ count: number }>('SELECT count(*)::int count FROM mca_background_jobs WHERE workspace_id=?').get(actor.workspaceId))?.count, 1)
  } finally { delete process.env.MCA_AUTO_SUBMIT_ENABLED }
})

for (const invalidation of ['quarantined application', 'deleted month extraction', 'changed month window', 'proposed position'] as const) test(`safe submission readiness rejects stale completeness after ${invalidation} without GET writes`, async () => {
  assert.ok(readiness?.getOnboardingReadiness)
  const { actor, dealId } = await safeFixture()
  setUnderwritingNowForTests(new Date('2026-10-02T12:00:00.000Z'))
  try {
    const { application } = await completeDocuments(actor, dealId)
    assert.equal((await checkCompleteness(actor, dealId)).ready, true)
    const db = getDatabase()
    if (invalidation === 'quarantined application') await db.prepare("UPDATE mca_documents SET processing_state='quarantined' WHERE id=?").run(application)
    if (invalidation === 'deleted month extraction') await db.prepare('DELETE FROM mca_statement_months WHERE workspace_id=? AND deal_id=?').run(actor.workspaceId, dealId)
    if (invalidation === 'changed month window') setUnderwritingNowForTests(new Date('2026-11-02T12:00:00.000Z'))
    if (invalidation === 'proposed position') {
      const now = nowIso()
      await db.prepare("INSERT INTO mca_existing_positions(id,workspace_id,deal_id,label,evidence,status,created_at,updated_at) VALUES (?,?,?,'Synthetic proposed position','fixture','proposed',?,?)").run(`readiness-position-${serial}`, actor.workspaceId, dealId, now, now)
    }
    const tables = ['mca_completeness_results', 'mca_readiness_events', 'audit_events', 'mca_submission_jobs']
    const counts = async () => Promise.all(tables.map(table => db.prepare<{ count: number }>(`SELECT count(*)::int count FROM ${table} WHERE workspace_id=?`).get(actor.workspaceId)))
    const before = await counts()
    assert.equal((await readiness.getOnboardingReadiness(actor)).safeSubmission, 'unavailable')
    assert.deepEqual(await counts(), before)
  } finally { setUnderwritingNowForTests() }
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

import './helpers/business-auth'
import test, { before, beforeEach, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import { createPostgresTestDatabase } from './helpers/postgres-test-db.mjs'
import { getDatabase, closeDatabaseForTests, nowIso } from '../src/lib/mca/db'
import { encryptSensitive, hashOpaqueToken } from '../src/lib/mca/crypto'
import type { DealActor } from '../src/lib/mca/deals/schema'
import { createDeal } from '../src/lib/mca/deals/service'
import { createSmsAccount, deliverClosingSms, recordSmsConsent, processTwilioOptOut, processTwilioStatus, getSmsConsent } from '../src/lib/mca/sms/service'
import { rememberOutbound } from '../src/lib/mca/sms/inbox'
import { SMS_PROVIDERS } from '../src/lib/mca/sms/contracts'
import { getSmsAdapter } from '../src/lib/mca/sms/adapters/registry'
import { smsRecipientHash } from '../src/lib/mca/sms/managed'
import { createTwilioSmsAdapter, twilioSmsAdapter } from '../src/lib/mca/sms/adapters/twilio'
import { POST as messagesPost } from '../src/app/api/mca/sms/messages/route'
import { createStipulation, previewStipulationRequest, sendRequestPreview, previewMerchantOffers, sendMerchantOfferPreview } from '../src/lib/mca/closing/service'
import { createOffer } from '../src/lib/mca/offers/service'
import { enqueueNotification, getNotification, setNotificationPolicy } from '../src/lib/mca/notifications/service'
import { runScheduledNotifications } from '../src/lib/mca/notifications/worker'
import { createMessageTemplate, publishMessageTemplate } from '../src/lib/mca/comms/templates'

let fixture: Awaited<ReturnType<typeof createPostgresTestDatabase>>
const workspaceId = 'stop-proof', phone = '+12125550123', sender = '+12125550999'
const actor: DealActor = { workspaceId, userId: 'stop-user', membershipId: 'stop-member', role: 'admin', source: 'user', managedMembershipIds: [], activeMembershipIds: ['stop-member'], correlationId: 'stop-proof' }
const credentials = { accountSid: `AC${'a'.repeat(32)}`, apiKeySid: `SK${'b'.repeat(32)}`, apiKeySecret: 'synthetic-secret', authToken: 'synthetic-token', allowedSenders: [sender] }
const savedEnv = { ...process.env }
let dealId: string, accountId: string, calls = 0, sequence = 0
const sid = () => `SM${(++sequence).toString(16).padStart(32, '0')}`
const input = (key: string) => ({ dealId, recipient: phone, body: 'Synthetic application update', senderAccountId: accountId, idempotencyKey: key, correlationId: key, payloadHash: key, deliveryMode: 'never_attempted' as const })
async function consent() {
  await recordSmsConsent(actor, { dealId, recipient: phone, state: 'opted_in', evidence: 'Fresh synthetic consent', idempotencyKey: `consent-${++sequence}` })
}
async function inbound(body: string, messageSid = sid(), optOutType?: string) {
  const params = new URLSearchParams({ From: phone, To: sender, Body: body, MessageSid: messageSid, AccountSid: credentials.accountSid })
  if (optOutType) params.set('OptOutType', optOutType)
  const url = `https://sms.example.test/api/mca/sms/webhooks/twilio/${accountId}/inbound`
  return processTwilioOptOut(accountId, params, sign(url, params), url)
}
function sign(url: string, params: URLSearchParams) {
  return createHmac('sha1', credentials.authToken).update(url + [...params].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => k + v).join('')).digest('base64')
}
before(async () => {
  fixture = await createPostgresTestDatabase('sms_stop_proof')
  Object.assign(process.env, fixture.env(), { MCA_DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64url'), MCA_SMS_PROVIDER: 'twilio', MCA_SMS_PUBLIC_BASE_URL: 'https://sms.example.test', MCA_APP_ORIGIN: 'https://sms.example.test', MCA_SMS_TWILIO_ACCOUNTS_JSON: JSON.stringify({ [workspaceId]: { DEFAULT: credentials } }) })
  const db = getDatabase(), now = nowIso()
  await db.prepare(`INSERT INTO workspaces(id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at) VALUES(?,?,'UTC',8,'{"integrations":true}','{"deals":true,"integrations":true}','{"createDeal":true}',?,?)`).run(workspaceId, workspaceId, now, now)
  await db.prepare(`INSERT INTO users(id,email,name,application_identifier,created_at,updated_at) VALUES('stop-user','stop@example.test','Stop','stop',?,?)`).run(now, now)
  await db.prepare(`INSERT INTO memberships(id,workspace_id,user_id,role,status,created_at,updated_at) VALUES('stop-member',?,'stop-user','admin','active',?,?)`).run(workspaceId, now, now)
  await db.prepare(`INSERT INTO sessions(id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at) VALUES('stop-session','stop-user','stop-member',?,'2099-01-01T00:00:00.000Z',?,?)`).run(hashOpaqueToken('stop-session'), now, now)
  dealId = (await createDeal(actor, { idempotencyKey: 'stop-deal', legalName: 'Synthetic Stop LLC', contactPhone: phone, contactEmail: 'stop@example.test' })).deal.id
  accountId = (await createSmsAccount(actor, { label: 'Synthetic sender', senderKind: 'phone_number', senderIdentity: sender, credentialRef: 'DEFAULT', memberIds: ['stop-member'], isDefault: true })).id
  // Exercise the real adapter's credential validation with an in-memory HTTP provider.
  const adapter = createTwilioSmsAdapter({ fetchImpl: async () => { calls++; return Response.json({ sid: sid(), status: 'queued' }, { status: 201 }) } })
  mock.method(twilioSmsAdapter, 'send', adapter.send)
})
beforeEach(async () => {
  const db = getDatabase()
  await db.execute('DROP TRIGGER IF EXISTS change_before_dispatch ON sms_conversations')
  await db.prepare('DELETE FROM sms_suppressions WHERE workspace_id=?').run(workspaceId)
  await db.prepare('DELETE FROM mca_sms_consent_events WHERE workspace_id=?').run(workspaceId)
  await db.prepare('DELETE FROM company_subscription_state WHERE workspace_id=?').run(workspaceId)
  await db.prepare('DELETE FROM mca_notification_receipts WHERE workspace_id=?').run(workspaceId)
  await db.prepare('DELETE FROM mca_notifications WHERE workspace_id=?').run(workspaceId)
  await db.prepare("UPDATE mca_sms_accounts SET provider='twilio',credential_ref='DEFAULT',state='active' WHERE id=?").run(accountId)
  await db.prepare('DELETE FROM sms_numbers WHERE workspace_id=?').run(workspaceId)
  await db.prepare('DELETE FROM sms_companies WHERE workspace_id=?').run(workspaceId)
  process.env.MCA_SMS_TWILIO_ACCOUNTS_JSON = JSON.stringify({ [workspaceId]: { DEFAULT: credentials } })
  await consent()
  calls = 0
})
after(async () => {
  mock.restoreAll()
  await closeDatabaseForTests()
  await fixture?.close()
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
  Object.assign(process.env, savedEnv)
})

for (const path of ['deal composer', 'inbox reply'] as const) test(`${path}: STOP after preview blocks send and retry`, async () => {
  await rememberOutbound(workspaceId, accountId, dealId, phone)
  const conversation = await getDatabase().prepare<{ id: string }>('SELECT id FROM sms_conversations WHERE workspace_id=? AND account_id=? AND recipient_hash=?').get(workspaceId, accountId, smsRecipientHash(workspaceId, phone))
  const post = (preview = false) => messagesPost(new Request('https://sms.example.test/api/mca/sms/messages', { method: 'POST', headers: { cookie: 'mca_session=stop-session', origin: 'https://sms.example.test', 'content-type': 'application/json' }, body: JSON.stringify({ dealId, recipient: phone, senderAccountId: accountId, body: 'Synthetic update', idempotencyKey: `http-${path.replaceAll(' ', '-')}`, preview, ...(path === 'inbox reply' ? { conversationId: conversation!.id } : {}) }) }))
  assert.equal((await (await post(true)).json()).canSend, true)
  await inbound('STOP')
  for (let retry = 0; retry < 2; retry++) {
    const response = await post()
    assert.equal(response.status, 409)
    assert.equal((await response.json()).error.code, 'sms_recipient_opted_out')
  }
  assert.equal(calls, 0)
})

test('merchant offer: STOP after preview blocks send and retry without pitching', async () => {
  const offer = await createOffer(actor, { dealId, funderName: 'Synthetic funder', terms: { amountCents: 100000, factorRate: 1.2, paymentAmountCents: 10000, paymentFrequency: 'weekly' } })
  const preview = await previewMerchantOffers(actor, { dealId, revisionId: offer.currentRevisionId, selectionMode: 'highest', channel: 'sms', senderId: accountId, idempotencyKey: 'stop-offer-preview' })
  await inbound('ordinary provider text', sid(), 'STOP')
  for (const key of ['stop-offer-send', 'stop-offer-retry']) {
    const result = await sendMerchantOfferPreview(actor, preview.id, key)
    assert.equal(result.delivery.errorCode, 'sms_recipient_opted_out')
    assert.equal(result.pitched, false)
  }
  assert.equal(calls, 0)
})

test('legacy stipulation SMS webhook stays disabled after STOP, including retry', async () => {
  process.env.MCA_MERCHANT_SMS_WEBHOOK_URL = 'https://provider.example.test/sms'
  process.env.MCA_MERCHANT_SMS_WEBHOOK_TOKEN = 'synthetic'
  const fetch = mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ id: 'unsafe-send' }) })
  try {
    const stip = await createStipulation(actor, { dealId, documentCategory: 'driver_license', label: 'Synthetic ID', idempotencyKey: 'stop-stip' })
    const preview = await previewStipulationRequest(actor, { dealId, stipulationIds: [stip.id], channel: 'sms', senderId: accountId, origin: 'https://sms.example.test', idempotencyKey: 'stop-stip-preview' })
    await inbound('STOP')
    for (const key of ['stop-stip-send', 'stop-stip-retry']) {
      assert.equal((await sendRequestPreview(actor, preview.id, key)).state, 'blocked')
    }
    assert.equal(calls, 0)
  } finally { fetch.mock.restore() }
})

for (const kind of ['document', 'renewal', 'missed_call'] as const) for (const state of ['queued', 'retry'] as const) test(`${kind} notification ${state}: STOP after scheduling blocks real SMS transport`, async () => {
  process.env.MCA_NOTIFICATION_RUNTIME = 'enabled'
  await setNotificationPolicy(actor, { kind, merchantEnabled: true, brokerEnabled: true })
  const template = await createMessageTemplate(actor, { name: `Stop ${kind} ${state}`, channel: 'sms', scope: 'merchant', body: 'Synthetic document reminder' })
  await publishMessageTemplate(actor, template.id)
  const now = nowIso()
  const row = await enqueueNotification(actor, { eventKey: `stop-${kind}-${state}`, kind, dealId, audience: 'merchant', channel: 'sms', templateId: template.id, scheduledFor: now, approvedAt: now })
  if (state === 'retry') await getDatabase().prepare("UPDATE mca_notifications SET state='retry',attempts=1 WHERE id=?").run(row.id)
  await inbound('STOP')
  await runScheduledNotifications(now, 1)
  assert.equal((await getNotification(actor, row.id)).state, 'suppressed')
  assert.equal(calls, 0)
})

// Test-only trigger changes state after the message reservation has committed,
// during rememberOutbound, deterministically exposing the old dispatch gap.
async function beforeDispatch(sql: string) {
  await getDatabase().execute(`CREATE OR REPLACE FUNCTION change_sms_before_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${sql}; RETURN NEW; END $$`)
  await getDatabase().execute('CREATE TRIGGER change_before_dispatch AFTER INSERT OR UPDATE ON sms_conversations FOR EACH ROW EXECUTE FUNCTION change_sms_before_dispatch()')
}
for (const transport of ['adapter', 'injected'] as const) test(`${transport}: STOP committed after reservation prevents provider dispatch`, async () => {
  await beforeDispatch(`INSERT INTO sms_suppressions(workspace_id,recipient_hash,state,updated_at) VALUES(NEW.workspace_id,NEW.recipient_hash,'opted_out',NEW.updated_at) ON CONFLICT(workspace_id,recipient_hash) DO UPDATE SET state='opted_out',updated_at=EXCLUDED.updated_at`)
  const result = await deliverClosingSms(actor, input(`reservation-${transport}`), transport === 'injected' ? { send: async () => { calls++; return { state: 'accepted', externalId: sid() } } } : undefined)
  assert.equal(result.errorCode, 'sms_recipient_opted_out')
  assert.equal(result.state, 'failed')
  assert.equal(calls, 0)
  await assert.rejects(deliverClosingSms(actor, input(`reservation-${transport}`)), { code: 'sms_recipient_opted_out' })
  assert.equal(calls, 0)
})

test('missing credentials never reach provider HTTP', async () => {
  delete process.env.MCA_SMS_TWILIO_ACCOUNTS_JSON
  const result = await deliverClosingSms(actor, input('missing-credentials'))
  assert.equal(result.errorCode, 'twilio_unconfigured')
  assert.equal(calls, 0)
})

test('company pause after reservation prevents provider dispatch', async () => {
  await beforeDispatch(`INSERT INTO company_subscription_state(workspace_id,legacy_exempt,manual_paused,updated_at) VALUES(NEW.workspace_id,1,1,NEW.updated_at) ON CONFLICT(workspace_id) DO UPDATE SET manual_paused=1`)
  // The existing company guard may reject before or inside guardedSend.
  const result = await deliverClosingSms(actor, input('pause-after-reservation')).catch(error => ({ errorCode: error.code }))
  assert.equal(result.errorCode, 'company_paused')
  assert.equal(calls, 0)
})

async function managed() {
  Object.assign(process.env, { MCA_SMS_ISV_APPROVED: 'true', MCA_SMS_ELIGIBILITY_REFERENCE: 'synthetic-only', MCA_TWILIO_PRIMARY_PROFILE_SID: `BU${'c'.repeat(32)}`, MCA_SMS_SEGMENT_ESTIMATE_CENTS: '1' })
  const db = getDatabase(), now = nowIso()
  await db.prepare("UPDATE mca_sms_accounts SET credential_ref='MANAGED',shared=1 WHERE id=?").run(accountId)
  await db.prepare(`INSERT INTO sms_companies(workspace_id,owner_user_id,email_verified_at,review_state,registration_state,provider_cipher,opt_out_ready,monthly_limit_cents,created_at,updated_at) VALUES(?,'stop-user',?,'approved','approved',?,1,100000,?,?)`).run(workspaceId, now, encryptSensitive(JSON.stringify({ ...credentials, serviceSid: `MG${'c'.repeat(32)}`, brandSid: `BN${'c'.repeat(32)}`, campaignSid: `QE${'c'.repeat(32)}` }), workspaceId), now, now)
  await db.prepare(`INSERT INTO sms_numbers(id,workspace_id,account_id,provider_sid,phone,state,monthly_cents,created_at,updated_at) VALUES('stop-number',?,?,?,?,'active',0,?,?)`).run(workspaceId, accountId, `PN${'c'.repeat(32)}`, sender, now, now)
}
for (const block of ['STOP', 'suspension', 'eligibility', 'credentials'] as const) test(`managed company SMS: ${block} blocks provider dispatch`, async () => {
  await managed()
  if (block === 'STOP') await inbound('STOP')
  if (block === 'suspension') await beforeDispatch("UPDATE sms_companies SET suspended=1 WHERE workspace_id=NEW.workspace_id")
  if (block === 'eligibility') delete process.env.MCA_SMS_ELIGIBILITY_REFERENCE
  if (block === 'credentials') await getDatabase().prepare('UPDATE sms_companies SET provider_cipher=NULL WHERE workspace_id=?').run(workspaceId)
  const result = await deliverClosingSms(actor, input(`managed-${block}`)).catch(error => ({ errorCode: error.code }))
  assert.equal(result.errorCode, block === 'STOP' ? 'sms_recipient_opted_out' : 'sms_setup_incomplete')
  assert.equal(calls, 0)
})

test('signed callback duplicates, HELP and delayed START cannot undo STOP', async () => {
  const start = sid(), stop = sid()
  await inbound('START', start)
  await Promise.all([inbound('STOP', stop), inbound('STOP', stop)])
  await inbound('START', start)
  await inbound('START') // previously unseen, possibly older START
  await inbound('HELP')
  await inbound('ordinary text', sid(), 'HELP')
  assert.equal((await getSmsConsent(actor, dealId, phone)).state, 'opted_out')
  const rows = await getDatabase().prepare<{ count: string }>('SELECT count(*) FROM sms_inbox_messages WHERE workspace_id=? AND provider_id=?').get(workspaceId, stop)
  assert.equal(rows?.count, '1')
  await assert.rejects(deliverClosingSms(actor, input('callback-stop')), { code: 'sms_recipient_opted_out' })
  assert.equal(calls, 0)
  await consent()
  assert.equal((await deliverClosingSms(actor, input('fresh-consent'))).state, 'accepted')
  assert.equal(calls, 1)
})

test('manual opt-out suppresses the same recipient on another deal', async () => {
  const other = (await createDeal(actor, { idempotencyKey: 'stop-other-deal', legalName: 'Other Synthetic LLC', contactPhone: phone })).deal.id
  await recordSmsConsent(actor, { dealId: other, recipient: phone, state: 'opted_in', evidence: 'Earlier consent', idempotencyKey: 'other-consent' })
  await recordSmsConsent(actor, { dealId, recipient: phone, state: 'opted_out', evidence: 'Manual withdrawal', idempotencyKey: 'manual-stop' })
  await assert.rejects(deliverClosingSms(actor, { ...input('other-deal-stop'), dealId: other }), { code: 'sms_recipient_opted_out' })
  assert.equal(calls, 0)
})

test('asynchronous 21610 status suppresses even when status events arrive out of order', async () => {
  const sent = await deliverClosingSms(actor, input('status-stop'))
  assert.equal(calls, 1)
  const url = `https://sms.example.test/api/mca/sms/webhooks/twilio/${accountId}/status?messageId=${sent.messageId}`
  const status = async (value: string, errorCode?: string) => {
    const params = new URLSearchParams({ AccountSid: credentials.accountSid, MessageSid: sent.externalId!, MessageStatus: value, To: phone, From: sender })
    if (errorCode) params.set('ErrorCode', errorCode)
    return processTwilioStatus(accountId, params, sign(url, params), url)
  }
  await status('undelivered', '21610')
  await status('sent')
  assert.equal((await status('undelivered', '21610')).replayed, true)
  await assert.rejects(deliverClosingSms(actor, input('after-status-stop')), { code: 'sms_recipient_opted_out' })
  assert.equal(calls, 1)
})

for (const provider of SMS_PROVIDERS) test(`${provider}: shared dispatch blocks STOP after reservation`, async () => {
  await getDatabase().prepare('UPDATE mca_sms_accounts SET provider=? WHERE id=?').run(provider, accountId)
  const send = mock.method(getSmsAdapter(provider), 'send', async () => { calls++; return { state: 'accepted' as const, externalId: sid() } })
  try {
    await beforeDispatch(`INSERT INTO sms_suppressions(workspace_id,recipient_hash,state,updated_at) VALUES(NEW.workspace_id,NEW.recipient_hash,'opted_out',NEW.updated_at) ON CONFLICT(workspace_id,recipient_hash) DO UPDATE SET state='opted_out'`)
    assert.equal((await deliverClosingSms(actor, input(`provider-${provider}`))).errorCode, 'sms_recipient_opted_out')
    assert.equal(calls, 0)
  } finally { send.mock.restore() }
})

test('company SMS suspension also blocks manually configured senders', async () => {
  await managed()
  await getDatabase().prepare("UPDATE mca_sms_accounts SET credential_ref='DEFAULT' WHERE id=?").run(accountId)
  await getDatabase().prepare('DELETE FROM sms_numbers WHERE workspace_id=?').run(workspaceId)
  await beforeDispatch("UPDATE sms_companies SET suspended=1 WHERE workspace_id=NEW.workspace_id")
  assert.equal((await deliverClosingSms(actor, input('suspended-manual-account'))).errorCode, 'sms_setup_incomplete')
  assert.equal(calls, 0)
})

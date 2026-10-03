import './helpers/business-auth'
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createPostgresTestDatabase } from './helpers/postgres-test-db.mjs'
import { getDatabase, closeDatabaseForTests, nowIso, withImmediateTransaction } from '../src/lib/mca/db'
import { createWorkspaceWithAdmin } from '../src/lib/mca/workspaces'
import { decryptSensitive, encryptSensitive, hashOpaqueToken } from '../src/lib/mca/crypto'
import type { DealActor } from '../src/lib/mca/deals/schema'

let fixture: Awaited<ReturnType<typeof createPostgresTestDatabase>>
const prior = { ...process.env }
import * as business from '../src/lib/mca/onboarding/business-profile'
let serial = 0
async function owner() {
  const created = await createWorkspaceWithAdmin({ workspaceName: 'Checkout Company', adminName: 'Owner', adminEmail: `basics-${++serial}@example.test`, password: 'SyntheticPassword123', role: 'admin' })
  return { ...created, source: 'user', role: 'admin', sessionId: 'verified-provider-session', managedMembershipIds: [], activeMembershipIds: [created.membershipId], correlationId: 'basics-test' } as DealActor
}
before(async () => { fixture = await createPostgresTestDatabase('onboarding_business'); Object.assign(process.env, fixture.env({ MCA_DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64url') })) })
after(async () => { await closeDatabaseForTests(); await fixture?.close(); for (const k of Object.keys(process.env)) if (!(k in prior)) delete process.env[k]; Object.assign(process.env, prior) })

test('business basics prefill workspace name without claiming an EIN or mutating SMS', async () => {
  assert.ok(business?.getBusinessBasics, 'business basics reader must exist')
  const actor = await owner()
  assert.deepEqual(await business.getBusinessBasics(actor), { legalName: 'Checkout Company', einPresent: false, revision: 0, registered: false })
  assert.equal((await getDatabase().prepare<{ count: number }>('SELECT count(*)::int count FROM sms_companies WHERE workspace_id=?').get(actor.workspaceId))?.count, 0)
})
test('save encrypts company-bound basics and excludes EIN from status and audit', async () => {
  assert.ok(business?.saveBusinessBasics)
  const actor = await owner()
  assert.deepEqual(await business.saveBusinessBasics(actor, { legalName: '  Legal Company  ', ein: '12-3456789', expectedRevision: 0 }), { legalName: 'Legal Company', einPresent: true, revision: 1 })
  const row = await getDatabase().prepare<{ profile_cipher: string }>('SELECT profile_cipher FROM company_basic_profiles WHERE workspace_id=?').get(actor.workspaceId)
  assert.ok(row); assert.doesNotMatch(row.profile_cipher, /Legal Company|123456789|12-3456789/)
  assert.deepEqual(JSON.parse(decryptSensitive(row.profile_cipher, actor.workspaceId)), { legalName: 'Legal Company', ein: '123456789' })
  assert.throws(() => decryptSensitive(row.profile_cipher, 'foreign-company'))
  assert.doesNotMatch(JSON.stringify(await business.getBusinessBasics(actor)), /123456789|12-3456789/)
  assert.doesNotMatch(JSON.stringify(await getDatabase().prepare('SELECT * FROM audit_events WHERE workspace_id=?').all(actor.workspaceId)), /123456789|12-3456789|Legal Company/)
})
test('strict name and EIN validation returns safe field errors', async () => {
  assert.ok(business?.saveBusinessBasics)
  const actor = await owner()
  for (const input of [{ legalName: 'X', ein: '12-3456789' }, { legalName: 'x'.repeat(151), ein: '123456789' }, { legalName: 'Valid', ein: 'secret-invalid-ein' }, { legalName: 'Valid', ein: '1234567890' }]) {
    await assert.rejects(() => business.saveBusinessBasics(actor, { ...input, expectedRevision: 0 }), (e: { code?: string; message?: string }) => e.code === 'validation_failed' && !JSON.stringify(e).includes(input.ein))
  }
})
test('CAS permits one concurrent save and rejects stale read and overwrite', async () => {
  assert.ok(business?.saveBusinessBasics)
  const actor = await owner()
  const results = await Promise.allSettled([business.saveBusinessBasics(actor, { legalName: 'First Company', ein: '123456789', expectedRevision: 0 }), business.saveBusinessBasics(actor, { legalName: 'Second Company', ein: '987654321', expectedRevision: 0 })])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(results.filter(r => r.status === 'rejected' && r.reason.code === 'business_revision_conflict').length, 1)
  await assert.rejects(() => business.businessBasicsForRegistration(actor, 0), { code: 'business_revision_conflict' })
})
test('basic save preserves full SMS review/provider profile and registered identity blocks correction', async () => {
  assert.ok(business?.saveBusinessBasics)
  const actor = await owner(), db = getDatabase(), cipher = encryptSensitive(JSON.stringify({ legalName: 'Registered Company', ein: '12-3456789' }), actor.workspaceId), now = nowIso()
  await db.prepare("INSERT INTO sms_companies(workspace_id,owner_user_id,profile_cipher,review_state,email_verified_at,created_at,updated_at) VALUES (?,?,?,'pending',?,?,?)").run(actor.workspaceId, actor.userId, cipher, now, now, now)
  await business.saveBusinessBasics(actor, { legalName: 'Draft Company', ein: '987654321', expectedRevision: 0 })
  const row = await db.prepare<{ profile_cipher: string; review_state: string; provider_cipher: string | null }>('SELECT profile_cipher,review_state,provider_cipher FROM sms_companies WHERE workspace_id=?').get(actor.workspaceId)
  assert.deepEqual(row, { profile_cipher: cipher, review_state: 'pending', provider_cipher: null })
  await db.prepare("UPDATE sms_companies SET review_state='approved' WHERE workspace_id=?").run(actor.workspaceId)
  assert.equal((await business.getBusinessBasics(actor)).legalName, 'Registered Company')
  assert.equal((await business.getBusinessBasics(actor)).registered, true)
  await assert.rejects(() => business.saveBusinessBasics(actor, { legalName: 'Override', ein: '987654321', expectedRevision: 1 }), { code: 'registration_started' })
})
test('services deny forged role, foreign tenant, member, API key, missing session, disabled features, MFA and paused billing', async () => {
  assert.ok(business?.saveBusinessBasics)
  const actor = await owner(), foreign = await owner(), db = getDatabase(), input = { legalName: 'Valid Company', ein: '123456789', expectedRevision: 0 }
  for (const forged of [{ ...actor, role: 'rep' }, { ...actor, workspaceId: foreign.workspaceId }, { ...actor, source: 'api_key' }, { ...actor, sessionId: null }]) await assert.rejects(() => business.saveBusinessBasics(forged as DealActor, input))
  await db.prepare("UPDATE memberships SET role='rep' WHERE id=?").run(actor.membershipId)
  await assert.rejects(() => business.saveBusinessBasics(actor, input), { code: 'business_admin_required' })
  await db.prepare("UPDATE memberships SET role='admin',status='deactivated' WHERE id=?").run(actor.membershipId)
  await assert.rejects(() => business.saveBusinessBasics(actor, input), { code: 'business_admin_required' })
  await db.prepare("UPDATE memberships SET status='active' WHERE id=?").run(actor.membershipId)
  for (const column of ['feature_flags', 'page_visibility']) { await db.prepare(`UPDATE workspaces SET ${column}=? WHERE id=?`).run(JSON.stringify({ integrations: false }), actor.workspaceId); await assert.rejects(() => business.saveBusinessBasics(actor, input), { code: 'page_disabled' }); await db.prepare(`UPDATE workspaces SET ${column}=? WHERE id=?`).run(JSON.stringify({ integrations: true }), actor.workspaceId) }
  await db.prepare('UPDATE workspaces SET require_2fa=true WHERE id=?').run(actor.workspaceId)
  await assert.rejects(() => business.saveBusinessBasics(actor, input), { code: 'totp_enrollment_required' })
  await db.prepare('UPDATE workspaces SET require_2fa=false WHERE id=?').run(actor.workspaceId)
  await db.prepare('UPDATE company_subscription_state SET manual_paused=1 WHERE workspace_id=?').run(actor.workspaceId)
  await assert.rejects(() => business.saveBusinessBasics(actor, input), { code: 'company_paused' })
})
test('business HTTP rejects anonymous, API keys and CSRF and GET remains sanitized', async () => {
  const route = await import('../src/app/api/mca/onboarding/business/route').catch(() => undefined)
  assert.ok(route?.POST)
  const actor = await owner(), now = nowIso()
  await getDatabase().prepare("INSERT INTO sessions(id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at) VALUES (?,?,?,?,'2099-01-01',?,?)").run(`session-${actor.userId}`, actor.userId, actor.membershipId, hashOpaqueToken('business-token'), now, now)
  const url = 'http://localhost/api/mca/onboarding/business', body = JSON.stringify({ legalName: 'Safe Company', ein: '123456789', expectedRevision: 0 })
  assert.equal((await route.POST(new Request(url, { method: 'POST', body }))).status, 401)
  assert.equal((await route.POST(new Request(url, { method: 'POST', body, headers: { cookie: 'mca_session=business-token', origin: 'https://foreign.test' } }))).status, 403)
  assert.equal((await route.POST(new Request(url, { method: 'POST', body, headers: { cookie: 'mca_session=business-token', origin: 'http://localhost' } }))).status, 200)
  const got = await route.GET(new Request(url, { headers: { cookie: 'mca_session=business-token' } }))
  assert.equal(got.status, 200); assert.doesNotMatch(await got.text(), /123456789/)
})

test('missing production encryption key fails closed without exposing stored EIN in errors', async () => {
  const actor = await owner()
  await business.saveBusinessBasics(actor, { legalName: 'Encrypted Company', ein: '123456789', expectedRevision: 0 })
  const testEnv: Record<string, string | undefined> = process.env
  const key = testEnv.MCA_DATA_ENCRYPTION_KEY, nodeEnv = testEnv.NODE_ENV
  await withImmediateTransaction(async () => {
    delete testEnv.MCA_DATA_ENCRYPTION_KEY; testEnv.NODE_ENV = 'production'
    try { await assert.rejects(() => business.getBusinessBasics(actor), (e: { code?: string }) => e.code === 'business_profile_unavailable' && !JSON.stringify(e).includes('123456789')) }
    finally { testEnv.MCA_DATA_ENCRYPTION_KEY = key; if (nodeEnv === undefined) delete testEnv.NODE_ENV; else testEnv.NODE_ENV = nodeEnv }
  })
})

test('HTTP validation never reflects sensitive input, including unexpected JSON keys', async () => {
  const route = await import('../src/app/api/mca/onboarding/business/route'), actor = await owner(), now = nowIso(), token = `safe-errors-${serial}`
  await getDatabase().prepare("INSERT INTO sessions(id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at) VALUES (?,?,?,?,'2099-01-01',?,?)").run(`safe-error-session-${serial}`, actor.userId, actor.membershipId, hashOpaqueToken(token), now, now)
  const response = await route.POST(new Request('http://localhost/api/mca/onboarding/business', { method: 'POST', body: JSON.stringify({ legalName: 'Safe Company', ein: '123456789', expectedRevision: 0, '123456789': true }), headers: { cookie: `mca_session=${token}`, origin: 'http://localhost' } }))
  assert.ok(response.status >= 400 && response.status < 500); assert.doesNotMatch(await response.text(), /123456789/)
})

const a2p = {
  businessType: 'Limited Liability Corporation', street: '100 Synthetic Way', city: 'Testville', region: 'NY', postalCode: '10001',
  website: 'https://synthetic-a2p.example.test', contactFirstName: 'Ada', contactLastName: 'Owner', contactEmail: 'ada@synthetic-a2p.example.test',
  contactPhone: '+15555550123', contactTitle: 'Managing Member', contactPosition: 'CEO',
  purpose: 'Application status updates for merchants who applied for funding.',
  samples: ['Synthetic Funding: your application was received. Reply STOP to opt out.', 'Synthetic Funding: an advisor will call you today. Reply STOP to opt out.'],
  consentEvidence: 'Merchants check an unchecked SMS consent box on the online application form.',
}
test('a fresh process importing sms onboarding before business profile has no import-cycle failure', () => {
  const script = "import('./src/lib/mca/sms/onboarding.ts').then(() => import('./src/lib/mca/onboarding/business-profile.ts')).then(m => { if (typeof m.saveBusinessBasics !== 'function') process.exit(2) })"
  execFileSync(process.execPath, ['--conditions=react-server', '--import', 'tsx', '-e', script], { cwd: process.cwd(), env: { ...process.env, NODE_OPTIONS: '' }, stdio: 'pipe' })
})
test('sms profile loaded first, then A2P details round-trip encrypted with audit flag only', async () => {
  await import('../src/lib/mca/sms/onboarding')
  const actor = await owner()
  assert.deepEqual(await business.saveBusinessBasics(actor, { legalName: 'A2P Company', ein: '12-3456789', a2p, expectedRevision: 0 }), { legalName: 'A2P Company', einPresent: true, revision: 1 })
  const row = await getDatabase().prepare<{ profile_cipher: string }>('SELECT profile_cipher FROM company_basic_profiles WHERE workspace_id=?').get(actor.workspaceId)
  assert.doesNotMatch(row!.profile_cipher, /synthetic-a2p|5555550123|Synthetic Funding/)
  assert.deepEqual(JSON.parse(decryptSensitive(row!.profile_cipher, actor.workspaceId)), { legalName: 'A2P Company', ein: '123456789', a2p })
  const basics = await business.getBusinessBasics(actor)
  assert.deepEqual(basics.a2p, a2p)
  assert.doesNotMatch(JSON.stringify(basics), /123456789/)
  const audit = await getDatabase().prepare<{ metadata_json: string }>("SELECT * FROM audit_events WHERE workspace_id=? AND action='company.business_basics_supplied'").all(actor.workspaceId)
  assert.match(JSON.stringify(audit), /a2pSubmitted/)
  assert.doesNotMatch(JSON.stringify(audit), /synthetic-a2p|5555550123|Synthetic Funding|123456789/)
})
test('resubmission keeps the stored EIN and A2P details in one row; a first save still requires an EIN', async () => {
  const actor = await owner()
  await assert.rejects(() => business.saveBusinessBasics(actor, { legalName: 'No EIN Company', a2p, expectedRevision: 0 }), (e: { code?: string; fieldErrors?: Record<string, string[]> }) => e.code === 'validation_failed' && Boolean(e.fieldErrors?.ein))
  await business.saveBusinessBasics(actor, { legalName: 'A2P Company', ein: '123456789', a2p, expectedRevision: 0 })
  const resubmitted = { ...a2p, privacyUrl: 'https://synthetic-a2p.example.test/privacy', termsUrl: 'https://synthetic-a2p.example.test/terms' }
  assert.equal((await business.saveBusinessBasics(actor, { legalName: 'A2P Company LLC', a2p: resubmitted, expectedRevision: 1 })).revision, 2)
  assert.equal((await business.saveBusinessBasics(actor, { legalName: 'A2P Company LLC', expectedRevision: 2 })).revision, 3)
  const rows = await getDatabase().prepare<{ profile_cipher: string }>('SELECT profile_cipher FROM company_basic_profiles WHERE workspace_id=?').all(actor.workspaceId)
  assert.equal(rows.length, 1)
  assert.deepEqual(JSON.parse(decryptSensitive(rows[0].profile_cipher, actor.workspaceId)), { legalName: 'A2P Company LLC', ein: '123456789', a2p: resubmitted })
})
test('invalid A2P fields return field keys only without reflecting input', async () => {
  const actor = await owner()
  for (const [field, value] of [['region', 'ny'], ['contactPhone', '555-0123'], ['website', 'http://insecure-a2p.example.test'], ['samples', ['too short sample']], ['samples', Array(6).fill('A sufficiently long synthetic sample message')], ['privacyUrl', 'ftp://bad-a2p.example.test']] as const) {
    await assert.rejects(() => business.saveBusinessBasics(actor, { legalName: 'Valid Company', ein: '123456789', a2p: { ...a2p, [field]: value }, expectedRevision: 0 }), (e: { code?: string; fieldErrors?: Record<string, string[]> }) => {
      const body = JSON.stringify(e)
      return e.code === 'validation_failed' && Boolean(e.fieldErrors?.[`a2p.${field}`]) && !body.includes(String(Array.isArray(value) ? value[0] : value))
    })
  }
  await assert.rejects(() => business.saveBusinessBasics(actor, { legalName: 'Valid Company', ein: '123456789', a2p: { ...a2p, secretExtra: 'reflect-me-not' }, expectedRevision: 0 }), (e: unknown) => (e as { code?: string }).code === 'validation_failed' && !JSON.stringify(e).includes('reflect-me-not'))
  const route = await import('../src/app/api/mca/onboarding/business/route'), now = nowIso(), token = `a2p-errors-${serial}`
  await getDatabase().prepare("INSERT INTO sessions(id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at) VALUES (?,?,?,?,'2099-01-01',?,?)").run(`a2p-error-session-${serial}`, actor.userId, actor.membershipId, hashOpaqueToken(token), now, now)
  const response = await route.POST(new Request('http://localhost/api/mca/onboarding/business', { method: 'POST', body: JSON.stringify({ legalName: 'Valid Company', ein: '123456789', a2p: { ...a2p, contactPhone: '+1-reflect-555' }, expectedRevision: 0 }), headers: { cookie: `mca_session=${token}`, origin: 'http://localhost' } }))
  assert.equal(response.status, 422)
  const text = await response.text()
  assert.match(text, /a2p\.contactPhone/); assert.doesNotMatch(text, /reflect-555|123456789/)
})
test('registered SMS identity refuses A2P resubmission', async () => {
  const actor = await owner(), db = getDatabase(), now = nowIso()
  await db.prepare("INSERT INTO sms_companies(workspace_id,owner_user_id,profile_cipher,review_state,email_verified_at,created_at,updated_at) VALUES (?,?,?,'approved',?,?,?)").run(actor.workspaceId, actor.userId, encryptSensitive(JSON.stringify({ legalName: 'Registered Company', ein: '12-3456789' }), actor.workspaceId), now, now, now)
  await assert.rejects(() => business.saveBusinessBasics(actor, { legalName: 'Registered Company', a2p, expectedRevision: 0 }), { code: 'registration_started' })
})

for (const level of ['envelope', 'profile'] as const) test(`full SMS HTTP validation rejects sensitive unexpected ${level} keys without reflection`, async () => {
  const route = await import('../src/app/api/mca/sms/onboarding/route'), actor = await owner(), now = nowIso(), token = `sms-safe-errors-${serial}`
  await getDatabase().prepare("INSERT INTO sessions(id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at) VALUES (?,?,?,?,'2099-01-01',?,?)").run(`sms-safe-error-session-${serial}`, actor.userId, actor.membershipId, hashOpaqueToken(token), now, now)
  const sensitive = '12-3456789'
  const input = { action: 'submit', profile: level === 'profile' ? { [sensitive]: true } : {}, useStoredEin: true, basicRevision: 1, ...(level === 'envelope' ? { [sensitive]: true } : {}) }
  const response = await route.POST(new Request('http://localhost/api/mca/sms/onboarding', { method: 'POST', body: JSON.stringify(input), headers: { cookie: `mca_session=${token}`, origin: 'http://localhost' } }))
  assert.equal(response.status, 400)
  assert.doesNotMatch(await response.text(), /12-3456789/)
  assert.equal((await getDatabase().prepare<{ count: number }>('SELECT count(*)::int count FROM sms_companies WHERE workspace_id=?').get(actor.workspaceId))?.count, 0)
})

import './helpers/business-auth';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresTestDatabase } from './helpers/postgres-test-db.mjs';
import { getDatabase, closeDatabaseForTests, withImmediateTransaction } from '../src/lib/mca/db';
import { createDeal } from '../src/lib/mca/deals/service';
import type { DealActor } from '../src/lib/mca/deals/schema';
import { enqueueNotification, getNotification, setNotificationPolicy, setNotificationConsent, suppressNotificationRecipient, notificationUnsubscribeToken, unsubscribeNotification } from '../src/lib/mca/notifications/service';
import { runScheduledNotifications as runNotifications, setNotificationTransportForTests, reconcileNotification, recordNotificationOutcome, reconcileNotificationProviders, setNotificationReceiptLookupForTests } from '../src/lib/mca/notifications/worker';
import { createMessageTemplate, publishMessageTemplate } from '../src/lib/mca/comms/templates';
import { recordSmsConsent } from '../src/lib/mca/sms/service';
import { defaultNotificationTransport, lookupNotificationReceipt } from '../src/lib/mca/notifications/transport';
import { registerNotificationCondition } from '../src/lib/mca/notifications/conditions';
import { Mailbox, setEmailProviderFetchForTests } from '../src/lib/mca/email-conversations/providers';
import { encryptSenderCredential } from '../src/lib/mca/senders/repository';
import { GOOGLE_SENDER_SCOPES, MICROSOFT_SENDER_SCOPES } from '../src/lib/mca/senders/oauth';
import type { NotificationRow } from '../src/lib/mca/notifications/contracts';
async function runScheduledNotifications(clock: string, limit = 25, options?: {
    deadlineMs?: number;
    operationClock?: () => string;
}) {
    return runNotifications(clock, limit, { ...options, operationClock: options?.operationClock ?? (() => clock) });
}
let cluster: Awaited<ReturnType<typeof createPostgresTestDatabase>>;
let dealId: string;
const actor = (workspaceId = 'notify-a'): DealActor => ({ workspaceId, userId: `${workspaceId}-user`, membershipId: `${workspaceId}-member`, role: 'admin', source: 'user', managedMembershipIds: [], activeMembershipIds: [`${workspaceId}-member`], correlationId: 'notification-test' });
const now = '2026-10-01T00:00:00.000Z';
const event = (eventKey: string) => ({ eventKey, kind: 'document' as const, dealId, audience: 'broker' as const, channel: 'email' as const, recipientUserId: 'notify-a-user', scheduledFor: now, approvedAt: now, payload: { title: 'Documents due', message: 'Review requested documents.' } });
before(async () => {
    cluster = await createPostgresTestDatabase('notifications');
    Object.assign(process.env, cluster.env());
    const db = getDatabase();
    for (const workspace of ['notify-a', 'notify-b']) {
        await db.prepare(`INSERT INTO workspaces(id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at) VALUES(?,?,'UTC',8,'{"integrations":true}','{"deals":true,"integrations":true}','{"createDeal":true}',?,?)`).run(workspace, workspace, now, now);
        await db.prepare(`INSERT INTO users(id,email,name,application_identifier,created_at,updated_at) VALUES(?,?,? ,?,?,?)`).run(`${workspace}-user`, `${workspace}@example.test`, workspace, workspace, now, now);
        await db.prepare(`INSERT INTO memberships(id,workspace_id,user_id,role,status,created_at,updated_at) VALUES(?,?,?,'admin','active',?,?)`).run(`${workspace}-member`, workspace, `${workspace}-user`, now, now);
    }
    dealId = (await createDeal(actor(), { idempotencyKey: 'notification-deal', legalName: 'Synthetic Notification LLC', contactEmail: 'merchant@example.test', contactPhone: '+15551234567', owners: [{ firstName: 'Pat', lastName: 'Test', isPrimary: true }], assignments: [{ membershipId: 'notify-a-member', kind: 'originator', isPrimary: true }] })).deal.id;
});
beforeEach(async () => {
    process.env.MCA_NOTIFICATION_RUNTIME = 'enabled';
    await getDatabase().prepare("DELETE FROM company_subscription_state WHERE workspace_id='notify-a'").run();
    await getDatabase().prepare('DELETE FROM mca_notification_receipts').run();
    await getDatabase().prepare('DELETE FROM mca_notifications').run();
    await getDatabase().prepare('DELETE FROM mca_notification_preferences').run();
    await getDatabase().prepare('DELETE FROM mca_notification_policies').run();
});
after(async () => { await closeDatabaseForTests(); await cluster?.close(); });
test('tenant references, broker recipient membership and reads are scoped', async () => {
    await assert.rejects(enqueueNotification(actor('notify-b'), event('foreign-deal')));
    await assert.rejects(enqueueNotification(actor(), { ...event('foreign-member'), recipientUserId: 'notify-b-user' }));
    const row = await enqueueNotification(actor(), event('tenant-read'));
    await assert.rejects(getNotification(actor('notify-b'), row.id));
});
test('duplicate events deduplicate under concurrency and reject changed content', async () => {
    const rows = await Promise.all(Array.from({ length: 8 }, () => enqueueNotification(actor(), event('dedup'))));
    assert.equal(new Set(rows.map(row => row.id)).size, 1);
    await assert.rejects(enqueueNotification(actor(), { ...event('dedup'), payload: { title: 'Changed', message: 'Changed' } }), /different/);
});
test('merchant policy and explicit email consent both default off', async () => {
    const input = { ...event('merchant-disabled'), audience: 'merchant' as const, recipientUserId: undefined, templateId: 'not-a-template', payload: undefined };
    await assert.rejects(enqueueNotification(actor(), input), /enabled/);
    await setNotificationPolicy(actor(), { kind: 'document', merchantEnabled: true, brokerEnabled: true });
    await assert.rejects(enqueueNotification(actor(), { ...input, eventKey: 'no-consent' }), /consent/);
    await setNotificationConsent(actor(), { dealId, channel: 'email', enabled: true });
    await assert.rejects(enqueueNotification(actor(), { ...input, eventKey: 'wrong-template' }), /template/);
    await setNotificationPolicy(actor(), { kind: 'document', merchantEnabled: false, brokerEnabled: true });
});
test('suppression prevents broker disclosure and admin settings reject reps', async () => {
    await getDatabase().prepare("UPDATE memberships SET role='rep' WHERE id='notify-a-member'").run();
    await assert.rejects(setNotificationPolicy(actor(), { kind: 'renewal', merchantEnabled: true, brokerEnabled: true }));
    await getDatabase().prepare("UPDATE memberships SET role='admin' WHERE id='notify-a-member'").run();
    await suppressNotificationRecipient(actor(), { dealId, channel: 'email', audience: 'broker', recipientUserId: 'notify-a-user' });
    await assert.rejects(enqueueNotification(actor(), event('suppressed')), /suppressed/);
});
test('runtime defaults off and concurrent ticks dispatch an event once', async () => {
    const row = await enqueueNotification(actor(), event('claim-once'));
    let calls = 0;
    setNotificationTransportForTests(async () => { calls++; return { state: 'accepted', providerMessageId: 'provider-claim' }; });
    delete process.env.MCA_NOTIFICATION_RUNTIME;
    assert.equal((await runScheduledNotifications(now)).attempted, 0);
    process.env.MCA_NOTIFICATION_RUNTIME = 'enabled';
    await Promise.all([runScheduledNotifications(now), runScheduledNotifications(now)]);
    assert.equal(calls, 1);
    assert.equal((await getNotification(actor(), row.id)).state, 'accepted');
});
test('unknown sends and killed claims stay durable, reconcile without replay', async () => {
    const row = await enqueueNotification(actor(), event('unknown-send'));
    let calls = 0;
    setNotificationTransportForTests(async () => { calls++; throw new Error('secret-provider-detail'); });
    await runScheduledNotifications(now);
    assert.equal((await getNotification(actor(), row.id)).state, 'uncertain');
    await runScheduledNotifications('2026-10-01T01:00:00.000Z');
    assert.equal(calls, 1);
    await assert.rejects(reconcileNotification(actor('notify-b'), row.id, { outcome: 'delivered', evidence: 'checked receipt' }));
    await assert.rejects(reconcileNotification(actor(), row.id, { outcome: 'delivered', evidence: '' }));
    await reconcileNotification(actor(), row.id, { outcome: 'delivered', evidence: 'Provider receipt reviewed by company owner' });
    assert.equal((await getNotification(actor(), row.id)).state, 'delivered');
    assert.equal(calls, 1);
    const killed = await enqueueNotification(actor(), event('killed-send'));
    await getDatabase().prepare("UPDATE mca_notifications SET state='sending',claim_token='stale-token',lease_until=?,attempts=1 WHERE id=?").run(now, killed.id);
    await runScheduledNotifications('2026-10-01T01:00:00.000Z');
    assert.equal((await getNotification(actor(), killed.id)).state, 'uncertain');
    assert.equal(calls, 1);
    assert.equal(await recordNotificationOutcome('notify-a', killed.id, 'stale-token', { state: 'accepted', providerMessageId: 'too-late' }, now), false);
});
test('only proven rejection retries, three attempts and frozen content', async () => {
    const row = await enqueueNotification(actor(), event('bounded-retry'));
    const messages: string[] = [];
    setNotificationTransportForTests(async (m) => { messages.push(m.text); return { state: 'retry', errorCode: 'rate_limited' }; });
    await runScheduledNotifications(now);
    await runScheduledNotifications(now);
    assert.equal(messages.length, 1);
    await runScheduledNotifications('2026-10-01T00:15:00.000Z');
    assert.equal(messages.length, 2);
    await runScheduledNotifications('2026-10-01T00:45:00.000Z');
    assert.equal(messages.length, 3);
    await runScheduledNotifications('2026-10-02T00:00:00.000Z');
    assert.equal(messages.length, 3);
    const view = await getNotification(actor(), row.id);
    assert.equal(view.state, 'failed');
    assert.equal(view.attempts, 3);
    assert.equal(new Set(messages).size, 1);
});
test('live member access, policy revocation and suppression prevent dispatch', async () => {
    const row = await enqueueNotification(actor(), event('revoked-policy'));
    let calls = 0;
    setNotificationTransportForTests(async () => { calls++; return { state: 'accepted' }; });
    await setNotificationPolicy(actor(), { kind: 'document', brokerEnabled: false, merchantEnabled: false });
    await runScheduledNotifications(now);
    assert.equal(calls, 0);
    assert.equal((await getNotification(actor(), row.id)).state, 'suppressed');
    await setNotificationPolicy(actor(), { kind: 'document', brokerEnabled: true, merchantEnabled: false });
    const gone = await enqueueNotification(actor(), event('inactive-member'));
    await getDatabase().prepare("UPDATE memberships SET status='deactivated' WHERE id='notify-a-member'").run();
    await runScheduledNotifications(now);
    assert.equal(calls, 0);
    await getDatabase().prepare("UPDATE memberships SET status='active' WHERE id='notify-a-member'").run();
    assert.equal((await getNotification(actor(), gone.id)).state, 'suppressed');
});
test('broker events without a deal are tenant resolved and transactional', async () => {
    const input = { ...event('missed-call'), kind: 'missed_call' as const, dealId: undefined };
    const row = await enqueueNotification(actor(), input);
    assert.equal(row.state, 'queued');
    await assert.rejects(enqueueNotification(actor(), { ...input, eventKey: 'foreign-call', recipientUserId: 'notify-b-user' }));
    await assert.rejects(enqueueNotification(actor(), { ...input, eventKey: 'merchant-no-deal', audience: 'merchant', recipientUserId: undefined }));
});
test('unsubscribe token is opaque, tenant-scoped and blocks future attempts', async () => {
    const row = await enqueueNotification(actor(), event('unsubscribe'));
    const token = notificationUnsubscribeToken('notify-a', row.id);
    assert.equal(await unsubscribeNotification('invalid-token'), false);
    assert.equal(await unsubscribeNotification(token), true);
    assert.equal(await unsubscribeNotification(token), true);
    await assert.rejects(enqueueNotification(actor(), event('after-unsubscribe')), /suppressed/);
    const other = { ...event('other-company'), dealId: undefined, recipientUserId: 'notify-b-user' };
    assert.equal((await enqueueNotification(actor('notify-b'), other)).state, 'queued');
});
test('transactional enqueue rolls back with producer and receipts exclude raw errors', async () => {
    await assert.rejects(withImmediateTransaction(async (db) => { await enqueueNotification(actor(), { ...event('rollback'), dealId: undefined }, { executor: db }); throw new Error('rollback'); }));
    assert.equal((await getDatabase().prepare<{
        count: string;
    }>("SELECT count(*) count FROM mca_notifications WHERE event_key='rollback'").get())?.count, '0');
    const row = await enqueueNotification(actor(), event('sanitized'));
    setNotificationTransportForTests(async () => ({ state: 'failed', errorCode: 'raw secret https://provider.test?key=abc' }));
    await runScheduledNotifications(now);
    assert.equal((await getNotification(actor(), row.id)).errorCode, 'notification_delivery_failed');
    const receipt = await getDatabase().prepare<{
        evidence: string;
    }>('SELECT evidence FROM mca_notification_receipts WHERE notification_id=?').get(row.id);
    assert.equal(receipt?.evidence, 'dispatch_result');
});
test('provider receipt lookup resolves uncertain without replay and absence stays uncertain', async () => {
    const row = await enqueueNotification(actor(), event('provider-reconcile'));
    let sends = 0;
    setNotificationTransportForTests(async () => { sends++; return { state: 'uncertain' }; });
    await runScheduledNotifications(now);
    setNotificationReceiptLookupForTests(async () => undefined);
    await reconcileNotificationProviders(now);
    assert.equal((await getNotification(actor(), row.id)).state, 'uncertain');
    setNotificationReceiptLookupForTests(async () => ({ state: 'accepted', providerMessageId: 'found-sent' }));
    await reconcileNotificationProviders('2026-10-01T00:15:00.000Z');
    assert.equal((await getNotification(actor(), row.id)).state, 'accepted');
    assert.equal(sends, 1);
    setNotificationReceiptLookupForTests();
});
test('standalone receipt poll starts with its default deadline after a clock tick', async (t) => {
    const row = await enqueueNotification(actor(), event('default-receipt-deadline'));
    await getDatabase().prepare("UPDATE mca_notifications SET state='uncertain' WHERE id=?").run(row.id);
    let tick = 1000000, lookups = 0;
    const clockMock = t.mock.method(Date, 'now', () => ++tick);
    setNotificationReceiptLookupForTests(async () => { lookups++; return { state: 'accepted', providerMessageId: 'default-deadline-receipt' }; });
    try {
        assert.deepEqual(await reconcileNotificationProviders(now), { resolved: 1 });
        assert.equal(lookups, 1);
    }
    finally {
        clockMock.mock.restore();
        setNotificationReceiptLookupForTests();
    }
    assert.equal((await getNotification(actor(), row.id)).state, 'accepted');
});
test('SMS optout after enqueue stops merchant sends', async () => {
    await setNotificationPolicy(actor(), { kind: 'document', merchantEnabled: true, brokerEnabled: true });
    const template = await createMessageTemplate(actor(), { name: 'Notification SMS consent', channel: 'sms', scope: 'merchant', body: 'Please review your documents.' });
    await publishMessageTemplate(actor(), template.id);
    const input = { ...event('sms-consent-off'), audience: 'merchant' as const, channel: 'sms' as const, recipientUserId: undefined, payload: undefined, templateId: template.id };
    await assert.rejects(enqueueNotification(actor(), input), /consent/);
    await recordSmsConsent(actor(), { dealId, recipient: '+15551234567', state: 'opted_in', evidence: 'Synthetic signed consent', idempotencyKey: 'notification-optin' });
    const row = await enqueueNotification(actor(), { ...input, eventKey: 'sms-consent-live' });
    await recordSmsConsent(actor(), { dealId, recipient: '+15551234567', state: 'opted_out', evidence: 'Synthetic withdrawal', idempotencyKey: 'notification-optout' });
    let sends = 0;
    setNotificationTransportForTests(async () => { sends++; return { state: 'accepted' }; });
    await runScheduledNotifications(now);
    assert.equal(sends, 0);
    assert.equal((await getNotification(actor(), row.id)).state, 'suppressed');
});
test('broker system adapter preserves provider IDs and never retries ambiguous HTTP outcomes', async () => {
    const original = globalThis.fetch, saved = [process.env.MCA_SYSTEM_EMAIL_PROVIDER, process.env.MCA_RESEND_API_KEY, process.env.MCA_RESEND_FROM];
    process.env.MCA_SYSTEM_EMAIL_PROVIDER = 'resend';
    process.env.MCA_RESEND_API_KEY = 'synthetic-no-live-key';
    process.env.MCA_RESEND_FROM = 'Notify <notify@example.test>';
    const message = { beforeSend: async () => { }, deadlineMs: Date.now() + 60000, id: 'synthetic-id', workspaceId: 'notify-a', actor: actor(), dealId: null, audience: 'broker' as const, channel: 'email' as const, recipient: 'notify-a@example.test', subject: 'Alert', text: 'Synthetic alert', approvedAt: now, idempotencyKey: 'notification:synthetic-id' };
    try {
        let key = '';
        globalThis.fetch = async (_url, init) => { key = new Headers(init?.headers).get('idempotency-key') ?? ''; return Response.json({ id: 'synthetic-provider-id' }, { status: 201 }); };
        assert.deepEqual(await defaultNotificationTransport(message), { state: 'accepted', providerMessageId: 'synthetic-provider-id' });
        assert.equal(key, message.idempotencyKey);
        globalThis.fetch = async () => Response.json({ error: 'redacted' }, { status: 429 });
        assert.equal((await defaultNotificationTransport(message)).state, 'retry');
        globalThis.fetch = async () => Response.json({ error: 'redacted' }, { status: 503 });
        assert.equal((await defaultNotificationTransport(message)).state, 'uncertain');
        globalThis.fetch = async () => { throw new Error('provider-secret'); };
        assert.equal((await defaultNotificationTransport(message)).state, 'uncertain');
    }
    finally {
        globalThis.fetch = original;
        ['MCA_SYSTEM_EMAIL_PROVIDER', 'MCA_RESEND_API_KEY', 'MCA_RESEND_FROM'].forEach((key, i) => {
            if (saved[i] === undefined)
                delete process.env[key];
            else
                process.env[key] = saved[i];
        });
    }
});
test('merchant approval predating pause remains blocked while broker alerts still work', async () => {
    await getDatabase().prepare(`INSERT INTO company_subscription_state(workspace_id,legacy_exempt,last_paused_at,updated_at) VALUES('notify-a',1,'2026-10-01T00:01:00.000Z',?) ON CONFLICT(workspace_id) DO UPDATE SET last_paused_at=excluded.last_paused_at`).run(now);
    await setNotificationPolicy(actor(), { kind: 'document', merchantEnabled: true, brokerEnabled: true });
    await assert.rejects(enqueueNotification(actor(), { ...event('old-merchant-approval'), audience: 'merchant', channel: 'sms', recipientUserId: undefined, payload: undefined }), /approved before/);
    const broker = await enqueueNotification(actor(), event('broker-after-pause'));
    let sends = 0;
    setNotificationTransportForTests(async () => { sends++; return { state: 'accepted' }; });
    await runScheduledNotifications(now);
    assert.equal(sends, 1);
    assert.equal((await getNotification(actor(), broker.id)).state, 'accepted');
});
test('registered conditions are tenant-scoped and rechecked after enqueue', async () => {
    let active = true;
    registerNotificationCondition('fixture_document', async (live, condition) => live.workspaceId === 'notify-a' && condition.key === 'request-owned' && active);
    const input = { ...event('guarded-document'), condition: { type: 'fixture_document', key: 'request-owned', version: '1' } };
    const row = await enqueueNotification(actor(), input);
    active = false;
    let sends = 0;
    setNotificationTransportForTests(async () => { sends++; return { state: 'accepted' }; });
    await runScheduledNotifications(now);
    assert.equal(sends, 0);
    assert.equal((await getNotification(actor(), row.id)).state, 'suppressed');
    await assert.rejects(enqueueNotification(actor(), { ...input, eventKey: 'guard-unregistered', condition: { type: 'unknown-condition', key: 'x' } }));
});
test('receipt polling rotates unresolved rows instead of starving later events', async () => {
    const a = await enqueueNotification(actor(), event('receipt-first')), b = await enqueueNotification(actor(), event('receipt-second'));
    setNotificationTransportForTests(async () => ({ state: 'uncertain' }));
    await runScheduledNotifications(now);
    const seen: string[] = [];
    setNotificationReceiptLookupForTests(async (row) => { seen.push(row.id); return undefined; });
    await reconcileNotificationProviders(now, 1);
    await reconcileNotificationProviders(now, 1);
    assert.equal(new Set(seen).size, 2);
    assert.deepEqual(new Set(seen), new Set([a.id, b.id]));
    setNotificationReceiptLookupForTests();
});
test('a comms tick with exhausted total runtime budget leaves notifications queued', async () => {
    const row = await enqueueNotification(actor(), event('runtime-budget'));
    let sends = 0;
    setNotificationTransportForTests(async () => { sends++; return { state: 'accepted' }; });
    await runScheduledNotifications(now, 25, { deadlineMs: Date.now() - 1 });
    assert.equal(sends, 0);
    assert.equal((await getNotification(actor(), row.id)).state, 'queued');
});
test('later batch claims use fresh operation time and concurrent tick cannot expire a healthy send', async () => {
    const a = await enqueueNotification(actor(), event('lease-batch-a')), b = await enqueueNotification(actor(), event('lease-batch-b'));
    let opTime = Date.parse(now), calls = 0;
    let release!: () => void, started!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { started = resolve; });
    setNotificationTransportForTests(async () => {
        calls++;
        if (calls === 1) {
            opTime += 180000;
            return { state: 'accepted', providerMessageId: 'first-accepted' };
        }
        started();
        await waiting;
        return { state: 'accepted', providerMessageId: 'second-accepted' };
    });
    const firstTick = runScheduledNotifications(now, 25, { operationClock: () => new Date(opTime).toISOString() });
    await ready;
    await runScheduledNotifications(new Date(opTime).toISOString(), 25, { operationClock: () => new Date(opTime).toISOString() });
    release();
    await firstTick;
    assert.equal(calls, 2);
    assert.equal((await getNotification(actor(), a.id)).state, 'accepted');
    assert.equal((await getNotification(actor(), b.id)).state, 'accepted');
});
async function seedMailbox(id: string, provider: 'google' | 'microsoft' = 'google') {
    const scopes = provider === 'google' ? GOOGLE_SENDER_SCOPES : MICROSOFT_SENDER_SCOPES;
    await getDatabase().prepare(`INSERT INTO mca_email_senders(id,workspace_id,provider,purpose,from_name,from_address,credential_cipher,state,is_default,owner_membership_id,created_at,updated_at) VALUES(?,'notify-a',?,'merchant','Synthetic Sender','sender@example.test',?,'verified',1,'notify-a-member',?,?)`).run(id, provider, encryptSenderCredential('notify-a', { kind: 'oauth', email: 'sender@example.test', accessToken: 'synthetic-token', refreshToken: 'synthetic-refresh', expiresAt: '2099-01-01T00:00:00.000Z', scope: scopes.join(' ') }), now, now);
}
test('receipt lookup with 61 seconds remaining stops pagination before its deadline', async () => {
    await seedMailbox('bounded-microsoft', 'microsoft');
    const queued = await enqueueNotification(actor(), event('bounded-lookup'));
    const row = await getDatabase().prepare<NotificationRow>('SELECT * FROM mca_notifications WHERE id=?').get(queued.id);
    let elapsed = 0, calls = 0;
    setEmailProviderFetchForTests(async () => { calls++; elapsed += 15000; return Response.json({ value: [], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages?$skip=next' }); });
    try {
        await assert.rejects(lookupNotificationReceipt({ ...row!, audience: 'merchant', sender_id: 'bounded-microsoft' }, { deadlineMs: 61000, now: () => elapsed }), /deadline/);
        assert.equal(calls, 4);
        assert.ok(elapsed < 61000);
    }
    finally {
        setEmailProviderFetchForTests();
    }
});
for (const revoke of ['unsubscribe', 'condition'] as const) {
    test(`merchant ${revoke} during blocked OAuth refresh prevents send POST`, async (t) => {
        await seedMailbox(`refresh-${revoke}`);
        await setNotificationPolicy(actor(), { kind: 'document', brokerEnabled: true, merchantEnabled: true });
        await setNotificationConsent(actor(), { dealId, channel: 'email', enabled: true });
        const template = await createMessageTemplate(actor(), { name: `Refresh ${revoke}`, channel: 'email', scope: 'merchant', subject: 'Synthetic documents', body: 'Review your synthetic request.' });
        await publishMessageTemplate(actor(), template.id);
        let eligible = true;
        registerNotificationCondition(`refresh_${revoke}`, async () => eligible);
        const row = await enqueueNotification(actor(), { ...event(`refresh-event-${revoke}`), audience: 'merchant', recipientUserId: undefined, payload: undefined, templateId: template.id, senderId: `refresh-${revoke}`, condition: { type: `refresh_${revoke}`, key: 'request-owned' } });
        let release!: () => void, started!: () => void, posts = 0;
        const barrier = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { started = resolve; });
        t.mock.method(Mailbox.prototype, 'connect', async () => { started(); await barrier; });
        setEmailProviderFetchForTests(async (_url, init) => { if (init?.method === 'POST')
            posts++; return Response.json({ id: 'would-send' }); });
        setNotificationTransportForTests();
        try {
            const tick = runScheduledNotifications(now);
            await ready;
            if (revoke === 'unsubscribe')
                await unsubscribeNotification(notificationUnsubscribeToken('notify-a', row.id));
            else
                eligible = false;
            release();
            await tick;
            assert.equal(posts, 0);
            assert.equal((await getNotification(actor(), row.id)).state, 'suppressed');
        }
        finally {
            setEmailProviderFetchForTests();
            release();
        }
    });
}

import 'server-only';
import { z } from 'zod';
import { getDatabase, newId, nowIso, withImmediateTransaction, recordAuditEvent, type DbExecutor } from '../db';
import { encryptSensitive, decryptSensitive } from '../crypto';
import { liveEmailActor } from '../email-conversations/service';
import type { DealActor } from '../deals/schema';
import { AppError } from '../errors';
import { withOutboundApproval } from '../outbound-approval';
import { notificationInput, notificationPreflight, notificationRecipientHash, notificationView, notificationActor, requireNotificationAdmin, notificationUnsubscribeToken } from './service';
import { defaultNotificationTransport, lookupNotificationReceipt } from './transport';
import type { NotificationRow, NotificationOutcome, NotificationContent, NotificationTransport } from './contracts';
let transportOverride: NotificationTransport | undefined;
export function setNotificationTransportForTests(transport?: NotificationTransport) { transportOverride = transport; }
const safeError = (code: string | undefined) => code && /^[a-z0-9_]{1,80}$/.test(code) ? code : 'notification_delivery_failed';
async function receipt(db: DbExecutor, row: NotificationRow, state: string, evidence: string, clock: string, providerId?: string) {
    await db.prepare(`INSERT INTO mca_notification_receipts(id,workspace_id,notification_id,state,provider_message_id,evidence,created_at) VALUES(?,?,?,?,?,?,?)`).run(newId(), row.workspace_id, row.id, state, providerId ?? null, evidence, clock);
}
/** Fencing token and state are checked in the same transaction as receipt persistence. */
export async function recordNotificationOutcome(workspaceId: string, id: string, token: string, outcome: NotificationOutcome, clock: string): Promise<boolean> {
    return withImmediateTransaction(async (db) => {
        const row = await db.prepare<NotificationRow>(`SELECT * FROM mca_notifications WHERE workspace_id=? AND id=? AND state='sending' AND claim_token=? FOR UPDATE`).get(workspaceId, id, token);
        if (!row)
            return false;
        const state = outcome.state === 'retry' && row.attempts >= 3 ? 'failed' : outcome.state;
        const next = state === 'retry' ? new Date(Date.parse(clock) + 15 * 60000 * 2 ** (row.attempts - 1)).toISOString() : clock;
        await db.prepare(`UPDATE mca_notifications SET state=?,provider_message_id=?,error_code=?,next_attempt_at=?,claim_token=NULL,lease_until=NULL,updated_at=? WHERE workspace_id=? AND id=? AND claim_token=?`).run(state, outcome.providerMessageId ?? null, ['retry', 'failed', 'uncertain'].includes(state) ? safeError(outcome.errorCode) : null, next, clock, workspaceId, id, token);
        await receipt(db, row, state, 'dispatch_result', clock, outcome.providerMessageId);
        return true;
    });
}
async function claim(clock: string): Promise<NotificationRow | undefined> {
    return withImmediateTransaction(async (db) => {
        const row = await db.prepare<NotificationRow>(`SELECT * FROM mca_notifications WHERE state IN ('queued','retry') AND next_attempt_at<=? AND scheduled_for<=? AND attempts<3 ORDER BY next_attempt_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`).get(clock, clock);
        if (!row)
            return;
        const token = newId(), until = new Date(Date.parse(clock) + 120000).toISOString();
        return db.prepare<NotificationRow>(`UPDATE mca_notifications SET state='sending',attempts=attempts+1,claim_token=?,lease_until=?,updated_at=? WHERE workspace_id=? AND id=? RETURNING *`).get(token, until, clock, row.workspace_id, row.id);
    });
}
async function expireClaims(clock: string) {
    await withImmediateTransaction(async (db) => {
        const rows = await db.prepare<NotificationRow>(`UPDATE mca_notifications SET state='uncertain',error_code='interrupted_dispatch',claim_token=NULL,lease_until=NULL,updated_at=? WHERE state='sending' AND lease_until<=? RETURNING *`).all(clock, clock);
        for (const row of rows)
            await receipt(db, row, 'uncertain', 'expired_dispatch_marker', clock);
    });
}
async function suppressClaim(row: NotificationRow, code: string, clock: string) {
    await withImmediateTransaction(async (db) => {
        const updated = await db.prepare<NotificationRow>(`UPDATE mca_notifications SET state='suppressed',error_code=?,claim_token=NULL,lease_until=NULL,updated_at=? WHERE workspace_id=? AND id=? AND state='sending' AND claim_token=? RETURNING *`).get(safeError(code), clock, row.workspace_id, row.id, row.claim_token);
        if (updated)
            await receipt(db, updated, 'suppressed', 'live_policy_check', clock);
    });
}
export async function runScheduledNotifications(clock = nowIso(), limit = 25) {
    const result = { attempted: 0, accepted: 0, uncertain: 0, suppressed: 0 };
    if (process.env.MCA_NOTIFICATION_RUNTIME !== 'enabled')
        return result;
    if (!Number.isFinite(Date.parse(clock)) || !Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new AppError(422, 'notification_clock_invalid', 'Use a valid clock and a limit between 1 and 100.');
    await expireClaims(clock);
    if (!transportOverride)
        await reconcileNotificationProviders(clock);
    const deadline = Date.now() + 230000;
    for (let i = 0; i < limit && Date.now() < deadline; i++) {
        const row = await claim(clock);
        if (!row)
            break;
        result.attempted++;
        let actor: DealActor, content: NotificationContent;
        const input = notificationInput(row);
        try {
            actor = await liveEmailActor(row.workspace_id, row.actor_membership_id);
            const fresh = await notificationPreflight(actor, input);
            if (notificationRecipientHash(row.workspace_id, row.channel, fresh.recipient) !== row.recipient_hash)
                throw new AppError(409, 'notification_recipient_changed', 'Review the changed recipient.');
            content = row.content_cipher ? JSON.parse(decryptSensitive(row.content_cipher, row.workspace_id)) : fresh;
            if (!row.content_cipher) {
                const origin = process.env.MCA_APP_ORIGIN ?? 'http://localhost:3000';
                const url = new URL('/api/notifications/unsubscribe', origin);
                if (url.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
                    throw new AppError(503, 'notification_origin_invalid', 'Configure a secure application origin.');
                url.searchParams.set('token', notificationUnsubscribeToken(row.workspace_id, row.id));
                content = { ...content, text: `${content.text}\n\nStop these notifications: ${url.toString()}` };
                if (row.channel === 'sms' && content.text.length > 1600)
                    throw new AppError(422, 'notification_text_too_long', 'The SMS including its unsubscribe link exceeds1600 characters.');
                const saved = await getDatabase().prepare(`UPDATE mca_notifications SET content_cipher=? WHERE workspace_id=? AND id=? AND claim_token=? AND state='sending'`).run(encryptSensitive(JSON.stringify(content), row.workspace_id), row.workspace_id, row.id, row.claim_token);
                if (!saved.changes)
                    continue;
            }
        }
        catch (error) {
            if (!(error instanceof AppError))
                throw error;
            await suppressClaim(row, error.code, clock);
            result.suppressed++;
            continue;
        }
        const message = { ...content, id: row.id, workspaceId: row.workspace_id, actor, dealId: row.deal_id, audience: row.audience, channel: row.channel, senderId: row.sender_id ?? undefined, approvedAt: row.approved_at, idempotencyKey: `notification:${row.id}` };
        let outcome: NotificationOutcome;
        try {
            const send = () => (transportOverride ?? defaultNotificationTransport)(message);
            outcome = row.audience === 'merchant' ? await withOutboundApproval(row.workspace_id, row.approved_at, send) : await send();
        }
        catch {
            outcome = { state: 'uncertain', errorCode: 'provider_outcome_unknown' };
        }
        const recorded = await recordNotificationOutcome(row.workspace_id, row.id, row.claim_token!, outcome, clock);
        if (!recorded)
            continue;
        if (outcome.state === 'accepted' || outcome.state === 'delivered')
            result.accepted++;
        if (outcome.state === 'uncertain')
            result.uncertain++;
    }
    return result;
}
const reconcileSchema = z.object({ outcome: z.enum(['accepted', 'delivered', 'failed']), evidence: z.string().trim().min(10).max(1000) }).strict();
/** Human evidence can resolve uncertainty but can never authorize automatic replay. */
export async function reconcileNotification(actor: DealActor, id: string, raw: z.infer<typeof reconcileSchema>) {
    const input = reconcileSchema.parse(raw), live = await notificationActor(actor);
    requireNotificationAdmin(live);
    return withImmediateTransaction(async (db) => {
        const row = await db.prepare<NotificationRow>(`SELECT * FROM mca_notifications WHERE workspace_id=? AND id=? AND state IN ('uncertain','accepted') FOR UPDATE`).get(live.workspaceId, id);
        if (!row)
            throw new AppError(404, 'notification_not_reconcilable', 'The notification is not available for reconciliation.');
        await db.prepare(`UPDATE mca_notifications SET state=?,error_code=NULL,claim_token=NULL,lease_until=NULL,updated_at=? WHERE workspace_id=? AND id=?`).run(input.outcome, nowIso(), live.workspaceId, id);
        await receipt(db, row, input.outcome, input.evidence, nowIso(), row.provider_message_id ?? undefined);
        await recordAuditEvent({ context: live, action: 'notification.reconciled', resourceType: 'notification', resourceId: id, metadata: { outcome: input.outcome }, executor: db });
        return notificationView({ ...row, state: input.outcome, error_code: null });
    });
}
type ReceiptLookup = (row: NotificationRow) => Promise<NotificationOutcome | undefined>;
let receiptLookupOverride: ReceiptLookup | undefined;
export function setNotificationReceiptLookupForTests(lookup?: ReceiptLookup) { receiptLookupOverride = lookup; }
export async function reconcileNotificationProviders(clock = nowIso(), limit = 5) {
    if (process.env.MCA_NOTIFICATION_RUNTIME !== 'enabled')
        return { resolved: 0 };
    if (!Number.isFinite(Date.parse(clock)) || !Number.isInteger(limit) || limit < 1 || limit > 25)
        throw new AppError(422, 'notification_clock_invalid', 'Use a valid clock and a limit between 1 and 25.');
    const rows = await getDatabase().prepare<NotificationRow>(`SELECT * FROM mca_notifications WHERE state IN ('uncertain','accepted') AND next_attempt_at<=? ORDER BY next_attempt_at,id LIMIT ?`).all(clock, limit);
    let resolved = 0;
    for (const row of rows) {
        const nextCheck = new Date(Date.parse(clock) + 15 * 60000).toISOString();
        const claimed = await getDatabase().prepare(`UPDATE mca_notifications SET next_attempt_at=? WHERE workspace_id=? AND id=? AND state=? AND next_attempt_at=?`).run(nextCheck, row.workspace_id, row.id, row.state, row.next_attempt_at);
        if (!claimed.changes)
            continue;
        let outcome: NotificationOutcome | undefined;
        try {
            outcome = await (receiptLookupOverride ?? lookupNotificationReceipt)(row);
        }
        catch {
            continue;
        }
        if (!outcome || !['accepted', 'delivered', 'failed'].includes(outcome.state))
            continue;
        if (outcome.state === row.state && (!outcome.providerMessageId || outcome.providerMessageId === row.provider_message_id))
            continue;
        const updated = await withImmediateTransaction(async (db) => {
            const saved = await db.prepare<NotificationRow>(`UPDATE mca_notifications SET state=?,provider_message_id=COALESCE(?,provider_message_id),error_code=NULL,updated_at=? WHERE workspace_id=? AND id=? AND state=? AND updated_at=? RETURNING *`).get(outcome!.state, outcome!.providerMessageId ?? null, clock, row.workspace_id, row.id, row.state, row.updated_at);
            if (saved)
                await receipt(db, saved, outcome!.state, 'verified_provider_lookup', clock, outcome!.providerMessageId);
            return Boolean(saved);
        });
        if (updated)
            resolved++;
    }
    return { resolved };
}

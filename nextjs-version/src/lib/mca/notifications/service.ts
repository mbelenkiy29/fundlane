import 'server-only';
import { checkNotificationCondition } from './conditions';
import { createHash } from 'node:crypto';
import { getDatabase, newId, nowIso, recordAuditEvent, type DbExecutor } from '../db';
import { encryptSensitive, decryptSensitive, hmacScopedToken, hashOpaqueToken } from '../crypto';
import { getDealForDocument } from '../deals/service';
import type { DealActor } from '../deals/schema';
import { AppError } from '../errors';
import { liveEmailActor, emailSender } from '../email-conversations/service';
import { getPublishedMessageTemplate, renderPublishedMessageTemplate } from '../comms/templates';
import { getSmsConsent, normalizeSmsRecipient } from '../sms/service';
import { assertCompanyOperational } from '../company-access';
import { assertOutboundDispatch } from '../outbound-approval';
import { notificationInputSchema, type NotificationInput, type NotificationRow, type NotificationView, type NotificationContent } from './contracts';
export const notificationRecipientHash = (workspaceId: string, channel: string, recipient: string) => hmacScopedToken(`notification:${channel}`, workspaceId, recipient.trim().toLowerCase());
export const notificationView = (row: NotificationRow): NotificationView => ({ id: row.id, state: row.state, attempts: row.attempts, scheduledFor: row.scheduled_for, providerMessageId: row.provider_message_id ?? undefined, errorCode: row.error_code ?? undefined });
export function requireNotificationAdmin(actor: DealActor) {
    if (actor.source !== 'user' || !['admin', 'super_admin'].includes(actor.role ?? ''))
        throw new AppError(403, 'notification_admin_required', 'A company administrator is required.');
}
export async function notificationActor(actor: DealActor) {
    if (actor.source !== 'user' || !actor.membershipId)
        throw new AppError(403, 'notification_member_required', 'An active company member is required.');
    const live = await liveEmailActor(actor.workspaceId, actor.membershipId);
    if (live.userId !== actor.userId)
        throw new AppError(403, 'notification_member_required', 'An active company member is required.');
    return live;
}
export async function setNotificationPolicy(actor: DealActor, input: {
    kind: 'document' | 'renewal' | 'missed_call';
    brokerEnabled: boolean;
    merchantEnabled: boolean;
}) {
    const live = await notificationActor(actor);
    requireNotificationAdmin(live);
    const kind = notificationInputSchema.shape.kind.parse(input.kind);
    await getDatabase().prepare(`INSERT INTO mca_notification_policies(workspace_id,kind,broker_enabled,merchant_enabled,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(workspace_id,kind) DO UPDATE SET broker_enabled=excluded.broker_enabled,merchant_enabled=excluded.merchant_enabled,updated_at=excluded.updated_at`).run(live.workspaceId, kind, input.brokerEnabled ? 1 : 0, input.merchantEnabled ? 1 : 0, nowIso());
    await recordAuditEvent({ context: live, action: 'notification.policy_updated', resourceType: 'notification_policy', resourceId: kind, metadata: { brokerEnabled: input.brokerEnabled, merchantEnabled: input.merchantEnabled } });
}
async function resolveRecipient(actor: DealActor, input: Pick<NotificationInput, 'dealId' | 'audience' | 'channel' | 'recipientUserId'>) {
    const deal = input.dealId ? await getDealForDocument(actor, input.dealId) : undefined;
    if (input.audience === 'broker') {
        if (input.channel !== 'email')
            throw new AppError(409, 'broker_sms_unavailable', 'Staff SMS requires an approved consent transport.');
        const member = await getDatabase().prepare<{
            id: string;
            email: string;
        }>(`SELECT m.id,u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND m.user_id=? AND m.status='active'`).get(actor.workspaceId, input.recipientUserId ?? '');
        if (!member)
            throw new AppError(404, 'notification_recipient_unavailable', 'The company recipient is unavailable.');
        const recipientActor = await liveEmailActor(actor.workspaceId, member.id);
        if (input.dealId)
            await getDealForDocument(recipientActor, input.dealId);
        return member.email.trim().toLowerCase();
    }
    if (!deal)
        throw new AppError(422, 'notification_deal_required', 'Merchant messages require a company deal.');
    if (input.recipientUserId)
        throw new AppError(422, 'notification_recipient_invalid', 'Merchant recipients resolve from the deal contact.');
    const raw = input.channel === 'email' ? deal.contactEmail : deal.contactPhone;
    if (!raw)
        throw new AppError(409, 'notification_recipient_unavailable', 'The deal contact is unavailable.');
    if (input.channel === 'sms')
        return normalizeSmsRecipient(raw);
    const email = raw.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        throw new AppError(422, 'notification_recipient_invalid', 'The deal email is invalid.');
    return email;
}
export async function notificationPreflight(actor: DealActor, input: NotificationInput): Promise<NotificationContent> {
    await assertCompanyOperational(actor.workspaceId);
    const notificationValues = await checkNotificationCondition(actor, input.condition);
    const recipient = await resolveRecipient(actor, input);
    const db = getDatabase();
    const policy = await db.prepare<{
        broker_enabled: number;
        merchant_enabled: number;
    }>(`SELECT broker_enabled,merchant_enabled FROM mca_notification_policies WHERE workspace_id=? AND kind=?`).get(actor.workspaceId, input.kind);
    if (input.audience === 'merchant' ? !policy?.merchant_enabled : policy?.broker_enabled === 0)
        throw new AppError(409, 'notification_policy_disabled', 'Notifications must be enabled for this company.');
    const hash = notificationRecipientHash(actor.workspaceId, input.channel, recipient);
    const preference = await db.prepare<{
        consented: number;
        suppressed: number;
    }>(`SELECT consented,suppressed FROM mca_notification_preferences WHERE workspace_id=? AND channel=? AND recipient_hash=?`).get(actor.workspaceId, input.channel, hash);
    if (preference?.suppressed)
        throw new AppError(409, 'notification_suppressed', 'This recipient is suppressed.');
    if (input.audience === 'broker') {
        if (!input.payload || input.templateId)
            throw new AppError(422, 'notification_payload_required', 'Internal alerts require a title and message.');
        return { recipient, subject: input.payload.title, text: input.payload.message };
    }
    await assertOutboundDispatch(actor.workspaceId, input.approvedAt);
    if (input.payload)
        throw new AppError(422, 'notification_payload_invalid', 'Merchant messages require a published template.');
    if (input.channel === 'email' && !preference?.consented)
        throw new AppError(409, 'notification_consent_required', 'Record recipient email notification consent first.');
    if (input.channel === 'sms' && (await getSmsConsent(actor, input.dealId!, recipient)).state !== 'opted_in')
        throw new AppError(409, 'notification_consent_required', 'Record recipient SMS consent first.');
    const template = await getPublishedMessageTemplate(actor, input.templateId ?? '');
    if (template.channel !== input.channel || !['merchant', 'followup', 'request_info'].includes(template.scope))
        throw new AppError(422, 'notification_template_invalid', 'Choose a published merchant template for this channel.');
    if (input.channel === 'email')
        await emailSender(actor, input.senderId ?? '', true);
    const rendered = await renderPublishedMessageTemplate(actor, { templateId: template.id, dealId: input.dealId!, origin: process.env.MCA_APP_ORIGIN ?? 'http://localhost:3000', ...(notificationValues ? { notificationValues } : {}) });
    if (rendered.publishBlocked || rendered.unknownVariables.length || rendered.forbiddenVariables.length)
        throw new AppError(422, 'notification_template_invalid', 'The template is not safe to send.');
    if (input.channel === 'sms' && rendered.text.length > 1600)
        throw new AppError(422, 'notification_template_invalid', 'SMS text must fit 1600 characters.');
    return { recipient, subject: rendered.subject, text: rendered.text };
}
export async function enqueueNotification(actor: DealActor, raw: NotificationInput, options?: {
    executor?: DbExecutor;
}): Promise<NotificationView> {
    const input = notificationInputSchema.parse(raw), live = await notificationActor(actor), db = options?.executor ?? getDatabase();
    if (Date.parse(input.approvedAt) > Date.now())
        throw new AppError(422, 'notification_approval_invalid', 'Approval cannot be in the future.');
    const content = await notificationPreflight(live, input), hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const recipientKey = input.audience === 'broker' ? input.recipientUserId! : 'merchant';
    const clock = nowIso(), id = newId();
    const row = await db.prepare<NotificationRow>(`INSERT INTO mca_notifications(id,workspace_id,deal_id,event_key,kind,audience,channel,recipient_key,recipient_user_id,actor_membership_id,template_id,sender_id,approved_at,scheduled_for,payload_cipher,recipient_hash,payload_hash,state,attempts,next_attempt_at,unsubscribe_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'queued',0,?,?,?,?) ON CONFLICT(workspace_id,event_key,audience,channel,recipient_key) DO NOTHING RETURNING *`).get(id, live.workspaceId, input.dealId ?? null, input.eventKey, input.kind, input.audience, input.channel, recipientKey, input.recipientUserId ?? null, live.membershipId, input.templateId ?? null, input.senderId ?? null, input.approvedAt, input.scheduledFor, encryptSensitive(JSON.stringify(input), live.workspaceId), notificationRecipientHash(live.workspaceId, input.channel, content.recipient), hash, input.scheduledFor, hashOpaqueToken(notificationUnsubscribeToken(live.workspaceId, id)), clock, clock);
    const saved = row ?? await db.prepare<NotificationRow>(`SELECT * FROM mca_notifications WHERE workspace_id=? AND event_key=? AND audience=? AND channel=? AND recipient_key=?`).get(live.workspaceId, input.eventKey, input.audience, input.channel, recipientKey);
    if (!saved)
        throw new Error('Notification enqueue did not return a row.');
    if (saved.payload_hash !== hash)
        throw new AppError(409, 'notification_idempotency_conflict', 'That event already identifies different notification content.');
    return notificationView(saved);
}
export async function getNotification(actor: DealActor, id: string): Promise<NotificationView> {
    const live = await notificationActor(actor), row = await getDatabase().prepare<NotificationRow>('SELECT * FROM mca_notifications WHERE workspace_id=? AND id=?').get(live.workspaceId, id);
    if (!row)
        throw new AppError(404, 'notification_not_found', 'The notification was not found.');
    if (row.deal_id)
        await getDealForDocument(live, row.deal_id);
    return notificationView(row);
}
export const notificationInput = (row: NotificationRow) => notificationInputSchema.parse(JSON.parse(decryptSensitive(row.payload_cipher, row.workspace_id)));
export async function setNotificationConsent(actor: DealActor, input: {
    dealId: string;
    channel: 'email' | 'sms';
    enabled: boolean;
}) {
    const live = await notificationActor(actor);
    requireNotificationAdmin(live);
    if (input.channel !== 'email')
        throw new AppError(422, 'notification_sms_consent_owned', 'Use the existing SMS consent service.');
    const recipient = await resolveRecipient(live, { ...input, audience: 'merchant' });
    await getDatabase().prepare(`INSERT INTO mca_notification_preferences(workspace_id,channel,recipient_hash,consented,suppressed,updated_at) VALUES(?,?,?, ?,0,?) ON CONFLICT(workspace_id,channel,recipient_hash) DO UPDATE SET consented=excluded.consented,updated_at=excluded.updated_at`).run(live.workspaceId, input.channel, notificationRecipientHash(live.workspaceId, input.channel, recipient), input.enabled ? 1 : 0, nowIso());
    await recordAuditEvent({ context: live, action: 'notification.consent_updated', resourceType: 'deal', resourceId: input.dealId, metadata: { channel: input.channel, enabled: input.enabled } });
}
export async function suppressNotificationRecipient(actor: DealActor, input: {
    dealId: string;
    channel: 'email' | 'sms';
    audience?: 'broker' | 'merchant';
    recipientUserId?: string;
}) {
    const live = await notificationActor(actor);
    requireNotificationAdmin(live);
    const channel = notificationInputSchema.shape.channel.parse(input.channel);
    const recipient = await resolveRecipient(live, { ...input, channel, audience: input.audience ?? 'merchant' });
    await suppressRecipient(live.workspaceId, channel, notificationRecipientHash(live.workspaceId, channel, recipient));
    await recordAuditEvent({ context: live, action: 'notification.suppressed', resourceType: 'deal', resourceId: input.dealId, metadata: { channel } });
}
export async function suppressRecipient(workspaceId: string, channel: string, hash: string) {
    await getDatabase().prepare(`INSERT INTO mca_notification_preferences(workspace_id,channel,recipient_hash,consented,suppressed,updated_at) VALUES(?,?,?,0,1,?) ON CONFLICT(workspace_id,channel,recipient_hash) DO UPDATE SET suppressed=1,updated_at=excluded.updated_at`).run(workspaceId, channel, hash, nowIso());
}
export const notificationUnsubscribeToken = (workspaceId: string, id: string) => hmacScopedToken('notification-unsubscribe', workspaceId, id);
/** Capability is recipient-scoped, opaque and reusable; it reveals no tenant data. */
export async function unsubscribeNotification(token: string): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
        return false;
    const row = await getDatabase().prepare<NotificationRow>('SELECT * FROM mca_notifications WHERE unsubscribe_hash=?').get(hashOpaqueToken(token));
    if (!row)
        return false;
    await suppressRecipient(row.workspace_id, row.channel, row.recipient_hash);
    return true;
}

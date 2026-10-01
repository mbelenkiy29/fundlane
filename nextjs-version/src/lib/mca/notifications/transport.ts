import 'server-only';
import { createHash } from 'node:crypto';
import { AppError } from '../errors';
import { Mailbox, EmailProviderError } from '../email-conversations/providers';
import { emailSender } from '../email-conversations/service';
import { sendSystemEmail, systemEmailCredentials } from '../system-email';
import { deliverClosingSms } from '../sms/service';
import { NotificationDispatchBlocked, NotificationDeadlineError, type NotificationLookupContext } from './contracts';
import type { NotificationMessage, NotificationOutcome } from './contracts';
/** Uses existing providers; uncertain acceptance must never be classified as retryable. */
export async function defaultNotificationTransport(message: NotificationMessage): Promise<NotificationOutcome> {
    const beforeRequest = async () => {
        if (message.deadlineMs - Date.now() < 15000)
            throw new NotificationDeadlineError();
        await message.beforeSend();
        if (message.deadlineMs - Date.now() < 15000)
            throw new NotificationDeadlineError();
    };
    if (message.channel === 'sms') {
        if (!message.dealId)
            return { state: 'failed', errorCode: 'notification_deal_required' };
        await beforeRequest();
        const result = await deliverClosingSms(message.actor, { dealId: message.dealId, recipient: message.recipient, body: message.text, idempotencyKey: message.idempotencyKey, correlationId: message.id, payloadHash: createHash('sha256').update(message.text).digest('hex'), deliveryMode: 'never_attempted' });
        return { state: result.state === 'unknown' ? 'uncertain' : result.state === 'accepted' ? 'accepted' : 'failed', providerMessageId: result.externalId, errorCode: result.errorCode };
    }
    if (message.audience === 'broker') {
        const credentials = systemEmailCredentials();
        if (!credentials)
            return { state: 'failed', errorCode: 'system_email_unconfigured' };
        try {
            await beforeRequest();
            const result = await sendSystemEmail({ apiKey: credentials.apiKey, from: credentials.from, to: message.recipient, subject: message.subject ?? 'Fundlane notification', text: message.text, html: `<p>${escapeHtml(message.text).replace(/\n/g, '<br>')}</p>`, idempotencyKey: message.idempotencyKey });
            return { state: 'accepted', providerMessageId: result.emailId };
        }
        catch (error) {
            if (error instanceof NotificationDispatchBlocked || error instanceof NotificationDeadlineError)
                throw error;
            const status = error instanceof AppError ? error.extra?.providerStatus : undefined;
            return { state: status === 429 ? 'retry' : typeof status === 'number' && [400, 401, 403, 422].includes(status) ? 'failed' : 'uncertain', errorCode: status === 429 ? 'rate_limited' : 'system_email_send_failed' };
        }
    }
    const sender = await emailSender(message.actor, message.senderId ?? '', true);
    const mailbox = new Mailbox(sender, beforeRequest);
    try {
        await mailbox.connect();
        await beforeRequest();
        const result = await mailbox.send({ id: message.id, internetId: `<${message.id}@notifications.fundlane>`, to: message.recipient, subject: message.subject ?? 'Fundlane notification', body: message.text });
        return { state: 'accepted', providerMessageId: result.id };
    }
    catch (error) {
        if (error instanceof NotificationDispatchBlocked || error instanceof NotificationDeadlineError)
            throw error;
        if (error instanceof EmailProviderError)
            return { state: error.uncertain ? 'uncertain' : error.status === 429 ? 'retry' : 'failed', errorCode: 'mailbox_send_failed' };
        return { state: 'uncertain', errorCode: 'mailbox_outcome_unknown' };
    }
}
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
/** Read existing provider ledgers or Sent mail; a missing result never means safe to resend. */
export async function lookupNotificationReceipt(row: import('./contracts').NotificationRow, context: NotificationLookupContext = { deadlineMs: Date.now() + 60000 }): Promise<NotificationOutcome | undefined> {
    const { getDatabase } = await import('../db');
    if (row.channel === 'sms') {
        const sms = await getDatabase().prepare<{
            state: string;
            provider_message_id: string | null;
        }>(`SELECT state,provider_message_id FROM mca_sms_messages WHERE workspace_id=? AND idempotency_key=?`).get(row.workspace_id, `notification:${row.id}`);
        if (!sms || !['accepted', 'sent', 'delivered', 'failed'].includes(sms.state))
            return;
        return { state: sms.state === 'delivered' ? 'delivered' : sms.state === 'failed' ? 'failed' : 'accepted', providerMessageId: sms.provider_message_id ?? undefined };
    }
    if (row.audience === 'broker' || !row.sender_id)
        return; // System providers require operator receipt review.
    const { liveEmailActor } = await import('../email-conversations/service');
    const actor = await liveEmailActor(row.workspace_id, row.actor_membership_id);
    const beforeRequest = async () => {
        if (context.deadlineMs - (context.now ?? Date.now)() < 15000)
            throw new NotificationDeadlineError();
    };
    const mailbox = new Mailbox(await emailSender(actor, row.sender_id, true), beforeRequest);
    await beforeRequest();
    await mailbox.connect();
    const found = await mailbox.findSent({ id: row.id, internetId: `<${row.id}@notifications.fundlane>`, createdAt: row.created_at });
    if (found)
        return { state: 'accepted', providerMessageId: found.id };
}

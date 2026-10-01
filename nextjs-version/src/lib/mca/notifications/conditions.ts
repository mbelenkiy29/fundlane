import 'server-only';
import { z } from 'zod';
import type { DealActor } from '../deals/schema';
import { AppError } from '../errors';
export const notificationConditionSchema = z.object({ type: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/), key: z.string().min(1).max(1000), version: z.string().min(1).max(80).optional() }).strict();
export type NotificationCondition = z.infer<typeof notificationConditionSchema>;
export type NotificationTemplateValues = {
    document_request_url?: string;
    document_request_label?: string;
};
export type NotificationConditionResult = boolean | {
    eligible: boolean;
    templateValues?: NotificationTemplateValues;
};
export type NotificationConditionGuard = (actor: DealActor, condition: NotificationCondition) => Promise<NotificationConditionResult>;
const guards = new Map<string, NotificationConditionGuard>();
/** Register from producer module AND scheduled runtime bootstrap, in each process. */
export function registerNotificationCondition(type: string, guard: NotificationConditionGuard) {
    notificationConditionSchema.shape.type.parse(type);
    guards.set(type, guard);
}
export async function checkNotificationCondition(actor: DealActor, condition?: NotificationCondition): Promise<NotificationTemplateValues | undefined> {
    if (!condition)
        return;
    const guard = guards.get(condition.type);
    if (!guard)
        throw new AppError(409, 'notification_condition_unavailable', 'The notification condition is not available in this runtime.');
    const result = await guard(actor, condition);
    const eligible = typeof result === 'boolean' ? result : result.eligible;
    if (!eligible)
        throw new AppError(409, 'notification_condition_resolved', 'The notification is no longer applicable.');
    return typeof result === 'boolean' ? undefined : result.templateValues;
}

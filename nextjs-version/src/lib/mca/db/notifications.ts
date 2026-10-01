import {sql} from "drizzle-orm"
import {pgTable,text,integer,primaryKey,unique,index,check,foreignKey} from "drizzle-orm/pg-core"
import {workspaces,users,deals,memberships} from "./schema"

export const mca_notification_policies=pgTable("mca_notification_policies",{
 workspace_id:text().notNull().references(()=>workspaces.id),
 kind:text().notNull(),
 broker_enabled:integer().notNull().default(1),
 merchant_enabled:integer().notNull().default(0),
 updated_at:text().notNull(),
},t=>[
 primaryKey({columns:[t.workspace_id,t.kind]}),
 check("mca_notification_policies_kind_check",sql`kind IN ('document','renewal','missed_call')`),
 check("mca_notification_policies_broker_enabled_check",sql`broker_enabled IN (0,1)`),
 check("mca_notification_policies_merchant_enabled_check",sql`merchant_enabled IN (0,1)`),
])

export const mca_notification_preferences=pgTable("mca_notification_preferences",{
 workspace_id:text().notNull().references(()=>workspaces.id),
 channel:text().notNull(),
 recipient_hash:text().notNull(),
 consented:integer().notNull().default(0),
 suppressed:integer().notNull().default(0),
 updated_at:text().notNull(),
},t=>[
 primaryKey({columns:[t.workspace_id,t.channel,t.recipient_hash]}),
 check("mca_notification_preferences_channel_check",sql`channel IN ('email','sms')`),
 check("mca_notification_preferences_consented_check",sql`consented IN (0,1)`),
 check("mca_notification_preferences_suppressed_check",sql`suppressed IN (0,1)`),
])

export const mca_notifications=pgTable("mca_notifications",{
 id:text().primaryKey(),
 workspace_id:text().notNull().references(()=>workspaces.id),
 deal_id:text(),
 event_key:text().notNull(),
 kind:text().notNull(),
 audience:text().notNull(),
 channel:text().notNull(),
 recipient_key:text().notNull(),
 recipient_user_id:text().references(()=>users.id),
 actor_membership_id:text().notNull(),
 template_id:text(),
 sender_id:text(),
 approved_at:text().notNull(),
 scheduled_for:text().notNull(),
 payload_cipher:text().notNull(),
 content_cipher:text(),
 recipient_hash:text().notNull(),
 payload_hash:text().notNull(),
 state:text().notNull().default('queued'),
 attempts:integer().notNull().default(0),
 next_attempt_at:text().notNull(),
 claim_token:text(),
 lease_until:text(),
 provider_message_id:text(),
 error_code:text(),
 unsubscribe_hash:text().unique(),
 created_at:text().notNull(),
 updated_at:text().notNull(),
},t=>[
 unique("mca_notifications_workspace_id_id_key").on(t.workspace_id,t.id),
 unique("mca_notifications_event_key").on(t.workspace_id,t.event_key,t.audience,t.channel,t.recipient_key),
 foreignKey({columns:[t.workspace_id,t.deal_id],foreignColumns:[deals.workspace_id,deals.id]}),
 foreignKey({columns:[t.workspace_id,t.actor_membership_id],foreignColumns:[memberships.workspace_id,memberships.id]}),
 index("mca_notifications_due_idx").on(t.state,t.next_attempt_at),
 check("mca_notifications_kind_check",sql`kind IN ('document','renewal','missed_call')`),
 check("mca_notifications_audience_check",sql`audience IN ('broker','merchant')`),
 check("mca_notifications_channel_check",sql`channel IN ('email','sms')`),
 check("mca_notifications_state_check",sql`state IN ('queued','sending','retry','accepted','delivered','suppressed','failed','uncertain')`),
 check("mca_notifications_attempts_check",sql`attempts BETWEEN 0 AND 3`),
])

export const mca_notification_receipts=pgTable("mca_notification_receipts",{
 id:text().primaryKey(),
 workspace_id:text().notNull().references(()=>workspaces.id),
 notification_id:text().notNull(),
 state:text().notNull(),
 provider_message_id:text(),
 evidence:text().notNull(),
 created_at:text().notNull(),
},t=>[
 foreignKey({columns:[t.workspace_id,t.notification_id],foreignColumns:[mca_notifications.workspace_id,mca_notifications.id]}),
 check("mca_notification_receipts_state_check",sql`state IN ('accepted','delivered','retry','failed','uncertain','suppressed')`),
])


CREATE UNIQUE INDEX IF NOT EXISTS deals_workspace_id_id_unique ON deals(workspace_id,id);
--> statement-breakpoint
CREATE TABLE mca_notification_policies (
  workspace_id text NOT NULL REFERENCES workspaces(id),
  kind text NOT NULL CHECK(kind IN ('document','renewal')),
  broker_enabled integer NOT NULL DEFAULT 1 CHECK(broker_enabled IN (0,1)),
  merchant_enabled integer NOT NULL DEFAULT 0 CHECK(merchant_enabled IN (0,1)),
  updated_at text NOT NULL,
  PRIMARY KEY(workspace_id,kind)
);
--> statement-breakpoint
ALTER TABLE mca_notification_policies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON mca_notification_policies FROM PUBLIC;
--> statement-breakpoint
DO $grants$ BEGIN
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON mca_notification_policies FROM anon; END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON mca_notification_policies FROM authenticated; END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='mca_app') THEN
 GRANT SELECT,INSERT,UPDATE ON mca_notification_policies TO mca_app;
 CREATE POLICY mca_server_access ON mca_notification_policies TO mca_app USING(true) WITH CHECK(true);
 END IF;
END $grants$;
--> statement-breakpoint
CREATE TABLE mca_notification_preferences (
  workspace_id text NOT NULL REFERENCES workspaces(id),
  channel text NOT NULL CHECK(channel IN ('email','sms')),
  recipient_hash text NOT NULL,
  consented integer NOT NULL DEFAULT 0 CHECK(consented IN (0,1)),
  suppressed integer NOT NULL DEFAULT 0 CHECK(suppressed IN (0,1)),
  updated_at text NOT NULL,
  PRIMARY KEY(workspace_id,channel,recipient_hash)
);
--> statement-breakpoint
ALTER TABLE mca_notification_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON mca_notification_preferences FROM PUBLIC;
--> statement-breakpoint
DO $grants$ BEGIN
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON mca_notification_preferences FROM anon; END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON mca_notification_preferences FROM authenticated; END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='mca_app') THEN
 GRANT SELECT,INSERT,UPDATE ON mca_notification_preferences TO mca_app;
 CREATE POLICY mca_server_access ON mca_notification_preferences TO mca_app USING(true) WITH CHECK(true);
 END IF;
END $grants$;
--> statement-breakpoint
CREATE TABLE mca_notifications (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  deal_id text NOT NULL,
  event_key text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('document','renewal')),
  audience text NOT NULL CHECK(audience IN ('broker','merchant')),
  channel text NOT NULL CHECK(channel IN ('email','sms')),
  recipient_key text NOT NULL,
  recipient_user_id text REFERENCES users(id),
  actor_membership_id text NOT NULL,
  template_id text,
  sender_id text,
  approved_at text NOT NULL,
  scheduled_for text NOT NULL,
  payload_cipher text NOT NULL,
  content_cipher text,
  recipient_hash text NOT NULL,
  payload_hash text NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','sending','retry','accepted','delivered','suppressed','failed','uncertain')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
  next_attempt_at text NOT NULL,
  claim_token text,
  lease_until text,
  provider_message_id text,
  error_code text,
  unsubscribe_hash text UNIQUE,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  UNIQUE(workspace_id,id),
  UNIQUE(workspace_id,event_key,audience,channel,recipient_key),
  FOREIGN KEY(workspace_id,deal_id) REFERENCES deals(workspace_id,id),
  FOREIGN KEY(workspace_id,actor_membership_id) REFERENCES memberships(workspace_id,id)
);
--> statement-breakpoint
ALTER TABLE mca_notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON mca_notifications FROM PUBLIC;
--> statement-breakpoint
DO $grants$ BEGIN
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON mca_notifications FROM anon; END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON mca_notifications FROM authenticated; END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='mca_app') THEN
 GRANT SELECT,INSERT,UPDATE ON mca_notifications TO mca_app;
 CREATE POLICY mca_server_access ON mca_notifications TO mca_app USING(true) WITH CHECK(true);
 END IF;
END $grants$;
--> statement-breakpoint
CREATE TABLE mca_notification_receipts (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  notification_id text NOT NULL,
  state text NOT NULL CHECK(state IN ('accepted','delivered','retry','failed','uncertain','suppressed')),
  provider_message_id text,
  evidence text NOT NULL,
  created_at text NOT NULL,
  FOREIGN KEY(workspace_id,notification_id) REFERENCES mca_notifications(workspace_id,id)
);
--> statement-breakpoint
ALTER TABLE mca_notification_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON mca_notification_receipts FROM PUBLIC;
--> statement-breakpoint
DO $grants$ BEGIN
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON mca_notification_receipts FROM anon; END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON mca_notification_receipts FROM authenticated; END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='mca_app') THEN
 GRANT SELECT,INSERT ON mca_notification_receipts TO mca_app;
 CREATE POLICY mca_server_access ON mca_notification_receipts TO mca_app USING(true) WITH CHECK(true);
 END IF;
END $grants$;
--> statement-breakpoint
CREATE INDEX mca_notifications_due_idx ON mca_notifications(state,next_attempt_at);

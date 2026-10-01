CREATE TABLE mca_document_notification_discovery (
 workspace_id text PRIMARY KEY REFERENCES workspaces(id),
 enabled integer NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 broker_enabled integer NOT NULL DEFAULT 1 CHECK(broker_enabled IN (0,1)),
 merchant_enabled integer NOT NULL DEFAULT 0 CHECK(merchant_enabled IN (0,1)),
 reasons_json text NOT NULL,
 local_schedule text NOT NULL,
 channel text NOT NULL CHECK(channel IN ('email','sms')),
 template_id text,
 sender_id text,
 approval_version integer NOT NULL CHECK(approval_version>=1),
 approved_by_membership_id text NOT NULL,
 approved_at text NOT NULL,
 last_deal_id text NOT NULL DEFAULT '',
 active_deal_id text,
 last_item_key text NOT NULL DEFAULT '',
 cursor_occurrence_key text,
 checked_at text NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
 lease_token text,
 lease_until text,
 updated_at text NOT NULL,
 FOREIGN KEY(workspace_id,approved_by_membership_id) REFERENCES memberships(workspace_id,id)
);
--> statement-breakpoint
CREATE INDEX mca_document_notification_discovery_due_idx ON mca_document_notification_discovery(enabled,checked_at,workspace_id);
--> statement-breakpoint
ALTER TABLE mca_document_notification_discovery ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON mca_document_notification_discovery FROM PUBLIC;
--> statement-breakpoint
DO $grants$ BEGIN
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON mca_document_notification_discovery FROM anon; END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON mca_document_notification_discovery FROM authenticated; END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='mca_app') THEN
  GRANT SELECT,INSERT,UPDATE ON mca_document_notification_discovery TO mca_app;
  CREATE POLICY mca_server_access ON mca_document_notification_discovery TO mca_app USING(true) WITH CHECK(true);
 END IF;
END $grants$;

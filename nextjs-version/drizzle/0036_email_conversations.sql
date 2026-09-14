ALTER TABLE mca_email_senders ADD COLUMN owner_membership_id text REFERENCES memberships(id);
ALTER TABLE mca_email_oauth_states ADD COLUMN user_id text REFERENCES users(id);
--> statement-breakpoint
CREATE TABLE mca_email_conversations (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  deal_id text NOT NULL REFERENCES deals(id),
  sender_id text NOT NULL REFERENCES mca_email_senders(id),
  recipient_cipher text NOT NULL,
  subject_cipher text NOT NULL,
  provider_thread_id text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  next_sync_at text NOT NULL,
  last_synced_at text,
  sync_error text,
  UNIQUE(workspace_id,id)
);
CREATE INDEX email_conversations_deal_idx ON mca_email_conversations(workspace_id,deal_id,updated_at,id);
CREATE INDEX email_conversations_workspace_idx ON mca_email_conversations(workspace_id,updated_at,id);
CREATE INDEX email_conversations_sync_idx ON mca_email_conversations(next_sync_at);
--> statement-breakpoint
CREATE TABLE mca_email_messages (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  conversation_id text NOT NULL,
  sequence bigserial NOT NULL UNIQUE,
  direction text NOT NULL CHECK(direction IN ('inbound','outbound')),
  body_cipher text NOT NULL,
  author_cipher text NOT NULL,
  actor_membership_id text REFERENCES memberships(id),
  request_key text,
  payload_hash text,
  provider_message_id text,
  internet_message_id text NOT NULL,
  reply_to_message_id text,
  state text NOT NULL CHECK(state IN ('queued','sending','accepted','sent','received','failed','unknown','blocked')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at text NOT NULL,
  error text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  FOREIGN KEY(workspace_id,conversation_id) REFERENCES mca_email_conversations(workspace_id,id),
  UNIQUE(workspace_id,request_key),
  UNIQUE(conversation_id,provider_message_id)
);
CREATE INDEX email_messages_queue_idx ON mca_email_messages(state,next_attempt_at);
CREATE INDEX email_messages_thread_idx ON mca_email_messages(conversation_id,sequence);
--> statement-breakpoint
CREATE TABLE mca_email_reads (
  workspace_id text NOT NULL,
  conversation_id text NOT NULL,
  membership_id text NOT NULL REFERENCES memberships(id),
  last_sequence bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(conversation_id,membership_id),
  FOREIGN KEY(workspace_id,conversation_id) REFERENCES mca_email_conversations(workspace_id,id)
);
-- One lease per sender serializes refresh, sending, and synchronization across workers.
CREATE TABLE mca_email_worker_leases (
  sender_id text PRIMARY KEY REFERENCES mca_email_senders(id),
  workspace_id text NOT NULL REFERENCES workspaces(id),
  token text NOT NULL,
  expires_at text NOT NULL
);
--> statement-breakpoint
ALTER TABLE mca_email_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE mca_email_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE mca_email_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE mca_email_worker_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON mca_email_conversations,mca_email_messages,mca_email_reads,mca_email_worker_leases FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON mca_email_conversations,mca_email_messages,mca_email_reads,mca_email_worker_leases FROM anon; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON mca_email_conversations,mca_email_messages,mca_email_reads,mca_email_worker_leases FROM authenticated; END IF;
END $$;

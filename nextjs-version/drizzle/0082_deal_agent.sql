CREATE TABLE IF NOT EXISTS mca_deal_agent_runs (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  deal_id text NOT NULL,
  input_key text NOT NULL,
  trigger_document_id text,
  state text NOT NULL CONSTRAINT mca_deal_agent_runs_state_check CHECK (state IN ('running','completed','failed')),
  inputs_json text NOT NULL DEFAULT '{}',
  steps_json text NOT NULL DEFAULT '[]',
  error_code text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  completed_at text,
  CONSTRAINT mca_deal_agent_runs_deal_fk FOREIGN KEY (workspace_id, deal_id) REFERENCES deals(workspace_id, id),
  CONSTRAINT mca_deal_agent_runs_input_unique UNIQUE (workspace_id, deal_id, input_key)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mca_deal_agent_runs_deal_idx ON mca_deal_agent_runs (workspace_id, deal_id, created_at DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS mca_deal_agent_actions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  deal_id text NOT NULL,
  run_id text NOT NULL REFERENCES mca_deal_agent_runs(id),
  kind text NOT NULL CONSTRAINT mca_deal_agent_actions_kind_check CHECK (kind IN ('request_documents','submit_to_funder','schedule_follow_up')),
  target_key text NOT NULL,
  fingerprint text NOT NULL,
  payload_json text NOT NULL,
  next_fingerprint text,
  next_payload_json text,
  status text NOT NULL CONSTRAINT mca_deal_agent_actions_status_check CHECK (status IN ('pending','executing','approved','dismissed','superseded','failed')),
  preview_id text,
  result_json text,
  error_code text,
  decided_by_user_id text REFERENCES users(id),
  decided_at text,
  decision_note text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  CONSTRAINT mca_deal_agent_actions_deal_fk FOREIGN KEY (workspace_id, deal_id) REFERENCES deals(workspace_id, id),
  CONSTRAINT mca_deal_agent_actions_target_unique UNIQUE (workspace_id, deal_id, target_key, fingerprint)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS mca_deal_agent_actions_open_idx ON mca_deal_agent_actions (workspace_id, deal_id, target_key) WHERE status IN ('pending','executing');
--> statement-breakpoint
ALTER TABLE mca_deal_agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE mca_deal_agent_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON mca_deal_agent_runs, mca_deal_agent_actions FROM PUBLIC;
DO $grants$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON mca_deal_agent_runs, mca_deal_agent_actions FROM anon;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON mca_deal_agent_runs, mca_deal_agent_actions FROM authenticated;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mca_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON mca_deal_agent_runs, mca_deal_agent_actions TO mca_app;
    IF NOT EXISTS (SELECT FROM pg_policies WHERE schemaname='public' AND tablename='mca_deal_agent_runs' AND policyname='mca_server_access') THEN
      CREATE POLICY mca_server_access ON mca_deal_agent_runs TO mca_app USING (true) WITH CHECK (true);
    END IF;
    IF NOT EXISTS (SELECT FROM pg_policies WHERE schemaname='public' AND tablename='mca_deal_agent_actions' AND policyname='mca_server_access') THEN
      CREATE POLICY mca_server_access ON mca_deal_agent_actions TO mca_app USING (true) WITH CHECK (true);
    END IF;
  END IF;
END
$grants$;

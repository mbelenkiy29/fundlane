CREATE TABLE IF NOT EXISTS roadmap_items (
  id text PRIMARY KEY,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120 AND title = btrim(title)),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 500 AND summary = btrim(summary)),
  status text NOT NULL CHECK (status IN ('planned', 'in_progress', 'shipped')),
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  published boolean NOT NULL DEFAULT false,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_by_user_id text REFERENCES users(id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS roadmap_items_published_order_idx ON roadmap_items (status, sort_order, id) WHERE published = true;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS roadmap_item_audit (
  id text PRIMARY KEY,
  item_id text NOT NULL,
  actor_user_id text NOT NULL REFERENCES users(id),
  action text NOT NULL CHECK (action IN ('created', 'updated', 'published', 'unpublished', 'deleted')),
  before_value jsonb,
  after_value jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS roadmap_item_audit_item_idx ON roadmap_item_audit (item_id, created_at);
--> statement-breakpoint
ALTER TABLE roadmap_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE roadmap_item_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON roadmap_items, roadmap_item_audit FROM PUBLIC;
DO $grants$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON roadmap_items, roadmap_item_audit FROM anon;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON roadmap_items, roadmap_item_audit FROM authenticated;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mca_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON roadmap_items TO mca_app;
    GRANT SELECT, INSERT ON roadmap_item_audit TO mca_app;
    IF NOT EXISTS (SELECT FROM pg_policies WHERE schemaname = 'public' AND tablename = 'roadmap_items' AND policyname = 'mca_server_access') THEN
      CREATE POLICY mca_server_access ON roadmap_items TO mca_app USING (true) WITH CHECK (true);
    END IF;
    IF NOT EXISTS (SELECT FROM pg_policies WHERE schemaname = 'public' AND tablename = 'roadmap_item_audit' AND policyname = 'mca_server_access') THEN
      CREATE POLICY mca_server_access ON roadmap_item_audit TO mca_app USING (true) WITH CHECK (true);
    END IF;
  END IF;
END
$grants$;

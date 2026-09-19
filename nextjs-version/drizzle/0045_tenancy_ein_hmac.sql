CREATE UNIQUE INDEX IF NOT EXISTS merchants_workspace_ein_hash_uidx
  ON mca_merchants (workspace_id, ein_lookup_hash)
  WHERE ein_lookup_hash IS NOT NULL;
--> statement-breakpoint

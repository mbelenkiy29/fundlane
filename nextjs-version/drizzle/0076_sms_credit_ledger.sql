-- Additive storage only: no conversion from AI credits, provider costs, or usage meters.
CREATE UNIQUE INDEX sms_credit_message_workspace_id ON mca_sms_messages(workspace_id,id);
--> statement-breakpoint
CREATE TABLE sms_credit_accounts (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id),
  balance_segments integer NOT NULL DEFAULT 0,
  reserved_segments integer NOT NULL DEFAULT 0,
  updated_at text NOT NULL,
  CONSTRAINT sms_credit_account_bounds CHECK (balance_segments >= 0 AND reserved_segments >= 0 AND reserved_segments <= balance_segments)
);
--> statement-breakpoint
CREATE TABLE sms_credit_reservations (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES sms_credit_accounts(workspace_id),
  message_id text NOT NULL UNIQUE,
  segments integer NOT NULL CHECK (segments > 0),
  payload_hash text NOT NULL CHECK (length(payload_hash) BETWEEN 1 AND 256),
  state text NOT NULL CHECK (state IN ('reserved','settled','released')),
  charge_segments integer,
  created_at text NOT NULL,
  UNIQUE(workspace_id,id),
  FOREIGN KEY (workspace_id,message_id) REFERENCES mca_sms_messages(workspace_id,id),
  CONSTRAINT sms_credit_reservation_charge CHECK ((state = 'settled' AND charge_segments IS NOT NULL AND charge_segments BETWEEN 0 AND segments) OR (state <> 'settled' AND charge_segments IS NULL))
);
--> statement-breakpoint
CREATE FUNCTION guard_sms_credit_reservation_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.workspace_id,NEW.message_id,NEW.segments,NEW.payload_hash,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.message_id,OLD.segments,OLD.payload_hash,OLD.created_at)
    OR (OLD.state <> 'reserved' AND ROW(NEW.state,NEW.charge_segments) IS DISTINCT FROM ROW(OLD.state,OLD.charge_segments)) THEN
    RAISE EXCEPTION 'SMS reservation identity and terminal outcome are immutable';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER sms_credit_reservation_immutable BEFORE UPDATE ON sms_credit_reservations FOR EACH ROW EXECUTE FUNCTION guard_sms_credit_reservation_change();
--> statement-breakpoint
CREATE TABLE sms_credit_ledger (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES sms_credit_accounts(workspace_id),
  reservation_id text,
  purchase_id text UNIQUE,
  provider_payment_id text UNIQUE,
  event_key text UNIQUE,
  kind text NOT NULL CHECK (kind IN ('grant','reserve','settle','release')),
  segments integer NOT NULL CHECK (segments >= 0),
  balance_delta integer NOT NULL,
  reserved_delta integer NOT NULL,
  created_at text NOT NULL,
  FOREIGN KEY (workspace_id,reservation_id) REFERENCES sms_credit_reservations(workspace_id,id),
  CONSTRAINT sms_credit_ledger_shape CHECK (
    (kind='grant' AND purchase_id IS NOT NULL AND provider_payment_id IS NOT NULL AND reservation_id IS NULL AND event_key IS NULL AND segments > 0 AND balance_delta=segments AND reserved_delta=0) OR
    (kind='reserve' AND purchase_id IS NULL AND provider_payment_id IS NULL AND reservation_id IS NOT NULL AND event_key IS NULL AND segments > 0 AND balance_delta=0 AND reserved_delta=segments) OR
    (kind='settle' AND purchase_id IS NULL AND provider_payment_id IS NULL AND reservation_id IS NOT NULL AND event_key IS NOT NULL AND balance_delta IN (0,-segments) AND reserved_delta <= 0) OR
    (kind='release' AND purchase_id IS NULL AND provider_payment_id IS NULL AND reservation_id IS NOT NULL AND event_key IS NOT NULL AND segments=0 AND balance_delta=0 AND reserved_delta <= 0)
  )
);
--> statement-breakpoint
CREATE INDEX sms_credit_ledger_workspace ON sms_credit_ledger(workspace_id,created_at);
CREATE UNIQUE INDEX sms_credit_reserve_once ON sms_credit_ledger(reservation_id) WHERE kind='reserve';
--> statement-breakpoint
CREATE FUNCTION reject_sms_credit_ledger_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'sms_credit_ledger is append-only';
END
$$;
CREATE TRIGGER sms_credit_ledger_append_only BEFORE UPDATE OR DELETE ON sms_credit_ledger FOR EACH ROW EXECUTE FUNCTION reject_sms_credit_ledger_change();
--> statement-breakpoint
ALTER TABLE sms_credit_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_credit_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_credit_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sms_credit_accounts,sms_credit_reservations,sms_credit_ledger FROM PUBLIC;
DO $grants$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON sms_credit_accounts,sms_credit_reservations,sms_credit_ledger FROM anon;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON sms_credit_accounts,sms_credit_reservations,sms_credit_ledger FROM authenticated;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='mca_app') THEN
    REVOKE ALL ON sms_credit_accounts,sms_credit_reservations,sms_credit_ledger FROM mca_app;
    GRANT SELECT,INSERT,UPDATE ON sms_credit_accounts,sms_credit_reservations TO mca_app;
    GRANT SELECT,INSERT ON sms_credit_ledger TO mca_app;
    CREATE POLICY mca_server_access ON sms_credit_accounts TO mca_app USING (true) WITH CHECK (true);
    CREATE POLICY mca_server_access ON sms_credit_reservations TO mca_app USING (true) WITH CHECK (true);
    CREATE POLICY mca_server_access ON sms_credit_ledger TO mca_app USING (true) WITH CHECK (true);
  END IF;
END
$grants$;

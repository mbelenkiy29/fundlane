import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { randomUUID, createHash } from "node:crypto"
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import pg from "pg"
import { createClient } from "@supabase/supabase-js"
import { postgresConnection } from "../database/connections"

const executeFile = promisify(execFile)
export const PRODUCTION_REF = "drubsfvhlggmtyiigwxy"
export const COMPANY_MANIFEST = [
  ["e533f62c-f92f-4367-990e-9e91c47c23bb", "Synthetic billing migration verification"],
  ["c880cbaf-f18d-4050-beab-840220624406", "Sentinel Tech Solutions Demo"],
  ["5fbcdb18-9f64-48f1-99f5-4b5055262e8b", "Home Review Demo"],
  ["7a0377b5-42d3-4939-a31b-11a75efc7710", "Live SMS test"],
  ["8ecf9c6b-d269-4694-b016-ac48b5727c21", "Bot Demo Company"],
  ["a2672c56-c652-4eed-9243-bf2b760a384c", "Fundlane QA Test"],
] as const
export const PROTECTED_USERS = ["d5a46f20-279f-4e33-9357-055318e1a45e", "669dabeb-915c-4086-9532-6fca4462712f"]
export const TEST_USERS = ["2c89f2f5-cdbc-46ed-9c33-bd970aebaa48", "f5be785d-45db-4dc1-8f12-21691a72da2b", "f251a79b-4f5b-4b2b-a78f-7bf0b4c5ff1d", "35c8a141-ef19-445c-9613-834308567822", "d3f5f3b4-3033-4cf2-816e-547515baecdc"]
const QA_CUSTOMER = "cus_VLVSq1hL2JtKtA"
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`
const ids = `ARRAY[${COMPANY_MANIFEST.map(([id]) => literal(id)).join(",")}]::text[]`
const testIds = `ARRAY[${TEST_USERS.map(literal).join(",")}]::text[]`
const ownerIds = `ARRAY[${PROTECTED_USERS.map(literal).join(",")}]::text[]`
const manifest = `VALUES ${COMPANY_MANIFEST.map(([id, name]) => `(${literal(id)},${literal(name)})`).join(",")}`

// Temporary tables only: the reviewed six-company deletion needs no persistent schema or migration.
const selectionSql = `
CREATE TEMP TABLE fresh_rows(table_name text NOT NULL, row_key jsonb NOT NULL, data jsonb NOT NULL, PRIMARY KEY(table_name,row_key)) ON COMMIT DROP;
CREATE TEMP TABLE fresh_keys(table_name text PRIMARY KEY, expression text NOT NULL) ON COMMIT DROP;
DO $selection$
DECLARE t record; f record; n integer; added integer; key_sql text; predicate text;
BEGIN
  FOR t IN SELECT c.relname, c.oid FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE ns.nspname='public' AND c.relkind='r' LOOP
    SELECT 'jsonb_build_array('||string_agg(format('r.%I',a.attname),',' ORDER BY k.ordinality)||')' INTO key_sql
      FROM pg_constraint pk CROSS JOIN LATERAL unnest(pk.conkey) WITH ORDINALITY k(attnum,ordinality)
      JOIN pg_attribute a ON a.attrelid=pk.conrelid AND a.attnum=k.attnum WHERE pk.conrelid=t.oid AND pk.contype='p';
    IF key_sql IS NOT NULL THEN INSERT INTO fresh_keys VALUES(t.relname,key_sql); END IF;
    predicate := NULL;
    IF t.relname='workspaces' THEN predicate:=format('r.id=ANY(%s)',${literal(ids)});
    ELSIF t.relname='users' THEN predicate:=format('r.id=ANY(%s)',${literal(testIds)});
    ELSIF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=t.oid AND attname='workspace_id' AND NOT attisdropped) THEN predicate:=format('r.workspace_id::text=ANY(%s)',${literal(ids)});
    END IF;
    IF predicate IS NOT NULL THEN
      IF key_sql IS NULL THEN
        EXECUTE format('SELECT count(*) FROM public.%I r WHERE %s',t.relname,predicate) INTO n;
        IF n>0 THEN RAISE EXCEPTION 'Selected table % has no primary key',t.relname; END IF;
      ELSE EXECUTE format('INSERT INTO fresh_rows SELECT %L,%s,to_jsonb(r) FROM public.%I r WHERE %s ON CONFLICT DO NOTHING',t.relname,key_sql,t.relname,predicate); END IF;
    END IF;
  END LOOP;
  LOOP
    added:=0;
    FOR f IN SELECT child.relname child_name,parent.relname parent_name,
        string_agg(format('to_jsonb(r)->%L=p.data->%L',ca.attname,pa.attname),' AND ' ORDER BY k.ordinality) matches
      FROM pg_constraint fk JOIN pg_class child ON child.oid=fk.conrelid JOIN pg_namespace cn ON cn.oid=child.relnamespace
      JOIN pg_class parent ON parent.oid=fk.confrelid JOIN pg_namespace pn ON pn.oid=parent.relnamespace
      CROSS JOIN LATERAL unnest(fk.conkey,fk.confkey) WITH ORDINALITY k(child_col,parent_col,ordinality)
      JOIN pg_attribute ca ON ca.attrelid=child.oid AND ca.attnum=k.child_col
      JOIN pg_attribute pa ON pa.attrelid=parent.oid AND pa.attnum=k.parent_col
      WHERE fk.contype='f' AND cn.nspname='public' AND pn.nspname='public' GROUP BY fk.oid,child.relname,parent.relname LOOP
      SELECT expression INTO key_sql FROM fresh_keys WHERE table_name=f.child_name;
      IF key_sql IS NULL THEN
        EXECUTE format('SELECT count(*) FROM public.%I r WHERE EXISTS(SELECT 1 FROM fresh_rows p WHERE p.table_name=%L AND %s)',f.child_name,f.parent_name,f.matches) INTO n;
        IF n>0 THEN RAISE EXCEPTION 'Dependent table % has no primary key',f.child_name; END IF;
      ELSE
        EXECUTE format('INSERT INTO fresh_rows SELECT %L,%s,to_jsonb(r) FROM public.%I r WHERE EXISTS(SELECT 1 FROM fresh_rows p WHERE p.table_name=%L AND %s) ON CONFLICT DO NOTHING',f.child_name,key_sql,f.child_name,f.parent_name,f.matches);
        GET DIAGNOSTICS n=ROW_COUNT; added:=added+n;
      END IF;
    END LOOP;
    EXIT WHEN added=0;
  END LOOP;
END $selection$;
`
const fingerprintSql = `(SELECT md5(COALESCE(string_agg(table_name||row_key::text||data::text,E'\\n' ORDER BY table_name,row_key),'empty')) FROM fresh_rows)`

const assertionsSql = `
DO $checks$
BEGIN
  IF (SELECT count(*) FROM workspaces WHERE id=ANY(${ids})) NOT IN (0,6) THEN RAISE EXCEPTION 'Reviewed manifest is incomplete'; END IF;
  IF EXISTS(SELECT 1 FROM workspaces w JOIN (${manifest}) m(id,name) ON m.id=w.id WHERE w.name<>m.name) THEN RAISE EXCEPTION 'Manifest company identity changed'; END IF;
  IF EXISTS(SELECT 1 FROM workspaces WHERE id=ANY(${ids})) AND EXISTS(SELECT 1 FROM workspaces WHERE NOT id=ANY(${ids})) THEN RAISE EXCEPTION 'New company present; fresh start refused'; END IF;
  IF (SELECT count(*) FROM users WHERE id=ANY(${ownerIds}))<>2 OR
     (SELECT count(*) FROM platform_admin_grants WHERE user_id=ANY(${ownerIds}) AND revoked_at IS NULL)<>2 OR
     (SELECT count(*) FROM users WHERE (id=${literal(PROTECTED_USERS[0])} AND lower(email)='mike@sentineltechsolutions.io') OR (id=${literal(PROTECTED_USERS[1])} AND lower(email)='ben@sentineltechsolutions.io'))<>2 THEN RAISE EXCEPTION 'Protected owner identity/grant missing'; END IF;
  IF EXISTS(SELECT 1 FROM memberships WHERE workspace_id=ANY(${ids}) AND NOT user_id=ANY(${testIds}||${ownerIds})) THEN RAISE EXCEPTION 'Unreviewed company member'; END IF;
  IF EXISTS(SELECT 1 FROM memberships WHERE user_id=ANY(${testIds}) AND NOT workspace_id=ANY(${ids})) THEN RAISE EXCEPTION 'Test identity belongs to an unreviewed company'; END IF;
  IF EXISTS(SELECT 1 FROM platform_admin_audit a JOIN fresh_rows r ON r.row_key @> jsonb_build_array(a.target_id)) OR EXISTS(SELECT 1 FROM fresh_rows WHERE table_name IN ('platform_admin_audit','platform_admin_grants')) THEN RAISE EXCEPTION 'Immutable audit or privileged identity reference blocks deletion'; END IF;
  IF EXISTS(SELECT 1 FROM fresh_rows WHERE data->>'workspace_id' IS NOT NULL AND NOT (data->>'workspace_id')=ANY(${ids})) THEN RAISE EXCEPTION 'Dependency crosses company boundary'; END IF;
  IF EXISTS(SELECT 1 FROM fresh_rows WHERE table_name='retention_holds' AND data->>'released_at' IS NULL) THEN RAISE EXCEPTION 'Active retention hold'; END IF;
  IF EXISTS(SELECT 1 FROM fresh_rows WHERE table_name IN ('company_billing_invoices','company_billing_payments','company_billing_adjustments') AND
    (COALESCE((data->>'amount_paid')::bigint,0)>0 OR COALESCE((data->>'amount_due')::bigint,0)>0 OR COALESCE((data->>'amount')::bigint,0)>0)) THEN RAISE EXCEPTION 'Paid activity or debt requires separate review'; END IF;
  IF EXISTS(SELECT 1 FROM fresh_rows WHERE table_name='workspace_stripe_customers' AND (data->>'stripe_customer_id'<>${literal(QA_CUSTOMER)} OR data->>'workspace_id'<>${literal(COMPANY_MANIFEST[5][0])} OR data->>'livemode'<>'1')) THEN RAISE EXCEPTION 'Unreviewed Stripe mapping'; END IF;
  IF EXISTS(SELECT 1 FROM fresh_rows WHERE table_name='sms_numbers' AND data->>'provider_sid' IS NOT NULL AND data->>'released_at' IS NULL) OR
     EXISTS(SELECT 1 FROM fresh_rows WHERE table_name IN ('sms_companies','sms_registrations','drive_connections','mca_email_senders','mca_calendar_connections') AND COALESCE(data->>'provider_sid',data->>'provider_id',data->>'oauth_cipher',data->>'access_token_cipher',data->>'refresh_token_cipher',data->>'brand_sid',data->>'campaign_sid',data->>'provider_cipher') IS NOT NULL) THEN RAISE EXCEPTION 'External integration requires explicit provider cleanup'; END IF;
  IF EXISTS(SELECT 1 FROM fresh_rows WHERE (COALESCE(data->>'state',data->>'status') IN ('running','sending','processing','in_progress') OR data->>'lease_until' IS NOT NULL OR data->>'lease_expires_at' IS NOT NULL) AND
    (COALESCE(data->>'lease_until',data->>'lease_expires_at','9999-01-01')::timestamptz>now())) THEN RAISE EXCEPTION 'Active job or outbound lease; wait for it to drain'; END IF;
END $checks$;
`

export function inventorySql() {
  return `BEGIN ISOLATION LEVEL REPEATABLE READ; SET LOCAL statement_timeout='60s'; ${selectionSql} ${assertionsSql}
    SELECT jsonb_build_object('fingerprint',${fingerprintSql},'rows',(SELECT COALESCE(jsonb_agg(jsonb_build_object('table',table_name,'key',row_key,'data',data) ORDER BY table_name,row_key),'[]') FROM fresh_rows)) inventory; COMMIT;`
}
export type Inventory = { fingerprint: string; rows: { table: string; key: unknown[]; data: Record<string, unknown> }[] }
export function deletionSql(fingerprint: string) {
  if (!/^[a-f0-9]{32}$/.test(fingerprint)) throw new Error("Invalid inventory fingerprint")
  return `BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s';
    -- ponytail: brief global write fence for this one-time reset; use tenant locks if cleanup becomes a product feature.
    DO $locks$ DECLARE t record; BEGIN FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname LOOP EXECUTE format('LOCK TABLE public.%I IN SHARE ROW EXCLUSIVE MODE',t.relname); END LOOP; END $locks$;
    ${selectionSql} ${assertionsSql}
    DO $fingerprint$ BEGIN IF ${fingerprintSql}<>${literal(fingerprint)} THEN RAISE EXCEPTION 'Inventory changed; export and review again'; END IF; END $fingerprint$;
    DO $delete$ DECLARE t record; progress integer; deleted integer; BEGIN
      LOOP
        progress:=0;
        FOR t IN SELECT k.* FROM fresh_keys k WHERE EXISTS(SELECT 1 FROM fresh_rows r WHERE r.table_name=k.table_name) ORDER BY k.table_name LOOP
          BEGIN
            EXECUTE format('DELETE FROM public.%I r WHERE EXISTS(SELECT 1 FROM fresh_rows s WHERE s.table_name=%L AND s.row_key=%s)',t.table_name,t.table_name,t.expression);
            GET DIAGNOSTICS deleted=ROW_COUNT;
            DELETE FROM fresh_rows WHERE table_name=t.table_name; progress:=progress+1;
          EXCEPTION WHEN foreign_key_violation THEN NULL;
          END;
        END LOOP;
        EXIT WHEN NOT EXISTS(SELECT 1 FROM fresh_rows);
        IF progress=0 THEN RAISE EXCEPTION 'Unresolved dependency; transaction rolled back'; END IF;
      END LOOP;
    END $delete$;
    INSERT INTO platform_admin_audit(id,actor_user_id,actor_email,action,target_type,target_id,reason)
      SELECT 'fresh-start-20261001-'||m.id,${literal(PROTECTED_USERS[0])},'mike@sentineltechsolutions.io','platform.test_company_deleted','workspace',m.id,'User-authorized fresh start; company data exported privately'
      FROM (${manifest}) m(id,name) ON CONFLICT(id) DO NOTHING;
    SELECT jsonb_build_object('companiesRemaining',(SELECT count(*) FROM workspaces WHERE id=ANY(${ids})),'testUsersRemaining',(SELECT count(*) FROM users WHERE id=ANY(${testIds}))) result; COMMIT;`
}

async function commandJson(command: string, args: string[]) {
  try {
    const result = await executeFile(command, command === "stripe" ? [...args, "--project-name", "sentinel tech solutions"] : args, { maxBuffer: 64 * 1024 * 1024, timeout: 90_000 })
    return JSON.parse(result.stdout)
  } catch { throw new Error(`${command} operation failed; no provider output logged. Check account access and retry.`) }
}

async function privateDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error("Recovery directory must be private (0700), not a symlink")
}
async function savePrivate(path: string, data: unknown) {
  const temp = `${path}.${randomUUID()}.tmp`
  await writeFile(temp, JSON.stringify(data), { mode: 0o600, flag: "wx" })
  await rename(temp, path)
}

type StripeHistory = { data: Record<string, unknown>[]; has_more: boolean }
export function reviewStripeCustomer(customer: Record<string, unknown>, history: Record<string, StripeHistory>) {
  if (customer.id !== QA_CUSTOMER) throw new Error("QA Stripe customer identity could not be verified")
  if (customer.deleted === true) return { deleted: true, sessions: [] as string[], fingerprint: "deleted", recovery: { customer, history } }
  if (customer.livemode !== true || (customer.metadata as Record<string, unknown> | undefined)?.workspace_id !== COMPANY_MANIFEST[5][0]) throw new Error("QA Stripe customer identity/mode could not be verified")
  if (Object.values(history).some(list => list.has_more)) throw new Error("QA Stripe history exceeds reviewed cleanup limit")
  if (customer.balance !== 0 || history.invoices.data.length || history.charges.data.length || history.balance.data.length ||
      history.payments.data.some(p => p.amount_received !== 0 || !["canceled", "requires_payment_method"].includes(String(p.status))) ||
      history.subscriptions.data.length || history.sessions.data.some(s => s.status === "complete")) throw new Error("QA customer has billing activity; deletion refused")
  return { deleted: false, sessions: history.sessions.data.filter(s => s.status === "open").map(s => String(s.id)),
    fingerprint: createHash("sha256").update(JSON.stringify([customer, history])).digest("hex"), recovery: { customer, history } }
}
export async function stripeCustomerInventory() {
  const account = await commandJson("stripe", ["get", "/v1/account", "--live"])
  if (account.id !== "acct_1SoUZ2PmDkyxVWee") throw new Error("Stripe account does not match production's reviewed Sync Engine account")
  const customer = await commandJson("stripe", ["get", QA_CUSTOMER, "--live"])
  if (customer.deleted) return reviewStripeCustomer(customer, {})
  const read = async (resource: string, scoped = false) => commandJson("stripe", ["get", `/v1/${resource}`, "--live", "--limit", "100", ...(scoped ? [] : ["--data", `customer=${QA_CUSTOMER}`]), ...(resource === "subscriptions" ? ["--data", "status=all"] : [])])
  const [invoices, payments, subscriptions, sessions, charges, balance] = await Promise.all([
    read("invoices"), read("payment_intents"), read("subscriptions"), read("checkout/sessions"), read("charges"), read(`customers/${QA_CUSTOMER}/balance_transactions`, true),
  ])
  return reviewStripeCustomer(customer, { invoices, payments, subscriptions, sessions, charges, balance })
}

export function quiesceSql(fingerprint: string) {
  if (!/^[a-f0-9]{32}$/.test(fingerprint)) throw new Error("Invalid inventory fingerprint")
  return `BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s';
    LOCK TABLE workspaces,users,memberships,mca_background_jobs,company_subscription_state IN SHARE ROW EXCLUSIVE MODE;
    ${selectionSql} ${assertionsSql}
    DO $same$ BEGIN IF ${fingerprintSql}<>${literal(fingerprint)} THEN RAISE EXCEPTION 'Inventory changed before pause'; END IF; END $same$;
    INSERT INTO company_subscription_state(workspace_id,state_kind,legacy_exempt,manual_paused,selected_seats,updated_at)
      SELECT id,'customer',0,1,GREATEST(seat_limit,1),now()::text FROM workspaces WHERE id=ANY(${ids}) ON CONFLICT(workspace_id) DO UPDATE SET manual_paused=1;
    DO $defer$ DECLARE t record; BEGIN FOR t IN SELECT c.table_name,c.column_name FROM information_schema.columns c WHERE c.table_schema='public' AND c.column_name IN ('available_at','next_attempt_at','next_run_at') AND EXISTS(SELECT 1 FROM information_schema.columns w WHERE w.table_schema='public' AND w.table_name=c.table_name AND w.column_name='workspace_id') LOOP
      EXECUTE format('UPDATE public.%I SET %I=%L WHERE workspace_id::text=ANY(%s)',t.table_name,t.column_name,'2099-01-01T00:00:00.000Z',${literal(ids)});
    END LOOP; END $defer$;
    SELECT jsonb_build_object('paused',true) result; COMMIT;`
}

type Progress = {
  projectRef?: string; authUsers?: { localId: string; id: string; email: string }[]
  dbComplete?: boolean; stripeReviewed?: boolean; paused?: boolean
  objects?: { bucket_id: string; name: string; sha256?: string }[]; authIds?: string[]
  removedObjects?: string[]; removedUsers?: string[]; cron?: { jobid: number; active: boolean }[]
}

export async function freshStart(args: string[]) {
  if (!args.includes(`--expected-project-ref=${PRODUCTION_REF}`)) throw new Error("Supply the reviewed --expected-project-ref=drubsfvhlggmtyiigwxy")
  const apply = args.includes("--apply")
  const directoryArg = args.find(arg => arg.startsWith("--directory="))?.slice("--directory=".length)
  if (apply && (!directoryArg || !args.includes("--confirm"))) throw new Error("Apply requires --confirm and a private --directory=PATH")
  const directory = directoryArg ? resolve(directoryArg) : undefined
  const dbUrl = process.env.MCA_OPS_SOURCE_DATABASE_URL
  if (args.includes("--synthetic") && !dbUrl) throw new Error("Synthetic mode requires an explicit disposable database; production fallback is prohibited")
  let client: pg.Client | undefined
  let accessToken: string | undefined
  let state: Progress = {}
  let restoreCron = false
  if (dbUrl) {
    const url = new URL(dbUrl)
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    if (!local || !args.includes("--synthetic") || !url.pathname.startsWith("/fundlane_test_")) throw new Error("Direct connections are limited to disposable synthetic test databases; production uses the authenticated Supabase CLI")
    client = new pg.Client(postgresConnection(dbUrl)); await client.connect()
  } else {
    accessToken = process.env.SUPABASE_ACCESS_TOKEN?.trim()
    if (!accessToken && process.platform === "darwin") {
      const profile = await readFile(join(homedir(), ".supabase", "profile"), "utf8").catch(() => "default")
      for (const account of [profile.trim(), "supabase", "access-token"]) {
        accessToken = (await executeFile("security", ["find-generic-password", "-s", "Supabase CLI", "-a", account, "-w"], { timeout: 10_000 }).catch(() => ({ stdout: "" }))).stdout.trim()
        if (accessToken) break
      }
    }
    if (accessToken?.startsWith("go-keyring-base64:")) accessToken = Buffer.from(accessToken.slice("go-keyring-base64:".length), "base64").toString("utf8")
    if (accessToken?.startsWith("go-keyring-encoded:")) accessToken = Buffer.from(accessToken.slice("go-keyring-encoded:".length), "hex").toString("utf8")
    if (!accessToken) throw new Error("Authenticate Supabase CLI on macOS or supply SUPABASE_ACCESS_TOKEN; no cleanup performed")
  }
  const query = async (sql: string) => {
    if (client) {
      const result = await client.query(sql)
      const results = Array.isArray(result) ? result : [result]
      return results.flatMap(r => r.rows)
    }
    // Management API avoids IPv6-only direct database endpoints; the token never leaves this process except HTTPS authorization.
    const response = await fetch(`https://api.supabase.com/v1/projects/${PRODUCTION_REF}/database/query`, {
      method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: sql }), signal: AbortSignal.timeout(90_000),
    })
    if (!response.ok) throw new Error(`Supabase database operation refused (${response.status}); inspect the dry run before retrying`)
    return await response.json() as Record<string, unknown>[]
  }
  try {
    const [{ inventory }] = await query(inventorySql()) as { inventory: Inventory }[]
    const counts: Record<string, number> = {}
    for (const row of inventory.rows) counts[row.table] = (counts[row.table] ?? 0) + 1
    if (!apply) return { mode: "dry-run", projectRef: PRODUCTION_REF, fingerprint: inventory.fingerprint, companies: counts.workspaces ?? 0, testUsers: counts.users ?? 0, tables: counts, requires: "Live Stripe verification, private recovery directory and --apply --confirm" }
    await privateDirectory(directory!)
    const statePath = join(directory!, "progress.json")
    state = await readFile(statePath, "utf8").then(text => JSON.parse(text), (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return {}; throw error }) as Progress
    if (Object.keys(state).length && state.projectRef !== PRODUCTION_REF) throw new Error("Recovery checkpoint belongs to another project")
    if ((state.objects ?? []).some(object => !COMPANY_MANIFEST.some(([id]) => object.name.startsWith(`${id}/`))) ||
        (state.authUsers ?? []).some(user => !TEST_USERS.includes(user.localId) || PROTECTED_USERS.includes(user.id) || ["mike@sentineltechsolutions.io", "ben@sentineltechsolutions.io"].includes(user.email.toLowerCase())) ||
        (state.authIds ?? []).some(id => !state.authUsers?.some(user => user.id === id))) throw new Error("Recovery checkpoint contains unreviewed targets")
    if ((state.cron ?? []).some(job => !Number.isSafeInteger(job.jobid) || typeof job.active !== "boolean")) throw new Error("Invalid cron recovery checkpoint")
    if (state.cron?.length && !client) {
      const allowed = await query("SELECT jobid FROM cron.job WHERE jobname IN ('stripe-sync-worker','fundlane-billing-maintenance')")
      if (state.cron.some(job => !allowed.some(row => Number(row.jobid) === job.jobid))) throw new Error("Recovery checkpoint references an unreviewed cron job")
      restoreCron = true
    }
    if (inventory.rows.length === 0 && !state.dbComplete) {
      const [receipt] = await query(`SELECT count(*)::int n FROM platform_admin_audit WHERE action='platform.test_company_deleted' AND id IN (${COMPANY_MANIFEST.map(([id]) => literal(`fresh-start-20261001-${id}`)).join(",")})`)
      if (Number(receipt.n) === COMPANY_MANIFEST.length && state.authIds && state.objects) state.dbComplete = true
      else throw new Error("Missing recovery checkpoint; cannot infer external cleanup targets")
    }
    let supabase: ReturnType<typeof createClient> | undefined
    if (!client) {
      // Operator keys remain in this process only, never environment files, command arguments or logs.
      const keys = await commandJson("supabase", ["projects", "api-keys", "--project-ref", PRODUCTION_REF, "--reveal", "--output", "json"])
      const key = keys.find((k: { name: string }) => k.name === "service_role")?.api_key
      if (!key) throw new Error("Supabase operator service key unavailable; no new cleanup performed")
      supabase = createClient(`https://${PRODUCTION_REF}.supabase.co`, key, { auth: { persistSession: false, autoRefreshToken: false } })
    }
    if (!state.dbComplete) {
      const objects = client ? [] : await query(`BEGIN READ ONLY; SELECT bucket_id,name FROM storage.objects WHERE split_part(name,'/',1)=ANY(${ids}); COMMIT;`) as { bucket_id: string; name: string; sha256?: string }[]
      const authUsers = inventory.rows.filter(row => row.table === "users" && row.data.supabase_user_id).map(row => ({ localId: String(row.data.id), id: String(row.data.supabase_user_id), email: String(row.data.email) }))
      const authIds = authUsers.map(user => user.id)
      state = { ...state, projectRef: PRODUCTION_REF, objects, authIds, authUsers, removedObjects: state.removedObjects ?? [], removedUsers: state.removedUsers ?? [] }
      await savePrivate(statePath, state)
      await savePrivate(join(directory!, `recovery-${inventory.fingerprint}.json`), inventory)
      if (supabase) {
        const [outside] = await query(`BEGIN READ ONLY; SELECT count(*)::int n FROM storage.objects WHERE owner_id=ANY(ARRAY[${authIds.map(literal).join(",")}]::text[]) AND NOT split_part(name,'/',1)=ANY(${ids}); COMMIT;`)
        if (outside.n) throw new Error("Test Auth identity owns storage outside the manifest")
        const identityExport = await query(`BEGIN READ ONLY; SELECT to_jsonb(u) identity,
          (SELECT jsonb_agg(to_jsonb(i)) FROM auth.identities i WHERE i.user_id=u.id) providers,
          (SELECT jsonb_agg(to_jsonb(f)) FROM auth.mfa_factors f WHERE f.user_id=u.id) factors
          FROM auth.users u WHERE u.id::text=ANY(ARRAY[${authIds.map(literal).join(",")}]::text[]); COMMIT;`)
        await savePrivate(join(directory!, `auth-recovery-${inventory.fingerprint}.json`), identityExport)
        for (const row of inventory.rows.filter(row => row.table === "users" && row.data.supabase_user_id)) {
          const user = await supabase.auth.admin.getUserById(String(row.data.supabase_user_id))
          if (user.error || user.data.user.email?.toLowerCase() !== String(row.data.email).toLowerCase() || ["mike@sentineltechsolutions.io", "ben@sentineltechsolutions.io"].includes(user.data.user.email?.toLowerCase() ?? "")) throw new Error("Test Auth identity could not be verified")
          await savePrivate(join(directory!, `auth-${row.data.supabase_user_id}.json`), user.data.user)
        }
        for (const object of objects) {
          const downloaded = await supabase.storage.from(object.bucket_id).download(object.name)
          if (downloaded.error || !downloaded.data) throw new Error("Storage recovery download failed; no deletion performed")
          const bytes = Buffer.from(await downloaded.data.arrayBuffer())
          object.sha256 = createHash("sha256").update(bytes).digest("hex")
          const path = join(directory!, `storage-${createHash("sha256").update(`${object.bucket_id}/${object.name}`).digest("hex")}-${object.sha256}.bin`)
          await writeFile(path, bytes, { mode: 0o600, flag: "wx" }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error })
        }
      }
      const stripe = !client && inventory.rows.some(row => row.table === "workspace_stripe_customers") ? await stripeCustomerInventory() : undefined
      if (stripe) { await savePrivate(join(directory!, `stripe-review-${stripe.fingerprint}.json`), stripe); state.stripeReviewed = true }
      if (!client && !state.cron) {
        state.cron = await query("SELECT jobid,active FROM cron.job WHERE jobname IN ('stripe-sync-worker','fundlane-billing-maintenance')")
      }
      await savePrivate(statePath, state)
      if (state.cron?.length) { restoreCron = true; await query(`BEGIN; ${state.cron.map(job => `SELECT cron.alter_job(${job.jobid},active:=false);`).join("\n")} COMMIT;`) }
      // Gate the target companies and defer queued deliveries. Active leases stop the operation.
      const [{ inventory: beforePause }] = await query(inventorySql()) as { inventory: Inventory }[]
      await savePrivate(join(directory!, `recovery-${beforePause.fingerprint}.json`), beforePause)
      await query(quiesceSql(beforePause.fingerprint)); state.paused = true; await savePrivate(statePath, state)
      if (supabase) {
        await query(`BEGIN; INSERT INTO auth_session_revocations(id,revoked_at) SELECT id::text,now()::text FROM auth.sessions WHERE user_id::text=ANY(ARRAY[${authIds.map(literal).join(",")}]::text[]) ON CONFLICT DO NOTHING; COMMIT;`)
        for (const id of authIds) {
          const { error } = await supabase.auth.admin.updateUserById(id, { ban_duration: "876600h" })
          if (error) throw new Error("Could not revoke test identity access; companies remain paused")
        }
      }
      if (stripe && !stripe.deleted) {
        const verified = await stripeCustomerInventory()
        if (verified.fingerprint !== stripe.fingerprint) throw new Error("Stripe changed during review; deletion refused")
        for (const session of verified.sessions) await commandJson("stripe", ["post", `/v1/checkout/sessions/${session}/expire`, "--live", "--confirm"])
        await commandJson("stripe", ["delete", `/v1/customers/${QA_CUSTOMER}`, "--live", "--confirm"])
      }
      if (supabase) {
        const latestObjects = await query(`BEGIN READ ONLY; SELECT bucket_id,name FROM storage.objects WHERE split_part(name,'/',1)=ANY(${ids}); COMMIT;`)
        if (JSON.stringify(latestObjects.map(o => `${o.bucket_id}/${o.name}`).sort()) !== JSON.stringify(objects.map(o => `${o.bucket_id}/${o.name}`).sort())) throw new Error("Storage inventory changed; resume to export the new objects before deletion")
      }
      const [{ inventory: paused }] = await query(inventorySql()) as { inventory: Inventory }[]
      await savePrivate(join(directory!, `recovery-${paused.fingerprint}.json`), paused)
      const result = await query(deletionSql(paused.fingerprint))
      state.dbComplete = true; await savePrivate(statePath, state)
      if (client) return { mode: "applied-synthetic", result }
    }
    if (supabase) {
      if (state.stripeReviewed && !(await stripeCustomerInventory()).deleted) throw new Error("Stripe customer deletion could not be verified")
      for (const object of state.objects ?? []) {
        const identity = `${object.bucket_id}/${object.name}`
        if (state.removedObjects?.includes(identity)) continue
        if (!object.sha256 || !/^[a-f0-9]{64}$/.test(object.sha256)) throw new Error("Storage recovery checksum missing")
        const backupPath = join(directory!, `storage-${createHash("sha256").update(identity).digest("hex")}-${object.sha256}.bin`)
        const backup = await lstat(backupPath)
        if (!backup.isFile() || backup.isSymbolicLink() || (backup.mode & 0o077)) throw new Error("Storage recovery copy missing or not private")
        if (createHash("sha256").update(await readFile(backupPath)).digest("hex") !== object.sha256) throw new Error("Storage recovery checksum failed")
        const { error } = await supabase.storage.from(object.bucket_id).remove([object.name])
        if (error) throw new Error("Storage deletion failed; resume with the same directory")
        state.removedObjects!.push(identity); await savePrivate(statePath, state)
      }
      for (const id of state.authIds ?? []) {
        if (state.removedUsers?.includes(id)) continue
        const user = await supabase.auth.admin.getUserById(id)
        if (!user.error) {
          if (user.data.user.email?.toLowerCase() !== state.authUsers?.find(reviewed => reviewed.id === id)?.email.toLowerCase()) throw new Error("Auth identity changed since review")
          const { error } = await supabase.auth.admin.deleteUser(id)
          if (error) throw new Error("Auth deletion failed; resume with the same directory")
        } else if (user.error.status !== 404) throw new Error("Auth identity verification failed")
        state.removedUsers!.push(id); await savePrivate(statePath, state)
      }
      const remaining = await query(`BEGIN READ ONLY; SELECT (SELECT count(*) FROM workspaces WHERE id=ANY(${ids})) companies,(SELECT count(*) FROM storage.objects WHERE split_part(name,'/',1)=ANY(${ids})) objects,(SELECT count(*) FROM auth.users WHERE id::text=ANY(ARRAY[${(state.authIds ?? []).map(literal).join(",")}]::text[])) test_identities; COMMIT;`)
      if (remaining.some((r: Record<string, number>) => Object.values(r).some(value => Number(value) !== 0))) throw new Error("Cleanup verification failed")
    }
    const [{ inventory: finalInventory }] = await query(inventorySql()) as { inventory: Inventory }[]
    if (finalInventory.rows.length) throw new Error("Company dependencies reappeared; stop and review before any further deletion")
    return { mode: "applied", projectRef: PRODUCTION_REF, companies: 0, externalCleanup: "verified", recoveryDirectory: directory }
  } finally {
    try { if (restoreCron && state.cron?.length) await query(`BEGIN; ${state.cron.map(job => `SELECT cron.alter_job(${job.jobid},active:=${job.active});`).join("\n")} COMMIT;`) }
    finally { await client?.end() }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  freshStart(process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch((error: Error) => { console.error(error.message); process.exitCode = 1 })
}

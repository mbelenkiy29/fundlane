import { Client } from 'pg';
import { applicationTables } from './manifest';
import { assertMigrationDestination, identifier, postgresConnection, requiredUrl } from './connections';
import { assertSafeRuntimeRole, type RuntimeRole } from './migration-safety';

async function main() {
  const password = process.env.MCA_DB_RUNTIME_PASSWORD;
  if (!password || !/^[A-Za-z0-9_-]{32,128}$/.test(password)) throw new Error('MCA_DB_RUNTIME_PASSWORD must contain 32–128 random base64url characters.');
  const destination = requiredUrl('DATABASE_URL_UNPOOLED');
  assertMigrationDestination(destination);
  const client = new Client(postgresConnection(destination));
  await client.connect();
  try {
    await client.query('BEGIN');
    // PostgreSQL16+ gives the postgres creator an administrative-only ownership
    // edge (no INHERIT/SET). All other incoming and outgoing memberships fail.
    const existing = (await client.query<RuntimeRole>(`SELECT r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,r.rolcanlogin,
      (SELECT count(*)::integer FROM pg_auth_members m JOIN pg_roles holder ON holder.oid=m.member
       WHERE (m.member=r.oid OR m.roleid=r.oid) AND NOT
         (m.roleid=r.oid AND holder.rolname='postgres' AND m.admin_option
          AND COALESCE((to_jsonb(m)->>'inherit_option')::boolean,true)=false
          AND COALESCE((to_jsonb(m)->>'set_option')::boolean,true)=false)) memberships
      FROM pg_roles r WHERE r.rolname='mca_app'`)).rows[0];
    const exists = Boolean(existing);
    if (existing) assertSafeRuntimeRole(existing);
    else await client.query('CREATE ROLE mca_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT');
    // Do not rotate the SCRAM verifier on every release: poolers cache it. Explicit
    // rotation requires updating deployed credentials and waiting for cache expiry.
    if (!exists || process.argv.includes('--rotate-password')) await client.query(`ALTER ROLE mca_app PASSWORD '${password}'`);
    await client.query('GRANT USAGE ON SCHEMA public TO mca_app');
    const browserRoles = (await client.query<{rolname:string}>("SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated')")).rows.map(r=>identifier(r.rolname));
    const available = new Set((await client.query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows.map(row=>row.tablename));
    const policies: string[] = [];
    for (const table of applicationTables()) {
      const qualified = `public.${identifier(table)}`;
      if (!available.has(table)) throw new Error(`Apply migrations before securing ${table}.`);
      policies.push(`REVOKE ALL ON TABLE ${qualified} FROM PUBLIC${browserRoles.length ? ', '+browserRoles.join(',') : ''}`);
      policies.push(`ALTER TABLE ${qualified} ENABLE ROW LEVEL SECURITY`);
      policies.push(`REVOKE ALL ON TABLE ${qualified} FROM mca_app`);
      policies.push(`GRANT ${table === 'platform_admin_grants' ? 'SELECT' : ['roadmap_item_audit','platform_admin_audit','mca_notification_receipts','sms_credit_ledger'].includes(table) ? 'SELECT, INSERT' : ['platform_step_ups','sms_credit_accounts','sms_credit_reservations'].includes(table) ? 'SELECT, INSERT, UPDATE' : 'SELECT, INSERT, UPDATE, DELETE'} ON TABLE ${qualified} TO mca_app`);
      policies.push(`DROP POLICY IF EXISTS mca_server_access ON ${qualified}`);
      // Only our server role has this policy. Every browser goes through MCA authorization.
      policies.push(table === 'platform_admin_grants'
        ? `CREATE POLICY mca_server_access ON ${qualified} FOR SELECT TO mca_app USING (true)`
        : `CREATE POLICY mca_server_access ON ${qualified} TO mca_app USING (true) WITH CHECK (true)`);
    }
    await client.query(policies.join(';\n'));
    const sequences = await client.query<{name:string}>(`SELECT DISTINCT s.relname name FROM pg_class s JOIN pg_depend d ON d.objid=s.oid JOIN pg_class t ON t.oid=d.refobjid JOIN pg_namespace n ON n.oid=s.relnamespace WHERE s.relkind='S' AND n.nspname='public' AND t.relname=ANY($1::text[])`, [applicationTables()]);
    for (const {name} of sequences.rows) await client.query(`GRANT USAGE, SELECT ON SEQUENCE public.${identifier(name)} TO mca_app`);
    if ((await client.query("SELECT to_regclass('auth.sessions') relation")).rows[0].relation) {
      // Supabase owns auth's schema and does not grant postgres USAGE WITH GRANT OPTION.
      // This private, owner-executed projection exposes exactly the three session fields
      // needed by the server. It is excluded from the Data API and has no browser grants.
      await client.query('CREATE SCHEMA IF NOT EXISTS mca_private');
      await client.query('CREATE OR REPLACE VIEW mca_private.auth_sessions WITH (security_invoker=false) AS SELECT id,user_id,not_after FROM auth.sessions');
      await client.query(`REVOKE ALL ON SCHEMA mca_private FROM PUBLIC${browserRoles.length ? ', '+browserRoles.join(',') : ''}`);
      await client.query(`REVOKE ALL ON mca_private.auth_sessions FROM PUBLIC${browserRoles.length ? ', '+browserRoles.join(',') : ''}`);
      await client.query('GRANT USAGE ON SCHEMA mca_private TO mca_app');
      await client.query('GRANT SELECT ON mca_private.auth_sessions TO mca_app');
      await client.query('REVOKE SELECT (id,user_id,not_after) ON auth.sessions FROM mca_app');
      const grants = await client.query("SELECT has_schema_privilege('mca_app','mca_private','USAGE') AND has_table_privilege('mca_app','mca_private.auth_sessions','SELECT') AS allowed");
      if (!grants.rows[0].allowed) throw new Error('Runtime session verification grant failed.');
    }
    if ((await client.query("SELECT 1 FROM pg_namespace WHERE nspname='stripe'")).rowCount) {
      await client.query(`REVOKE ALL ON SCHEMA stripe FROM PUBLIC${browserRoles.length ? ', '+browserRoles.join(',') : ''}`);
      await client.query('GRANT USAGE ON SCHEMA stripe TO mca_app');
      for (const table of ['subscriptions', 'subscription_items']) {
        if ((await client.query('SELECT to_regclass($1) AS relation', [`stripe.${table}`])).rows[0].relation) {
          await client.query(`GRANT SELECT ON stripe.${identifier(table)} TO mca_app`);
        }
      }
    }
    await client.query('COMMIT'); console.log('Application RLS, browser restrictions, and server role configured.');
  } catch(error) { await client.query('ROLLBACK'); throw error; }
  finally { await client.end(); }
}
main().catch(error=>{ console.error(error instanceof Error ? error.message.replace(process.env.MCA_DB_RUNTIME_PASSWORD ?? '<unset>', '[redacted]') : 'Role setup failed.'); process.exitCode=1; });

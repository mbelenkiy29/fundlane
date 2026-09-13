import { postgresConnection } from '../../src/lib/mca/db-connection';
export { postgresConnection };

export function requiredUrl(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required; no production connection fallback is permitted.`);
  new URL(value);
  return value;
}

export function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error('Unsafe PostgreSQL identifier.');
  return `"${value}"`;
}

function supabaseReference(url: URL): string | undefined {
  const direct = /^db\.([a-z0-9]+)\.supabase\.co$/.exec(url.hostname)?.[1];
  return direct ?? (url.hostname.endsWith('.pooler.supabase.com') ? decodeURIComponent(url.username).split('.').at(-1) : undefined);
}

/** Mutating release commands must explicitly name their hosted destination. */
export function assertMigrationDestination(connection: string, args = process.argv): void {
  const url = new URL(connection);
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    const admin = process.env.MCA_TEST_DATABASE_ADMIN_URL ? new URL(process.env.MCA_TEST_DATABASE_ADMIN_URL) : undefined;
    if (process.env.MCA_TEST_DATABASE_DISPOSABLE === 'true' ||
        (url.pathname.startsWith('/fundlane_test_') && admin?.hostname === url.hostname && admin?.port === url.port)) return;
    throw new Error('Local schema mutations require an explicitly disposable test target.');
  }
  const expected = args.find(arg=>arg.startsWith('--expected-project-ref='))?.slice('--expected-project-ref='.length)
    ?? process.env.MCA_MIGRATION_EXPECTED_PROJECT_REF;
  if (!expected || !/^[a-z0-9]+$/.test(expected) || supabaseReference(url) !== expected) {
    throw new Error('Hosted schema mutations require the matching --expected-project-ref=REF destination.');
  }
}

export function sameDatabase(left: string, right: string): boolean {
  const a = new URL(left), b = new URL(right);
  const ar = supabaseReference(a), br = supabaseReference(b);
  if (ar && br) return ar === br && a.pathname === b.pathname;
  return a.hostname.replace('-pooler.', '.') === b.hostname.replace('-pooler.', '.') &&
    (a.port || '5432') === (b.port || '5432') && a.pathname === b.pathname;
}

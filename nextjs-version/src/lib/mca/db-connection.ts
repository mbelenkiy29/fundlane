import { readFileSync } from "node:fs";
import type { PoolConfig } from "pg";
import { SUPABASE_DATABASE_CA } from "./supabase-ca";

/** Explicit URLs are required: Supavisor hostnames cannot be inferred from a project ref. */
export function postgresConnection(connectionString: string): PoolConfig {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Expected a PostgreSQL URL.');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (local && process.env.NODE_ENV !== 'production') {
    url.searchParams.delete('sslmode');
    return { connectionString: url.toString(), ssl: false };
  }
  // pg connection-string options can override the explicit TLS object.
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(key);
  const ca = process.env.MCA_DB_CA_CERT_PATH ? readFileSync(process.env.MCA_DB_CA_CERT_PATH, 'utf8') : (url.hostname.endsWith('.supabase.co') || url.hostname.endsWith('.pooler.supabase.com') ? SUPABASE_DATABASE_CA : undefined);
  return { connectionString: url.toString(), ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) }, enableChannelBinding: true };
}

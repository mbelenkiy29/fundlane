/** Hosted services must share one Supabase project. Never include secret values in errors. */
export function assertHostedSupabaseConfig(env: Record<string, string | undefined> = process.env, connectionString = env.DATABASE_URL) {
  if (!env.VERCEL && env.NODE_ENV !== "production") return;
  const publicUrl = new URL(env.NEXT_PUBLIC_SUPABASE_URL || "https://unconfigured.invalid");
  const match = /^([a-z]{20})\.supabase\.co$/.exec(publicUrl.hostname);
  if (!match || publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password) {
    throw new Error("Hosted runtime requires a Supabase project URL.");
  }
  const project = match[1];
  if (env.SUPABASE_URL && new URL(env.SUPABASE_URL).origin !== publicUrl.origin) {
    throw new Error("Supabase server and browser projects must match.");
  }
  if (!connectionString) throw new Error("Hosted runtime requires DATABASE_URL.");
  const database = new URL(connectionString);
  const direct = database.hostname === `db.${project}.supabase.co`;
  const pooled = database.hostname.endsWith(".pooler.supabase.com") && decodeURIComponent(database.username).endsWith(`.${project}`);
  if (!["postgres:", "postgresql:"].includes(database.protocol) || (!direct && !pooled)) {
    throw new Error("Hosted database must belong to the configured Supabase project; other providers are unsupported.");
  }
}

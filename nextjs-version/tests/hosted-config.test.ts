import assert from "node:assert/strict";
import test from "node:test";
import { assertHostedSupabaseConfig } from "../src/lib/mca/hosted-config";

const project = "drubsfvhlggmtyiigwxy";
const env = {
  VERCEL: "1",
  NEXT_PUBLIC_SUPABASE_URL: `https://${project}.supabase.co`,
  SUPABASE_URL: `https://${project}.supabase.co`,
  DATABASE_URL: `postgresql://mca_app.${project}:test@aws-0-us-west-2.pooler.supabase.com:6543/postgres`,
};

test("hosted database and Auth accept only matching Supabase projects", () => {
  assert.doesNotThrow(() => assertHostedSupabaseConfig(env));
  assert.doesNotThrow(() => assertHostedSupabaseConfig(env, `postgresql://mca_app:test@db.${project}.supabase.co/postgres`));
  for (const url of [
    "postgresql://user:test@ep-example.neon.tech/db",
    "postgresql://user.wrongproject:test@aws-0-us-west-2.pooler.supabase.com/postgres",
    "postgresql://user:test@db.otherproject.supabase.co/postgres",
    "postgresql://user:test@localhost/postgres",
  ]) assert.throws(() => assertHostedSupabaseConfig(env, url), /configured Supabase project/);
});

test("hosted configuration fails closed when missing or inconsistent", () => {
  assert.throws(() => assertHostedSupabaseConfig({ VERCEL: "1" }), /project URL/);
  assert.throws(() => assertHostedSupabaseConfig({ ...env, DATABASE_URL: "" }), /DATABASE_URL/);
  assert.throws(() => assertHostedSupabaseConfig({ ...env, SUPABASE_URL: "https://other.supabase.co" }), /must match/);
  assert.throws(() => assertHostedSupabaseConfig({ ...env, NEXT_PUBLIC_SUPABASE_URL: `http://${project}.supabase.co` }), /project URL/);
});

test("isolated local database tests remain supported", () => {
  assert.doesNotThrow(() => assertHostedSupabaseConfig({ NODE_ENV: "test", DATABASE_URL: "postgresql://localhost/test" }));
});

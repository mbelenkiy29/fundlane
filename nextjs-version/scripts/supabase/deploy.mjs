import { spawnSync } from "node:child_process"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "../..")
const values = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, "").split("=")))
const production = "drubsfvhlggmtyiigwxy"
const expected = values["expected-project-ref"]
if (!["staging", "production"].includes(values.environment) || !/^[a-z]{20}$/.test(expected ?? "")) {
  throw new Error("Specify --environment=staging|production and --expected-project-ref=REF.")
}
if (values.environment === "production" || expected === production) {
  throw new Error("Production deployment is gated: hosted maximum-size acceptance and completed worker migration are required.")
}
if (expected !== process.env.MCA_SUPABASE_STAGING_PROJECT_REF) throw new Error("The explicit ref must match MCA_SUPABASE_STAGING_PROJECT_REF.")
// An explicit allowlist prevents accidentally deploying/replacing existing Stripe functions.
for (const args of [[process.execPath, ["scripts/supabase/build.mjs"]], ["supabase", ["functions", "deploy", "mca-feasibility", "--project-ref", expected, "--use-api", "--workdir", root]]]) {
  const result = spawnSync(args[0], args[1], { cwd: root, stdio: "inherit" })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
